/*!
 * block.js - block object for bcoin
 * Copyright (c) 2014-2015, Fedor Indutny (MIT License)
 * Copyright (c) 2014-2016, Christopher Jeffrey (MIT License).
 * https://github.com/bcoin-org/bcoin
 */

'use strict';

module.exports = Block;

var utils = require('../utils/utils');
var crypto = require('../crypto/crypto');
var assert = require('assert');
var constants = require('../protocol/constants');
var AbstractBlock = require('./abstractblock');
var VerifyResult = utils.VerifyResult;
var BufferWriter = require('../utils/writer');
var BufferReader = require('../utils/reader');
var TX = require('./tx');
var MerkleBlock = require('./merkleblock');
var Network = require('../protocol/network');

/**
 * Represents a full block.
 * @exports Block
 * @constructor
 * @extends AbstractBlock
 * @param {NakedBlock} options
 */

function Block(options) {
  if (!(this instanceof Block))
    return new Block(options);

  AbstractBlock.call(this, options);

  this.txs = [];

  this._cbHeight = null;
  this._commitmentHash = null;

  this._raw = null;
  this._size = -1;
  this._witnessSize = -1;
  this._lastWitnessSize = 0;

  if (options)
    this.fromOptions(options);
}

utils.inherits(Block, AbstractBlock);

/**
 * Inject properties from options object.
 * @private
 * @param {Object} options
 */

Block.prototype.fromOptions = function fromOptions(options) {
  var i;

  if (options.txs) {
    for (i = 0; i < options.txs.length; i++)
      this.addTX(options.txs[i]);
  }
};

/**
 * Instantiate block from options.
 * @param {Object} options
 * @returns {Block}
 */

Block.fromOptions = function fromOptions(options) {
  return new Block().fromOptions(options);
};

/**
 * Serialize the block. Include witnesses if present.
 * @returns {Buffer}
 */

Block.prototype.toRaw = function toRaw(writer) {
  var raw = this.getRaw();
  if (writer) {
    writer.writeBytes(raw);
    return writer;
  }
  return raw;
};

/**
 * Serialize the block, do not include witnesses.
 * @returns {Buffer}
 */

Block.prototype.toNormal = function toNormal(writer) {
  var raw;
  if (!this.hasWitness()) {
    raw = this.getRaw();
    if (writer) {
      writer.writeBytes(raw);
      return writer;
    }
    return raw;
  }
  return this.frameNormal(writer);
};

/**
 * Serialize the block. Include witnesses if present.
 * @returns {Buffer}
 */

Block.prototype.toWitness = function toWitness(writer) {
  return this.toRaw(writer);
};

/**
 * Get the raw block serialization.
 * Include witnesses if present.
 * @returns {Buffer}
 */

Block.prototype.getRaw = function getRaw() {
  var raw;

  if (this._raw) {
    assert(this._size > 0);
    assert(this._witnessSize >= 0);
    this._lastWitnessSize = this._witnessSize;
    return this._raw;
  }

  raw = this.frameWitness();

  if (!this.mutable) {
    this._size = raw.length;
    this._witnessSize = this._lastWitnessSize;
    this._raw = raw;
  }

  return raw;
};

/**
 * Calculate real size and size of the witness bytes.
 * @returns {Object} Contains `size` and `witnessSize`.
 */

Block.prototype.getSizes = function getSizes() {
  var writer;

  if (this._size !== -1) {
    return {
      size: this._size,
      witnessSize: this._witnessSize
    };
  }

  if (!this.mutable) {
    assert(!this._raw);
    this.getRaw();
    return {
      size: this._size,
      witnessSize: this._witnessSize
    };
  }

  writer = new BufferWriter();
  this.toRaw(writer);

  return {
    size: writer.written,
    witnessSize: this._lastWitnessSize
  };
};

/**
 * Calculate virtual block size.
 * @returns {Number} Virtual size.
 */

Block.prototype.getVirtualSize = function getVirtualSize() {
  var scale = constants.WITNESS_SCALE_FACTOR;
  return (this.getWeight() + scale - 1) / scale | 0;
};

/**
 * Calculate block weight.
 * @returns {Number} weight
 */

Block.prototype.getWeight = function getWeight() {
  var sizes = this.getSizes();
  var base = sizes.size - sizes.witnessSize;
  return base * (constants.WITNESS_SCALE_FACTOR - 1) + sizes.size;
};

/**
 * Get real block size.
 * @returns {Number} size
 */

Block.prototype.getSize = function getSize() {
  return this.getSizes().size;
};

/**
 * Get base block size (without witness).
 * @returns {Number} size
 */

Block.prototype.getBaseSize = function getBaseSize() {
  var sizes = this.getSizes();
  return sizes.size - sizes.witnessSize;
};

