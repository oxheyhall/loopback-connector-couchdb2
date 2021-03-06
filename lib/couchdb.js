// Copyright IBM Corp. 2017,2019. All Rights Reserved.
// Node module: loopback-connector-couchdb2
// This file is licensed under the Apache License 2.0.
// License text available at https://opensource.org/licenses/Apache-2.0

// Modified by Greig Dendor <greig.dendor@oxheyhall.com> to enable database
// switching based on context passed through options.
// This is enabled through the setting dbSwitching (bool). Default is false
// to preserve original behaviour.
// dbSwitchingExceptions is an array of database names which should not be
// dynamically overridden.

'use strict';

var g = require('strong-globalize')();
var Connector = require('loopback-connector').Connector;
var Driver = require('nano');
var assert = require('assert');
var debug = require('debug')('loopback:connector:couchdb2');
var indexWarning = require('debug')('aspect:indexWarning');
var indexExplain = require('debug')('aspect:indexExplain');
var async = require('async');
var url = require('url');
var util = require('util');
var _ = require('lodash');
const winston = require('winston');

const ejs = require('ejs');
const hash = require('object-hash');

const dblogger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  defaultMeta: {service: 'dbtracker'},
  transports: [
    new winston.transports.Http({
      format: winston.format.json(),
      host: '10.0.5.8',
      port: 8081,
    }),
  ],
});

const DEFAULT_MODEL_VIEW = 'loopback__model__name';
const DEFAULT_MODEL_PREFIX = 'LBModel';
const DEFAULT_PROPERTY_PREFIX = 'LBIndex';

/**
 * Initialize the CouchDB connector for the given data source
 *
 * @param {DataSource} ds The data source instance
 * @callback {Function} cb The callback function
 */
exports.initialize = function(ds, cb) {
  ds.connector = new CouchDB('couchdb', ds.settings, ds);
  if (cb) {
    if (ds.settings.lazyConnect) {
      process.nextTick(function() {
        cb();
      });
    } else {
      ds.connector.connect(cb);
    }
  }
};

/**
 * The constructor for the CouchDB LoopBack connector
 *
 * @param {Object} settings The settings object
 * @param {DataSource} ds The data source instance
 * @constructor
 */

function CouchDB(name, settings, ds) {
  // Injection for tests
  this.CouchDBDriver = settings.Driver || Driver;
  debug('CouchDB constructor settings: %j', settings);
  Connector.call(this, name, settings);
  this.debug = settings.debug || debug.enabled;
  this.dataSource = ds;
  this.dbSwitching = settings.dbSwitching || false;
  this.dbSwitchingExceptions = settings.dbSwitchingExceptions || [];

  if (!settings.url && (!settings.username || !settings.password)) {
    throw new Error(
      g.f('Invalid settings: "url" OR "username"' + ' AND "password" required')
    );
  }
  this.options = _.merge({}, settings);
  // If settings.url is not set, then setup account/password props.
  if (!this.options.url) {
    this.options.account = settings.username;
    this.options.password = settings.password;
  }
  this.pool = {};
}

util.inherits(CouchDB, Connector);

CouchDB.prototype.getTypes = function() {
  return ['db', 'nosql', 'couchdb'];
};

/**
 * Connect to CouchDB
 *
 * @callback {Function} cb The callback function
 */
CouchDB.prototype.connect = function(cb) {
  debug('CouchDB.prototype.connect');
  var self = this;

  // strip db name if defined in path of url before
  // sending it to our driver
  if (self.options.url) {
    var parsedUrl = url.parse(self.options.url);
    if (parsedUrl.path && parsedUrl.path !== '/') {
      self.options.url = self.options.url.replace(parsedUrl.path, '');
      if (!self.options.database)
        self.options.database = parsedUrl.path.split('/')[1];
    }
  }
  self.couchdb = self.CouchDBDriver(self.options);
  if (self.options.database) {
    // check if database exists
    self.couchdb.db.get(self.options.database, function(err) {
      if (err) return cb(err);
      return cb(err, self.couchdb);
    });
  } else return cb(null, self.couchdb);
};

/**
 * Return the driver instance, so cloudant can override this function,
 * and call driver functions as `this.getDriverInst().foo`
 */
CouchDB.prototype.getDriverInst = function() {
  return this.couchdb;
};

/**
 * Called by function CouchDB.prototype.selectModel, and cloudant can
 * override this function.
 */
CouchDB.prototype.getModelObjectSettings = function(mo) {
  if (mo) return mo.settings.couchdb;
  return undefined;
};

/**
 * Prepare the data for the save/insert DB operation
 *
 * @param {String} modelName The model name
 * @param {Object} modelObject The model properties etc
 * @param {Object} doc The model document/data
 * @returns {Object} doc The model document/data
 */
CouchDB.prototype.toDB = function(modelName, modelObject, doc) {
  // toString() this value because IDs must be strings: https://docs.cloudant.com/document.html
  var idValue = this.getIdValue(modelName, doc);
  if (idValue) idValue = idValue.toString();
  var idName = this.idName(modelName);
  if (!doc) doc = {};
  for (var i in doc) {
    if (typeof doc[i] === 'undefined') delete doc[i];
  }
  if (idValue === null) delete doc[idName];
  else {
    if (idValue) doc._id = idValue;
    if (idName !== '_id') delete doc[idName];
  }
  if (modelObject.modelView) doc[modelObject.modelView] = modelName;
  return doc;
};

/**
 * Preserve round-trip type information, etc.
 *
 * @param {String} modelName The model name
 * @param {Object} modelObject The model properties etc
 * @param {Object} doc The model document/data
 * @param {Array} fields The fields to include in the result
 * @returns {Object} doc The model document/data
 */
CouchDB.prototype.fromDB = function(modelName, modelObject, doc, fields) {
  var idName = this.idName(modelName);
  // we should return the `id` as an int if the user specified the property as an int

  if (idName && modelObject.mo.properties[idName])
    var idType = modelObject.mo.properties[idName].type.name;
  if (!doc) return doc;
  assert(doc._id);

  if (fields && !fields.includes(idName)) {
    delete doc._id;
  }

  if (doc._id) {
    if (idType === 'Number') doc[idName] = parseInt(doc._id);
    else doc[idName] = doc._id;
    delete doc._id;
  }

  for (var i = 0; i < modelObject.dateFields.length; i++) {
    var dateField = modelObject.dateFields[i];
    var dateValue = doc[dateField];
    if (dateValue) doc[dateField] = new Date(dateValue);
  }
  if (modelObject.modelView) delete doc[modelObject.modelView];
  return doc;
};

