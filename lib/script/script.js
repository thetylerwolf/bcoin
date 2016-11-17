/*!
 * script.js - script interpreter for bcoin
 * Copyright (c) 2014-2015, Fedor Indutny (MIT License)
 * Copyright (c) 2014-2016, Christopher Jeffrey (MIT License).
 * https://github.com/bcoin-org/bcoin
 */

'use strict';

module.exports = Script;

var BN = require('bn.js');
var constants = require('../protocol/constants');
var utils = require('../utils/utils');
var crypto = require('../crypto/crypto');
var assert = require('assert');
var BufferWriter = require('../utils/writer');
var BufferReader = require('../utils/reader');
var opcodes = constants.opcodes;
var STACK_TRUE = new Buffer([1]);
var STACK_FALSE = new Buffer(0);
var STACK_NEGATE = new Buffer([0x81]);
var ScriptError = require('../utils/errors').ScriptError;
var scriptTypes = constants.scriptTypes;
var Program = require('./program');
var Opcode = require('./opcode');
var Stack = require('./stack');
var SigCache = require('./sigcache');
var ec = require('../crypto/ec');
var Address = require('../primitives/address');

/**
 * Represents a input or output script.
 * @exports Script
 * @constructor
 * @param {Buffer|Array|Object|NakedScript} code - Array
 * of script code or a serialized script Buffer.
 * @property {Array} code - Parsed script code.
 * @property {Buffer?} raw - Serialized script.
 * @property {Script?} redeem - Redeem script.
 * @property {Number} length - Number of parsed opcodes.
 */

function Script(options) {
  if (!(this instanceof Script))
    return new Script(options);

  this.raw = STACK_FALSE;
  this.code = [];

  if (options)
    this.fromOptions(options);
}

Script.prototype.__defineGetter__('length', function() {
  return this.code.length;
});

Script.prototype.__defineSetter__('length', function(length) {
  return this.code.length = length;
});

/**
 * Inject properties from options object.
 * @private
 * @param {Object} options
 */

Script.prototype.fromOptions = function fromOptions(options) {
  assert(options, 'Script data is required.');

  if (Buffer.isBuffer(options))
    return this.fromRaw(options);

  if (Array.isArray(options))
    return this.fromArray(options);

  if (options.raw) {
    if (!options.code)
      return this.fromRaw(options.raw);
    assert(Buffer.isBuffer(options.raw));
    this.raw = options.raw;
  }

  if (options.code) {
    if (!options.raw)
      return this.fromArray(options.code);
    assert(Array.isArray(options.code));
    this.code = options.code;
  }

  return this;
};

/**
 * Insantiate script from options object.
 * @param {Object} options
 * @returns {Script}
 */

Script.fromOptions = function fromOptions(options) {
  return new Script().fromOptions(options);
};

/**
 * Convert the script to an array of
 * Buffers (pushdatas) and Numbers
 * (opcodes).
 * @returns {Array}
 */

Script.prototype.toArray = function toArray() {
  var code = [];
  var i, op;

  for (i = 0; i < this.code.length; i++) {
    op = this.code[i];
    code.push(op.data || op.value);
  }

  return code;
};

/**
 * Inject properties from an array of
 * of buffers and numbers.
 * @private
 */

Script.prototype.fromArray = function fromArray(code) {
  assert(Array.isArray(code));
  this.code = Script.parseArray(code);
  this.raw = Script.encode(this.code);
  return this;
};

/**
 * Instantiate script from an array
 * of buffers and numbers.
 * @returns {Script}
 */

Script.fromArray = function fromArray(code) {
  return new Script().fromArray(code);
};

/**
 * Clone the script.
 * @returns {Script} Cloned script.
 */

Script.prototype.clone = function clone() {
  return new Script(this.raw);
};

/**
 * Inspect the script.
 * @returns {String} Human-readable script code.
 */

Script.prototype.inspect = function inspect() {
  return '<Script: ' + this.toString() + '>';
};

/**
 * Convert the script to a bitcoind test string.
 * @returns {String} Human-readable script code.
 */

Script.prototype.toString = function toString() {
  return Script.format(this.code);
};

/**
 * Format the script as bitcoind asm.
 * @param {Boolean?} decode - Attempt to decode hash types.
 * @returns {String} Human-readable script.
 */

Script.prototype.toASM = function toASM(decode) {
  return Script.formatASM(this.code, decode);
};

/**
 * Re-encode the script internally. Useful if you
 * changed something manually in the `code` array.
 */

Script.prototype.compile = function compile() {
  this.raw = Script.encode(this.code);
};

/**
 * Encode the script to a Buffer. See {@link Script#encode}.
 * @param {String} enc - Encoding, either `'hex'` or `null`.
 * @returns {Buffer|String} Serialized script.
 */

Script.prototype.toRaw = function toRaw(writer) {
  if (writer) {
    writer.writeVarBytes(this.raw);
    return writer;
  }
  return this.raw;
};

/**
 * Convert script to a hex string.
 * @returns {String}
 */

Script.prototype.toJSON = function toJSON() {
  return this.toRaw().toString('hex');
};

/**
 * Inject properties from json object.
 * @private
 * @param {String} json
 */

Script.prototype.fromJSON = function fromJSON(json) {
  assert(typeof json === 'string');
  return this.fromRaw(new Buffer(json, 'hex'));
};

/**
 * Instantiate script from a hex string.
 * @params {String} json
 * @returns {Script}
 */

Script.fromJSON = function fromJSON(json) {
  return new Script().fromJSON(json);
};

/**
 * Get the script's "subscript" starting at a separator.
 * @param {Number?} lastSep - The last separator to sign/verify beyond.
 * @returns {Script} Subscript.
 */

Script.prototype.getSubscript = function getSubscript(lastSep) {
  var code = [];
  var i, op;

  if (lastSep === 0)
    return this.clone();

  for (i = lastSep; i < this.code.length; i++) {
    op = this.code[i];
    if (op.value === -1)
      break;
    code.push(op);
  }

  return new Script(code);
};

/**
 * Get the script's "subscript" starting at a separator.
 * Remove all OP_CODESEPARATORs if present. This bizarre
 * behavior is necessary for signing and verification when
 * code separators are present.
 * @returns {Script} Subscript.
 */

Script.prototype.removeSeparators = function removeSeparators() {
  var code = [];
  var i, op;

  for (i = 0; i < this.code.length; i++) {
    op = this.code[i];
    if (op.value === -1)
      break;
    if (op.value !== opcodes.OP_CODESEPARATOR)
      code.push(op);
  }

  if (code.length === this.code.length)
    return this.clone();

  return new Script(code);
};

/**
 * Execute and interpret the script.
 * @param {Stack} stack - Script execution stack.
 * @param {Number?} flags - Script standard flags.
 * @param {TX?} tx - Transaction being verified.
 * @param {Number?} index - Index of input being verified.
 * @param {Number?} version - Signature hash version (0=legacy, 1=segwit).
 * @throws {ScriptError} Will be thrown on VERIFY failures, among other things.
 * @returns {Boolean} Whether the execution was successful.
 */