/**
 * Test whether the block contains a
 * transaction with a non-empty witness.
 * @returns {Boolean}
 */

Block.prototype.hasWitness = function hasWitness() {
  var i;

  if (this._witnessSize !== -1)
    return this._witnessSize !== 0;

  for (i = 0; i < this.txs.length; i++) {
    if (this.txs[i].hasWitness())
      return true;
  }

  return false;
};

/**
 * Add a transaction to the block's tx vector.
 * @param {TX|NakedTX} tx
 * @returns {TX}
 */

Block.prototype.addTX = function addTX(tx) {
  var index = this.txs.push(tx) - 1;
  tx.setBlock(this, index);
  return index;
};

/**
 * Test the block's transaction vector against a hash.
 * @param {Hash|TX} hash
 * @returns {Boolean}
 */

Block.prototype.hasTX = function hasTX(hash) {
  return this.indexOf(hash) !== -1;
};

/**
 * Find the index of a transaction in the block.
 * @param {Hash|TX} hash
 * @returns {Number} index (-1 if not present).
 */

Block.prototype.indexOf = function indexOf(hash) {
  var i;

  if (hash instanceof TX)
    hash = hash.hash('hex');

  for (i = 0; i < this.txs.length; i++) {
    if (this.txs[i].hash('hex') === hash)
      return i;
  }

  return -1;
};

/**
 * Calculate merkle root.
 * @param {String?} enc - Encoding, can be `'hex'` or null.
 * @returns {Buffer|Hash} hash
 */

Block.prototype.getMerkleRoot = function getMerkleRoot(enc) {
  var leaves = [];
  var i, root;

  for (i = 0; i < this.txs.length; i++)
    leaves.push(this.txs[i].hash());

  root = crypto.getMerkleRoot(leaves);

  if (!root)
    return;

  return enc === 'hex'
    ? root.toString('hex')
    : root;
};

/**
 * Calculate commitment hash (the root of the
 * witness merkle tree hashed with the witnessNonce).
 * @param {String?} enc - Encoding, can be `'hex'` or null.
 * @returns {Buffer|Hash} hash
 */

Block.prototype.getCommitmentHash = function getCommitmentHash(enc) {
  var leaves = [];
  var witnessNonce = this.witnessNonce;
  var i, buf, witnessRoot, commitmentHash;

  if (!witnessNonce)
    return;

  for (i = 0; i < this.txs.length; i++)
    leaves.push(this.txs[i].witnessHash());

  witnessRoot = crypto.getMerkleRoot(leaves);

  if (!witnessRoot)
    return;

  buf = new Buffer(64);
  witnessRoot.copy(buf, 0);
  witnessNonce.copy(buf, 32);

  commitmentHash = crypto.hash256(buf);

  return enc === 'hex'
    ? commitmentHash.toString('hex')
    : commitmentHash;
};

Block.prototype.__defineGetter__('witnessNonce', function() {
  var coinbase = this.txs[0];

  if (!coinbase)
    return;

  if (coinbase.inputs.length !== 1)
    return;

  if (coinbase.inputs[0].witness.items.length !== 1)
    return;

  if (coinbase.inputs[0].witness.items[0].length !== 32)
    return;

  return coinbase.inputs[0].witness.items[0];
});

Block.prototype.__defineGetter__('commitmentHash', function() {
  var i, coinbase, script, commitmentHash;

  if (this._commitmentHash)
    return this._commitmentHash;

  coinbase = this.txs[0];

  if (!coinbase)
    return;

  for (i = coinbase.outputs.length - 1; i >= 0; i--) {
    script = coinbase.outputs[i].script;
    if (script.isCommitment()) {
      commitmentHash = script.getCommitmentHash();
      commitmentHash = commitmentHash.toString('hex');

      if (!this.mutable)
        this._commitmentHash = commitmentHash;

      break;
    }
  }

  return commitmentHash;
});

/**
 * Do non-contextual verification on the block. Including checking the block
 * size, the coinbase and the merkle root. This is consensus-critical.
 * @alias Block#verify
 * @param {Object?} ret - Return object, may be
 * set with properties `reason` and `score`.
 * @returns {Boolean}
 */

