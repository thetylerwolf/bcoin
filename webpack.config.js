const path = require('path');

//=========================================================
//  ENVIRONMENT VARS
//---------------------------------------------------------
const NODE_ENV = process.env.NODE_ENV || 'development';

const ENV_DEVELOPMENT = NODE_ENV === 'development';
const ENV_PRODUCTION = NODE_ENV === 'production';
const ENV_TEST = NODE_ENV === 'test';

const HOST = process.env.HOST || 'localhost';
const PORT = process.env.PORT || 3000;

var alias;

if(ENV_DEVELOPMENT) {
    alias = {
        './lib/http/base': __dirname + '/browser/empty.js',
        './lib/http/client': __dirname + '/browser/empty.js',
        './lib/http/request': __dirname + '/browser/empty.js',
        './lib/http/rpcclient': __dirname + '/browser/empty.js',
        './lib/http/server': __dirname + '/browser/empty.js',
        './lib/http/wallet': __dirname + '/browser/empty.js',
        'fs': __dirname + '/browser/empty.js',
        'crypto': __dirname + '/browser/empty.js',
        'child_process': __dirname + '/browser/empty.js',
        'os': __dirname + '/browser/empty.js',
        'net': __dirname + '/browser/empty.js',
        'bcoin-native': __dirname + '/browser/empty.js',
        'secp256k1': __dirname + '/browser/empty.js',
        'tls': __dirname + '/browser/empty.js'
    }
}

module.exports = {
    entry: "./lib/bcoin.js",
    output: {
        path: __dirname + '/browser/',
        filename: "bcoin.js"
    },
    devtool: 'inline-source-map',
    resolve: {
        alias: alias
    },
    module: {
        loaders: [
            { test: /\.json$/, loader: 'json' }
        ]
    },
};