/**
 * Insert a model instance
 *
 * @param {String} model The model name
 * @param {Object} data The model data
 * @callback {Function} cb The callback function
 */
CouchDB.prototype._insert = function(model, data, options, cb) {
  const start = process.hrtime();
  var self = this;
  var idName = self.idName(model);
  var mo = self.selectModel(model, options);
  const logMessage = {
    requestId: options ? (options.req ? options.req.id || null : null) : null,
    method: '_insert',
    model: model,
    db: mo.dbName,
  };

  mo.db.insert(self.toDB(model, mo, data), function(err, result) {
    // clear the cache key for this model where cache is active
    let cacheKeys = null;
    const redisDb = getRedisInstance(mo.mo.model, options);
    if (redisDb) {
      cacheKeys = getCacheKeys(mo.mo.model, null, options, null);
      if (cacheKeys) {
        redisDb.del(cacheKeys.rKey, (delErr, delRes) => {
          if (err) {
            dbLog(start, 'error', logMessage, null, null, delErr, false);
          }
          debug('Result of cache DEL ', delRes);
        });
      }
    }

    debug('CouchDB.prototype.insert %j %j', err, result);
    if (err) {
      if (err.statusCode === 409) err.message = err.message + ' (duplicate?)';
      dbLog(start, 'error', logMessage, null, data.id, err, false);
      return cb(err);
    }
    data[idName] = result.id;

    // Convert ID to Number if Model defines ID as type Number
    if (mo.mo.properties[idName]) {
      var idType = mo.mo.properties[idName].type.name;
      if (idType === 'Number') {
        result.id = parseInt(result.id);
      }
    }
    dbLog(start, 'info', logMessage, null, result.id, null, true);
    cb(null, result.id, result.rev);
  });
};

/**
 * Create a new model instance for the given data
 *
 * @param {String} model The model name
 * @param {Object} data The model data
 * @param {Object} options The options object
 * @callback {Function} cb The callback function
 */
CouchDB.prototype.create = function(model, data, options, cb) {
  debug('CouchDB.prototype.create %j %j %j ', model, data, options);
  this._insert(model, data, options, cb);
};

/**
 * Save the model instance for the given data
 *
 * @param {String} model The model name
 * @param {Object} data The model data
 * @param {Object} options The options object
 * @callback {Function} cb The callback function
 * @returns {Function} [_insert] model insert function
 */
CouchDB.prototype.save = function(model, data, options, cb) {
  const start = process.hrtime();
  debug('CouchDB.prototype.save %j %j %j', model, data, options);
  var self = this;
  var idName = self.idName(model);
  var id = data[idName];
  var mo = self.selectModel(model, options);
  data[idName] = id.toString();

  var saveHandler = function(err, id) {
    let diff = process.hrtime(start);
    let ms = diff[0] * 1e3 + diff[1] * 1e-6;
    if (err) {
      dblogger.log({
        level: 'info',
        message: {
          requestId: options ?
            options.req ?
              options.req.id || null :
              null :
            null,
          method: 'save',
          docId: id,
          model: model,
          db: mo.dbName,
          success: false,
          err: err,
          time: ms,
        },
      });
      return cb(err);
    }
    mo.db.get(id, function(err, doc) {
      if (err) return cb(err);
      diff = process.hrtime(start);
      ms = diff[0] * 1e3 + diff[1] * 1e-6;
      dblogger.log({
        level: 'info',
        message: {
          requestId: options ?
            options.req ?
              options.req.id || null :
              null :
            null,
          method: 'save',
          docId: id,
          model: model,
          db: mo.dbName,
          success: true,
          err: null,
          time: ms,
        },
      });
      cb(null, self.fromDB(model, mo, doc));
    });
  };
  self._insert(model, data, options, saveHandler);
};

/**
 * Get the current document revision
 *
 * @param {String} model The model name
 * @param {String} id Instance id
 * @callback {Function} cb The callback function
 */
CouchDB.prototype.getCurrentRevision = function(model, id, cb) {
  var mo = this.selectModel(model);
  mo.db.head(id, function(err, stuff, headers) {
    if (err) {
      if (err.statusCode === 404) {
        err.message = g.f('No instance with id %s found for %s', id, model);
        err.code = 'NOT_FOUND';
      }
      return cb(err, null);
    }
    if (headers && !headers.etag) return cb(err, null);
    cb(null, headers.etag.substr(1, headers.etag.length - 2));
  });
};

function getRedisInstance(modelInstance, options) {
  let redisDb = null;
  // TODO integration tests should use cache
  if (modelInstance.settings && modelInstance.settings.useCache) {
    if (process.env.NODE_ENV !== 'test') {
      if (
        (options && options.req && options.req.redisDb) ||
        modelInstance.name === 'Account'
      ) {
        if (
          modelInstance.name === 'Account' &&
          process.env.NODE_ENV !== 'test' &&
          (!options || !options.req || !options.req.redisDb)
        ) {
          const redisConnection = require('redis');
          redisDb = redisConnection.createClient(
            {
              host: process.env.REDIS_HOST || '127.0.0.1',
              port: process.env.REDIS_PORT || '6379',
              db: process.env.REDIS_DB || '2',
              prefix: process.env.ENV_NAME || 'development',
            }
          );
        } else {
          redisDb = options.req.redisDb;
        }
      }
    }
  }
  return redisDb;
}

function getCacheKeys(modelInstance, method, options, data = null) {
  if (modelInstance.settings.cacheKey && modelInstance.settings.cacheField) {
    const renderContext = {
      options: options,
      Model: modelInstance,
      data: data,
    };
    // TODO if template rendering fails, log error, return null
    const rKey = ejs.render(modelInstance.settings.cacheKey, renderContext);
    let rField = ejs.render(modelInstance.settings.cacheField, renderContext);
    if (method) {
      rField = `${rField}:${method}`;
    }
    if (data) {
      rField = `${rField}:${hash(data)}`;
    }
    return {rKey: rKey, rField: rField};
  } else {
    return null;
  }
}

function _msDiff(start) {
  const diff = process.hrtime(start);
  return diff[0] * 1e3 + diff[1] * 1e-6;
}

function dbLog(
  start,
  level = 'info',
  message,
  result,
  docId = null,
  err = null,
  success = true
) {
  message.result = result;
  message.err = err;
  message.success = success;
  message.docId = docId;
  message.time = _msDiff(start);
  dblogger.log({
    level: level,
    message,
  });
}