Block.prototype._verify = function _verify(ret) {
  var sigops = 0;
  var scale = constants.WITNESS_SCALE_FACTOR;
  var i, tx, merkle;

  if (!ret)
    ret = new VerifyResult();

  if (!this.verifyHeaders(ret))
    return false;

  // Size can't be bigger than MAX_BLOCK_SIZE
  if (this.txs.length > constants.block.MAX_SIZE
      || this.getBaseSize() > constants.block.MAX_SIZE) {
    ret.reason = 'bad-blk-length';
    ret.score = 100;
    return false;
  }

  // First TX must be a coinbase
  if (this.txs.length === 0 || !this.txs[0].isCoinbase()) {
    ret.reason = 'bad-cb-missing';
    ret.score = 100;
    return false;
  }

  // Test all txs
  for (i = 0; i < this.txs.length; i++) {
    tx = this.txs[i];

    // The rest of the txs must not be coinbases
    if (i > 0 && tx.isCoinbase()) {
      ret.reason = 'bad-cb-multiple';
      ret.score = 100;
      return false;
    }

    // Sanity checks
    if (!tx.isSane(ret))
      return false;

    // Count legacy sigops (do not count scripthash or witness)
    sigops += tx.getLegacySigops();
    if (sigops * scale > constants.block.MAX_SIGOPS_WEIGHT) {
      ret.reason = 'bad-blk-sigops';
      ret.score = 100;
      return false;
    }
  }

  // Check merkle root
  merkle = this.getMerkleRoot('hex');

  // If the merkle is mutated,
  // we have duplicate txs.
  if (!merkle) {
    ret.reason = 'bad-txns-duplicate';
    ret.score = 100;
    return false;
  }

  if (this.merkleRoot !== merkle) {
    ret.reason = 'bad-txnmrklroot';
    ret.score = 100;
    return false;
  }

  return true;
};

/**
 * Retrieve the coinbase height from the coinbase input script.
 * @returns {Number} height (-1 if not present).
 */

Block.prototype.getCoinbaseHeight = function getCoinbaseHeight() {
  var coinbase, height;

  if (this.version < 2)
    return -1;

  if (this._cbHeight != null)
    return this._cbHeight;

  coinbase = this.txs[0];

  if (!coinbase || coinbase.inputs.length === 0)
    return -1;

  height = coinbase.inputs[0].script.getCoinbaseHeight();

  if (!this.mutable)
    this._cbHeight = height;

  return height;
};

/**
 * Calculate the block reward.
 * @returns {Amount} reward
 */

Block.prototype.getReward = function getReward(network) {
  var reward = Block.reward(this.height, network);
  var i, fee;

  for (i = 1; i < this.txs.length; i++) {
    fee = this.txs[i].getFee();

    if (fee < 0 || fee > constants.MAX_MONEY)
      return -1;

    reward += fee;

    // We don't want to go above 53 bits.
    // This is to make the getClaimed check
    // fail if the miner mined an evil block.
    // Note that this check ONLY works because
    // MAX_MONEY is 51 bits. The result of
    // (51 bits + 51 bits) is _never_ greater
    // than 52 bits.
    if (reward < 0 || reward > constants.MAX_MONEY)
      return -1;
  }

  return reward;
};

/**
 * Get the "claimed" reward by the coinbase.
 * @returns {Amount} claimed
 */

Block.prototype.getClaimed = function getClaimed() {
  assert(this.txs[0]);
  assert(this.txs[0].isCoinbase());
  return this.txs[0].getOutputValue();
};

/**
 * Calculate block subsidy.
 * @param {Number} height - Reward era by height.
 * @returns {Amount}
 */

Block.reward = function reward(height, network) {
  var halvings;

  assert(height >= 0, 'Bad height for reward.');

  network = Network.get(network);
  halvings = height / network.halvingInterval | 0;

  // BIP 42 (well, our own version of it,
  // since we can only handle 32 bit shifts).
  // https://github.com/bitcoin/bips/blob/master/bip-0042.mediawiki
  if (halvings >= 33)
    return 0;

  // We need to shift right by `halvings`,
  // but 50 btc is a 33 bit number, so we
  // cheat. We only start halving once the
  // halvings are at least 1.
  if (halvings === 0)
    return 5000000000;

  return 2500000000 >>> (halvings - 1);
};

/**
 * Get all unique outpoint hashes in the
 * block. Coinbases are ignored.
 * @returns {Hash[]} Outpoint hashes.
 */

Block.prototype.getPrevout = function getPrevout() {
  var prevout = {};
  var i, j, tx, input;

  for (i = 0; i < this.txs.length; i++) {
    tx = this.txs[i];

    if (tx.isCoinbase())
      continue;

    for (j = 0; j < tx.inputs.length; j++) {
      input = tx.inputs[j];
      prevout[input.prevout.hash] = true;
    }
  }

  return Object.keys(prevout);
};

/**
 * Inspect the block and return a more
 * user-friendly representation of the data.
 * @returns {Object}
 */

Block.prototype.inspect = function inspect() {
  return {
    hash: this.rhash,
    height: this.height,
    size: this.getSize(),
    virtualSize: this.getVirtualSize(),
    date: utils.date(this.ts),
    version: this.version,
    prevBlock: utils.revHex(this.prevBlock),
    merkleRoot: utils.revHex(this.merkleRoot),
    commitmentHash: this.commitmentHash
      ? utils.revHex(this.commitmentHash)
      : null,
    ts: this.ts,
    bits: this.bits,
    nonce: this.nonce,
    txs: this.txs
  };
};