Script.prototype.execute = function execute(stack, flags, tx, index, version) {
  var ip = 0;
  var lastSep = 0;
  var opCount = 0;
  var alt = [];
  var state = [];
  var negate = 0;
  var op, code, data;
  var val, v1, v2, v3;
  var num, n1, n2, n3;
  var m, n, key, sig;
  var type, subscript, hash;
  var ikey, isig, ikey2;
  var i, j, res, locktime;

  if (flags == null)
    flags = constants.flags.STANDARD_VERIFY_FLAGS;

  if (this.getSize() > constants.script.MAX_SIZE)
    throw new ScriptError('SCRIPT_SIZE');

  for (ip = 0; ip < this.code.length; ip++) {
    code = this.code[ip];
    op = code.value;
    data = code.data;

    if (op === -1)
      throw new ScriptError('BAD_OPCODE', op, ip);

    if (data) {
      if (data.length > constants.script.MAX_PUSH)
        throw new ScriptError('PUSH_SIZE', op, ip);

      // Note that minimaldata is not checked
      // on unexecuted branches of code.
      if (negate === 0) {
        if (!Script.isMinimal(data, op, flags))
          throw new ScriptError('MINIMALDATA', op, ip);
        stack.push(data);
      }

      continue;
    }

    if (op > opcodes.OP_16 && ++opCount > constants.script.MAX_OPS)
      throw new ScriptError('OP_COUNT', op, ip);

    // It's very important to make a distiction
    // here: these opcodes will fail _even if they
    // are in unexecuted branches of code_. Whereas
    // a totally unknown opcode is fine as long as it
    // is unexecuted.
    switch (op) {
      case opcodes.OP_CAT:
      case opcodes.OP_SUBSTR:
      case opcodes.OP_LEFT:
      case opcodes.OP_RIGHT:
      case opcodes.OP_INVERT:
      case opcodes.OP_AND:
      case opcodes.OP_OR:
      case opcodes.OP_XOR:
      case opcodes.OP_2MUL:
      case opcodes.OP_2DIV:
      case opcodes.OP_MUL:
      case opcodes.OP_DIV:
      case opcodes.OP_MOD:
      case opcodes.OP_LSHIFT:
      case opcodes.OP_RSHIFT:
        throw new ScriptError('DISABLED_OPCODE', op, ip);
    }

    if (op >= opcodes.OP_IF && op <= opcodes.OP_ENDIF) {
      switch (op) {
        case opcodes.OP_IF:
        case opcodes.OP_NOTIF: {
          val = false;

          if (negate === 0) {
            if (stack.length < 1)
              throw new ScriptError('UNBALANCED_CONDITIONAL', op, ip);

            val = stack.top(-1);

            if (version === 1 && (flags & constants.flags.VERIFY_MINIMALIF)) {
              if (val.length > 1)
                throw new ScriptError('MINIMALIF');

              if (val.length === 1 && val[0] !== 1)
                throw new ScriptError('MINIMALIF');
            }

            val = Script.bool(val);

            if (op === opcodes.OP_NOTIF)
              val = !val;

            stack.pop();
          }

          state.push(val);

          if (!val)
            negate++;

          break;
        }
        case opcodes.OP_ELSE: {
          if (state.length === 0)
            throw new ScriptError('UNBALANCED_CONDITIONAL', op, ip);

          state[state.length - 1] = !state[state.length - 1];

          if (!state[state.length - 1])
            negate++;
          else
            negate--;

          break;
        }
        case opcodes.OP_ENDIF: {
          if (state.length === 0)
            throw new ScriptError('UNBALANCED_CONDITIONAL', op, ip);

          if (!state.pop())
            negate--;

          break;
        }
        case opcodes.OP_VERIF:
        case opcodes.OP_VERNOTIF: {
          throw new ScriptError('BAD_OPCODE', op, ip);
        }
        default: {
          assert(false, 'Fatal script error.');
        }
      }
      continue;
    }

    if (negate !== 0)
      continue;

    switch (op) {
      case opcodes.OP_0: {
        stack.push(STACK_FALSE);
        break;
      }
      case opcodes.OP_1NEGATE: {
        stack.push(STACK_NEGATE);
        break;
      }
      case opcodes.OP_1:
      case opcodes.OP_2:
      case opcodes.OP_3:
      case opcodes.OP_4:
      case opcodes.OP_5:
      case opcodes.OP_6:
      case opcodes.OP_7:
      case opcodes.OP_8:
      case opcodes.OP_9:
      case opcodes.OP_10:
      case opcodes.OP_11:
      case opcodes.OP_12:
      case opcodes.OP_13:
      case opcodes.OP_14:
      case opcodes.OP_15:
      case opcodes.OP_16: {
        stack.push(new Buffer([op - 0x50]));
        break;
      }
      case opcodes.OP_NOP: {
        break;
      }
      case opcodes.OP_CHECKLOCKTIMEVERIFY: {
        // OP_CHECKLOCKTIMEVERIFY = OP_NOP2
        if (!(flags & constants.flags.VERIFY_CHECKLOCKTIMEVERIFY)) {
          if (flags & constants.flags.VERIFY_DISCOURAGE_UPGRADABLE_NOPS)
            throw new ScriptError('DISCOURAGE_UPGRADABLE_NOPS', op, ip);
          break;
        }

        if (!tx)
          throw new ScriptError('UNKNOWN_ERROR', 'No TX passed in.');

        if (stack.length === 0)
          throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

        locktime = Script.num(stack.top(-1), flags, 5);

        if (locktime.cmpn(0) < 0)
          throw new ScriptError('NEGATIVE_LOCKTIME', op, ip);

        locktime = locktime.toNumber();

        if (!Script.checkLocktime(locktime, tx, index))
          throw new ScriptError('UNSATISFIED_LOCKTIME', op, ip);

        break;
      }
      case opcodes.OP_CHECKSEQUENCEVERIFY: {
        // OP_CHECKSEQUENCEVERIFY = OP_NOP3
        if (!(flags & constants.flags.VERIFY_CHECKSEQUENCEVERIFY)) {
          if (flags & constants.flags.VERIFY_DISCOURAGE_UPGRADABLE_NOPS)
            throw new ScriptError('DISCOURAGE_UPGRADABLE_NOPS', op, ip);
          break;
        }

        if (!tx)
          throw new ScriptError('UNKNOWN_ERROR', 'No TX passed in.');

        if (stack.length === 0)
          throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

        locktime = Script.num(stack.top(-1), flags, 5);

        if (locktime.cmpn(0) < 0)
          throw new ScriptError('NEGATIVE_LOCKTIME', op, ip);

        locktime = locktime.toNumber();

        if ((locktime & constants.sequence.DISABLE_FLAG) !== 0)
          break;

        if (!Script.checkSequence(locktime, tx, index))
          throw new ScriptError('UNSATISFIED_LOCKTIME', op, ip);

        break;
      }
      case opcodes.OP_NOP1:
      case opcodes.OP_NOP4:
      case opcodes.OP_NOP5:
      case opcodes.OP_NOP6:
      case opcodes.OP_NOP7:
      case opcodes.OP_NOP8:
      case opcodes.OP_NOP9:
      case opcodes.OP_NOP10: {
        if (flags & constants.flags.VERIFY_DISCOURAGE_UPGRADABLE_NOPS)
          throw new ScriptError('DISCOURAGE_UPGRADABLE_NOPS', op, ip);
        break;
      }
      case opcodes.OP_VERIFY: {
        if (stack.length === 0)
          throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

        if (!Script.bool(stack.top(-1)))
          throw new ScriptError('VERIFY', op, ip);

        stack.pop();

        break;
      }
      case opcodes.OP_RETURN: {
        throw new ScriptError('OP_RETURN', op, ip);
      }
      case opcodes.OP_TOALTSTACK: {
        if (stack.length === 0)
          throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

        alt.push(stack.pop());
        break;
      }
      case opcodes.OP_FROMALTSTACK: {
        if (alt.length === 0)
          throw new ScriptError('INVALID_ALTSTACK_OPERATION', op, ip);

        stack.push(alt.pop());
        break;
      }
      case opcodes.OP_2DROP: {
        if (stack.length < 2)
          throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

        stack.pop();
        stack.pop();
        break;
      }
      case opcodes.OP_2DUP: {
        if (stack.length < 2)
          throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

        v1 = stack.top(-2);
        v2 = stack.top(-1);

        stack.push(v1);
        stack.push(v2);
        break;
      }
      case opcodes.OP_3DUP: {
        if (stack.length < 3)
          throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

        v1 = stack.top(-3);
        v2 = stack.top(-2);
        v3 = stack.top(-1);

        stack.push(v1);
        stack.push(v2);
        stack.push(v3);
        break;
      }
      case opcodes.OP_2OVER: {
        if (stack.length < 4)
          throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

        v1 = stack.top(-4);
        v2 = stack.top(-3);

        stack.push(v1);
        stack.push(v2);
        break;
      }
      case opcodes.OP_2ROT: {
        if (stack.length < 6)
          throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

        v1 = stack.top(-6);
        v2 = stack.top(-5);

        stack.erase(-6, -4);
        stack.push(v1);
        stack.push(v2);
        break;
      }
      case opcodes.OP_2SWAP: {
        if (stack.length < 4)
          throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

        stack.swap(-4, -2);
        stack.swap(-3, -1);
        break;
      }
      case opcodes.OP_IFDUP: {
        if (stack.length === 0)
          throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

        val = stack.top(-1);

        if (Script.bool(val))
          stack.push(val);
        break;
      }
      case opcodes.OP_DEPTH: {
        stack.push(Script.array(stack.length));
        break;
      }
      case opcodes.OP_DROP: {
        if (stack.length === 0)
          throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

        stack.pop();
        break;
      }
      case opcodes.OP_DUP: {
        if (stack.length === 0)
          throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

        stack.push(stack.top(-1));
        break;
      }
      case opcodes.OP_NIP: {
        if (stack.length < 2)
          throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

        stack.remove(-2);
        break;
      }
      case opcodes.OP_OVER: {
        if (stack.length < 2)
          throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

        stack.push(stack.top(-2));
        break;
      }
      case opcodes.OP_PICK:
      case opcodes.OP_ROLL: {
        if (stack.length < 2)
          throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

        num = Script.num(stack.top(-1), flags).toNumber();
        stack.pop();

        if (num < 0 || num >= stack.length)
          throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

        val = stack.top(-num - 1);

        if (op === opcodes.OP_ROLL)
          stack.remove(-num - 1);

        stack.push(val);
        break;
      }
      case opcodes.OP_ROT: {
        if (stack.length < 3)
          throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

        stack.swap(-3, -2);
        stack.swap(-2, -1);
        break;
      }
      case opcodes.OP_SWAP: {
        if (stack.length < 2)
          throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

        stack.swap(-2, -1);
        break;
      }
      case opcodes.OP_TUCK: {
        if (stack.length < 2)
          throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

        stack.insert(-2, stack.top(-1));
        break;
      }
      case opcodes.OP_SIZE: {
        if (stack.length < 1)
          throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

        stack.push(Script.array(stack.top(-1).length));
        break;
      }
      case opcodes.OP_EQUAL:
      case opcodes.OP_EQUALVERIFY: {
      // case opcodes.OP_NOTEQUAL: // use OP_NUMNOTEQUAL
        if (stack.length < 2)
          throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

        v1 = stack.top(-2);
        v2 = stack.top(-1);

        res = utils.equal(v1, v2);

        // if (op == opcodes.OP_NOTEQUAL)
        //   res = !res;

        stack.pop();
        stack.pop();

        stack.push(res ? STACK_TRUE : STACK_FALSE);

        if (op === opcodes.OP_EQUALVERIFY) {
          if (!res)
            throw new ScriptError('EQUALVERIFY', op, ip);
          stack.pop();
        }

        break;
      }
      case opcodes.OP_1ADD:
      case opcodes.OP_1SUB:
      case opcodes.OP_2MUL:
      case opcodes.OP_2DIV:
      case opcodes.OP_NEGATE:
      case opcodes.OP_ABS:
      case opcodes.OP_NOT:
      case opcodes.OP_0NOTEQUAL: {
        if (stack.length < 1)
          throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

        num = Script.num(stack.top(-1), flags);

        switch (op) {
          case opcodes.OP_1ADD:
            num.iaddn(1);
            break;
          case opcodes.OP_1SUB:
            num.isubn(1);
            break;
          case opcodes.OP_2MUL:
            num.iushln(1);
            break;
          case opcodes.OP_2DIV:
            num.iushrn(1);
            break;
          case opcodes.OP_NEGATE:
            num.ineg();
            break;
          case opcodes.OP_ABS:
            if (num.cmpn(0) < 0)
              num.ineg();
            break;
          case opcodes.OP_NOT:
            num = num.cmpn(0) === 0;
            num = new BN(num ? 1 : 0);
            break;
          case opcodes.OP_0NOTEQUAL:
            num = num.cmpn(0) !== 0;
            num = new BN(num ? 1 : 0);
            break;
          default:
            assert(false, 'Fatal script error.');
            break;
        }

        stack.pop();
        stack.push(Script.array(num));

        break;
      }
      case opcodes.OP_ADD:
      case opcodes.OP_SUB:
      case opcodes.OP_MUL:
      case opcodes.OP_DIV:
      case opcodes.OP_MOD:
      case opcodes.OP_LSHIFT:
      case opcodes.OP_RSHIFT:
      case opcodes.OP_BOOLAND:
      case opcodes.OP_BOOLOR:
      case opcodes.OP_NUMEQUAL:
      case opcodes.OP_NUMEQUALVERIFY:
      case opcodes.OP_NUMNOTEQUAL:
      case opcodes.OP_LESSTHAN:
      case opcodes.OP_GREATERTHAN:
      case opcodes.OP_LESSTHANOREQUAL:
      case opcodes.OP_GREATERTHANOREQUAL:
      case opcodes.OP_MIN:
      case opcodes.OP_MAX: {
        if (stack.length < 2)
          throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

        n1 = Script.num(stack.top(-2), flags);
        n2 = Script.num(stack.top(-1), flags);

        switch (op) {
          case opcodes.OP_ADD:
            num = n1.add(n2);
            break;
          case opcodes.OP_SUB:
            num = n1.sub(n2);
            break;
          case opcodes.OP_MUL:
            num = n1.mul(n2);
            break;
          case opcodes.OP_DIV:
            num = n1.div(n2);
            break;
          case opcodes.OP_MOD:
            num = n1.mod(n2);
            break;
          case opcodes.OP_LSHIFT:
            if (n2.cmpn(0) < 0 || n2.cmpn(2048) > 0)
              throw new ScriptError('UNKNOWN_ERROR', 'Bad shift.');

            num = n1.ushln(n2.toNumber());
            break;
          case opcodes.OP_RSHIFT:
            if (n2.cmpn(0) < 0 || n2.cmpn(2048) > 0)
              throw new ScriptError('UNKNOWN_ERROR', 'Bad shift.');

            num = n1.ushrn(n2.toNumber());
            break;
          case opcodes.OP_BOOLAND:
            num = n1.cmpn(0) !== 0 && n2.cmpn(0) !== 0;
            num = new BN(num ? 1 : 0);
            break;
          case opcodes.OP_BOOLOR:
            num = n1.cmpn(0) !== 0 || n2.cmpn(0) !== 0;
            num = new BN(num ? 1 : 0);
            break;
          case opcodes.OP_NUMEQUAL:
            num = n1.cmp(n2) === 0;
            num = new BN(num ? 1 : 0);
            break;
          case opcodes.OP_NUMEQUALVERIFY:
            num = n1.cmp(n2) === 0;
            num = new BN(num ? 1 : 0);
            break;
          case opcodes.OP_NUMNOTEQUAL:
            num = n1.cmp(n2) !== 0;
            num = new BN(num ? 1 : 0);
            break;
          case opcodes.OP_LESSTHAN:
            num = n1.cmp(n2) < 0;
            num = new BN(num ? 1 : 0);
            break;
          case opcodes.OP_GREATERTHAN:
            num = n1.cmp(n2) > 0;
            num = new BN(num ? 1 : 0);
            break;
          case opcodes.OP_LESSTHANOREQUAL:
            num = n1.cmp(n2) <= 0;
            num = new BN(num ? 1 : 0);
            break;
          case opcodes.OP_GREATERTHANOREQUAL:
            num = n1.cmp(n2) >= 0;
            num = new BN(num ? 1 : 0);
            break;
          case opcodes.OP_MIN:
            num = n1.cmp(n2) < 0 ? n1 : n2;
            break;
          case opcodes.OP_MAX:
            num = n1.cmp(n2) > 0 ? n1 : n2;
            break;
          default:
            assert(false, 'Fatal script error.');
            break;
        }

        stack.pop();
        stack.pop();
        stack.push(Script.array(num));

        if (op === opcodes.OP_NUMEQUALVERIFY) {
          if (!Script.bool(stack.top(-1)))
            throw new ScriptError('NUMEQUALVERIFY', op, ip);
          stack.pop();
        }

        break;
      }
      case opcodes.OP_WITHIN: {
        if (stack.length < 3)
          throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

        n1 = Script.num(stack.top(-3), flags);
        n2 = Script.num(stack.top(-2), flags);
        n3 = Script.num(stack.top(-1), flags);

        val = n2.cmp(n1) <= 0 && n1.cmp(n3) < 0;

        stack.pop();
        stack.pop();
        stack.pop();

        stack.push(val ? STACK_TRUE : STACK_FALSE);
        break;
      }
      case opcodes.OP_RIPEMD160: {
        if (stack.length === 0)
          throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

        stack.push(crypto.ripemd160(stack.pop()));
        break;
      }
      case opcodes.OP_SHA1: {
        if (stack.length === 0)
          throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

        stack.push(crypto.sha1(stack.pop()));
        break;
      }
      case opcodes.OP_SHA256: {
        if (stack.length === 0)
          throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

        stack.push(crypto.sha256(stack.pop()));
        break;
      }
      case opcodes.OP_HASH160: {
        if (stack.length === 0)
          throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

        stack.push(crypto.hash160(stack.pop()));
        break;
      }
      case opcodes.OP_HASH256: {
        if (stack.length === 0)
          throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

        stack.push(crypto.hash256(stack.pop()));
        break;
      }
      case opcodes.OP_CODESEPARATOR: {
        lastSep = ip + 1;
        break;
      }
      case opcodes.OP_CHECKSIG:
      case opcodes.OP_CHECKSIGVERIFY: {
        if (!tx)
          throw new ScriptError('UNKNOWN_ERROR', 'No TX passed in.');

        if (stack.length < 2)
          throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

        sig = stack.top(-2);
        key = stack.top(-1);
        res = false;

        subscript = this.getSubscript(lastSep);

        if (version === 0)
          subscript.removeData(sig);

        Script.validateSignature(sig, flags);
        Script.validateKey(key, flags, version);

        if (sig.length > 0) {
          type = sig[sig.length - 1];
          hash = tx.signatureHash(index, subscript, type, version);
          res = Script.checksig(hash, sig, key, flags);
        }

        if (!res && (flags & constants.flags.VERIFY_NULLFAIL)) {
          if (sig.length !== 0)
            throw new ScriptError('NULLFAIL', op, ip);
        }

        stack.pop();
        stack.pop();

        stack.push(res ? STACK_TRUE : STACK_FALSE);

        if (op === opcodes.OP_CHECKSIGVERIFY) {
          if (!res)
            throw new ScriptError('CHECKSIGVERIFY', op, ip);
          stack.pop();
        }

        break;
      }
      case opcodes.OP_CHECKMULTISIG:
      case opcodes.OP_CHECKMULTISIGVERIFY: {
        if (!tx)
          throw new ScriptError('UNKNOWN_ERROR', 'No TX passed in.');

        i = 1;
        if (stack.length < i)
          throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

        n = Script.num(stack.top(-i), flags).toNumber();
        ikey2 = n + 2;

        if (!(n >= 0 && n <= constants.script.MAX_MULTISIG_PUBKEYS))
          throw new ScriptError('PUBKEY_COUNT', op, ip);

        opCount += n;

        if (opCount > constants.script.MAX_OPS)
          throw new ScriptError('OP_COUNT', op, ip);

        i++;
        ikey = i;
        i += n;

        if (stack.length < i)
          throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

        m = Script.num(stack.top(-i), flags).toNumber();

        if (!(m >= 0 && m <= n))
          throw new ScriptError('SIG_COUNT', op, ip);

        i++;
        isig = i;
        i += m;

        if (stack.length < i)
          throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

        subscript = this.getSubscript(lastSep);

        for (j = 0; j < m; j++) {
          sig = stack.top(-isig - j);
          if (version === 0)
            subscript.removeData(sig);
        }

        res = true;
        while (res && m > 0) {
          sig = stack.top(-isig);
          key = stack.top(-ikey);

          Script.validateSignature(sig, flags);
          Script.validateKey(key, flags, version);

          if (sig.length > 0) {
            type = sig[sig.length - 1];
            hash = tx.signatureHash(index, subscript, type, version);

            if (Script.checksig(hash, sig, key, flags)) {
              isig++;
              m--;
            }
          }

          ikey++;
          n--;

          if (m > n)
            res = false;
        }

        while (i-- > 1) {
          if (!res && (flags & constants.flags.VERIFY_NULLFAIL)) {
            if (ikey2 === 0 && stack.top(-1).length !== 0)
              throw new ScriptError('NULLFAIL', op, ip);
          }
          if (ikey2 > 0)
            ikey2--;
          stack.pop();
        }

        if (stack.length < 1)
          throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

        if (flags & constants.flags.VERIFY_NULLDUMMY) {
          if (!Script.isDummy(stack.top(-1)))
            throw new ScriptError('SIG_NULLDUMMY', op, ip);
        }

        stack.pop();

        stack.push(res ? STACK_TRUE : STACK_FALSE);

        if (op === opcodes.OP_CHECKMULTISIGVERIFY) {
          if (!res)
            throw new ScriptError('CHECKMULTISIGVERIFY', op, ip);
          stack.pop();
        }

        break;
      }
      case opcodes.OP_CAT: {
        if (stack.length < 2)
          throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

        v1 = stack.top(-2);
        v2 = stack.top(-1);

        stack.set(-2, utils.concat(v1, v2));

        stack.pop();

        break;
      }
      case opcodes.OP_SUBSTR: {
        if (stack.length < 3)
          throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

        v1 = stack.top(-3);
        v2 = Script.num(stack.top(-2), flags).toNumber();
        v3 = Script.num(stack.top(-1), flags).toNumber();

        if (v2 < 0 || v3 < v2)
          throw new ScriptError('UNKNOWN_ERROR', 'String out of range.');

        if (v2 > v1.length)
          v2 = v1.length;

        if (v3 > v1.length)
          v3 = v1.length;

        stack.set(-3, v1.slice(v2, v3));
        stack.pop();
        stack.pop();

        break;
      }
      case opcodes.OP_LEFT:
      case opcodes.OP_RIGHT: {
        if (stack.length < 2)
          throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

        v1 = stack.top(-2);
        v2 = Script.num(stack.top(-1), flags).toNumber();

        if (v2 < 0)
          throw new ScriptError('UNKNOWN_ERROR', 'String size out of range.');

        if (v2 > v1.length)
          v2 = v1.length;

        if (op === opcodes.OP_LEFT)
          v1 = v1.slice(0, v2);
        else
          v1 = v1.slice(v1.length - v2);

        stack.set(-2, v1);
        stack.pop();

        break;
      }
      case opcodes.OP_INVERT: {
        if (stack.length < 1)
          throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

        val = utils.copy(stack.top(-1));
        stack.set(-1, val);

        for (i = 0; i < val.length; i++)
          val[i] = ~val[i] & 0xff;

        break;
      }
      case opcodes.OP_AND:
      case opcodes.OP_OR:
      case opcodes.OP_XOR: {
        if (stack.length < 2)
          throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

        v1 = utils.copy(stack.top(-2));
        v2 = stack.top(-1);

        if (v1.length < v2.length) {
          v3 = new Buffer(v2.length);
          v3.fill(0);
          v1.copy(v3, 0);
          v1 = v3;
        }

        if (v2.length < v1.length) {
          v3 = new Buffer(v1.length);
          v3.fill(0);
          v2.copy(v3, 0);
          v2 = v3;
        }

        stack.set(-2, v1);

        if (op === opcodes.OP_AND) {
          for (i = 0; i < v1.length; i++)
            v1[i] &= v2[i];
        } else if (op === opcodes.OP_OR) {
          for (i = 0; i < v1.length; i++)
            v1[i] |= v2[i];
        } else if (op === opcodes.OP_XOR) {
          for (i = 0; i < v1.length; i++)
            v1[i] ^= v2[i];
        }

        stack.pop();

        break;
      }
      default: {
        throw new ScriptError('BAD_OPCODE', op, ip);
      }
    }
  }

  if (stack.length + alt.length > constants.script.MAX_STACK)
    throw new ScriptError('STACK_SIZE', op, ip);

  if (state.length !== 0)
    throw new ScriptError('UNBALANCED_CONDITIONAL', op, ip);

  return true;
};

