'use strict';

var util = require('util');
var EventEmitter = require('events').EventEmitter;
var _ = require('lodash');
var Redis = require('../redis');

function ConnectionPool(redisOptions) {
  EventEmitter.call(this);
  this.redisOptions = redisOptions;

  // master + slave = all
  this.nodes = {
    all: {},
    master: {},
    slave: {}
  };

  this.specifiedOptions = {};
}

util.inherits(ConnectionPool, EventEmitter);

/**
 * Find or create a connection to the node
 *
 * @param {Object} node - the node to connect to
 * @param {boolean} [readOnly=false] - whether the node is a slave
 * @return {Redis}
 * @public
 */
ConnectionPool.prototype.findOrCreate = function (node, readOnly) {
  node.port = node.port || 6379;
  node.host = node.host || '127.0.0.1';
  node.key = node.key || node.host + ':' + node.port;
  readOnly = Boolean(readOnly);

  if (this.specifiedOptions[node.key]) {
    _.assign(node, this.specifiedOptions[node.key]);
  } else {
    this.specifiedOptions[node.key] = node;
  }

  var redis;
  if (this.nodes.all[node.key]) {
    redis = this.nodes.all[node.key];
    if (redis.options.readOnly !== readOnly) {
      redis.options.readOnly = readOnly;
      redis[readOnly ? 'readonly' : 'readwrite']().catch(function () {});
      if (readOnly) {
        delete this.nodes.master[node.key];
        this.nodes.slave[node.key] = redis;
      } else {
        delete this.nodes.slave[node.key];
        this.nodes.master[node.key] = redis;
      }
    }
  } else {
    redis = new Redis(_.defaults({
      retryStrategy: null,
      readOnly: readOnly
    }, node, this.redisOptions, { lazyConnect: true }));
    this.nodes.all[node.key] = redis;
    this.nodes[readOnly ? 'slave' : 'master'][node.key] = redis;

    var _this = this;
    redis.once('end', function () {
      delete _this.nodes.all[node.key];
      delete _this.nodes.master[node.key];
      delete _this.nodes.slave[node.key];
      _this.emit('-node', redis);
      if (!Object.keys(_this.nodes.all).length) {
        _this.emit('drain');
      }
    });

    this.emit('+node', redis);
  }

  return this.nodes.all[node.key];
};

/**
 * Reset the pool with a set of nodes.
 * The old node will be removed.
 *
 * @param {Object[]} nodes
 * @public
 */
ConnectionPool.prototype.reset = function (nodes) {
  var newNodes = {};
  for (var i = 0; i < nodes.length; i++) {
    var node = nodes[i];
    node.key = node.host + ':' + node.port;
    newNodes[node.key] = node;
  }
  var _this = this;
  Object.keys(this.nodes.all).forEach(function (key) {
    if (!newNodes[key]) {
      _this.nodes.all[key].disconnect();
    }
  });
  Object.keys(newNodes).forEach(function (key) {
    _this.findOrCreate(newNodes[key], newNodes[key].readOnly);
  });
};

module.exports = ConnectionPool;