/**
 * Find matching model instances by the filter
 *
 * @param {String} model The model name
 * @param {Object} filter The filter
 * @param {Object} options The options object
 * @callback {Function} cb The callback function
 */
CouchDB.prototype.all = function all(model, filter, options, cb) {
  let getCachedResult = true;
  const start = process.hrtime();
  var self = this;
  var docs = [];
  var include = null;
  var mo = self.selectModel(model, options);
  /* eslint-disable camelcase */
  var query = {
    selector: self.buildSelector(model, mo, filter.where, options),
  };

  const logMessage = {
    requestId: options ? (options.req ? options.req.id || null : null) : null,
    method: 'all',
    model: model,
    db: mo.dbName,
    query: query,
  };

  // if the user specifies use_index
  if (options.use_index) query.use_index = options.use_index;

  /* eslint-enable camelcase */
  if (filter.couchFields) query.fields = filter.couchFields;
  if (filter.offset) query.skip = filter.offset;
  // If the query is for an include, a high limit is applied to ensure all related records are found
  // this is overridden below if an explicit limit was specified for the include
  if (options.include) query.limit = 99999;
  if (filter.limit) query.limit = filter.limit;
  if (filter.fields) query.fields = filter.fields.concat('_id');
  if (filter.order) query.sort = self.buildSort(mo, model, filter.order);
  debug('CouchDB.prototype.all %j %j %j', model, filter, query);
  include = function(docs, cb) {
    if (!options || !options.raw) {
      for (var i = 0; i < docs.length; i++) {
        self.fromDB(model, mo, docs[i], filter.fields);
      }
    }
    if (filter && filter.include) {
      // Add include boolean to the options object to be passed to subsequent queries
      options.include = true;
      self._models[model].model.include(docs, filter.include, options, cb);
    } else {
      cb();
    }
  };

  let cacheKeys = null;
  const redisDb = getRedisInstance(mo.mo.model, options);
  if (redisDb) {
    cacheKeys = getCacheKeys(mo.mo.model, 'all', options, filter);
    if (cacheKeys) {
      logMessage.cacheKey = cacheKeys.rKey;
      logMessage.cacheField = cacheKeys.rField;
      debug(`Checking cache ${cacheKeys.rKey}:${cacheKeys.rField}`);
      // TODO conditional cache check - i.e. certain filter query field combos - or use query in key
      redisDb.hget(
        cacheKeys.rKey,
        cacheKeys.rField,
        (cacheErr, cacheResult) => {
          if (cacheResult && !cacheErr) {
            const parsedResult = JSON.parse(cacheResult);
            logMessage.cache = true;
            dbLog(
              start,
              'info',
              logMessage,
              cacheResult,
              null,
              null,
              true
            );
            return cb(null, parsedResult);
          } else if (cacheErr) {
            debug('CACHE ERROR ', cacheErr);
          }
          debug('No cache, fetching data');
          self._findRecursive(mo, query, docs, include, options, function(
            err,
            result
          ) {
            if (err) {
              debug('Error fetching data ', err);
              dbLog(
                start,
                'error',
                logMessage,
                result ? result.docs ? result.docs.length || null : null : null,
                null,
                err,
                false
              );
              return cb(err, result);
            }

            dbLog(
              start,
              'info',
              logMessage,
              result.docs.length,
              null,
              null,
              true
            );

            debug('Setting result in cache');
            return redisDb.hset(
              cacheKeys.rKey,
              cacheKeys.rField,
              JSON.stringify(result.docs),
              (hsetErr, hsetResult) => {
                debug('HSET result: ', hsetResult);
                if (hsetErr) {
                  dbLog(
                    start,
                    'error',
                    logMessage,
                    result.docs.length,
                    null,
                    err,
                    false
                  );
                  debug('HSET error: ', hsetErr);
                }
                debug('returning result after caching');
                return cb(null, result.docs);
              }
            );
          });
        }
      );
    } else {
      getCachedResult = false;
    }
  } else {
    getCachedResult = false;
  }

  if (!getCachedResult) {
    self._findRecursive(mo, query, docs, include, options, function(
      err,
      result
    ) {
      if (err) {
        dbLog(start, 'error', logMessage, result.docs.length, null, err, false);
        return cb(err, result);
      }

      dbLog(start, 'info', logMessage, result.docs.length, null, null, true);
      cb(null, result.docs);
    });
  }
};

/**
 * Build query selector
 *
 * @param {String} model The model name
 * @param {Object} mo The model object generated by selectModel()
 * @param {Object} where The where filter
 */
CouchDB.prototype.buildSelector = function(model, mo, where, options) {
  var self = this;
  var query = mo.modelSelector || {};
  if (mo.modelSelector === null) query[mo.modelView] = model;
  if (where === null || typeof where !== 'object') return query;

  var idName = self.idName(model);

  return self._buildQuery(model, idName, query, where, options);
};

/**
 * Build a sort query using order filter
 *
 * @param {Object} mo The model object
 * @param {String} model The model name
 * @param {Object} order The order filter
 */
CouchDB.prototype.buildSort = function(mo, model, order) {
  debug('CouchDB.prototype.buildSort %j', order);
  var field, fieldType, nestedFields, obj;
  var sort = [];
  var props = mo.mo.properties;
  var idName = this.idName(model);

  if (!order) order = idName;
  if (typeof order === 'string') order = order.split(',');

  for (var i in order) {
    var k = order[i];
    var m = k.match(/\s+(A|DE)SC$/);
    var n = k.replace(/\s+(A|DE)SC$/, '').trim();
    obj = {};

    if (n === idName) n = '_id';

    if (m && m[1] === 'DE') obj[n] = 'desc';
    else obj[n] = 'asc';
    sort.push(obj);
  }
  debug('CouchDB.prototype.buildSort order: %j sort: %j', order, sort);
  return sort;
};

/**
 * make it a private function, maybe need it somewhere
 */
CouchDB.prototype._destroy = function _destroy(model, id, rev, options, cb) {
  debug('CouchDB.prototype._destroy %j %j %j', model, id, rev, options);
  var self = this;
  var mo = self.selectModel(model, options);
  id = id.toString();
  mo.db.destroy(id, rev, function(err, result) {
    if (err) return cb(err, null);
    cb(null, {id: id, rev: rev, count: 1});
  });
};

/**
 * Delete a model instance by id
 *
 * @param {String} model The model name
 * @param {*} id The id value
 * @param {Object} options The options object
 * @param [cb] The cb function
 */