/**
 * Verify the nLockTime of a transaction.
 * @param {Number} locktime - Locktime to verify against (max=u32).
 * @param {TX} tx - Transaction to verify.
 * @param {Number} index - Index of input being verified (for IsFinal).
 * @returns {Boolean}
 */

Script.checkLocktime = function checkLocktime(locktime, tx, i) {
  var threshold = constants.LOCKTIME_THRESHOLD;

  if (!(
    (tx.locktime < threshold && locktime < threshold)
    || (tx.locktime >= threshold && locktime >= threshold)
  )) {
    return false;
  }

  if (locktime > tx.locktime)
    return false;

  if (tx.inputs[i].sequence === 0xffffffff)
    return false;

  return true;
};

/**
 * Verify the nSequence locktime of a transaction.
 * @param {Number} sequence - Locktime to verify against (max=u32).
 * @param {TX} tx - Transaction to verify.
 * @param {Number} index - Index of input being verified.
 * @returns {Boolean}
 */

Script.checkSequence = function checkSequence(sequence, tx, i) {
  var txSequence = tx.inputs[i].sequence;
  var locktimeMask, txSequenceMasked, sequenceMasked;

  if (tx.version < 2)
    return false;

  if (txSequence & constants.sequence.DISABLE_FLAG)
    return false;

  locktimeMask = constants.sequence.TYPE_FLAG
    | constants.sequence.MASK;
  txSequenceMasked = txSequence & locktimeMask;
  sequenceMasked = sequence & locktimeMask;

  if (!(
    (txSequenceMasked < constants.sequence.TYPE_FLAG
    && sequenceMasked < constants.sequence.TYPE_FLAG)
    || (txSequenceMasked >= constants.sequence.TYPE_FLAG
    && sequenceMasked >= constants.sequence.TYPE_FLAG)
  )) {
    return false;
  }

  if (sequenceMasked > txSequenceMasked)
    return false;

  return true;
};

/**
 * Cast a big number or Buffer to a bool.
 * @see CastToBool
 * @param {BN|Buffer} value
 * @returns {Boolean}
 */

Script.bool = function bool(value) {
  var i;

  assert(Buffer.isBuffer(value));

  for (i = 0; i < value.length; i++) {
    if (value[i] !== 0) {
      // Cannot be negative zero
      if (i === value.length - 1 && value[i] === 0x80)
        return false;
      return true;
    }
  }

  return false;
};

/**
 * Create a CScriptNum.
 * @param {Buffer} value
 * @param {Number?} flags - Script standard flags.
 * @param {Number?} size - Max size in bytes.
 * @returns {BN}
 * @throws {ScriptError}
 */

Script.num = function num(value, flags, size) {
  var result;

  assert(Buffer.isBuffer(value));

  if (flags == null)
    flags = constants.flags.STANDARD_VERIFY_FLAGS;

  if (size == null)
    size = 4;

  if (value.length > size)
    throw new ScriptError('UNKNOWN_ERROR', 'Script number overflow.');

  if ((flags & constants.flags.VERIFY_MINIMALDATA) && value.length > 0) {
    // If the low bits on the last byte are unset,
    // fail if the value's second to last byte does
    // not have the high bit set. A number can't
    // justify having the last byte's low bits unset
    // unless they ran out of space for the sign bit
    // in the second to last bit. We also fail on [0]
    // to avoid negative zero (also avoids positive
    // zero).
    if (!(value[value.length - 1] & 0x7f)) {
      if (value.length === 1 || !(value[value.length - 2] & 0x80)) {
        throw new ScriptError(
          'UNKNOWN_ERROR',
          'Non-minimally encoded Script number.');
      }
    }
  }

  if (value.length === 0)
    return new BN(0);

  result = new BN(value, 'le');

  // If the input vector's most significant byte is
  // 0x80, remove it from the result's msb and return
  // a negative.
  // Equivalent to:
  // -(result & ~(0x80 << (8 * (value.length - 1))))
  if (value[value.length - 1] & 0x80)
    result.setn((value.length * 8) - 1, 0).ineg();

  return result;
};

/**
 * Create a script array. Will convert Numbers and big
 * numbers to a little-endian buffer while taking into
 * account negative zero, minimaldata, etc.
 * @example
 * assert.deepEqual(Script.array(0), new Buffer(0));
 * assert.deepEqual(Script.array(0xffee), new Buffer('eeff00', 'hex'));
 * assert.deepEqual(Script.array(new BN(0xffee)), new Buffer('eeff00', 'hex'));
 * assert.deepEqual(Script.array(new BN(0x1e).ineg()), new Buffer('9e', 'hex'));
 * @param {Number|BN} value
 * @returns {Buffer}
 */

Script.array = function(value) {
  var neg, result;

  if (utils.isNumber(value))
    value = new BN(value);

  assert(BN.isBN(value));

  if (value.cmpn(0) === 0)
    return STACK_FALSE;

  // If the most significant byte is >= 0x80
  // and the value is positive, push a new
  // zero-byte to make the significant
  // byte < 0x80 again.

  // If the most significant byte is >= 0x80
  // and the value is negative, push a new
  // 0x80 byte that will be popped off when
  // converting to an integral.

  // If the most significant byte is < 0x80
  // and the value is negative, add 0x80 to
  // it, since it will be subtracted and
  // interpreted as a negative when
  // converting to an integral.

  neg = value.cmpn(0) < 0;
  result = value.toArray('le');

  if (result[result.length - 1] & 0x80)
    result.push(neg ? 0x80 : 0);
  else if (neg)
    result[result.length - 1] |= 0x80;

  return new Buffer(result);
};