/**
 * Convert the block to an object suitable
 * for JSON serialization. Note that the hashes
 * will be reversed to abide by bitcoind's legacy
 * of little-endian uint256s.
 * @returns {Object}
 */

Block.prototype.toJSON = function toJSON(network) {
  network = Network.get(network);
  return {
    hash: this.rhash,
    height: this.height,
    version: this.version,
    prevBlock: utils.revHex(this.prevBlock),
    merkleRoot: utils.revHex(this.merkleRoot),
    ts: this.ts,
    bits: this.bits,
    nonce: this.nonce,
    totalTX: this.totalTX,
    txs: this.txs.map(function(tx) {
      return tx.toJSON(network);
    })
  };
};

/**
 * Inject properties from json object.
 * @private
 * @param {Object} json
 */

Block.prototype.fromJSON = function fromJSON(json) {
  var i;

  assert(json, 'Block data is required.');
  assert.equal(json.type, 'block');
  assert(Array.isArray(json.txs));

  this.parseJSON(json);

  for (i = 0; i < json.txs.length; i++)
    this.txs.push(TX.fromJSON(json.txs[i]));

  return this;
};

/**
 * Instantiate a block from a jsonified block object.
 * @param {Object} json - The jsonified block object.
 * @returns {Block}
 */

Block.fromJSON = function fromJSON(json) {
  return new Block().fromJSON(json);
};

/**
 * Inject properties from serialized data.
 * @private
 * @param {Buffer} data
 */

Block.prototype.fromRaw = function fromRaw(data) {
  var p = BufferReader(data);
  var i, tx, witnessSize;

  p.start();

  this.version = p.readU32(); // Technically signed
  this.prevBlock = p.readHash('hex');
  this.merkleRoot = p.readHash('hex');
  this.ts = p.readU32();
  this.bits = p.readU32();
  this.nonce = p.readU32();
  this.totalTX = p.readVarint();

  witnessSize = 0;

  for (i = 0; i < this.totalTX; i++) {
    tx = TX.fromRaw(p);
    witnessSize += tx._witnessSize;
    this.addTX(tx);
  }

  if (!this.mutable) {
    this._raw = p.endData();
    this._size = this._raw.length;
    this._witnessSize = witnessSize;
  }

  return this;
};

/**
 * Instantiate a block from a serialized Buffer.
 * @param {Buffer} data
 * @param {String?} enc - Encoding, can be `'hex'` or null.
 * @returns {Block}
 */

Block.fromRaw = function fromRaw(data, enc) {
  if (typeof data === 'string')
    data = new Buffer(data, enc);
  return new Block().fromRaw(data);
};

/**
 * Convert the Block to a MerkleBlock.
 * @param {Bloom} filter - Bloom filter for transactions
 * to match. The merkle block will contain only the
 * matched transactions.
 * @returns {MerkleBlock}
 */

Block.prototype.toMerkle = function toMerkle(filter) {
  return MerkleBlock.fromBlock(this, filter);
};

/**
 * Serialze block with or without witness data.
 * @private
 * @param {Boolean} witness
 * @param {BufferWriter?} writer
 * @returns {Buffer}
 */

Block.prototype.frame = function frame(witness, writer) {
  var p = BufferWriter(writer);
  var witnessSize = 0;
  var i, tx;

  p.writeU32(this.version);
  p.writeHash(this.prevBlock);
  p.writeHash(this.merkleRoot);
  p.writeU32(this.ts);
  p.writeU32(this.bits);
  p.writeU32(this.nonce);
  p.writeVarint(this.txs.length);

  for (i = 0; i < this.txs.length; i++) {
    tx = this.txs[i];
    if (witness) {
      tx.toRaw(p);
      witnessSize += tx._lastWitnessSize;
    } else {
      tx.toNormal(p);
    }
  }

  this._lastWitnessSize = witnessSize;

  if (!writer)
    p = p.render();

  return p;
};

/**
 * Serialze block without witness data.
 * @private
 * @param {BufferWriter?} writer
 * @returns {Buffer}
 */

Block.prototype.frameNormal = function frameNormal(writer) {
  return this.frame(false, writer);
};

/**
 * Serialze block with witness data.
 * @private
 * @param {BufferWriter?} writer
 * @returns {Buffer}
 */

Block.prototype.frameWitness = function frameWitness(writer) {
  return this.frame(true, writer);
};

/**
 * Test whether an object is a Block.
 * @param {Object} obj
 * @returns {Boolean}
 */

Block.isBlock = function isBlock(obj) {
  return obj
    && obj.merkleRoot !== undefined
    && typeof obj.getClaimed === 'function';
};

/*
 * Expose
 */

module.exports = Block;