CouchDB.prototype.destroy = function destroy(model, id, options, cb) {
  const start = process.hrtime();
  var mo = this.selectModel(model, options);
  const passedOptions = {raw: true};
  Object.assign(passedOptions, options);
  const logMessage = {
    requestId: options ? (options.req ? options.req.id || null : null) : null,
    method: 'destroy',
    model: model,
    db: mo.dbName,
  };
  this.all(model, {where: {id: id}}, passedOptions, function(err, doc) {
    if (err) return cb(err);
    if (doc.length > 1)
      cb(
        new Error('instance method destroy tries to delete more than one item!')
      );
    else if (doc.length === 1) {
      mo.db.destroy(doc[0]._id, doc[0]._rev, function(err, result) {
        // clear the cache key for this model where cache is active
        let cacheKeys = null;
        const redisDb = getRedisInstance(mo.mo.model, options);
        if (redisDb) {
          cacheKeys = getCacheKeys(mo.mo.model, null, options, null);
          if (cacheKeys) {
            redisDb.del(cacheKeys.rKey, (delErr, delRes) => {
              if (err) {
                dbLog(start, 'error', logMessage, null, null, delErr, false);
              }
              debug('Result of cache DEL ', delRes);
            });
          }
        }
        debug('CouchDB.prototype.destroy db.destroy %j %j', err, result);
        if (err) return cb(err);
        cb(err, result && result.ok ? {count: 1} : {count: 0});
      });
    } else {
      return cb(null, {count: 0});
    }
  });
};

/**
 * Delete all instances for the given model
 *
 * @param {String} model The model name
 * @param {Object} [where] The filter for where
 * @param {Object} options The options object
 * @callback {Function} cb The callback function
 */
CouchDB.prototype.destroyAll = function destroyAll(model, where, options, cb) {
  const start = process.hrtime();
  debug('CouchDB.prototype.destroyAll %j %j %j', model, where, options);

  var self = this;
  var dels = 0;
  var mo = self.selectModel(model, options);

  const passedOptions = {raw: true};
  Object.assign(passedOptions, options);
  const logMessage = {
    requestId: options ? (options.req ? options.req.id || null : null) : null,
    method: 'destroyAll',
    model: model,
    db: mo.dbName,
  };

  self.all(
    model,
    {where: where, limit: self.getLimit()},
    passedOptions,
    function(err, docs) {
      if (err) return cb(err, null);
      async.each(
        docs,
        function(doc, cb2) {
          mo.db.destroy(doc._id, doc._rev, function(err, result) {
            // clear the cache key for this model where cache is active
            let cacheKeys = null;
            const redisDb = getRedisInstance(mo.mo.model, options);
            if (redisDb) {
              cacheKeys = getCacheKeys(mo.mo.model, null, options, null);
              if (cacheKeys) {
                redisDb.del(cacheKeys.rKey, (delErr, delRes) => {
                  if (err) {
                    dbLog(start, 'error', logMessage, null, null, delErr, false);
                  }
                  debug('Result of cache DEL ', delRes);
                });
              }
            }
            debug('CouchDB.prototype.destroyAll db.destroy %j %j', err, result);
            if (result && result.ok) dels++;
            cb2(err);
          });
        },
        function(err) {
          cb(err, {count: dels});
        }
      );
    }
  );
};

/**
 * Recursive function to count the number of instances for the given model with a
 * low limit to preserve memory
 *
 * @param {Object} self The context from the calling function
 * @param {String} model The model name
 * @param {Object} where The where filter
 * @param {Object} options The options Object
 * @param {Number} offset The offset (incremented on each call)
 * @docCount {Number} The accumulator
 * @callback {Function} cb The callback function
 */
// function accumulateCount(self, model, where, options, offset, docCount, cb) {
//   let limit = 50000;
//   self.all(
//     model,
//     {couchFields: ['_id'], where: where, limit: limit, offset: offset},
//     options,
//     function(err, docs) {
//       if (err) {
//         return cb(err);
//       }
//       if (docs && docs.length > 0) {
//         docCount = docCount + docs.length;
//         docs = [];
//         offset = offset + limit;
//         accumulateCount(
//           self,
//           model,
//           where,
//           options,
//           offset,
//           docCount,
//           (err, result) => {
//             if (err) {
//               return cb(err);
//             }
//             return cb(null, result);
//           }
//         );
//       } else {
//         return cb(null, docCount);
//       }
//     }
//   );
// }

/**
 * Count the number of instances for the given model
 *
 * @param {String} model The model name
 * @callback {Function} cb The callback function
 * @param {Object} options The options Object
 * @param {Object} filter The filter for where
 */
CouchDB.prototype.count = function count(model, where, options, cb) {
  debug('CouchDB.prototype.count %j %j %j', model, where, options);
  var self = this;
  let offset = 0;

    self.all(
    model,
    {couchFields: ['_id'], where: where, limit: 99999, offset: offset},
    options,
    function(err, docs) {
      if (err) {
        return cb(err);
      }
        return cb(null, docs.length);
    }
  );
  // accumulateCount(self, model, where, options, offset, 0, (err, result) => {
  //   return cb(err, result);
  // });
};

/**
 * Check if a model instance exists by id
 *
 * @param {String} model The model name
 * @param {*} id The id value
 * @param {Object} options The options Object
 * @callback {Function} cb The callback function
 */
CouchDB.prototype.exists = function(model, id, options, cb) {
  debug('CouchDB.prototype.exists %j %j %j', model, id, options);
  var self = this;
  var idName = self.idName(model);
  var where = {};
  where[idName] = id;
  self.count(model, where, {}, function(err, cnt) {
    if (err) return cb(err, 0);
    cb(null, cnt);
  });
};

/**
 * Find a model instance by id
 *
 * @param {String} model The model name
 * @param {*} id The id value
 * @param {Object} options The options object
 * @callback {Function} cb The callback function
 */