/**
 * Remove all matched data elements from
 * a script's code (used to remove signatures
 * before verification). Note that this
 * compares and removes data on the _byte level_.
 * It also reserializes the data to a single
 * script with minimaldata encoding beforehand.
 * A signature will _not_ be removed if it is
 * not minimaldata.
 * @see https://lists.linuxfoundation.org/pipermail/bitcoin-dev/2014-November/006878.html
 * @see https://test.webbtc.com/tx/19aa42fee0fa57c45d3b16488198b27caaacc4ff5794510d0c17f173f05587ff
 * @param {Buffer} data - Data element to match against.
 * @returns {Number} Total.
 */

Script.prototype.removeData = function removeData(data) {
  var index = [];
  var i, op;

  // We need to go forward first. We can't go
  // backwards (this is consensus code and we
  // need to be aware of bad pushes).
  for (i = 0; i < this.code.length; i++) {
    op = this.code[i];

    if (op.value === -1) {
      // Can't reserialize
      // a parse error.
      if (index.length > 0)
        index.push(i);
      break;
    }

    if (!op.data)
      continue;

    if (!Script.isMinimal(op.data, op.value))
      continue;

    if (utils.equal(op.data, data))
      index.push(i);
  }

  if (index.length === 0)
    return 0;

  // Go backwards and splice out the data.
  for (i = index.length - 1; i >= 0; i--)
    this.code.splice(index[i], 1);

  this.raw = Script.encode(this.code);

  return index.length;
};

/**
 * Find a data element in a script.
 * @param {Buffer} data - Data element to match against.
 * @returns {Number} Index (`-1` if not present).
 */

Script.prototype.indexOf = function indexOf(data) {
  var i, op;

  for (i = 0; i < this.code.length; i++) {
    op = this.code[i];

    if (op.value === -1)
      break;

    if (!op.data)
      continue;

    if (utils.equal(op.data, data))
      return i;
  }

  return -1;
};

/**
 * Check to see if a pushdata Buffer abides by minimaldata.
 * @param {Buffer} data
 * @param {Number} opcode
 * @param {Number?} flags
 * @returns {Boolean}
 */

Script.isMinimal = function isMinimal(data, opcode, flags) {
  if (flags == null)
    flags = constants.flags.STANDARD_VERIFY_FLAGS;

  if (!(flags & constants.flags.VERIFY_MINIMALDATA))
    return true;

  if (!data)
    return true;

  if (data.length === 0)
    return opcode === opcodes.OP_0;

  if (data.length === 1 && data[0] >= 1 && data[0] <= 16)
    return false;

  if (data.length === 1 && data[0] === 0x81)
    return false;

  if (data.length <= 75)
    return opcode === data.length;

  if (data.length <= 255)
    return opcode === opcodes.OP_PUSHDATA1;

  if (data.length <= 65535)
    return opcode === opcodes.OP_PUSHDATA2;

  return true;
};

/**
 * Test a buffer to see if it is valid
 * script code (no non-existent opcodes).
 * @param {Buffer} raw
 * @returns {Boolean}
 */

Script.isCode = function isCode(raw) {
  var i, op, code;

  assert(Buffer.isBuffer(raw));

  code = Script.decode(raw);

  for (i = 0; i < code.length; i++) {
    op = code[i];

    if (op.data)
      continue;

    if (op.value === -1)
      return false;

    if (op.value > opcodes.OP_NOP10)
      return false;
  }

  return true;
};

/**
 * Inject properties from a pay-to-pubkey script.
 * @private
 * @param {Buffer} key
 */

Script.prototype.fromPubkey = function fromPubkey(key) {
  assert(Buffer.isBuffer(key) && key.length >= 33);
  this.push(key);
  this.push(opcodes.OP_CHECKSIG);
  this.compile();
  return this;
};

/**
 * Create a pay-to-pubkey script.
 * @param {Buffer} key
 * @returns {Script}
 */

Script.fromPubkey = function fromPubkey(key) {
  return new Script().fromPubkey(key);
};

/**
 * Inject properties from a pay-to-pubkeyhash script.
 * @private
 * @param {Buffer} hash
 */

Script.prototype.fromPubkeyhash = function fromPubkeyhash(hash) {
  assert(Buffer.isBuffer(hash) && hash.length === 20);

  this.raw = new Buffer(25);
  this.raw[0] = opcodes.OP_DUP;
  this.raw[1] = opcodes.OP_HASH160;
  this.raw[2] = 0x14;
  hash.copy(this.raw, 3);
  this.raw[23] = opcodes.OP_EQUALVERIFY;
  this.raw[24] = opcodes.OP_CHECKSIG;

  hash = this.raw.slice(3, 23);

  this.code.push(new Opcode(opcodes.OP_DUP));
  this.code.push(new Opcode(opcodes.OP_HASH160));
  this.code.push(new Opcode(0x14, hash));
  this.code.push(new Opcode(opcodes.OP_EQUALVERIFY));
  this.code.push(new Opcode(opcodes.OP_CHECKSIG));

  return this;
};

/**
 * Create a pay-to-pubkeyhash script.
 * @param {Buffer} hash
 * @returns {Script}
 */

Script.fromPubkeyhash = function fromPubkeyhash(hash) {
  return new Script().fromPubkeyhash(hash);
};

/**
 * Inject properties from pay-to-multisig script.
 * @private
 * @param {Number} m
 * @param {Number} n
 * @param {Buffer[]} keys
 */

Script.prototype.fromMultisig = function fromMultisig(m, n, keys) {
  var i;

  assert(utils.isNumber(m) && utils.isNumber(n));
  assert(Array.isArray(keys));
  assert(keys.length === n, '`n` keys are required for multisig.');
  assert(m >= 1 && m <= n);
  assert(n >= 1 && n <= 15);

  keys = utils.sortKeys(keys);

  this.push(Opcode.fromSmall(m));

  for (i = 0; i < keys.length; i++)
    this.push(keys[i]);

  this.push(Opcode.fromSmall(n));
  this.push(opcodes.OP_CHECKMULTISIG);

  this.compile();

  return this;
};

/**
 * Create a pay-to-multisig script.
 * @param {Number} m
 * @param {Number} n
 * @param {Buffer[]} keys
 * @returns {Script}
 */

Script.fromMultisig = function fromMultisig(m, n, keys) {
  return new Script().fromMultisig(m, n, keys);
};

/**
 * Inject properties from a pay-to-scripthash script.
 * @private
 * @param {Buffer} hash
 */

Script.prototype.fromScripthash = function fromScripthash(hash) {
  assert(Buffer.isBuffer(hash) && hash.length === 20);

  this.raw = new Buffer(23);
  this.raw[0] = opcodes.OP_HASH160;
  this.raw[1] = 0x14;
  hash.copy(this.raw, 2);
  this.raw[22] = opcodes.OP_EQUAL;

  hash = this.raw.slice(2, 22);

  this.code.push(new Opcode(opcodes.OP_HASH160));
  this.code.push(new Opcode(0x14, hash));
  this.code.push(new Opcode(opcodes.OP_EQUAL));

  return this;
};

/**
 * Create a pay-to-scripthash script.
 * @param {Buffer} hash
 * @returns {Script}
 */

Script.fromScripthash = function fromScripthash(hash) {
  return new Script().fromScripthash(hash);
};

/**
 * Inject properties from a nulldata/opreturn script.
 * @private
 * @param {Buffer} flags
 */

Script.prototype.fromNulldata = function fromNulldata(flags) {
  assert(Buffer.isBuffer(flags));
  assert(flags.length <= constants.script.MAX_OP_RETURN, 'Nulldata too large.');
  this.push(opcodes.OP_RETURN);
  this.push(flags);
  this.compile();
  return this;
};

/**
 * Create a nulldata/opreturn script.
 * @param {Buffer} flags
 * @returns {Script}
 */

Script.fromNulldata = function fromNulldata(flags) {
  return new Script().fromNulldata(flags);
};

/**
 * Inject properties from a witness program.
 * @private
 * @param {Number} version
 * @param {Buffer} data
 */

Script.prototype.fromProgram = function fromProgram(version, data) {
  assert(utils.isNumber(version) && version >= 0 && version <= 16);
  assert(Buffer.isBuffer(data) && data.length >= 2 && data.length <= 40);
  this.push(Opcode.fromSmall(version));
  this.push(data);
  this.compile();
  return this;
};

/**
 * Create a witness program.
 * @param {Number} version
 * @param {Buffer} data
 * @returns {Script}
 */

Script.fromProgram = function fromProgram(version, data) {
  return new Script().fromProgram(version, data);
};

/**
 * Inject properties from an address.
 * @private
 * @param {Address|Base58Address} address
 */

Script.prototype.fromAddress = function fromAddress(address) {
  if (typeof address === 'string')
    address = Address.fromBase58(address);

  assert(address instanceof Address, 'Not an address.');

  if (address.type === scriptTypes.PUBKEYHASH)
    return this.fromPubkeyhash(address.hash);

  if (address.type === scriptTypes.SCRIPTHASH)
    return this.fromScripthash(address.hash);

  if (address.version !== -1)
    return this.fromProgram(address.version, address.hash);

  throw new Error('Unknown address type.');
};

/**
 * Create an output script from an address.
 * @param {Address|Base58Address} address
 * @returns {Script}
 */

Script.fromAddress = function fromAddress(address) {
  return new Script().fromAddress(address);
};

/**
 * Inject properties from a witness block commitment.
 * @private
 * @param {Buffer} hash
 * @param {String|Buffer} flags
 */

Script.prototype.fromCommitment = function fromCommitment(hash, flags) {
  var p = new BufferWriter();
  p.writeU32BE(0xaa21a9ed);
  p.writeHash(hash);

  this.push(opcodes.OP_RETURN);
  this.push(p.render());

  if (flags)
    this.push(flags);

  this.compile();

  return this;
};

/**
 * Create a witness block commitment.
 * @param {Buffer} hash
 * @param {String|Buffer} flags
 * @returns {Script}
 */

Script.fromCommitment = function fromCommitment(hash, flags) {
  return new Script().fromCommitment(hash, flags);
};

/**
 * Grab and deserialize the redeem script.
 * @returns {Script|null} Redeem script.
 */

Script.prototype.getRedeem = function getRedeem() {
  var redeem;

  if (!this.isPushOnly())
    return;

  redeem = this.code[this.code.length - 1];

  if (!redeem || !redeem.data)
    return;

  return new Script(redeem.data);
};

/**
 * Get the standard script type.
 * @returns {ScriptType}
 */

Script.prototype.getType = function getType() {
  if (this.isPubkey())
    return scriptTypes.PUBKEY;

  if (this.isPubkeyhash())
    return scriptTypes.PUBKEYHASH;

  if (this.isScripthash())
    return scriptTypes.SCRIPTHASH;

  if (this.isWitnessPubkeyhash())
    return scriptTypes.WITNESSPUBKEYHASH;

  if (this.isWitnessScripthash())
    return scriptTypes.WITNESSSCRIPTHASH;

  if (this.isWitnessMasthash())
    return scriptTypes.WITNESSMASTHASH;

  if (this.isMultisig())
    return scriptTypes.MULTISIG;

  if (this.isNulldata())
    return scriptTypes.NULLDATA;

  return scriptTypes.NONSTANDARD;
};

/**
 * Test whether a script is of an unknown/non-standard type.
 * @returns {Boolean}
 */

Script.prototype.isUnknown = function isUnknown() {
  return this.getType() === scriptTypes.NONSTANDARD;
};

/**
 * Test whether the script is standard by policy standards.
 * @returns {Boolean}
 */

Script.prototype.isStandard = function isStandard() {
  var type = this.getType();
  var m, n;

  switch (type) {
    case scriptTypes.MULTISIG:
      m = this.getSmall(0);
      n = this.getSmall(this.code.length - 2);

      if (n < 1 || n > 3)
        return false;

      if (m < 1 || m > n)
        return false;

      return true;
    case scriptTypes.NULLDATA:
      if (this.raw.length > constants.script.MAX_OP_RETURN_BYTES)
        return false;
      return true;
    default:
      return type !== scriptTypes.NONSTANDARD;
  }
};

/**
 * Calculate size of script excluding the varint size bytes.
 * @returns {Number}
 */

Script.prototype.getSize = function getSize() {
  return this.raw.length;
};

/**
 * "Guess" the address of the input script.
 * This method is not 100% reliable.
 * @returns {Address|null}
 */

Script.prototype.getInputAddress = function getInputAddress() {
  return Address.fromInputScript(this);
};

/**
 * Get the address of the script if present. Note that
 * pubkey and multisig scripts will be treated as though
 * they are pubkeyhash and scripthashes respectively.
 * @returns {Address|null}
 */

Script.prototype.getAddress = function getAddress() {
  return Address.fromScript(this);
};

/**
 * Get the hash160 of the raw script.
 * @param {Buffer}
 */

Script.prototype.hash160 = function hash160(enc) {
  var hash = crypto.hash160(this.toRaw());
  if (enc === 'hex')
    hash = hash.toString('hex');
  return hash;
};

/**
 * Get the sha256 of the raw script.
 * @param {Buffer}
 */

Script.prototype.sha256 = function sha256(enc) {
  var hash = crypto.sha256(this.toRaw());
  if (enc === 'hex')
    hash = hash.toString('hex');
  return hash;
};

/**
 * Test whether the output script is pay-to-pubkey.
 * @param {Boolean} [minimal=false] - Minimaldata only.
 * @returns {Boolean}
 */

Script.prototype.isPubkey = function isPubkey(minimal) {
  if (minimal) {
    return this.raw.length >= 35
      && this.raw[0] >= 33 && this.raw[0] <= 65
      && this.raw[0] + 2 === this.raw.length
      && this.raw[this.raw.length - 1] === opcodes.OP_CHECKSIG;
  }

  return this.code.length === 2
    && Script.isKey(this.code[0].data)
    && this.code[1].value === opcodes.OP_CHECKSIG;
};

/**
 * Test whether the output script is pay-to-pubkeyhash.
 * @param {Boolean} [minimal=false] - Minimaldata only.
 * @returns {Boolean}
 */

Script.prototype.isPubkeyhash = function isPubkeyhash(minimal) {
  if (minimal) {
    return this.raw.length === 25
      && this.raw[0] === opcodes.OP_DUP
      && this.raw[1] === opcodes.OP_HASH160
      && this.raw[2] === 0x14
      && this.raw[23] === opcodes.OP_EQUALVERIFY
      && this.raw[24] === opcodes.OP_CHECKSIG;
  }

  return this.code.length === 5
    && this.code[0].value === opcodes.OP_DUP
    && this.code[1].value === opcodes.OP_HASH160
    && Script.isHash(this.code[2].data)
    && this.code[3].value === opcodes.OP_EQUALVERIFY
    && this.code[4].value === opcodes.OP_CHECKSIG;
};

/**
 * Test whether the output script is pay-to-multisig.
 * @param {Boolean} [minimal=false] - Minimaldata only.
 * @returns {Boolean}
 */

Script.prototype.isMultisig = function isMultisig(minimal) {
  var m, n, i, op;

  if (this.raw.length < 41)
    return false;

  if (this.raw[this.raw.length - 1] !== opcodes.OP_CHECKMULTISIG)
    return false;

  n = Script.getSmall(this.raw[this.raw.length - 2]);

  if (n < 1)
    return false;

  m = Script.getSmall(this.raw[0]);

  if (!(m >= 1 && m <= n))
    return false;

  if (n + 3 !== this.code.length)
    return false;

  for (i = 1; i < n + 1; i++) {
    op = this.code[i];

    if (!Script.isKey(op.data))
      return false;

    if (minimal) {
      if (!Script.isMinimal(op.data, op.value))
        return false;
    }
  }

  return true;
};

/**
 * Test whether the output script is pay-to-scripthash. Note that
 * bitcoin itself requires scripthashes to be in strict minimaldata
 * encoding. Using `OP_HASH160 OP_PUSHDATA1 [hash] OP_EQUAL` will
 * _not_ be recognized as a scripthash.
 * @returns {Boolean}
 */

Script.prototype.isScripthash = function isScripthash() {
  return this.raw.length === 23
    && this.raw[0] === opcodes.OP_HASH160
    && this.raw[1] === 0x14
    && this.raw[22] === opcodes.OP_EQUAL;
};

/**
 * Test whether the output script is nulldata/opreturn.
 * @param {Boolean} [minimal=false] - Minimaldata only.
 * @returns {Boolean}
 */

Script.prototype.isNulldata = function isNulldata(minimal) {
  var i, op;

  if (this.raw.length === 0)
    return false;

  if (this.raw[0] !== opcodes.OP_RETURN)
    return false;

  if (this.raw.length === 1)
    return true;

  if (minimal) {
    if (this.raw.length > constants.script.MAX_OP_RETURN_BYTES)
      return false;

    if (this.raw.length === 2)
      return Script.getSmall(this.raw[1]) !== -1;

    if (this.raw[1] >= 0x01 && this.raw[1] <= 0x4b)
      return this.raw[1] + 2 === this.raw.length;

    if (this.raw[1] === opcodes.OP_PUSHDATA1)
      return this.raw[2] > 75 && this.raw[2] + 3 === this.raw.length;

    return false;
  }

  for (i = 1; i < this.code.length; i++) {
    op = this.code[i];

    if (op.data)
      continue;

    if (op.value === -1)
      return false;

    if (op.value > opcodes.OP_16)
      return false;
  }

  return true;
};

/**
 * Test whether the output script is a segregated witness
 * commitment.
 * @returns {Boolean}
 */

Script.prototype.isCommitment = function isCommitment() {
  return this.raw.length >= 38
    && this.raw[0] === opcodes.OP_RETURN
    && this.raw[1] === 0x24
    && this.raw.readUInt32BE(2, true) === 0xaa21a9ed;
};

/**
 * Get the commitment hash if present.
 * @returns {Buffer|null}
 */

Script.prototype.getCommitmentHash = function getCommitmentHash() {
  if (!this.isCommitment())
    return;

  return this.raw.slice(6, 38);
};

/**
 * Test whether the output script is a witness program.
 * Note that this will return true even for malformed
 * witness v0 programs.
 * @return {Boolean}
 */

Script.prototype.isProgram = function isProgram() {
  if (!(this.raw.length >= 4 && this.raw.length <= 42))
    return false;

  if (this.raw[0] !== opcodes.OP_0
      && !(this.raw[0] >= opcodes.OP_1 && this.raw[0] <= opcodes.OP_16)) {
    return false;
  }

  if (this.raw[1] + 2 !== this.raw.length)
    return false;

  return true;
};

/**
 * Get the witness program if present.
 * @returns {Program|null}
 */

Script.prototype.toProgram = function toProgram() {
  var version, data;

  if (!this.isProgram())
    return;

  version = Script.getSmall(this.raw[0]);
  data = this.raw.slice(2);

  return new Program(version, data);
};

/**
 * Get the script to the equivalent witness
 * program (mimics bitcoind's scriptForWitness).
 * @returns {Program|null}
 */

Script.prototype.forWitness = function() {
  var hash;

  if (this.isProgram())
    return this;

  if (this.isPubkey()) {
    hash = crypto.hash160(this.get(0));
    return Script.fromProgram(0, hash);
  }

  if (this.isPubkeyhash())
    return Script.fromProgram(0, this.get(2));

  return Script.fromProgram(0, this.sha256());
};

/**
 * Test whether the output script is
 * a pay-to-witness-pubkeyhash program.
 * @returns {Boolean}
 */

Script.prototype.isWitnessPubkeyhash = function isWitnessPubkeyhash() {
  return this.raw.length === 22
    && this.raw[0] === opcodes.OP_0
    && this.raw[1] === 0x14;
};

/**
 * Test whether the output script is
 * a pay-to-witness-scripthash program.
 * @returns {Boolean}
 */

Script.prototype.isWitnessScripthash = function isWitnessScripthash() {
  return this.raw.length === 34
    && this.raw[0] === opcodes.OP_0
    && this.raw[1] === 0x20;
};

/**
 * Test whether the output script
 * is a pay-to-mast program.
 * @returns {Boolean}
 */

Script.prototype.isWitnessMasthash = function isWitnessMasthash() {
  return this.raw.length === 34
    && this.raw[0] === opcodes.OP_1
    && this.raw[1] === 0x20;
};

/**
 * Test whether the output script is unspendable.
 * @returns {Boolean}
 */

Script.prototype.isUnspendable = function isUnspendable() {
  return this.raw.length > 0 && this.raw[0] === opcodes.OP_RETURN;
};

/**
 * "Guess" the type of the input script.
 * This method is not 100% reliable.
 * @returns {ScriptType}
 */

Script.prototype.getInputType = function getInputType() {
  if (this.isPubkeyInput())
    return scriptTypes.PUBKEY;

  if (this.isPubkeyhashInput())
    return scriptTypes.PUBKEYHASH;

  if (this.isScripthashInput())
    return scriptTypes.SCRIPTHASH;

  if (this.isMultisigInput())
    return scriptTypes.MULTISIG;

  return scriptTypes.NONSTANDARD;
};

/**
 * "Guess" whether the input script is an unknown/non-standard type.
 * This method is not 100% reliable.
 * @returns {Boolean}
 */

Script.prototype.isUnknownInput = function isUnknownInput() {
  return this.getInputType() === scriptTypes.NONSTANDARD;
};

/**
 * "Guess" whether the input script is pay-to-pubkey.
 * This method is not 100% reliable.
 * @returns {Boolean}
 */

Script.prototype.isPubkeyInput = function isPubkeyInput() {
  if (this.raw.length < 10)
    return false;

  if (this.raw.length > 78)
    return false;

  if (this.raw[0] > opcodes.OP_PUSHDATA4)
    return false;

  return this.code.length === 1 && Script.isSignature(this.code[0].data);
};

/**
 * "Guess" whether the input script is pay-to-pubkeyhash.
 * This method is not 100% reliable.
 * @returns {Boolean}
 */

Script.prototype.isPubkeyhashInput = function isPubkeyhashInput() {
  if (this.raw.length < 44)
    return false;

  if (this.raw.length > 148)
    return false;

  if (this.raw[0] > opcodes.OP_PUSHDATA4)
    return false;

  return this.code.length === 2
    && Script.isSignature(this.code[0].data)
    && Script.isKey(this.code[1].data);
};

/**
 * "Guess" whether the input script is pay-to-multisig.
 * This method is not 100% reliable.
 * @returns {Boolean}
 */

Script.prototype.isMultisigInput = function isMultisigInput() {
  var i;

  if (this.raw.length < 20)
    return false;

  if (this.raw[0] !== opcodes.OP_0)
    return false;

  if (this.raw[1] > opcodes.OP_PUSHDATA4)
    return false;

  // We need to rule out scripthash
  // because it may look like multisig.
  if (this.isScripthashInput())
    return false;

  if (this.code.length < 3)
    return false;

  for (i = 1; i < this.code.length; i++) {
    if (!Script.isSignature(this.code[i].data))
      return false;
  }

  return true;
};

/**
 * "Guess" whether the input script is pay-to-scripthash.
 * This method is not 100% reliable.
 * @returns {Boolean}
 */

Script.prototype.isScripthashInput = function isScripthashInput() {
  var op;

  if (this.raw.length < 2)
    return false;

  // Grab the raw redeem script.
  op = this.code[this.code.length - 1];

  // Last data element should be an array
  // for the redeem script.
  if (!op.data)
    return false;

  // Testing for scripthash inputs requires
  // some evil magic to work. We do it by
  // ruling things _out_. This test will not
  // be correct 100% of the time. We rule
  // out that the last data element is: a
  // null dummy, a valid signature, a valid
  // key, and we ensure that it is at least
  // a script that does not use undefined
  // opcodes.
  if (Script.isDummy(op.data))
    return false;

  if (Script.isSignatureEncoding(op.data))
    return false;

  if (Script.isKeyEncoding(op.data))
    return false;

  if (!Script.isCode(op.data))
    return false;

  return true;
};

/**
 * Get coinbase height.
 * @returns {Number} `-1` if not present.
 */

Script.prototype.getCoinbaseHeight = function getCoinbaseHeight() {
  return Script.getCoinbaseHeight(this.raw);
};

/**
 * Get coinbase height.
 * @param {Buffer} raw - Raw script.
 * @returns {Number} `-1` if not present.
 */

Script.getCoinbaseHeight = function getCoinbaseHeight(raw) {
  var flags = constants.flags.STANDARD_VERIFY_FLAGS;
  var data, height, op;

  if (raw.length === 0)
    return -1;

  // Small ints are allowed.
  height = Script.getSmall(raw[0]);

  if (height !== -1)
    return height;

  // No more than 6 bytes (we can't
  // handle 7 byte JS numbers and
  // height 281 trillion is far away).
  if (raw[0] > 0x06)
    return -1;

  // No bad pushes allowed.
  if (raw.length < 1 + raw[0])
    return -1;

  data = raw.slice(1, 1 + raw[0]);

  // Deserialize the height.
  try {
    height = Script.num(data, flags, 6);
  } catch (e) {
    return -1;
  }

  // Reserialize the height.
  op = Opcode.fromNumber(height);

  // Should have been OP_0-OP_16.
  if (!op.data)
    return -1;

  // Ensure the miner serialized the
  // number in the most minimal fashion.
  if (!utils.equal(data, op.data))
    return -1;

  return height.toNumber();
};