CouchDB.prototype.find = CouchDB.prototype.findById = function(
  model,
  id,
  options,
  cb
) {
  const start = process.hrtime();
  debug('CouchDB.prototype.find %j %j %j', model, id, options);
  var self = this;
  var mo = self.selectModel(model, options);
  mo.db.get(id, function(err, doc) {
    let diff = process.hrtime(start);
    let ms = diff[0] * 1e3 + diff[1] * 1e-6;
    if (err) {
      dblogger.log({
        level: 'info',
        message: {
          requestId: options ?
            options.req ?
              options.req.id || null :
              null :
            null,
          method: 'findById',
          docId: id,
          model: model,
          db: mo.dbName,
          query: id,
          success: false,
          err: err,
          time: ms,
        },
      });
    }
    if (err && err.statusCode === 404) return cb(null, []);
    if (err) return cb(err);
    diff = process.hrtime(start);
    ms = diff[0] * 1e3 + diff[1] * 1e-6;
    dblogger.log({
      level: 'info',
      message: {
        requestId: options ?
          options.req ?
            options.req.id || null :
            null :
          null,
        method: 'findById',
        docId: id,
        model: model,
        db: mo.dbName,
        query: id,
        success: true,
        err: null,
        time: ms,
      },
    });
    cb(null, self.fromDB(model, mo, doc));
  });
};

/**
 * Update properties for the model instance data
 *
 * @param {String} model The model name
 * @param {Object} data The model data
 * @param {Object} options The options Object
 * @callback {Function} cb The callback function
 */
CouchDB.prototype.updateAttributes = function(model, id, data, options, cb) {
  debug(
    'CouchDB.prototype.updateAttributes %j %j %j',
    model,
    id,
    data,
    options
  );
  var self = this;
  var mo = self.selectModel(model, options);
  mo.db.get(id, function(err, doc) {
    if (err) return cb(err);
    data = self._getPlainJSONData.call(self, model, data);
    _.mergeWith(doc, data, function(dest, src) {
      return src;
    });
    self.create(model, doc, options, function(err, id, rev) {
      if (err) return cb(err);
      debug('GD TEST %j %j', id, rev);
      doc._rev = rev;
      // API-202 - PATCH should return latest _rev
      return cb(err, self.fromDB(model, mo, doc));
    });
  });
};

/**
 * Update if the model instance exists with the same id or create a
 * new instance
 *
 * @param {String} model The model name
 * @param {Object} data The model instance data
 * @param {Object} options The options Object
 * @callback {Function} cb The callback function
 */
CouchDB.prototype.updateOrCreate = function(model, data, options, cb) {
  debug('CouchDB.prototype.updateOrCreate %j %j', model, data);
  var self = this;
  var idName = self.idName(model);
  var mo = self.selectModel(model, options);
  var id = data[idName].toString();

  // Callback handler for both create calls.
  var createHandler = function(err, id) {
    if (err) return cb(err);
    mo.db.get(id, function(err, doc) {
      if (err) return cb(err);
      return cb(err, self.fromDB(model, mo, doc), {isNewInstance: true});
    });
  };

  if (id) {
    self.updateAttributes(model, id, data, {}, function(err, docs) {
      if (err && err.statusCode !== 404) return cb(err);
      else if (err && err.statusCode === 404) {
        self.create(model, data, options, createHandler);
      } else {
        return cb(err, docs, {isNewInstance: false});
      }
    });
  } else {
    self.create(model, data, options, createHandler);
  }
};

/**
 * Update all matching instances
 * @param {String} model The model name
 * @param {Object} where The search criteria
 * @param {Object} data The property/value pairs to be updated
 * @param {Object} options The options Object
 * @callback {Function} cb The callback function
 */
CouchDB.prototype.update = CouchDB.prototype.updateAll = function(
  model,
  where,
  data,
  options,
  cb
) {
  const start = process.hrtime();

  debug('CouchDB.prototype.updateAll %j %j %j %j', model, where, data, options);
  var self = this;
  var mo = self.selectModel(model, options);
  const passedOptions = {raw: true};
  Object.assign(passedOptions, options);
  const logMessage = {
    requestId: options ? (options.req ? options.req.id || null : null) : null,
    method: 'update',
    model: model,
    db: mo.dbName,
  };
  self.all(model, {where: where}, passedOptions, function(err, docs) {
    if (err) return cb(err, docs);
    if (docs.length === 0) return cb(null, {count: 0});

    data = self._getPlainJSONData.call(self, model, data);
    async.each(
      docs,
      function(doc, cb) {
        _.mergeWith(doc, data, function(dest, src) {
          return src;
        });
        return cb();
      },
      function(err) {
        if (err) return cb(err);
        mo.db.bulk({docs: docs}, function(err, result) {
          // clear the cache key for this model where cache is active
          let cacheKeys = null;
          const redisDb = getRedisInstance(mo.mo.model, options);
          if (redisDb) {
            cacheKeys = getCacheKeys(mo.mo.model, null, options, null);
            if (cacheKeys) {
              redisDb.del(cacheKeys.rKey, (delErr, delRes) => {
                if (err) {
                  dbLog(start, 'error', logMessage, null, null, delErr, false);
                }
                debug('Result of cache DEL ', delRes);
              });
            }
          }
          if (err) return cb(err);
          var errorArray = _.filter(result, 'error');
          if (errorArray.length > 0) {
            err = new Error(
              g.f(
                util.format(
                  'Unable to update 1 or more ' + 'document(s): %s',
                  util.inspect(result, 2)
                )
              )
            );
            return cb(err);
          } else {
            return cb(err, {count: result.length});
          }
        });
      }
    );
  });
};

/**
 * Perform a bulk update on a model instance
 *
 * @param {String} model The model name
 * @param {Array} dataList List of data to be updated
 * @param {Object} options The options Object
 * @callback {Function} cb The callback function
 */
CouchDB.prototype.bulkReplace = function(model, dataList, options, cb) {
  debug('CouchDB.prototype.bulkReplace %j %j', model, dataList);
  var self = this;
  var mo = self.selectModel(model, options);

  var dataToBeUpdated = _.map(dataList, function(data) {
    return self.toDB(model, mo, data);
  });

  mo.db.bulk({docs: dataToBeUpdated}, function(err, result) {
    if (err) return cb(err);
    var errorArray = _.filter(result, 'error');
    if (errorArray.length > 0) {
      err = new Error(
        g.f(
          util.format(
            'Unable to update 1 or more ' + 'document(s): %s',
            util.inspect(result, 2)
          )
        )
      );
      return cb(err);
    } else {
      return cb(err, result);
    }
  });
};

/**
 * Ping the DB for connectivity
 * @callback {Function} cb The callback function
 */
CouchDB.prototype.ping = function(cb) {
  debug('CouchDB.prototype.ping');
  this.getDriverInst().db.list(function(err, result) {
    debug('CouchDB.prototype.ping results %j %j', err, result);
    if (err) cb(new Error('ping failed'));
    else cb();
  });
};

/**
 * Replace if the model instance exists with the same id or create a
 * new instance
 *
 * @param {String} model The model name
 * @param {Object} data The model instance data
 * @param {Object} options The options Object
 * @callback {Function} cb The callback function
 */