/**
 * Get info about a coinbase script.
 * @returns {Object} Object containing `height`,
 * `nonce`, `flags`, and `text`.
 */

Script.prototype.getCoinbaseFlags = function getCoinbaseFlags() {
  var height = this.getCoinbaseHeight();
  var index = 0;
  var nonce, flags, text;

  if (height !== -1)
    index++;

  nonce = this.getNumber(1);

  if (nonce)
    nonce = nonce.toNumber();
  else
    nonce = -1;

  flags = Script.encode(this.code.slice(index));

  text = flags.toString('utf8');
  text = text.replace(/[\u0000-\u0019\u007f-\u00ff]/g, '');

  return {
    height: height,
    nonce: nonce,
    flags: flags,
    text: text
  };
};

/**
 * Test the script against a bloom filter.
 * @param {Bloom} filter
 * @returns {Boolean}
 */

Script.prototype.test = function test(filter) {
  var i, op;

  for (i = 0; i < this.code.length; i++) {
    op = this.code[i];

    if (op.value === -1)
      break;

    if (!op.data || op.data.length === 0)
      continue;

    if (filter.test(op.data))
      return true;
  }

  return false;
};

/**
 * Unshift an item onto the `code` array.
 * @param {Number|String|BN|Buffer} data
 * @returns {Number} Length.
 */

Script.prototype.unshift = function unshift(data) {
  return this.code.unshift(Opcode.from(data));
};

/**
 * Push an item onto the `code` array.
 * @param {Number|String|BN|Buffer} data
 * @returns {Number} Length.
 */

Script.prototype.push = function push(data) {
  return this.code.push(Opcode.from(data));
};

/**
 * Shift an item off of the `code` array.
 * @returns {Buffer|Number}
 */

Script.prototype.shift = function shift() {
  var op = this.code.shift();
  if (!op)
    return;
  return op.data || op.value;
};

/**
 * Pop an item off of the `code` array.
 * @returns {Buffer|Number}
 */

Script.prototype.pop = function push(data) {
  var op = this.code.pop();
  if (!op)
    return;
  return op.data || op.value;
};

/**
 * Remove an item from the `code` array.
 * @param {Number} index
 * @returns {Buffer|Number}
 */

Script.prototype.remove = function remove(i) {
  var op = this.code.splice(i, 1)[0];
  if (!op)
    return;
  return op.data || op.value;
};

/**
 * Insert an item into the `code` array.
 * @param {Number} index
 * @param {Number|String|BN|Buffer} data
 */

Script.prototype.insert = function insert(i, data) {
  assert(i <= this.code.length, 'Index out of bounds.');
  this.code.splice(i, 0, Opcode.from(data))[0];
};

/**
 * Get an item from the `code` array.
 * @param {Number} index
 * @returns {Buffer|Number}
 */

Script.prototype.get = function get(i) {
  var op = this.code[i];
  if (!op)
    return;
  return op.data || op.value;
};

/**
 * Get a small integer from an opcode (OP_0-OP_16).
 * @param {Number} index
 * @returns {Number}
 */

Script.prototype.getSmall = function getSmall(i) {
  var op = this.code[i];
  if (!op)
    return -1;
  return Script.getSmall(op.value);
};

/**
 * Get a number from the `code` array (5-byte limit).
 * @params {Number} index
 * @returns {BN}
 */

Script.prototype.getNumber = function getNumber(i) {
  var small = this.getSmall(i);
  var op = this.code[i];

  if (small !== -1)
    return new BN(small);

  if (!op || !op.data || op.data.length > 5)
    return;

  return Script.num(op.data, constants.flags.VERIFY_NONE, 5);
};

/**
 * Get a string from the `code` array (utf8).
 * @params {Number} index
 * @returns {String}
 */

Script.prototype.getString = function getString(i) {
  var op = this.code[i];
  if (!op || !op.data)
    return;
  return op.data.toString('utf8');
};

/**
 * Clear the script code.
 */

Script.prototype.clear = function clear() {
  this.code.length = 0;
};

/**
 * Set an item in the `code` array.
 * @param {Number} index
 * @param {Buffer|Number|String|BN} data
 */

Script.prototype.set = function set(i, data) {
  assert(i <= this.code.length, 'Index out of bounds.');
  this.code[i] = Opcode.from(data);
};

/**
 * Test whether the data element is a ripemd160 hash.
 * @param {Buffer?} hash
 * @returns {Boolean}
 */

Script.isHash = function isHash(hash) {
  return Buffer.isBuffer(hash) && hash.length === 20;
};

/**
 * Test whether the data element is a public key. Note that
 * this does not verify the format of the key, only the length.
 * @param {Buffer?} key
 * @returns {Boolean}
 */

Script.isKey = function isKey(key) {
  return Buffer.isBuffer(key) && key.length >= 33 && key.length <= 65;
};

/**
 * Test whether the data element is a signature. Note that
 * this does not verify the format of the signature, only the length.
 * @param {Buffer?} sig
 * @returns {Boolean}
 */

Script.isSignature = function isSignature(sig) {
  return Buffer.isBuffer(sig) && sig.length >= 9 && sig.length <= 73;
};

/**
 * Test whether the data element is a null dummy (a zero-length array).
 * @param {Buffer?} data
 * @returns {Boolean}
 */

Script.isDummy = function isDummy(data) {
  return Buffer.isBuffer(data) && data.length === 0;
};

/**
 * Test whether the data element is a valid key if VERIFY_STRICTENC is enabled.
 * @param {Buffer} key
 * @param {VerifyFlags?} flags
 * @returns {Boolean}
 * @throws {ScriptError}
 */

Script.validateKey = function validateKey(key, flags, version) {
  if (flags == null)
    flags = constants.flags.STANDARD_VERIFY_FLAGS;

  assert(Buffer.isBuffer(key));

  if (flags & constants.flags.VERIFY_STRICTENC) {
    if (!Script.isKeyEncoding(key))
      throw new ScriptError('PUBKEYTYPE');
  }

  if (version === 1) {
    if (flags & constants.flags.VERIFY_WITNESS_PUBKEYTYPE) {
      if (!Script.isCompressedEncoding(key))
        throw new ScriptError('WITNESS_PUBKEYTYPE');
    }
  }

  return true;
};

/**
 * Test whether the data element is a compressed key.
 * @param {Buffer} key
 * @returns {Boolean}
 */

Script.isCompressedEncoding = function isCompressedEncoding(key) {
  assert(Buffer.isBuffer(key));

  if (key.length !== 33)
    return false;

  if (key[0] !== 0x02 && key[0] !== 0x03)
    return false;

  return true;
};

/**
 * Test whether the data element is a valid key.
 * @param {Buffer} key
 * @returns {Boolean}
 */

Script.isKeyEncoding = function isKeyEncoding(key) {
  assert(Buffer.isBuffer(key));

  if (key.length < 33)
    return false;

  if (key[0] === 0x04) {
    if (key.length !== 65)
      return false;
  } else if (key[0] === 0x02 || key[0] === 0x03) {
    if (key.length !== 33)
      return false;
  } else {
    return false;
  }

  return true;
};

/**
 * Test whether the data element is a valid signature based
 * on the encoding, S value, and sighash type. Requires
 * VERIFY_DERSIG|VERIFY_LOW_S|VERIFY_STRICTENC, VERIFY_LOW_S
 * and VERIFY_STRING_ENC to be enabled respectively. Note that
 * this will allow zero-length signatures.
 * @param {Buffer} sig
 * @param {VerifyFlags?} flags
 * @returns {Boolean}
 * @throws {ScriptError}
 */

Script.validateSignature = function validateSignature(sig, flags) {
  if (flags == null)
    flags = constants.flags.STANDARD_VERIFY_FLAGS;

  assert(Buffer.isBuffer(sig));

  // Allow empty sigs
  if (sig.length === 0)
    return true;

  if ((flags & constants.flags.VERIFY_DERSIG)
      || (flags & constants.flags.VERIFY_LOW_S)
      || (flags & constants.flags.VERIFY_STRICTENC)) {
    if (!Script.isSignatureEncoding(sig))
      throw new ScriptError('SIG_DER');
  }

  if (flags & constants.flags.VERIFY_LOW_S) {
    if (!Script.isLowDER(sig))
      throw new ScriptError('SIG_HIGH_S');
  }

  if (flags & constants.flags.VERIFY_STRICTENC) {
    if (!Script.isHashType(sig))
      throw new ScriptError('SIG_HASHTYPE');
  }

  return true;
};

/**
 * Test a signature to see if it abides by BIP66.
 * @see https://github.com/bitcoin/bips/blob/master/bip-0066.mediawiki
 * @param {Buffer} sig
 * @returns {Boolean}
 */

Script.isSignatureEncoding = function isSignatureEncoding(sig) {
  var lenR, lenS;

  assert(Buffer.isBuffer(sig));

  // Format: 0x30 [total-length] 0x02 [R-length] [R] 0x02 [S-length] [S] [sighash]
  // * total-length: 1-byte length descriptor of everything that follows,
  //   excluding the sighash byte.
  // * R-length: 1-byte length descriptor of the R value that follows.
  // * R: arbitrary-length big-endian encoded R value. It must use the shortest
  //   possible encoding for a positive integers (which means no null bytes at
  //   the start, except a single one when the next byte has its highest bit set).
  // * S-length: 1-byte length descriptor of the S value that follows.
  // * S: arbitrary-length big-endian encoded S value. The same rules apply.
  // * sighash: 1-byte value indicating what data is hashed (not part of the DER
  //   signature)

  // Minimum and maximum size constraints.
  if (sig.length < 9)
    return false;

  if (sig.length > 73)
    return false;

  // A signature is of type 0x30 (compound).
  if (sig[0] !== 0x30)
    return false;

  // Make sure the length covers the entire signature.
  if (sig[1] !== sig.length - 3)
    return false;

  // Extract the length of the R element.
  lenR = sig[3];

  // Make sure the length of the S element is still inside the signature.
  if (5 + lenR >= sig.length)
    return false;

  // Extract the length of the S element.
  lenS = sig[5 + lenR];

  // Verify that the length of the signature matches the sum of the length
  // of the elements.
  if (lenR + lenS + 7 !== sig.length)
    return false;

  // Check whether the R element is an integer.
  if (sig[2] !== 0x02)
    return false;

  // Zero-length integers are not allowed for R.
  if (lenR === 0)
    return false;

  // Negative numbers are not allowed for R.
  if (sig[4] & 0x80)
    return false;

  // Null bytes at the start of R are not allowed, unless R would
  // otherwise be interpreted as a negative number.
  if (lenR > 1 && (sig[4] === 0x00) && !(sig[5] & 0x80))
    return false;

  // Check whether the S element is an integer.
  if (sig[lenR + 4] !== 0x02)
    return false;

  // Zero-length integers are not allowed for S.
  if (lenS === 0)
    return false;

  // Negative numbers are not allowed for S.
  if (sig[lenR + 6] & 0x80)
    return false;

  // Null bytes at the start of S are not allowed, unless S would otherwise be
  // interpreted as a negative number.
  if (lenS > 1 && (sig[lenR + 6] === 0x00) && !(sig[lenR + 7] & 0x80))
    return false;

  return true;
};

/**
 * Test a signature to see whether it contains a valid sighash type.
 * @param {Buffer} sig
 * @returns {Boolean}
 */

Script.isHashType = function isHashType(sig) {
  var type;

  assert(Buffer.isBuffer(sig));

  if (sig.length === 0)
    return false;

  type = sig[sig.length - 1] & ~constants.hashType.ANYONECANPAY;

  if (!(type >= constants.hashType.ALL && type <= constants.hashType.SINGLE))
    return false;

  return true;
};

/**
 * Test a signature to see whether it contains a low S value.
 * @param {Buffer} sig
 * @returns {Boolean}
 */

Script.isLowDER = function isLowDER(sig) {
  if (!Script.isSignatureEncoding(sig))
    return false;

  return ec.isLowS(sig.slice(0, -1));
};

/**
 * Format script code into a human readable-string.
 * @param {Array} code
 * @returns {String} Human-readable string.
 */