CouchDB.prototype.replaceOrCreate = function(model, data, options, cb) {
  debug('CouchDB.prototype.replaceOrCreate %j %j', model, data);
  var self = this;
  var idName = self.idName(model);
  var mo = self.selectModel(model, options);
  var id = data[idName].toString();

  // Callback handler for both create calls.
  var createHandler = function(err, id) {
    if (err) return cb(err);
    mo.db.get(id, function(err, doc) {
      if (err) return cb(err);
      cb(err, self.fromDB(model, mo, doc), {isNewInstance: true});
    });
  };

  self.exists(model, id, {}, function(err, count) {
    if (err) return cb(err);
    else if (count > 0) {
      self._insert(model, data, options, function(err) {
        if (err) return cb(err);
        mo.db.get(id, function(err, doc) {
          if (err) return cb(err);
          cb(err, self.fromDB(model, mo, doc), {isNewInstance: false});
        });
      });
    } else {
      self.create(model, data, options, createHandler);
    }
  });
};

/**
 * Replace properties for the model instance data
 *
 * @param {String} model The name of the model
 * @param {*} id The instance id
 * @param {Object} data The model data
 * @param {Object} options The options object
 * @callback {Function} cb The callback function
 */

CouchDB.prototype.replaceById = function(model, id, data, options, cb) {
  debug('CouchDB.prototype.replaceById %j %j %j', model, id, data);
  var self = this;
  var mo = self.selectModel(model, options);
  var idName = self.idName(model);
  var newData = _.clone(data);
  newData[idName] = id.toString();

  var replaceHandler = function(err, id) {
    if (err) return cb(err);
    mo.db.get(id, function(err, doc) {
      if (err) return cb(err);
      cb(null, self.fromDB(model, mo, doc));
    });
  };
  self._insert(model, newData, options, replaceHandler);
};

/**
 * Select the correct DB. This is typically specified on the datasource
 * configuration but this connector also supports per model DB config
 * @param {String} model The model name
 */
CouchDB.prototype.selectModel = function(model, options, migrate) {
  var self = this;
  var dbName, db, mo;
  var modelView = null;
  var modelSelector = null;
  var dateFields = [];
  var s = this.settings;

  // Safeguard unexpected DB selection if the correct context is not provided
  // in dbSwitching mode
  if ((!options || !options.db) && this.dbSwitching) {
    throw new Error('No database provided in context with dbSwitching active');
  }

  db = this.pool[model];
  // The following line re-uses a previously created db instance
  // to enable project switching per request it is disabled
  if (!this.dbSwitching) {
    if (db && !migrate) return db;
  }

  mo = this._models[model];
  var dbSettings = self.getModelObjectSettings(mo);

  if (mo && dbSettings) {
    dbName = dbSettings.db || dbSettings.database;
    // model settings level: `modelSelector` overrides `modelView`
    if (dbSettings.modelSelector) {
      modelSelector = dbSettings.modelSelector;
    } else {
      modelView = dbSettings.modelIndex;
    }
  }
  if (!dbName) dbName = s.database || s.db || 'test';

  // DB switching per request, unless the current datasource db is in the exceptions list
  if (this.dbSwitching) {
    if (!this.dbSwitchingExceptions.includes(dbName)) {
      dbName = options.db;
    }
  }

  if (!modelView && modelSelector === null) {
    modelView = s.modelIndex || self.defaultModelView();
  }

  for (var p in mo.properties) {
    if (mo.properties[p].type.name === 'Date') {
      dateFields.push(p);
    }
  }
  var idName = this.idName(model);
  debug('CouchDB.prototype.selectModel use %j', dbName);
  this.pool[model] = {
    mo: mo,
    db: self.getDriverInst().use(dbName),
    idName: idName,
    modelView: modelView,
    modelSelector: modelSelector,
    dateFields: dateFields,
    dbName: dbName,
  };

  // nano doesn't have api 'find' while nodejs-cloudant has
  if (!this.pool[model].db.find) {
    this.pool[model].db.find = function(query, cb) {
      self._find(dbName, query, cb);
    };
  }
  return this.pool[model];
};

/**
 * Replaces the new revalue
 *
 * @param {Object} [context] Juggler defined context data.
 * @param {Object} [data] The real data sent out by the connector.
 */
CouchDB.prototype.generateContextData = function(context, data) {
  context.data._rev = data._rev;
  return context;
};

/**
 * Update the indexes.
 *
 * Properties Example:
 *    "name": { "type": "String", "index": true },
 *
 * Indexes Example:
 * "indexes": {
 *   "ignore": {
 *      "keys": {"name": 1, "age": -1}
 *   },
 *   "ignore": {"age": -1},
 *   "ignore": {"age1": 1, "age2":1}
 *        "<key2>": -1
 *
 * @param {Object} mo The model object
 * @param {String} modelName The model name
 * @callback {Function} cb The callback function
 */
CouchDB.prototype.updateIndex = function(mo, modelName, cb) {
  /* eslint-disable camelcase */
  var idx = {
    type: 'text',
    name: 'lb-index-' + modelName,
    ddoc: 'lb-index-ddoc-' + modelName,
    index: {
      default_field: {
        enabled: false,
      },
      selector: mo.modelSelector || {},
    },
  };
  /* eslint-enable camelcase */
  var indexView = util.inspect(idx, 4);
  debug(
    'CouchDB.prototype.updateIndex -- modelName %s, idx %s',
    modelName,
    indexView
  );
  if (mo.modelSelector === null) {
    idx.index.selector[mo.modelView] = modelName;
  }
  mo.db.index(idx, function(err, result) {
    debug('CouchDB.prototype.updateIndex index %j %j', err, result);
    if (cb) {
      cb(err, result);
    }
  });
};

/**
 * If input is a model instance, convert to a plain JSON object
 * The input would be a model instance when the request is made from
 * REST endpoint as remoting converts it to model if endpoint expects a
 * model instance
 *
 * @param {String} model The model name
 * @param {Object} data The model data
 */
CouchDB.prototype._getPlainJSONData = function(model, data) {
  if (this._models[model] && data instanceof this._models[model].model)
    return data.toJSON();
  return data;
};

/** Build query for selection
 *
 * @param {Object} mo The model object
 * @param {String} model The model name
 * @param {Object} query The query object
 * @param {Object} where The where filter
 */
CouchDB.prototype._buildQuery = function(model, idName, query, where, options) {
  var self = this;
  var containsRegex = false;
  var mo = self.selectModel(model, options);
  var opts = options;

  Object.keys(where).forEach(function(k) {
    var cond = where[k];
    if (k === 'and' || k === 'or' || k === 'nor') {
      if (Array.isArray(cond)) {
        cond = cond.map(function(c) {
          return self.buildSelector(model, mo, c, opts);
        });
      }
      query['$' + k] = cond;
      delete query[k];
      return;
    }
    if (k === idName) {
      k = '_id';
      cond =
        typeof cond === 'object' || Array.isArray(cond) ?
          cond :
          cond.toString();
    }
    var spec = false;
    var options = null;
    if (cond && cond.constructor.name === 'Object') {
      options = cond.options;
      spec = Object.keys(cond)[0];
      cond = cond[spec];
    }
    if (spec) {
      var selectedOperator = self._selectOperator(spec, cond, containsRegex);
      query[k] = selectedOperator[0];
      containsRegex = selectedOperator[1];
    } else query[k] = cond;

    var filterWithArray = self._buildFilterArr(k, mo.mo.properties);

    // unfold the string filter to nested object
    // e.g. {'address.tags.$elemMatch.tag': 'business'} =>
    // {address: {tags: {$elemMatch: {tag: 'business'}}}}
    if (typeof filterWithArray === 'string') {
      var kParser = filterWithArray.split('.');
      if (kParser.length > 1) {
        query[kParser.shift()] = buildUnfold(kParser);
      } else {
        if (filterWithArray === k) return;
        query[filterWithArray] = query[k];
      }
      function buildUnfold(props) {
        var obj = {};
        if (props.length === 1) {
          obj[props[0]] = query[k];
          return obj;
        }
        obj[props.shift()] = buildUnfold(props);
        return obj;
      }
    } else {
      if (filterWithArray === k) return;
      query[filterWithArray] = query[k];
    }
    delete query[k];
  });

  if (containsRegex && !query['_id']) {
    query['_id'] = {
      $gt: null,
    };
  }
  return query;
};

/** Select operator with a condition
 *
 * @param {String} op The spec operator
 * @param {Object[]} cond Array of conditions
 * @param {Boolean} regex If the condition is regex
 */
CouchDB.prototype._selectOperator = function(op, cond, regex) {
  var newQuery = {};
  var containsRegex = regex;
  switch (op) {
    case 'between':
      newQuery = {$gte: cond[0], $lte: cond[1]};
      break;
    case 'inq':
      newQuery = {
        $in: cond.map(function(x) {
          return x;
        }),
      };
      break;
    case 'nin':
      newQuery = {
        $nin: cond.map(function(x) {
          return x;
        }),
      };
      break;
    case 'neq':
      newQuery = {$ne: cond};
      break;
    case 'like':
      newQuery = {$regex: this._regexToPCRE(cond)};
      containsRegex = true;
      break;
    case 'nlike':
      var negative = true;
      newQuery = {$regex: this._regexToPCRE(cond, negative)};
      containsRegex = true;
      break;
    case 'regexp':
      if (cond.constructor.name === 'RegExp') {
        if (cond.global)
          g.warn('CouchDB {{regex}} syntax does not support global');
        var expression = cond.source;
        if (cond.ignoreCase) expression = '(?i)' + expression;
        newQuery = {$regex: expression};
        containsRegex = true;
      } else {
        newQuery = {$regex: cond};
        containsRegex = true;
      }
      break;
    default:
      newQuery = {};
      newQuery['$' + op] = cond;
  }
  return [newQuery, containsRegex];
};

/** Build a PCRE compatiable regular expression from a javascript regular expression
 *
 * @param {String|RegExp} regex Suspected regular expression
 */
CouchDB.prototype._regexToPCRE = function(regex, negative) {
  if (typeof regex === 'string' || !(regex instanceof RegExp))
    return negative ? '[^' + regex + ']' : regex;

  var flags = regex.flags ? '(?' + regex.flags + ')' : '';
  var source = regex.source;

  if (negative) return flags + '[^' + source + ']';
  return flags + source;
};

/** Build an array of filter
 *
 * @param {String} k Keys from the filter
 * @param {Object[]} props List of model properties
 * @param {Boolean} regex If the condition is regex
 */
CouchDB.prototype._buildFilterArr = function(k, props) {
  // return original k if k is not a String OR there is no properties OR k is not a nested property
  if (typeof k !== 'string' || !props) return k;
  var fields = k.split('.');
  var len = fields.length;
  if (len <= 1) return k;

  var newFields = [];
  var currentProperty = props;
  var field = '';
  var propIsArr = false;
  var propIsObjWithTypeArr = false;

  for (var i = 0; i < len; i++) {
    if (propIsArr) {
      // when Array.isArray(property) is true
      currentProperty = currentProperty.filter(containsField);
      if (currentProperty.length < 1) field = null;
      else {
        currentProperty = currentProperty[0];
        field = currentProperty[fields[i]];
      }
      function containsField(obj) {
        return obj.hasOwnProperty(fields[i]);
      }
      // reset the flag
      propIsArr = false;
    } else if (propIsObjWithTypeArr) {
      // when property is an Object but its type is Array
      // e.g. my_prop: {
      //  type: 'array',
      //  0: {nestedprop1: 'string'},
      //  1: {nestedprop2: 'number'}
      // }
      field = null;
      for (var property in currentProperty) {
        if (property === 'type') continue;
        if (currentProperty[property].hasOwnProperty(fields[i])) {
          currentProperty = currentProperty[property];
          field = currentProperty[fields[i]];
          break;
        }
      }
      // reset the flag
      propIsObjWithTypeArr = false;
    } else field = currentProperty[fields[i]];
    // if a nested field doesn't exist, return k. therefore if $elemMatch provided we don't add anything
    if (!field) return k;

    newFields.push(fields[i]);
    if (isArray(field)) newFields.push('$elemMatch');
    currentProperty = field;
  }
  function isArray(elem) {
    if (Array.isArray(elem)) {
      propIsArr = true;
      return true;
    }
    if (
      typeof elem === 'object' &&
      (Array.isArray(elem.type) || elem.type === 'Array')
    ) {
      propIsObjWithTypeArr = true;
      return true;
    }
    return false;
  }
  return newFields.join('.');
};

/**
 *  Apply find queries function
 *
 * @param {Object} mo The selected model
 * @param {Object} query The query to filter
 * @param {Object[]} docs Model document/data
 * @param {Object} include Include filter
 * @callback {Function} cb The callback function
 */