Script.format = function format(code) {
  var out = [];
  var i, op, data, value, size;

  for (i = 0; i < code.length; i++) {
    op = code[i];
    data = op.data;
    value = op.value;

    if (data) {
      size = data.length.toString(16);

      while (size.length % 2 !== 0)
        size = '0' + size;

      if (!constants.opcodesByVal[value]) {
        value = value.toString(16);
        if (value.length < 2)
          value = '0' + value;
        value = '0x' + value + ' 0x' + data.toString('hex');
        out.push(value);
        continue;
      }

      value = constants.opcodesByVal[value];
      value = value + ' 0x' + size + ' 0x' + data.toString('hex');
      out.push(value);
      continue;
    }

    assert(typeof value === 'number');

    if (constants.opcodesByVal[value]) {
      value = constants.opcodesByVal[value];
      out.push(value);
      continue;
    }

    if (value === -1) {
      out.push('OP_INVALIDOPCODE');
      break;
    }

    value = value.toString(16);

    if (value.length < 2)
      value = '0' + value;

    value = '0x' + value;
    out.push(value);
  }

  return out.join(' ');
};

/**
 * Format script code into bitcoind asm format.
 * @param {Array} code
 * @param {Boolean?} decode - Attempt to decode hash types.
 * @returns {String} Human-readable string.
 */

Script.formatASM = function formatASM(code, decode) {
  var out = [];
  var i, op, type, symbol, data, value;

  for (i = 0; i < code.length; i++) {
    op = code[i];
    data = op.data;
    value = op.value;

    if (value === -1) {
      out.push('[error]');
      break;
    }

    if (data) {
      if (data.length <= 4) {
        data = Script.num(data, constants.flags.VERIFY_NONE);
        out.push(data.toString(10));
        continue;
      }

      if (decode && code[0] !== opcodes.OP_RETURN) {
        symbol = '';
        if (Script.isSignatureEncoding(data)) {
          type = data[data.length - 1];
          symbol = constants.hashTypeByVal[type & 0x1f] || '';
          if (symbol) {
            if (type & constants.hashType.ANYONECANPAY)
              symbol += '|ANYONECANPAY';
            symbol = '[' + symbol + ']';
          }
          data = data.slice(0, -1);
        }
        out.push(data.toString('hex') + symbol);
        continue;
      }

      out.push(data.toString('hex'));
      continue;
    }

    value = constants.opcodesByVal[value] || 'OP_UNKNOWN';

    out.push(value);
  }

  return out.join(' ');
};

/**
 * Test the script to see if it contains only push ops.
 * Push ops are: OP_1NEGATE, OP_0-OP_16 and all PUSHDATAs.
 * @returns {Boolean}
 */

Script.prototype.isPushOnly = function isPushOnly() {
  var i, op;

  for (i = 0; i < this.code.length; i++) {
    op = this.code[i];

    if (op.data)
      continue;

    if (op.value === -1)
      return false;

    if (op.value > opcodes.OP_16)
      return false;
  }

  return true;
};

/**
 * Count the sigops in the script.
 * @param {Boolean} accurate - Whether to enable accurate counting. This will
 * take into account the `n` value for OP_CHECKMULTISIG(VERIFY).
 * @returns {Number} sigop count
 */

Script.prototype.getSigops = function getSigops(accurate) {
  var total = 0;
  var lastOp = -1;
  var i, op;

  for (i = 0; i < this.code.length; i++) {
    op = this.code[i];

    if (op.data)
      continue;

    if (op.value === -1)
      break;

    switch (op.value) {
      case opcodes.OP_CHECKSIG:
      case opcodes.OP_CHECKSIGVERIFY:
        total++;
        break;
      case opcodes.OP_CHECKMULTISIG:
      case opcodes.OP_CHECKMULTISIGVERIFY:
        if (accurate && lastOp >= opcodes.OP_1 && lastOp <= opcodes.OP_16)
          total += lastOp - 0x50;
        else
          total += constants.script.MAX_MULTISIG_PUBKEYS;
        break;
    }

    lastOp = op.value;
  }

  return total;
};

/**
 * Count the sigops in the script, taking into account redeem scripts.
 * @param {Script} input - Input script, needed for access to redeem script.
 * @returns {Number} sigop count
 */

Script.prototype.getScripthashSigops = function getScripthashSigops(input) {
  var i, op, redeem;

  if (!this.isScripthash())
    return this.getSigops(true);

  for (i = 0; i < input.code.length; i++) {
    op = input.code[i];

    if (op.data)
      continue;

    if (op.value === -1)
      return 0;

    if (op.value > opcodes.OP_16)
      return 0;
  }

  if (!op.data)
    return 0;

  redeem = new Script(op.data);

  return redeem.getSigops(true);
};

/**
 * Count the sigops for a program.
 * @param {Program} program
 * @param {Witness} witness
 * @param {VerifyFlags} flags
 * @returns {Number} sigop count
 */

Script.witnessSigops = function witnessSigops(program, witness, flags) {
  var redeem;

  if (flags == null)
    flags = constants.flags.STANDARD_VERIFY_FLAGS;

  if (program.version === 0) {
    if (program.data.length === 20)
      return 1;

    if (program.data.length === 32 && witness.items.length > 0) {
      redeem = witness.getRedeem();
      return redeem.getSigops(true);
    }
  }

  return 0;
};

/**
 * Count the sigops in a script, taking into account witness programs.
 * @param {Script} input
 * @param {Script} output
 * @param {Witness} witness
 * @param {VerifyFlags} flags
 * @returns {Number} sigop count
 */

Script.getWitnessSigops = function getWitnessSigops(input, output, witness, flags) {
  var redeem;

  if (flags == null)
    flags = constants.flags.STANDARD_VERIFY_FLAGS;

  if ((flags & constants.flags.VERIFY_WITNESS) === 0)
    return 0;

  assert((flags & constants.flags.VERIFY_P2SH) !== 0);

  if (output.isProgram())
    return Script.witnessSigops(output.toProgram(), witness, flags);

  // This is a unique situation in terms of consensus
  // rules. We can just grab the redeem script without
  // "parsing" (i.e. checking for pushdata parse errors)
  // the script. This is because isPushOnly is called
  // which checks for parse errors and will return
  // false if one is found. Even the bitcoind code
  // does not check the return value of GetOp.
  if (output.isScripthash() && input.isPushOnly()) {
    redeem = input.getRedeem();
    if (redeem && redeem.isProgram())
      return Script.witnessSigops(redeem.toProgram(), witness, flags);
  }

  return 0;
};

/**
 * Inject properties from bitcoind test string.
 * @private
 * @param {String} items - Script string.
 * @throws Parse error.
 */

Script.prototype.fromString = function fromString(code) {
  var i, op, symbol, p;

  assert(typeof code === 'string');

  code = code.trim();

  if (code.length === 0)
    return this;

  code = code.split(/\s+/);

  p = new BufferWriter();

  for (i = 0; i < code.length; i++) {
    op = code[i];

    symbol = op.toUpperCase();
    if (symbol.indexOf('OP_') !== 0)
      symbol = 'OP_' + symbol;

    if (opcodes[symbol] == null) {
      if (op[0] === '\'') {
        assert(op[op.length - 1] === '\'', 'Unknown opcode.');
        op = op.slice(1, -1);
        op = Opcode.fromString(op);
        p.writeBytes(op.toRaw());
        continue;
      }
      if (/^-?\d+$/.test(op)) {
        op = new BN(op, 10);
        op = Opcode.fromNumber(op);
        p.writeBytes(op.toRaw());
        continue;
      }
      assert(op.indexOf('0x') === 0, 'Unknown opcode.');
      op = op.substring(2);
      assert(utils.isHex(op), 'Unknown opcode.');
      op = new Buffer(op, 'hex');
      p.writeBytes(op);
      continue;
    }

    p.writeU8(opcodes[symbol]);
  }

  return this.fromRaw(p.render());
};

/**
 * Parse a bitcoind test script
 * string into a script object.
 * @param {String} items - Script string.
 * @returns {Script}
 * @throws Parse error.
 */

Script.fromString = function fromString(code) {
  return new Script().fromString(code);
};

/**
 * Get a small integer from an opcode (OP_0-OP_16).
 * @param {Number} index
 * @returns {Number}
 */

Script.getSmall = function getSmall(op) {
  if (typeof op !== 'number')
    return -1;

  if (op === opcodes.OP_0)
    return 0;

  if (op >= opcodes.OP_1 && op <= opcodes.OP_16)
    return op - 0x50;

  return -1;
};

/**
 * Verify an input and output script, and a witness if present.
 * @param {Script} input
 * @param {Witness} witness
 * @param {Script} output
 * @param {TX} tx
 * @param {Number} i
 * @param {VerifyFlags} flags
 * @returns {Boolean}
 * @throws {ScriptError}
 */

Script.verify = function verify(input, witness, output, tx, i, flags) {
  var stack, copy, raw, redeem, hadWitness;

  if (flags == null)
    flags = constants.flags.STANDARD_VERIFY_FLAGS;

  if (flags & constants.flags.VERIFY_SIGPUSHONLY) {
    if (!input.isPushOnly())
      throw new ScriptError('SIG_PUSHONLY');
  }

  // Setup a stack.
  stack = new Stack();

  // Execute the input script
  input.execute(stack, flags, tx, i, 0);

  // Copy the stack for P2SH
  if (flags & constants.flags.VERIFY_P2SH)
    copy = stack.clone();

  // Execute the previous output script.
  output.execute(stack, flags, tx, i, 0);

  // Verify the stack values.
  if (stack.length === 0 || !Script.bool(stack.top(-1)))
    throw new ScriptError('EVAL_FALSE');

  if ((flags & constants.flags.VERIFY_WITNESS) && output.isProgram()) {
    hadWitness = true;

    // Input script must be empty.
    if (input.raw.length !== 0)
      throw new ScriptError('WITNESS_MALLEATED');

    // Verify the program in the output script.
    Script.verifyProgram(witness, output, flags, tx, i);

    // Force a cleanstack
    stack.length = 1;
  }

  // If the script is P2SH, execute the real output script
  if ((flags & constants.flags.VERIFY_P2SH) && output.isScripthash()) {
    // P2SH can only have push ops in the scriptSig
    if (!input.isPushOnly())
      throw new ScriptError('SIG_PUSHONLY');

    // Reset the stack
    stack = copy;

    // Stack should not be empty at this point
    if (stack.length === 0)
      throw new ScriptError('EVAL_FALSE');

    // Grab the real redeem script
    raw = stack.pop();
    redeem = new Script(raw);

    // Execute the redeem script.
    redeem.execute(stack, flags, tx, i, 0);

    // Verify the the stack values.
    if (stack.length === 0 || !Script.bool(stack.top(-1)))
      throw new ScriptError('EVAL_FALSE');

    if ((flags & constants.flags.VERIFY_WITNESS) && redeem.isProgram()) {
      hadWitness = true;

      // Input script must be exactly one push of the redeem script.
      if (!utils.equal(input.raw, Opcode.fromPush(raw).toRaw()))
        throw new ScriptError('WITNESS_MALLEATED_P2SH');

      // Verify the program in the redeem script.
      Script.verifyProgram(witness, redeem, flags, tx, i);

      // Force a cleanstack.
      stack.length = 1;
    }
  }

  // Ensure there is nothing left on the stack.
  if (flags & constants.flags.VERIFY_CLEANSTACK) {
    assert((flags & constants.flags.VERIFY_P2SH) !== 0);
    if (stack.length !== 1)
      throw new ScriptError('CLEANSTACK');
  }

  // If we had a witness but no witness program, fail.
  if (flags & constants.flags.VERIFY_WITNESS) {
    assert((flags & constants.flags.VERIFY_P2SH) !== 0);
    if (!hadWitness && witness.items.length > 0)
      throw new ScriptError('WITNESS_UNEXPECTED');
  }

  return true;
};

/**
 * Verify a witness program. This runs after regular script
 * execution if a witness program is present. It will convert
 * the witness to a stack and execute the program.
 * @param {Witness} witness
 * @param {Script} output
 * @param {VerifyFlags} flags
 * @param {TX} tx
 * @param {Number} i
 * @returns {Boolean}
 * @throws {ScriptError}
 */

Script.verifyProgram = function verifyProgram(witness, output, flags, tx, i) {
  var program = output.toProgram();
  var stack = witness.toStack();
  var j, witnessScript, redeem;

  assert(program, 'verifyProgram called on non-witness-program.');
  assert((flags & constants.flags.VERIFY_WITNESS) !== 0);

  if (program.version === 0) {
    if (program.data.length === 32) {
      if (stack.length === 0)
        throw new ScriptError('WITNESS_PROGRAM_WITNESS_EMPTY');

      witnessScript = stack.pop();

      if (!utils.equal(crypto.sha256(witnessScript), program.data))
        throw new ScriptError('WITNESS_PROGRAM_MISMATCH');

      redeem = new Script(witnessScript);
    } else if (program.data.length === 20) {
      if (stack.length !== 2)
        throw new ScriptError('WITNESS_PROGRAM_MISMATCH');

      redeem = Script.fromPubkeyhash(program.data);
    } else {
      // Failure on version=0 (bad program data length).
      throw new ScriptError('WITNESS_PROGRAM_WRONG_LENGTH');
    }
  } else if ((flags & constants.flags.VERIFY_MAST) && program.version === 1) {
    return Script.verifyMast(program, stack, output, flags, tx, i);
  } else {
    // Anyone can spend (we can return true here
    // if we want to always relay these transactions).
    // Otherwise, if we want to act like an "old"
    // implementation and only accept them in blocks,
    // we can use the regalar output script which will
    // succeed in a block, but fail in the mempool
    // due to VERIFY_CLEANSTACK.
    if (flags & constants.flags.VERIFY_DISCOURAGE_UPGRADABLE_WITNESS_PROGRAM)
      throw new ScriptError('DISCOURAGE_UPGRADABLE_WITNESS_PROGRAM');
    return true;
  }

  // Witnesses still have push limits.
  for (j = 0; j < stack.length; j++) {
    if (stack.get(j).length > constants.script.MAX_PUSH)
      throw new ScriptError('PUSH_SIZE');
  }

  // Verify the redeem script.
  redeem.execute(stack, flags, tx, i, 1);

  // Verify the stack values.
  if (stack.length !== 1 || !Script.bool(stack.top(-1)))
    throw new ScriptError('EVAL_FALSE');

  return true;
};

/**
 * Verify a MAST witness program.
 * @param {Program} program
 * @param {Stack} stack
 * @param {Script} output
 * @param {VerifyFlags} flags
 * @param {TX} tx
 * @param {Number} i
 * @returns {Boolean}
 * @throws {ScriptError}
 */

Script.verifyMast = function verifyMast(program, stack, output, flags, tx, i) {
  var mastRoot = new BufferWriter();
  var scriptRoot = new BufferWriter();
  var scripts = new BufferWriter();
  var version = 0;
  var pathdata, depth, path, posdata, pos;
  var metadata, subscripts, ops, script;
  var j;

  assert(program.version === 1);
  assert((flags & constants.flags.VERIFY_MAST) !== 0);

  if (stack.length < 4)
    throw new ScriptError('INVALID_MAST_STACK');

  metadata = stack.top(-1);
  if (metadata.length < 1 || metadata.length > 5)
    throw new ScriptError('INVALID_MAST_STACK');

  subscripts = metadata[0];
  if (subscripts === 0 || stack.length < subscripts + 3)
    throw new ScriptError('INVALID_MAST_STACK');

  ops = subscripts;
  scriptRoot.writeU8(subscripts);

  if (metadata[metadata.length - 1] === 0x00)
    throw new ScriptError('INVALID_MAST_STACK');

  for (j = 1; j < metadata.length; j++)
    version |= metadata[i] << 8 * (j - 1);

  if (version < 0)
    version += 0x100000000;

  if (version > 0) {
    if (flags & constants.flags.DISCOURAGE_UPGRADABLE_WITNESS_PROGRAM)
      throw new ScriptError('DISCOURAGE_UPGRADABLE_WITNESS_PROGRAM');
  }

  mastRoot.writeU32(version);

  pathdata = stack.top(-2);

  if (pathdata.length & 0x1f)
    throw new ScriptError('INVALID_MAST_STACK');

  depth = pathdata.length >>> 5;

  if (depth > 32)
    throw new ScriptError('INVALID_MAST_STACK');

  ops += depth;
  if (version === 0) {
    if (ops > constants.script.MAX_OPS)
      throw new ScriptError('OP_COUNT');
  }

  path = [];

  for (j = 0; j < depth; j++)
    path.push(pathdata.slice(j * 32, j * 32 + 32));

  posdata = stack.top(-3);

  if (posdata.length > 4)
    throw new ScriptError('INVALID_MAST_STACK');

  pos = 0;
  if (posdata.length > 0) {
    if (posdata[posdata.length - 1] === 0x00)
      throw new ScriptError('INVALID_MAST_STACK');

    for (j = 0; j < posdata.length; j++)
      pos |= posdata[i] << 8 * j;

    if (pos < 0)
      pos += 0x100000000;
  }

  if (depth < 32) {
    if (pos >= ((1 << depth) >>> 0))
      throw new ScriptError('INVALID_MAST_STACK');
  }

  scripts.writeBytes(output.raw);

  for (j = 0; j < subscripts; j++) {
    script = stack.top(-(4 + j));
    if (version === 0) {
      if ((scripts.written + script.length) > constants.script.MAX_SIZE)
        throw new ScriptError('SCRIPT_SIZE');
    }
    scriptRoot.writeBytes(crypto.hash256(script));
    scripts.writeBytes(script);
  }

  scriptRoot = crypto.hash256(scriptRoot.render());
  scriptRoot = crypto.checkMerkleBranch(scriptRoot, path, pos);

  mastRoot.writeBytes(scriptRoot);
  mastRoot = crypto.hash256(mastRoot.render());

  if (!utils.equal(mastRoot, program.data))
    throw new ScriptError('WITNESS_PROGRAM_MISMATCH');

  if (version === 0) {
    stack.length -= 3 + subscripts;

    for (j = 0; j < stack.length; j++) {
      if (stack.get(j).length > constants.script.MAX_PUSH)
        throw new ScriptError('PUSH_SIZE');
    }

    output = new Script(scripts.render());
    output.execute(stack, flags, tx, i, 1);

    if (stack.length !== 0)
      throw new ScriptError('EVAL_FALSE');
  }

  return true;
};

/**
 * Verify a signature, taking into account sighash type
 * and whether the signature is historical.
 * @param {Buffer} msg - Signature hash.
 * @param {Buffer} sig
 * @param {Buffer} key
 * @param {VerifyFlags?} flags - If none of VERIFY_DERSIG,
 * VERIFY_LOW_S, or VERIFY_STRICTENC are enabled, the signature
 * is treated as historical, allowing odd signature lengths
 * and high S values.
 * @returns {Boolean}
 */

Script.checksig = function checksig(msg, sig, key, flags) {
  var historical = false;
  var high = false;

  if (flags == null)
    flags = constants.flags.STANDARD_VERIFY_FLAGS;

  // Attempt to normalize the signature
  // length before passing to elliptic.
  // Note: We only do this for historical data!
  // https://github.com/indutny/elliptic/issues/78
  if (!((flags & constants.flags.VERIFY_DERSIG)
      || (flags & constants.flags.VERIFY_LOW_S)
      || (flags & constants.flags.VERIFY_STRICTENC))) {
    historical = true;
  }

  if (!(flags & constants.flags.VERIFY_LOW_S))
    high = true;

  return SigCache.verify(msg, sig.slice(0, -1), key, historical, high);
};

/**
 * Sign a message, appending the sighash type.
 * @param {Buffer} msg - Signature hash.
 * @param {Buffer} key - Public key.
 * @param {Number} type - Sighash type.
 * @returns {Buffer} signature
 */

Script.sign = function sign(msg, key, type) {
  var sig = ec.sign(msg, key);
  var p = new BufferWriter();

  // Add the sighash type as a single byte
  // to the signature.
  p.writeBytes(sig);
  p.writeU8(type);

  return p.render();
};

/**
 * Inject properties from serialized data.
 * @private
 * @param {Buffer}
 */

Script.prototype.fromRaw = function fromRaw(data) {
  if (data instanceof BufferReader)
    data = data.readVarBytes();

  this.raw = data;
  this.code = Script.decode(data);

  return this;
};

/**
 * Create a script from a serialized buffer.
 * @param {Buffer|String} data - Serialized script.
 * @param {String?} enc - Either `"hex"` or `null`.
 * @returns {Script}
 */

Script.fromRaw = function fromRaw(data, enc) {
  if (typeof data === 'string')
    data = new Buffer(data, enc);
  return new Script().fromRaw(data);
};

/**
 * Decode a serialized script into script code.
 * Note that the serialized script must _not_
 * include the varint size before it. Parse
 * errors will output an opcode with a value
 * of -1.
 *
 * @param {Buffer} raw - Serialized script.
 * @returns {Opcode[]} Script code.
 */

Script.decode = function decode(raw) {
  var p = new BufferReader(raw, true);
  var code = [];
  var op, size, data;

  assert(Buffer.isBuffer(raw));

  while (p.left()) {
    op = p.readU8();
    if (op >= 0x01 && op <= 0x4b) {
      if (p.left() < op) {
        code.push(new Opcode(-1));
        break;
      }
      data = p.readBytes(op);
      code.push(new Opcode(op, data));
    } else if (op === opcodes.OP_PUSHDATA1) {
      if (p.left() < 1) {
        code.push(new Opcode(-1));
        break;
      }
      size = p.readU8();
      if (p.left() < size) {
        code.push(new Opcode(-1));
        break;
      }
      data = p.readBytes(size);
      code.push(new Opcode(op, data));
    } else if (op === opcodes.OP_PUSHDATA2) {
      if (p.left() < 2) {
        code.push(new Opcode(-1));
        break;
      }
      size = p.readU16();
      if (p.left() < size) {
        code.push(new Opcode(-1));
        break;
      }
      data = p.readBytes(size);
      code.push(new Opcode(op, data));
    } else if (op === opcodes.OP_PUSHDATA4) {
      if (p.left() < 4) {
        code.push(new Opcode(-1));
        break;
      }
      size = p.readU32();
      if (p.left() < size) {
        code.push(new Opcode(-1));
        break;
      }
      data = p.readBytes(size);
      code.push(new Opcode(op, data));
    } else {
      code.push(new Opcode(op));
    }
  }

  return code;
};

/**
 * Encode and serialize script code. This will _not_
 * include the varint size at the start.
 * @param {Array} code - Script code.
 * @returns {Buffer} Serialized script.
 */

Script.encode = function encode(code, writer) {
  var p = new BufferWriter(writer);
  var i, op;

  assert(Array.isArray(code));

  for (i = 0; i < code.length; i++) {
    op = code[i];

    if (op.value === -1)
      throw new Error('Cannot reserialize a parse error.');

    if (op.data) {
      if (op.value <= 0x4b) {
        p.writeU8(op.data.length);
        p.writeBytes(op.data);
      } else if (op.value === opcodes.OP_PUSHDATA1) {
        p.writeU8(opcodes.OP_PUSHDATA1);
        p.writeU8(op.data.length);
        p.writeBytes(op.data);
      } else if (op.value === opcodes.OP_PUSHDATA2) {
        p.writeU8(opcodes.OP_PUSHDATA2);
        p.writeU16(op.data.length);
        p.writeBytes(op.data);
      } else if (op.value === opcodes.OP_PUSHDATA4) {
        p.writeU8(opcodes.OP_PUSHDATA4);
        p.writeU32(op.data.length);
        p.writeBytes(op.data);
      } else {
        throw new Error('Unknown pushdata opcode.');
      }
      continue;
    }

    p.writeU8(op.value);
  }

  if (!writer)
    p = p.render();

  return p;
};

/**
 * Convert an array of Buffers and
 * Numbers into an array of Opcodes.
 * @param {Array} code
 * @returns {Opcode[]}
 */

Script.parseArray = function parseArray(code) {
  var out = [];
  var i, op;

  assert(Array.isArray(code));

  if (code.length === 0)
    return code;

  if (code[0] instanceof Opcode)
    return code;

  for (i = 0; i < code.length; i++) {
    op = code[i];
    if (Buffer.isBuffer(op)) {
      out.push(Opcode.fromData(op));
      continue;
    }
    assert(typeof op === 'number');
    out.push(new Opcode(op));
  }

  return out;
};

/**
 * Calculate the size (including
 * the opcode) of a pushdata.
 * @param {Number} num - Pushdata data length.
 * @returns {Number} size
 */

Script.sizePush = function sizePush(num) {
  if (num <= 0x4b)
    return 1;

  if (num <= 0xff)
    return 2;

  if (num <= 0xffff)
    return 3;

  return 5;
};

/**
 * Test whether an object a Script.
 * @param {Object} obj
 * @returns {Boolean}
 */

Script.isScript = function isScript(obj) {
  return obj
    && Buffer.isBuffer(obj.raw)
    && typeof obj.getSubscript === 'function';
};

/*
 * Expose
 */

exports = Script;

exports.opcodes = constants.opcodes;
exports.opcodesByVal = constants.opcodesByVal;
exports.types = scriptTypes;
exports.typesByVal = constants.scriptTypesByVal;
exports.flags = constants.flags;

module.exports = exports;