CouchDB.prototype._findRecursive = function(
  mo,
  query,
  docs,
  include,
  options,
  cb
) {
  var self = this;
  if (mo.explain) {
    self.couchdb.relax(
      {db: mo.dbName, method: 'post', path: '_explain', body: query},
      (err, rst) => {
        indexExplain(
          'Explain: %j: %j: %j: %j',
          mo.mo.model.modelName,
          query,
          rst.index.ddoc,
          rst.index.def
        );
      }
    );
  }
  mo.db.find(query, function(err, rst) {
    debug('CouchDB.prototype.all (findRecursive) results: %j', err);
    if (err) {
      dblogger.log({
        level: 'info',
        message: {
          requestId: options ?
            options.req ?
              options.req.id || null :
              null :
            null,
          method: 'findRecursive',
          docId: null,
          model: mo.modelName,
          db: mo.dbName,
          success: true,
          err: null,
          query: query,
          time: null,
        },
      });
      return cb(err);
    }
    if (rst && rst.warning) {
      dblogger.log({
        level: 'info',
        message: {
          requestId: options ?
            options.req ?
              options.req.id || null :
              null :
            null,
          method: 'findRecursive',
          docId: null,
          model: mo.modelName,
          db: mo.dbName,
          success: true,
          err: null,
          indexWarning: rst ? rst.warning || null : null,
          query: query,
          time: null,
        },
      });
      indexWarning('%j: %j: %j', rst ? rst.warning || null : null, mo.modelName, query);
    }

    // only sort numeric id if the id type is of Number
    var idName = self.getIdName(mo.mo.model.modelName);
    if (
      !!idName &&
      mo.mo.properties[idName].type.name === 'Number' &&
      query.sort
    )
      self._sortNumericId(rst.docs, query.sort);

    // work around for issue
    // https://github.com/strongloop/loopback-connector-Couchdb/issues/73
    if (!rst.docs) {
      var queryView = util.inspect(query, 4);
      debug('findRecursive query: %s', queryView);
      var errMsg = util.format(
        'No documents returned for query: %s',
        queryView
      );
      return cb(new Error(g.f(errMsg)));
    }
    include(rst.docs, function(err) {
      if (err) return cb(err);
      self._extendDocs(rst, docs, query, mo, include, options, cb);
    });
  });
};

/**
 * extend docs function
 *
 * @param {Object} rst the resulting query
 * @param {Object[]} docs Model document/data
 * @callback {Function} cb The callback function
 */
CouchDB.prototype._extendDocs = function(
  rst,
  docs,
  query,
  mo,
  include,
  options,
  cb
) {
  var self = this;
  if (query.limit) {
    if (docs.length === 0 && rst.docs.length <= query.limit)
      return cb(null, rst);
  }
  for (var i = 0; i < rst.docs.length; i++) {
    docs.push(rst.docs[i]);
  }
  if (rst.bookmark && rst.bookmark !== 'nil') {
    if (query.bookmark === rst.bookmark) {
      rst.docs = docs;
      cb(null, rst);
    } else {
      query.bookmark = rst.bookmark;
      self._findRecursive(mo, query, docs, include, options, cb);
    }
  } else {
    cb(null, rst);
  }
};

/**
 * Sort ids in numerical order
 *
 * @param {Object} docs Model document/data
 * @param {Object[]} filter Sorting filter
 */
CouchDB.prototype._sortNumericId = function(docs, filter) {
  filter.forEach(function(f) {
    if (f.hasOwnProperty('_id')) {
      var sortType = f['_id'];
      if (Array.isArray(docs))
        if (sortType === 'desc')
          docs
            .sort(function(a, b) {
              return parseInt(a._id) - parseInt(b._id);
            })
            .reverse();
        else
          docs.sort(function(a, b) {
            return parseInt(a._id) - parseInt(b._id);
          });
    }
  });
};

/**
 * Return idName for model existing in this.pool
 *
 * Apply to the following scenario:
 * ```javascript
 * var Test;
 * Test = db.define('Test', {oldid: String});
 * db.automigrate('Test', function(err) {
 *   Test = db.define('Test', {newid: String});
 *   db.automigrate('Test', cb);
 * });
 * ```
 *
 * `automigrate` first destroy all old data then autoupdate, which
 * also updates `this.pool` with the new model config, but it still
 * needs the old id name when destroy the data.
 *
 * @param {String} model The model name
 */
CouchDB.prototype.getIdName = function(model) {
  var self = this;
  var cachedModel = self.pool[model];
  if (!!cachedModel) return cachedModel.idName;
  else return self.idName(model);
};

/**
 * Check if a type is string
 *
 * @param {String} type The property type
 */
function isString(type) {
  return type === String || type === 'string' || type === 'String';
}

/**
 * Check if a type is a Date
 *
 * @param {String} type The property type
 */
function isDate(type) {
  return type === Date || type === 'date' || type === 'Date';
}

/**
 * sends to couchdb endpoint `_find`
 */
CouchDB.prototype._find = function(dbName, query, cb) {
  var self = this;

  var requestObject = {
    db: dbName,
    path: '_find',
    method: 'post',
    body: query,
  };

  self.getDriverInst().request(requestObject, cb);
};

/**
 * A model index's naming convention: '_design/LBModel__Foo__LBIndex__foo_index',
 * this function returns the model prefix, default as 'LBModel'.
 */
CouchDB.prototype.getIndexModelPrefix = function(mo) {
  return DEFAULT_MODEL_PREFIX;
};

/**
 * A model instance is stored with the property specify which model it belongs
 * to, e.g. {name: 'foo', pwd: 'bar', loopback__model__name: 'User'}
 * This function returns the default model view: 'loopback__model__name'
 */
CouchDB.prototype.defaultModelView = function() {
  return DEFAULT_MODEL_VIEW;
};

/**
 * A model index's naming convention: '_design/LBModel__Foo__LBIndex__foo_index',
 * this function returns the property prefix, default as 'LBIndex'.
 * Default as 'LBIndex'
 */
CouchDB.prototype.getIndexPropertyPrefix = function(mo) {
  return DEFAULT_PROPERTY_PREFIX;
};

CouchDB.prototype.getLimit = function(limit) {
  return limit || this.getGlobalLimit();
};

CouchDB.prototype.getGlobalLimit = function() {
  return this.settings.globalLimit;
};
// mixins
// require('./discovery')(CouchDB);
require('./view')(CouchDB);
require('./migrate')(CouchDB);

exports.CouchDB = CouchDB;
