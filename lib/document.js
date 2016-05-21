'use strict';
const Promise = require('bluebird'),
      Errors = require('./errors'),
      schemaUtil = require('./schema'),
      type = require('./type'),
      util = require('./util');

/**
 * Create a document of a model (returned by `thinky.createModel`).
 * @param {function} model The model of this document
 * @param {object=} options Options that can overwrite the ones of the model
 */
function Document(model, options) {
  let self = this;  // Keep a reference to itself.

  this.constructor = model;  // The constructor for this model
  this._model = model._getModel(); // The instance of Model

  // We don't want to store options if they are different
  // than the one provided by the model
  if (util.isPlainObject(options)) {
    this._schemaOptions = {};
    this._schemaOptions.enforce_missing =
        (options.enforce_missing != null) ? options.enforce_missing : model.getOptions().enforce_missing; // eslint-disable-line
    this._schemaOptions.enforce_extra =
        (options.enforce_extra != null) ? options.enforce_extra : model.getOptions().enforce_extra; // eslint-disable-line
    this._schemaOptions.enforce_type =
        (options.enforce_type != null) ? options.enforce_type : model.getOptions().enforce_type; // eslint-disable-line
  }

  //TODO: We do not need to make a deep copy. We can do the same as for this._schemaOptions.
  options = options || {};
  this._options = {};
  this._options.timeFormat =
    (options.timeFormat != null) ? options.timeFormat : model.getOptions().timeFormat; // eslint-disable-line
  this._options.validate =
    (options.validate != null) ? options.validate : model.getOptions().validate; // eslint-disable-line

  this._saved = options.saved || false;  // Whether the document is saved or not

  util.bindEmitter(self);  // Copy methods from eventEmitter

  // links to hasOne/hasMany documents
  // We use it to know if some links have been removed/added before saving.
  // Example: { key: doc } or { key: [docs] }
  this._belongsTo = {};
  this._hasOne = {};
  this._hasMany = {};
  // Example: { <linkTableName>: { <valueOfRightKey>: true, ... }, ... }
  this._links = {};

  // Keep reference of any doc having a link pointing to this
  // So we can clean when users do doc.belongsToDoc.delete()
  this._parents = {
    _hasOne: {},      // <tableName>: [{doc, key}]
    _hasMany: {},     // <tableName>: [{doc, key}]
    _belongsTo: {},   // <tableName>: [{doc, key, foreignKey}]
    _belongsLinks: {} // <tableName>: [{doc, key}]
  };

  // Bind listeners of the model to this documents.
  util.loopKeys(model._listeners, function(listeners, eventKey) {
    for (let j = 0; j < listeners[eventKey].length; j++) {
      if (listeners[eventKey][j].once === false) {
        self.addListener(eventKey, listeners[eventKey][j].listener);
      } else if (listeners[eventKey][j].once === true) {
        self.once(eventKey, listeners[eventKey][j].listener);
      }
    }
  });

  // Atom feed
  this._active = false;
  this._feed = null;

  // Add customized methods of the model on this document.
  util.loopKeys(model._methods, function(methods, key) {
    if (self[key] === undefined) {
      self[key] = methods[key];
    } else {
      //TODO: Should we warn the users? Throw an error?
      console.log(self[key]);
      console.log('A property ' + key + ' is already defined in the prototype chain. Skipping.');
    }
  });
}

/**
 * Return the options of the document, not the instance of Document.
 * @return {Object=}
 */
Document.prototype._getOptions = function() {
  return this.__proto__._options; // eslint-disable-line
};

/**
 * Return the options for the schema of the document, not the instance of Document.
 * @return {Object=}
 */
Document.prototype._getSchemaOptions = function() {
  return this.__proto__._schemaOptions; // eslint-disable-line
};

/**
 * Return the constructor of the document, not the instance of Document.
 * @return {function}
 */
Document.prototype.getModel = function() {
  return this.__proto__.constructor; // eslint-disable-line
};

/**
 * Return the model, the instance of Model
 * @return {function}
 */
Document.prototype._getModel = function() {
  return this.__proto__._model; // eslint-disable-line
};

/**
 * Save the virtual fields of the document to be re-injected later.
 */
Document.prototype._saveVirtual = function() {
  let copy = {};

  // TODO We could do better and copy less things, but things get a bit tricky
  // when virtual fields are nested in arrays.
  // This implementation still allows no overhead if no virtual fields exist,
  // which should be the most common case
  for (let i = 0; i < this._getModel().virtualFields.length; i++) {
    let key = this._getModel().virtualFields[i].path[0];
    copy[key] = this[key];
  }

  this.__proto__.virtualValue = util.deepCopy(copy); // eslint-disable-line
};

/**
 * Get the virtual fields saved by `_saveVirtual`.
 * @return {Object=}
 */
Document.prototype._getVirtual = function() {
  return this.__proto__.virtualValue; // eslint-disable-line
};

/**
 * Generate the virtual values for the document, or re-inject the ones
 * previously saved.
 * This should be called **after** `_generateDefault`.
 */
Document.prototype.generateVirtualValues = function() {
  for (let i = 0; i < this._getModel().virtualFields.length; i++) {
    schemaUtil.generateVirtual(this, this._getModel().virtualFields[i], this, this._getVirtual());
  }
};

/**
 * Generate the default values for the document, first the non virtual fields, and then
 * the virtual fields.
 */
Document.prototype._generateDefault = function() {
  for (let i = 0; i < this._getModel().defaultFields.length; i++) {
    schemaUtil.generateDefault(this, this._getModel().defaultFields[i], this);
  }

  if (this._getModel().virtualFields.length > 0) {
    this.generateVirtualValues();
  }
};

/*
 * Validate this document against the schema of its model and triggers all the hooks.
 * @param {Object=} options Options to overwrite the ones of the document.
 * @param {Object=} modelToValidate Internal parameter, model to validate
 * @param {boolean=} validateAll Internal parameter, Option to keep recursing as long as no non-circular model have been found.
 * @param {Object=} validatedModel Internal parameter, All the models for which we already validated at least one document.
 * @param {string=} prefix Internal parameter, The current path to this path (used in case of joined documents).
 * @return {Promise=} return a promise if the validation is asynchrone, else undefined.
 */
Document.prototype.validate = function(options, modelToValidate, validateAll, validatedModel, prefix) {
  modelToValidate = modelToValidate || {};
  validateAll = validateAll || false;
  validatedModel = validatedModel || {};
  prefix = prefix || '';

  let self = this;
  let validatedModelCopy = util.deepCopy(validatedModel);

  //TODO: Can we not always call this?
  let async = self._validateIsAsync(modelToValidate, validateAll, validatedModelCopy);

  return util.hook({
    preHooks: self._getModel()._pre.validate,
    postHooks: self._getModel()._post.validate,
    doc: self,
    async: async,
    fn: self._validateHook,
    fnArgs: [options, modelToValidate, validateAll, validatedModel, prefix]
  });
};

/*
 * Validate this document against the schema of its model and all its joined documents and triggers all the hooks
 * @param {Object=} options Options to overwrite the ones of the document.
 * @param {Object=} modelToValidate Internal parameter, model to validate
 * @return {Promise=} return a promise if the validation is asynchrone, else undefined.
 */
Document.prototype.validateAll = function(options, modelToValidate) {
  let validateAll = modelToValidate === undefined;
  modelToValidate = modelToValidate || {};

  return this.validate(options, modelToValidate, validateAll, {}, '', true);
};

/*
 * Internal methods that will validate the document (but that will not execute the hooks).
 * @param {Object=} options Options to overwrite the ones of the document.
 * @param {Object=} modelToValidate Internal parameter, model to validate
 * @param {boolean=} validateAll Internal parameter, Option to keep recursing as long as no non-circular model have been found.
 * @param {Object=} validatedModel Internal parameter, All the models for which we already validated at least one document.
 * @param {string=} prefix Internal parameter, The current path to this path (used in case of joined documents).
 * @return {Promise=} return a promise if the validation is asynchrone, else undefined.
 */
Document.prototype._validateHook = function(options, modelToValidate, validateAll, validatedModel, prefix) {
  let self = this;
  let promises = [];

  let schemaOptions = self._getSchemaOptions();
  if (util.isPlainObject(schemaOptions)) {
    schemaOptions = util.mergeOptions(schemaOptions, options);
  } else {
    schemaOptions = options;
  }

  if (typeof self._getModel()._validator === 'function') {
    if (self._getModel()._validator.call(self, self) === false) {
      throw new Errors.ValidationError("Document's validator returned `false`.");
    }
  }

  // Validate this document
  self._getModel()._schema.validate(self, prefix, schemaOptions);

  if (util.isPlainObject(modelToValidate) === false) {
    modelToValidate = {};
  }

  let constructor = self.__proto__.constructor; // eslint-disable-line
  validatedModel[constructor.getTableName()] = true;

  // Validate joined documents
  util.loopKeys(self._getModel()._joins, function(joins, key) {
    if (util.recurse(key, joins, modelToValidate, validateAll, validatedModel)) {
      switch (joins[key].type) { // eslint-disable-line
      case 'hasOne':
      case 'belongsTo':
        if (util.isPlainObject(self[key])) {
          if (self[key] instanceof Document === false) {
            self[key] = new self._getModel()._joins[key].model(self[key]);
          }
            // We do not propagate the options of this document, but only those given to validate
          let promise = self[key].validate(options, modelToValidate[key], validateAll, validatedModel, prefix + '[' + key + ']');
          if (promise instanceof Promise) {
            promises.push(promise);
            promise = null;
          }
        } else if (self[key] != null) { // eslint-disable-line
          throw new Errors.ValidationError('Joined field ' + prefix + '[' + key + '] should be `undefined`, `null` or an `Object`');
        }
        break;

      case 'hasMany':
      case 'hasAndBelongsToMany':
        if (Array.isArray(self[key])) {
          for (let i = 0; i < self[key].length; i++) {
            if (util.isPlainObject(self[key][i])) {
              if (self[key][i] instanceof Document === false) {
                self[key][i] = new self._getModel()._joins[key].model(self[key][i]);
              }

              let promise =
                self[key][i].validate(options, modelToValidate[key], validateAll, validatedModel, prefix + '[' + key + '][' + i + ']');
              if (promise instanceof Promise) {
                promises.push(promise);
                promise = null;
              }
            } else {
              throw new Errors.ValidationError('Joined field ' + prefix + '[' + key + '][' + i + '] should be `undefined`, `null` or an `Array`');
            }
          }
        } else if (self[key] != null) { // eslint-disable-line
          throw new Errors.ValidationError('Joined field ' + prefix + '[' + key + '] should be `undefined`, `null` or an `Array`');
        }
        break;
      }
    }
  });

  if (promises.length > 0) {
    return Promise.all(promises);
  }
};

/*
 * Return whether the validation run with the same options will be asynchronous or not.
 * @param {Object=} modelToValidate Internal parameter, model to validate
 * @param {boolean=} validateAll Internal parameter, Option to keep recursing as long as no non-circular model have been found.
 * @param {Object=} validatedModel Internal parameter, All the models for which we already validated at least one document.
 * @return {boolean}
 */
Document.prototype._validateIsAsync = function(modelToValidate, validateAll, validatedModel) {
  let self = this;
  if (self._getModel()._async.validate) {
    return true;
  }

  let async = false;
  util.loopKeys(self._getModel()._joins, function(joins, key) {
    if (util.recurse(key, joins, modelToValidate, validateAll, validatedModel)) {
      if (((joins[key].type === 'hasOne') || (joins[key].type === 'belongsTo'))) {
        if (util.isPlainObject(self[key])) {
          if (self[key] instanceof Document === false) {
            self[key] = new self._getModel()._joins[key].model(self[key]);
          }
          // We do not propagate the options of this document, but only those given to validate
          if (self[key]._getModel()._async.validate || self[key]._validateIsAsync(modelToValidate, validateAll, validatedModel)) {
            async = true;
            return false;
          }
        }
      } else if (((joins[key].type === 'hasMany') || (joins[key].type === 'hasAndBelongsToMany'))) {
        if (Array.isArray(self[key])) {
          for (let i = 0; i < self[key].length; i++) {
            if (util.isPlainObject(self[key][i])) {
              if (self[key][i] instanceof Document === false) {
                self[key][i] = new self._getModel()._joins[key].model(self[key][i]);
              }

              if (self[key][i]._getModel()._async.validate || self[key][i]._validateIsAsync(modelToValidate, validateAll, validatedModel)) {
                async = true;
                return false;
              }
            }
          }
        }
      }
    }
    return false;
  });

  return async;
};

/**
 * Save the document and execute the hooks. Return a promise if the callback
 * is not provided.
 * @param {function=} callback to execute
 * @return {Promise=}
 */
Document.prototype.save = function(callback) {
  return this._save({}, false, {}, callback);
};

/**
 * Save the document and its joined documents. It will also execute the hooks.
 * Return a promise if the callback is not provided.
 * It will save joined documents as long as a document of th esame model has not
 * been saved.
 * @param {function=} callback to execute
 * @return {Promise=}
 */
Document.prototype.saveAll = function(docToSave, callback) {
  let saveAll;
  if (typeof docToSave === 'function') {
    callback = docToSave;
    saveAll = true;
    docToSave = {};
  } else {
    saveAll = docToSave === undefined;
    docToSave = docToSave || {};
  }

  return this._save(docToSave, saveAll, {}, callback);
};

/**
 * Return a savable copy of the document by removing the extra fields,
 * generating the dfault and virtual fields.
 * @return {object}
 */
Document.prototype._makeSavableCopy = function() {
  let model = this._getModel(); // instance of Model
  let schema = this._getModel()._schema;
  let r = this._getModel()._thinky.r;

  if (this._getModel().needToGenerateFields === true) {
    this._generateDefault();
  }

  return this.__makeSavableCopy(this, schema, this._getOptions(), model, r);
};

/**
 * Internal helper for _makeSavableCopy.
 * generating the dfault and virtual fields.
 * @return {any} the copy of the field/object.
 */
Document.prototype.__makeSavableCopy = function(doc, schema, options, model, r) {
  let localOptions; // can be undefined
  if (schema !== undefined) {
    localOptions = schema._options;
  }

  // model is an instance of a Model (for the top level fields), or undefined
  let result, key, nextSchema, copyFlag;
  if (type.isDate(schema) && (typeof doc === 'string' || typeof doc === 'number')) {
    if (typeof doc === 'number') {
      let numericDate = parseInt(doc, 10);
      if (!isNaN(numericDate)) {
        doc = numericDate;
      }
    }
    return new Date(doc); // Use r.ISO8601 and not `new Date()` to keep timezone
  } else if (type.isPoint(schema)) {
    if (util.isPlainObject(doc) && (doc.$reql_type$ !== 'GEOMETRY')) {
      let keys = Object.keys(doc).sort();
      if ((keys.length === 2) && (keys[0] === 'latitude') && (keys[1] === 'longitude') && (typeof doc.latitude === 'number') && (typeof doc.longitude === 'number')) {
        return r.point(doc.longitude, doc.latitude);
      } else if ((doc.type === 'Point') && (Array.isArray(doc.coordinates)) && (doc.coordinates.length === 2)) { // Geojson
        return r.geojson(doc);
      }
    } else if (Array.isArray(doc)) {
      if ((doc.length === 2) && (typeof doc[0] === 'number') && (typeof doc[1] === 'number')) {
        return r.point(doc[0], doc[1]);
      }
    } else { // no transformation are required here, return doc
      return doc;
    }
  } else if (type.isNumber(schema) && (typeof doc === 'string')) {
    let numericString = parseFloat(doc);
    if (!isNaN(numericString)) {
      return numericString;
    }

    return doc;
  }

  if (util.isPlainObject(doc) && (doc instanceof Buffer === false)) {
    result = {};
    util.loopKeys(doc, function(doc, key) { // eslint-disable-line
      copyFlag = true;
      if ((util.isPlainObject(model) === false) || (model._joins[key] === undefined)) { // We do not copy joined documents
        if ((schema !== undefined) && (schema._schema !== undefined) && (type.isVirtual(schema._schema[key]) === true)) {
          // We do not copy virtual
        } else if (((schema === undefined) || (schema._schema === undefined) || (schema._schema[key] === undefined)) &&
            (localOptions !== undefined) && (localOptions.enforce_extra === 'remove')) {
          // We do not copy fields if enfroce_extra is "remove"
        } else {
          if ((schema !== undefined) && (schema._schema !== undefined)) {
            nextSchema = schema._schema[key];
          } else {
            nextSchema = undefined;
          }
          result[key] = Document.prototype.__makeSavableCopy(doc[key], nextSchema, localOptions, undefined, r);
        }
      }
    });

    // Copy the fields that are used as foreign keys
    if (util.isPlainObject(model) === true) {
      util.loopKeys(model._localKeys, function(localKeys, localKey) {
        if (doc[localKey] !== undefined) {
          if (schema !== undefined) {
            nextSchema = schema._schema[key];
          } else {
            nextSchema = undefined;
          }
          //TODO: Do we want to copy the foreign key value? If yes, there's no need for this loop
          //Do we want to copy the key from the joined document? If yes we need to replace doc[localKey]
          result[localKey] = Document.prototype.__makeSavableCopy(doc[localKey], nextSchema, localOptions, undefined, r);
        }
      });
    }
    return result;
  } else if (Array.isArray(doc)) {
    result = [];
    copyFlag = true;

    // Next schema
    if (type.isArray(schema)) {
      nextSchema = schema._schema;
    } else if ((util.isPlainObject(schema)) && (schema._type !== undefined) && (schema._schema !== undefined)) {
      nextSchema = schema._schema;
      if (schema._type === 'virtual') {
        copyFlag = false;
      }
    } else {
      nextSchema = undefined;
    }
    if (copyFlag === true) {
      for (let i = 0; i < doc.length; i++) {
        result.push(Document.prototype.__makeSavableCopy(doc[i], nextSchema, localOptions, undefined, r));
      }
    }
    return result;
  }
  // else, doc is a primitive (or a buffer)
  return doc;
};

/**
 * Save the document, its joined documents and execute the hooks. Return a
 * promise if the callback is undefined.
 * @param {Object=} docToSave Documents to save represented by an object field->true
 * @param {boolean} saveAll Whether _save should recurse by default or not
 * @param {Object=} savedModel Models saved in this call
 * @param {Object=} callback to execute
 * @return {Promise=}
 */
Document.prototype._save = function(docToSave, saveAll, savedModel, callback) {
  //TOIMPROVE? How should we handle circular references outsides of joined fields? Now we throw with a maximum call stack size exceed
  let self = this;
  self.emit('saving', self);

  return util.hook({
    preHooks: self._getModel()._pre.save,
    postHooks: self._getModel()._post.save,
    doc: self,
    async: true,
    fn: self._saveHook,
    fnArgs: [docToSave, saveAll, savedModel]
  }).nodeify(callback);
};

/**
 * Save the document and execute the hooks. This is an internal method used with
 * Model.save. This let us use a similar code path for `document.save` and `Model.save`.
 * @param {Function} executeInsert the method that will execute the batch insert
 * @return {Promise}
 */
Document.prototype._batchSave = function(executeInsert) {
  // Keep in sync with _save
  let self = this;
  self.emit('saving', self);

  return util.hook({
    preHooks: self._getModel()._pre.save,
    postHooks: self._getModel()._post.save,
    doc: self,
    async: true,
    fn: self._batchSaveSelf,
    fnArgs: [executeInsert]
  });
};

/**
 * Call executeInsert when the model is ready
 * @param {Function} executeInsert the method that will execute the batch insert
 * @return {Promise}
 */
Document.prototype._batchSaveSelf = function(executeInsert) {
  let self = this;

  return new Promise(function(resolve, reject) {
    self.getModel().ready().then(function() {
      executeInsert(resolve, reject);
    });
  });
};

/**
 * Save the document and maybe its joined documents. Hooks have been dealt with
 * in _save.
 * @param {!Object} copy The savable copy of the original documents.
 * @param {Object=} docToSave Documents to save represented by an object field->true
 * @param {Object=} belongsToKeysSaved The keys that may contains a document to save
 * @param {boolean} saveAll Whether _save should recurse by default or not
 * @param {Object=} savedModel Models saved in this call
 * @param {Function} resolve The function to call when everything has been saved
 * @param {Function} reject The function to call if an error happened
 */
Document.prototype._saveHook = function(docToSave, saveAll, savedModel) {
  let self = this;
  let model = self._getModel(); // instance of Model
  let constructor = self.getModel();

  if (util.isPlainObject(docToSave) === false) {
    docToSave = {};
  }

  savedModel[constructor.getTableName()] = true;


  let p = new Promise(function(resolve, reject) {
    // Steps:
    // - Save belongsTo
    // - Save this
    // - Save hasOne, hasMany and hasAndBelongsToMany docs
    // - Save links

    // We'll use it to know which `belongsTo` docs were saved
    let belongsToKeysSaved = {};

    let copy = self._makeSavableCopy();
    self._saveVirtual();

    // Save the joined documents via belongsTo first
    let promises = [];
    util.loopKeys(model._joins, function(joins, key) {
      if ((docToSave.hasOwnProperty(key) || (saveAll === true)) &&
          (joins[key].type === 'belongsTo') && ((saveAll === false) || (savedModel[joins[key].model.getTableName()] !== true))) {
        belongsToKeysSaved[key] = true;
        if (self[key] != null) { // eslint-disable-line
          savedModel[joins[key].model.getTableName()] = true;
          if (saveAll === true) {
            promises.push(self[key]._save({}, true, savedModel));
          } else {
            promises.push(self[key]._save(docToSave[joins[key].model.getTableName()], false, savedModel));
          }
        }
      }
    });

    //TODO Remove once
    self.getModel().ready().then(function() {
      Promise.all(promises).then(function() {
        self._onSavedBelongsTo(copy, docToSave, belongsToKeysSaved, saveAll, savedModel, resolve, reject);
      }).error(reject);
    });
  });
  return p;
};

/**
 * Save the joined documents linked with a BelongsTo relation. This should be
 * called before _saveSelf as we will have to copy the foreign keys in `self`.
 * @param {!Object} copy The savable copy of the original documents.
 * @param {Object=} docToSave Documents to save represented by an object field->true
 * @param {Object=} belongsToKeysSaved The keys that may contains a document to save
 * @param {boolean} saveAll Whether _save should recurse by default or not
 * @param {Object=} savedModel Models saved in this call
 * @param {Function} resolve The function to call when everything has been saved
 * @param {Function} reject The function to call if an error happened
 */
Document.prototype._onSavedBelongsTo = function(copy, docToSave, belongsToKeysSaved, saveAll, savedModel, resolve, reject) {
  let self = this;
  let model = self._getModel();
  let constructor = self.__proto__.constructor; // eslint-disable-line

  util.loopKeys(belongsToKeysSaved, function(_joins, key) {
    let joins = model._joins;
    if (self[key] != null) { // eslint-disable-line
      self.__proto__._belongsTo[key] = true; // eslint-disable-line

      // Copy foreign key
      if (self[key][joins[key].rightKey] == null) { // eslint-disable-line
        if (self.hasOwnProperty(joins[key].leftKey)) {
          delete self[joins[key][joins[key].leftKey]];
        }
        if (copy.hasOwnProperty(joins[key].leftKey)) {
          delete copy[joins[key][joins[key].leftKey]];
        }
      } else {
        self[joins[key].leftKey] = self[key][joins[key].rightKey];
        copy[joins[key].leftKey] = self[key][joins[key].rightKey]; // We need to put it in copy before saving it
      }

      // Save the document that belongs to self[key]
      if (self[key].__proto__._parents._belongsTo[constructor.getTableName()] == null) { // eslint-disable-line
        self[key].__proto__._parents._belongsTo[constructor.getTableName()] = []; // eslint-disable-line
      }

      self[key].__proto__._parents._belongsTo[constructor.getTableName()].push({ // eslint-disable-line
        doc: self,
        foreignKey: joins[key].leftKey,
        key: key // foreignDoc
      });
    }
  });

  self._saveSelf(copy, docToSave, belongsToKeysSaved, saveAll, savedModel, resolve, reject);
};

/**
 * Save the document on which `save` was called.
 * @param {!Object} copy The savable copy of the original documents.
 * @param {Object=} docToSave Documents to save represented by an object field->true
 * @param {Object=} belongsToKeysSaved The keys that may contains a document to save
 * @param {boolean} saveAll Whether _save should recurse by default or not
 * @param {Object=} savedModel Models saved in this call
 * @param {Function} resolve The function to call when everything has been saved
 * @param {Function} reject The function to call if an error happened
 */
Document.prototype._saveSelf = function(copy, docToSave, belongsToKeysSaved, saveAll, savedModel, resolve, reject) {
  let self = this;
  let model = self._getModel();
  let constructor = self.__proto__.constructor; // eslint-disable-line
  let r = this._getModel()._thinky.r;

  // BelongsTo documents were saved before. We just need to copy the foreign
  // keys.
  util.loopKeys(model._joins, function(joins, key) {
    if ((joins[key].type === 'belongsTo') && (belongsToKeysSaved[key] === true)) {
      if (self[key] != null) { // eslint-disable-line
        self[joins[key].leftKey] = self[key][joins[key].rightKey];
      } else if (self.__proto__._belongsTo[key]) { // eslint-disable-line
        delete self[joins[key].leftKey];
        delete copy[joins[key].leftKey];
      }
    }
  });

  let querySaveSelf; // The query to save the document on which `save`/`saveAll` was called.
  // We haven't validated the document yet, so building the query with `copy`
  // may throw an error (for example if a Date has not a valid time).
  let buildQuery = function() {
    if (self.__proto__._saved === false) { // eslint-disable-line
      querySaveSelf = r.table(constructor.getTableName())
        .insert(copy, {returnChanges: 'always'});
    } else {
      if (copy[model._pk] === undefined) {
        throw new Error('The document was previously saved, but its primary key is undefined.');
      }

      querySaveSelf = r.table(constructor.getTableName())
        .get(copy[model._pk]).replace(copy, {returnChanges: 'always'});
    }

    return querySaveSelf;
  };

  self.getModel().ready().then(function() {
    util.tryCatch(function() {
      // Validate the document before saving it
      let promise = self.validate();
      if (promise instanceof Promise) {
        promise.then(function() {
          querySaveSelf = buildQuery();
          querySaveSelf.run().then(function(result) {
            self._onSaved(result, docToSave, saveAll, savedModel, resolve, reject);
          }).error(reject);
        }).error(reject);
      } else {
        querySaveSelf = buildQuery();
        querySaveSelf.run().then(function(result) {
          self._onSaved(result, docToSave, saveAll, savedModel, resolve, reject);
        }).error(reject);
      }
    }, reject);
  });
};

/**
 * Callback for the insert query.
 * @param {Object} result The result from the insert query
 * @param {Object=} docToSave Documents to save represented by an object field->true
 * @param {boolean} saveAll Whether _save should recurse by default or not
 * @param {Object=} savedModel Models saved in this call
 * @param {Function} resolve The function to call when everything has been saved
 * @param {Function} reject The function to call if an error happened
 */
Document.prototype._onSaved = function(result, docToSave, saveAll, savedModel, resolve, reject) {
  // Keep in sync with Model.save
  let self = this;

  if (result.first_error != null) { // eslint-disable-line
    return reject(Errors.create(result.first_error));
  }

  util.tryCatch(function() { // Validate the doc, replace it, and tag it as saved
    if (Array.isArray(result.changes) && result.changes.length > 0) {
      self._merge(result.changes[0].new_val);
      self._setOldValue(util.deepCopy(result.changes[0].old_val));
    }

    if (self._getModel().needToGenerateFields === true) {
      self._generateDefault();
    }
    self.setSaved();
    self.emit('saved', self);

    let promise = self.validate();
    if (promise instanceof Promise) {
      promise.then(function() {
        self._saveMany(docToSave, saveAll, savedModel, resolve, reject);
      }).error(reject);
    } else {
      self._saveMany(docToSave, saveAll, savedModel, resolve, reject);
    }
  }, reject);
};

/**
 * Save the joined documents linked with a hasOne or hasMany or
 * hasAndBelongsToMany relation. This should be called after `_saveSelf` as we
 * will have to copy the foreign keys in the joined documents.
 * @param {Object} result The result from the insert query
 * @param {Object=} docToSave Documents to save represented by an object field->true
 * @param {boolean} saveAll Whether _save should recurse by default or not
 * @param {Object=} savedModel Models saved in this call
 * @param {Function} resolve The function to call when everything has been saved
 * @param {Function} reject The function to call if an error happened
 */
Document.prototype._saveMany = function(docToSave, saveAll, savedModel, resolve, reject) {
  let self = this;
  let model = self._getModel();

  let promisesMany = [];
  util.loopKeys(model._joins, function(joins, key) {
    if (((key in docToSave) || (saveAll === true)) &&
        (joins[key].type === 'hasOne') && ((saveAll === false) || (savedModel[joins[key].model.getTableName()] !== true))) {
      savedModel[joins[key].model.getTableName()] = true;

      if (self[key] != null) { // eslint-disable-line
        self[key][joins[key].rightKey] = self[joins[key].leftKey];
        (function(_key) {
          promisesMany.push(new Promise(function(resolve, reject) { // eslint-disable-line
            self[_key]._save(docToSave[_key], saveAll, savedModel).then(function() {
              self.__proto__._hasOne[_key] = { // eslint-disable-line
                doc: self[_key],
                foreignKey: self._getModel()._joins[_key].rightKey
              };

              if (self[_key].__proto__._parents._hasOne[self._getModel()._name] == null) { // eslint-disable-line
                self[_key].__proto__._parents._hasOne[self._getModel()._name] = []; // eslint-disable-line
              }

              self[_key].__proto__._parents._hasOne[self._getModel()._name].push({ // eslint-disable-line
                doc: self,
                key: key
              });
              resolve();
            }).error(reject);
          }));
        })(key);
      } else if ((self[key] == null) && (self.__proto__._hasOne[key] != null)) { // eslint-disable-line
        let doc = self.__proto__._hasOne[key].doc; // eslint-disable-line
        delete doc[self.__proto__._hasOne[key].foreignKey]; // eslint-disable-line
        promisesMany.push(doc._save(docToSave[key], saveAll, savedModel));
        self.__proto__._hasOne[key] = null; // eslint-disable-line
      }
    }
  });

  util.loopKeys(model._joins, function(joins, key) {
    if (((key in docToSave) || (saveAll === true)) &&
        (joins[key].type === 'hasMany') && ((saveAll === false) || (savedModel[joins[key].model.getTableName()] !== true))
        && (Array.isArray(self[key]))) {
      savedModel[joins[key].model.getTableName()] = true;

      //Go through _hasMany and find element that were removed
      let pkMap = {};
      if (Array.isArray(self[key])) {
        for (let i = 0; i < self[key].length; i++) {
          if (self[key][i][joins[key].model._pk] != null) { // eslint-disable-line
            pkMap[self[key][i][joins[key].model._pk]] = true;
          }
        }
      }

      if (self.__proto__._hasMany[key] != null) { // eslint-disable-line
        for (let i = 0; i < self.__proto__._hasMany[key].length; i++) { // eslint-disable-line
          if (pkMap[self.__proto__._hasMany[key][i].doc[[joins[key].model._pk]]] == null) { // eslint-disable-line
            delete self.__proto__._hasMany[key][i].doc[self.__proto__._hasMany[key][i].foreignKey]; // eslint-disable-line
            promisesMany.push(self.__proto__._hasMany[key][i].doc._save(docToSave[key], saveAll, savedModel)); // eslint-disable-line
          }
        }
      }
      self.__proto__._hasMany[key] = []; // eslint-disable-line

      for (let i = 0; i < self[key].length; i++) {
        self[key][i][joins[key].rightKey] = self[joins[key].leftKey];
        (function(key, i) { // eslint-disable-line
          promisesMany.push(new Promise(function(resolve, reject) { // eslint-disable-line
            if (!(self[key][i] instanceof Document)) {
              self[key][i] = new joins[key].model(self[key][i]); // eslint-disable-line
            }

            let callback = function() {
              self[key][i]._save(docToSave[key], saveAll, savedModel).then(function(doc) {
                if (!Array.isArray(self.__proto__._hasMany[key])) { // eslint-disable-line
                  self.__proto__._hasMany[key] = []; // eslint-disable-line
                }
                self.__proto__._hasMany[key].push({ // eslint-disable-line
                  doc: doc,
                  foreignKey: self._getModel()._joins[key].rightKey
                });

                if (self[key][i].__proto__._parents._hasMany[self._getModel()._name] == null) { // eslint-disable-line
                  self[key][i].__proto__._parents._hasMany[self._getModel()._name] = []; // eslint-disable-line
                }
                self[key][i].__proto__._parents._hasMany[self._getModel()._name].push({ // eslint-disable-line
                  doc: self,
                  key: key
                });

                resolve();
              }).error(reject);
            };

            if (self[key][i] instanceof Promise) {
              self[key][i].then(callback).error(reject);
            } else {
              callback();
            }
          }));
        })(key, i);
      }
    }
  });

  util.loopKeys(model._joins, function(joins, key) {
    // Compare to null
    if (((key in docToSave) || (saveAll === true)) &&
        (joins[key].type === 'hasAndBelongsToMany') && ((saveAll === false) || (savedModel[joins[key].model.getTableName()] !== true))) {
      savedModel[joins[key].model.getTableName()] = true;

      if (Array.isArray(self[key])) {
        for (let i = 0; i < self[key].length; i++) {
          if (util.isPlainObject(self[key][i])) { // Save only if we have a full object, and not just a key
            (function(key, i) { // eslint-disable-line
              promisesMany.push(new Promise(function(resolve, reject) { // eslint-disable-line
                if (!(self[key][i] instanceof Document)) {
                  self[key][i] = new joins[key].model(self[key][i]); // eslint-disable-line
                }
                let callback = function() {
                  self[key][i]._save(docToSave[key], saveAll, savedModel).then(function() {
                    // self.__proto__._links will be saved in saveLinks
                    if (self[key][i].__proto__._parents._belongsLinks[self._getModel()._name] == null) { // eslint-disable-line
                      self[key][i].__proto__._parents._belongsLinks[self._getModel()._name] = []; // eslint-disable-line
                    }
                    self[key][i].__proto__._parents._belongsLinks[self._getModel()._name].push({ // eslint-disable-line
                      doc: self,
                      key: key
                    });
                    resolve();
                  }).error(reject);
                };

                if (self[key][i] instanceof Promise) {
                  self[key][i].then(callback).error(reject);
                } else {
                  callback();
                }
              }));
            })(key, i);
          }
        }
      }
    }
  });

  if (promisesMany.length > 0) {
    Promise.all(promisesMany).then(function() {
      self._saveLinks(docToSave, saveAll, resolve, reject);
    }).error(reject);
  } else {
    self._saveLinks(docToSave, saveAll, resolve, reject);
  }
};


/**
 * Save the links for hasAndBelongsToMany joined documents.
 * called before _saveSelf as we will have to copy the foreign keys in `self`.
 * @param {Object=} docToSave Documents to save represented by an object field->true
 * @param {boolean} saveAll Whether _save should recurse by default or not
 * @param {Function} resolve The function to call when everything has been saved
 * @param {Function} reject The function to call if an error happened
 */
Document.prototype._saveLinks = function(docToSave, saveAll, resolve, reject) {
  let self = this;
  let model = self._getModel();
  let constructor = self.getModel();
  let r = model._thinky.r;

  let promisesLink = [];

  util.loopKeys(model._joins, function(joins, key) {
    // Write tests about that!
    if (((key in docToSave) || (saveAll === true)) &&
        (joins[key].type === 'hasAndBelongsToMany')) {
      if (Array.isArray(self[key])) {
        let newKeys = {};
        for (let i = 0; i < self[key].length; i++) {
          if (util.isPlainObject(self[key][i])) {
            if (self[key][i].isSaved() === true) {
              newKeys[self[key][i][joins[key].rightKey]] = true;
            }
          } else { // self[key][i] is just the key
            newKeys[self[key][i]] = true;
          }
        }

        if (self.__proto__._links[joins[key].link] === undefined) { // eslint-disable-line
          self.__proto__._links[joins[key].link] = {}; // eslint-disable-line
        }
        let oldKeys = self.__proto__._links[joins[key].link]; // eslint-disable-line

        util.loopKeys(newKeys, function(_newKeys, link) {
          if (oldKeys[link] !== true) {
            let newLink = {};

            if ((constructor.getTableName() === joins[key].model.getTableName())
              && (joins[key].leftKey === joins[key].rightKey)) {
              // We link on the same model and same key
              // We don't want to save redundant field
              if (link < self[joins[key].leftKey]) {
                newLink.id = link + '_' + self[joins[key].leftKey];
              } else {
                newLink.id = self[joins[key].leftKey] + '_' + link;
              }
              newLink[joins[key].leftKey + '_' + joins[key].leftKey] = [link, self[joins[key].leftKey]];
            } else {
              newLink[constructor.getTableName() + '_' + joins[key].leftKey] = self[joins[key].leftKey];
              newLink[joins[key].model.getTableName() + '_' + joins[key].rightKey] = link;

              // Create the primary key
              if (constructor.getTableName() < joins[key].model.getTableName()) {
                newLink.id = self[joins[key].leftKey] + '_' + link;
              } else if (constructor.getTableName() > joins[key].model.getTableName()) {
                newLink.id = link + '_' + self[joins[key].leftKey];
              } else {
                if (link < self[joins[key].leftKey]) {
                  newLink.id = link + '_' + self[joins[key].leftKey];
                } else {
                  newLink.id = self[joins[key].leftKey] + '_' + link;
                }
              }
            }

            (function(key, link) { // eslint-disable-line
              promisesLink.push(new Promise(function(resolve, reject) { // eslint-disable-line
                r.table(self._getModel()._joins[key].link).insert(newLink, {conflict: 'replace', returnChanges: 'always'}).run().then(function(result) {
                  if (Array.isArray(result.changes) && result.changes.length > 0) {
                    self.__proto__._links[joins[key].link][result.changes[0].new_val[joins[key].model.getTableName() + '_' + joins[key].rightKey]] = true; // eslint-disable-line
                  } else {
                    self.__proto__._links[joins[key].link][newLink[joins[key].model.getTableName() + '_' + joins[key].rightKey]] = true; // eslint-disable-line
                  }
                  resolve();
                }).error(reject);
              }));
            })(key, link);
          }
        });

        let keysToDelete = [];
        util.loopKeys(oldKeys, function(_oldKeys, link) {
          if (newKeys[link] === undefined) {
            if (constructor.getTableName() < joins[key].model.getTableName()) {
              keysToDelete.push(self[joins[key].leftKey] + '_' + link);
            } else {
              keysToDelete.push(link + '_' + self[joins[key].leftKey]);
            }
          }
        });

        if (keysToDelete.length > 0) {
          let table = r.table(joins[key].link);
          promisesLink.push(table.getAll.apply(table, keysToDelete).delete().run().then(function() {
            for (let i = 0; i < keysToDelete.length; i++) {
              self.__proto__._links[joins[key].link][keysToDelete[i]] = false; // eslint-disable-line
            }
          }));
        }
      }
    }
  });

  if (promisesLink.length > 0) {
    Promise.all(promisesLink).then(function() {
      resolve(self);
    }).error(reject);
  } else {
    resolve(self);
  }
};

/**
 * Return the value saved in __proto__.oldValue
 */
Document.prototype.getOldValue = function() {
  return this.__proto__.oldValue; // eslint-disable-line
};

/**
 * Save a reference of `value` that will be later accessible with `getOldValue`.
 * @param {Object} value The value to save
 */
Document.prototype._setOldValue = function(value) {
  this.__proto__.oldValue = value; // eslint-disable-line
};

/**
 * Return whether this document was saved or not.
 * @return {boolean}
 */
Document.prototype.isSaved = function() {
  return this.__proto__._saved; // eslint-disable-line
};

/**
 * Set the document (and maybe its joined documents) as saved.
 * @param {boolean=} all Recursively set all the joined documents as saved
 */
Document.prototype.setSaved = function(all) {
  let self = this;
  self.__proto__._saved = true; // eslint-disable-line
  if (all !== true) return;
  util.loopKeys(self._getModel()._joins, function(joins, key) {
    switch (joins[key].type) { // eslint-disable-line
    case 'hasOne':
      if (self[key] instanceof Document) {
        self[key].setSaved(true);
      }
      break;

    case 'belongsTo':
      if (self[key] instanceof Document) {
        self[key].setSaved(true);
      }
      break;

    case 'hasMany':
      if (Array.isArray(self[key])) {
        for (let i = 0; i < self[key].length; i++) {
          if (self[key][i] instanceof Document) {
            self[key][i].setSaved(true);
          }
        }
      }
      break;

    case 'hasAndBelongsToMany':
      if (Array.isArray(self[key])) {
        for (let i = 0; i < self[key].length; i++) {
          if (self[key][i] instanceof Document) {
            self[key][i].setSaved(true);
          }
        }
      }
      break;
    }
  });

    // Make joins, we should keep references only of the saved documents
  util.loopKeys(self._getModel()._joins, function(joins, key) {
    if (self[key] == null) return; // eslint-disable-line
    switch (joins[key].type) { // eslint-disable-line
    case 'hasOne':
      if (self[key].isSaved()) {
        self.__proto__._hasOne[key] = { // eslint-disable-line
          doc: self[key],
          foreignKey: self._getModel()._joins[key].rightKey
        };
      }

      if (self[key].__proto__._parents._hasOne[self._getModel()._name] == null) { // eslint-disable-line
        self[key].__proto__._parents._hasOne[self._getModel()._name] = []; // eslint-disable-line
      }
      self[key].__proto__._parents._hasOne[self._getModel()._name].push({ // eslint-disable-line
        doc: self,
        key: key
      });
      break;

    case 'belongsTo':
      if (self[key].__proto__._parents._belongsTo[self._getModel()._name] == null) { // eslint-disable-line
        self[key].__proto__._parents._belongsTo[self._getModel()._name] = []; // eslint-disable-line
      }
      self[key].__proto__._parents._belongsTo[self._getModel()._name].push({ // eslint-disable-line
        doc: self,
        foreignKey: self._getModel()._joins[key].leftKey,
        key: key
      });
      self.__proto__._belongsTo[key] = true; // eslint-disable-line
      break;

    case 'hasMany':
      self.__proto__._hasMany[key] = []; // eslint-disable-line

      for (let i = 0; i < self[key].length; i++) {
        if (self[key][i].isSaved()) {
          self.__proto__._hasMany[key].push({ // eslint-disable-line
            doc: self[key][i],
            foreignKey: self._getModel()._joins[key].rightKey
          });
        }

        if (self[key][i].__proto__._parents._hasMany[self._getModel()._name] == null) { // eslint-disable-line
          self[key][i].__proto__._parents._hasMany[self._getModel()._name] = []; // eslint-disable-line
        }
        self[key][i].__proto__._parents._hasMany[self._getModel()._name].push({ // eslint-disable-line
          doc: self,
          key: key
        });
      }
      break;

    case 'hasAndBelongsToMany':
      if (self.__proto__._links[self._getModel()._joins[key].link] === undefined) { // eslint-disable-line
        self.__proto__._links[self._getModel()._joins[key].link] = {}; // eslint-disable-line
      }

      for (let i = 0; i < self[key].length; i++) {
        if (self[key][i].isSaved()) {
          self.__proto__._links[self._getModel()._joins[key].link][self[key][i][self._getModel()._joins[key].rightKey]] = true; // eslint-disable-line
        }

        if (self[key][i].__proto__._parents._belongsLinks[self._getModel()._name] == null) { // eslint-disable-line
          self[key][i].__proto__._parents._belongsLinks[self._getModel()._name] = []; // eslint-disable-line
        }
        self[key][i].__proto__._parents._belongsLinks[self._getModel()._name].push({ // eslint-disable-line
          doc: self,
          key: key
        });
      }
      break;
    }
  });
};

/**
 * Set the document as unsaved
 */
Document.prototype._setUnSaved = function() {
  this.__proto__._saved = false; // eslint-disable-line
};

/**
 * Delete the document from the database. Update the joined documents by
 * removing the foreign key for hasOne/hasMany joined documents, and remove the
 * links for hasAndBelongsToMany joined documents if the link is built on the
 * primary key.
 * @param {Function=} callback
 * @return {Promise=} Return a promise if no callback is provided
 */
Document.prototype.delete = function(callback) {
  return this._delete({}, false, [], true, true, callback);
};

/**
 * Delete the document from the database and the joined documents. If
 * `docToDelete` is undefined, it will delete all the joined documents, else it
 * will limits itself to the one stored in the keys defined in `docToDelete`.
 * It will also update the joined documents by removing the foreign key for
 * `hasOne`/`hasMany` joined documents, and remove the links for
 * `hasAndBelongsToMany` joined documents if the link is built on the primary
 * key.
 * @param {Object=} docToDelete An object where a field maps to `true` if the
 * document stored in this field should be deleted.
 * @param {Function=} callback
 * @return {Promise=} Return a promise if no callback is provided
 */
Document.prototype.deleteAll = function(docToDelete, callback) {
  let deleteAll;
  if (typeof docToDelete === 'function') {
    callback = docToDelete;
    deleteAll = true;
    docToDelete = {};
  } else {
    deleteAll = docToDelete === undefined;
    docToDelete = docToDelete || {};
  }

  return this._delete(docToDelete, deleteAll, [], true, true, callback);
};

/**
 * Delete the document from the database and the joined documents. If
 * `docToDelete` is `undefined` and `deleteAll` is `true`, it will delete all
 * the joined documents, else it will limits itself to the one stored in the
 * keys defined in `docToDelete`. It will also update the joined documents by
 * removing the foreign key for `hasOne`/`hasMany` joined documents, and
 * remove the links for `hasAndBelongsToMany` joined documents if the link is
 * built on the primary key.
 * Hooks will also be executed.
 * @param {Object=} docToDelete Explicit maps of the documents to delete
 * @param {boolean} deleteAll Recursively delete all the documents if
 *     `docToDelete` is undefined
 * @param {Array} deletedDocs Array of docs already deleted, used to make sure
 *     that we do not try to delete multiple times the same documents
 * @param {boolean} deleteSelf Whether it should delete self
 * @param {boolean} updateParents Whether it should update the keys for the
 *     parents
 * @param {Function=} callback
 * @return {Promise=} Return a promise if no callback is provided
 */
Document.prototype._delete = function(docToDelete, deleteAll, deletedDocs, deleteSelf, updateParents, callback) {
  //TODO Set a (string) id per document and use it to perform faster lookup
  let self = this;
  if (util.isPlainObject(docToDelete) === false) {
    docToDelete = {};
  }

  deleteSelf = (deleteSelf === undefined) ? true : deleteSelf;

  return util.hook({
    preHooks: self._getModel()._pre.delete,
    postHooks: self._getModel()._post.delete,
    doc: self,
    async: true,
    fn: self._deleteHook,
    fnArgs: [docToDelete, deleteAll, deletedDocs, deleteSelf, updateParents, callback]
  });
};

/**
 * Internal methods used in `_delete`. Does the same as `_delete` but without
 * the hooks.
 * @param {Object=} docToDelete Explicit maps of the documents to delete
 * @param {boolean} deleteAll Recursively delete all the documents if
 *     `docToDelete` is undefined
 * @param {Array} deletedDocs Array of docs already deleted, used to make sure
 *     that we do not try to delete multiple times the same documents
 * @param {boolean} deleteSelf Whether it should delete self
 * @param {boolean} updateParents Whether it should update the keys for the
 *     parents
 * @return {Promise=} Return a promise if no callback is provided
 */
Document.prototype._deleteHook = function(docToDelete, deleteAll, deletedDocs, deleteSelf, updateParents, callback) {
  let self = this;
  let model = self._getModel(); // instance of Model
  let r = model._thinky.r;

  let promises = [];

  deletedDocs.push(self);
  util.loopKeys(self._getModel()._joins, function(joins, key) {
    if ((joins[key].type === 'hasOne') && (self[key] instanceof Document)) {
      if ((self[key].isSaved() === true) &&
        ((key in docToDelete) || ((deleteAll === true) && (deletedDocs.indexOf(self[key]) === -1)))) {
        (function(_key) {
          promises.push(new Promise(function(resolve, reject) {
            self[key]._delete(docToDelete[_key], deleteAll, deletedDocs, true, false).then(function() {
              delete self[_key];
              resolve();
            }).error(reject);
          }));
        })(key);
      } else if ((deleteSelf === true) && (deletedDocs.indexOf(self[key]) === -1)) {
        delete self[key][joins[key].rightKey];
        if (self[key].isSaved() === true) {
          promises.push(self[key].save({}, false, {}, true, false));
        }
      }
    }

    if ((joins[key].type === 'belongsTo') && (self[key] instanceof Document)) {
      if ((self[key].isSaved() === true) &&
        ((key in docToDelete) || ((deleteAll === true) && (deletedDocs.indexOf(self[key]) === -1)))) {
        (function(_key) {
          promises.push(new Promise(function(resolve, reject) {
            self[key]._delete(docToDelete[_key], deleteAll, deletedDocs, true, false).then(function() {
              delete self[_key];
              resolve();
            }).error(reject);
          }));
        })(key);
      }
    }

    if ((joins[key].type === 'hasMany') && (Array.isArray(self[key]))) {
      let manyPromises = [];
      for (let i = 0; i < self[key].length; i++) {
        if (((self[key][i] instanceof Document) && (self[key][i].isSaved() === true))
          && ((key in docToDelete) || ((deleteAll === true) && (deletedDocs.indexOf(self[key][i]) === -1)))) {
          manyPromises.push(self[key][i]._delete(docToDelete[key], deleteAll, deletedDocs, true, false));
        } else if ((self[key][i] instanceof Document) && (deletedDocs.indexOf(self[key][i]) === -1)) {
          delete self[key][i][joins[key].rightKey];
          if (self[key][i].isSaved() === true) {
            promises.push(self[key][i].save({}, false, {}, true, false));
          }
        }
      }
      (function(_key) {
        promises.push(new Promise(function(resolve, reject) {
          Promise.all(manyPromises).then(function() {
            delete self[_key];
            resolve();
          });
        }));
      })(key);
    }

    if ((joins[key].type === 'hasAndBelongsToMany') && (Array.isArray(self[key]))) {
      // Delete links + docs
      let linksPks = []; // primary keys of the links

      // Store the element we are going to delete.
      // If the user force the deletion of the same element multiple times, we can't naively loop
      // over the elements in the array...
      let docsToDelete = [];

      for (let i = 0; i < self[key].length; i++) {
        if (((self[key][i] instanceof Document) && (self[key][i].isSaved() === true))
          && ((key in docToDelete) || ((deleteAll === true) && (deletedDocs.indexOf(self[key][i]) === -1)))) {
          //pks.push(self[key][i][joins[key].model._getModel()._pk]);
          docsToDelete.push(self[key][i]);
          // We are going to do a range delete, but we still have to recurse
          promises.push(self[key][i]._delete(docToDelete[key], deleteAll, deletedDocs, true, false));

          if (self.getModel()._getModel()._pk === joins[key].leftKey) {
            // The table is created since we are deleting an element from it
            if (self._getModel()._name === joins[key].model._getModel()._name) {
              if (self[joins[key].leftKey] < self[key][i][joins[key].rightKey]) {
                //TODO Add test for this
                linksPks.push(self[joins[key].leftKey] + '_' + self[key][i][joins[key].rightKey]);
              } else {
                linksPks.push(self[key][i][joins[key].rightKey] + '_' + self[joins[key].leftKey]);
              }
            } else if (self._getModel()._name < joins[key].model._getModel()._name) {
              linksPks.push(self[joins[key].leftKey] + '_' + self[key][i][joins[key].rightKey]);
            } else {
              linksPks.push(self[key][i][joins[key].rightKey] + '_' + self[joins[key].leftKey]);
            }
          }
        } else if ((self[key][i] instanceof Document) && (deletedDocs.indexOf(self[key][i]) === -1)) {
          // It's safe to destroy links only if it's a primary key
          if (self.getModel()._getModel()._pk === joins[key].leftKey) {
            if (self._getModel()._name < joins[key].model._getModel()._name) {
              linksPks.push(self[joins[key].leftKey] + '_' + self[key][i][joins[key].rightKey]);
            } else {
              linksPks.push(self[key][i][joins[key].rightKey] + '_' + self[joins[key].leftKey]);
            }
          }
        }
      }

      if (linksPks.length > 0) {
        let query = r.table(joins[key].link);
        query = query.getAll.apply(query, linksPks).delete();
        promises.push(query.run());
      }
    }
  });

  if (updateParents !== false) {
    // Clean links that we are aware of
    util.loopKeys(self.__proto__._parents._hasOne, function(hasOne, key) { // eslint-disable-line
      let parents = hasOne[key];
      for (let i = 0; i < parents.length; i++) {
        delete parents[i].doc[parents[i].key];
        util.loopKeys(parents[i].doc.__proto__._hasOne, function(joined, joinKey) { // eslint-disable-line
          if (joined[joinKey].doc === self) {
            delete parents[i].doc.__proto__._hasOne[joinKey]; // eslint-disable-line
          }
        });
      }
    });

    util.loopKeys(self.__proto__._parents._belongsTo, function(belongsTo, key) { // eslint-disable-line
      let parents = belongsTo[key];
      for (let i = 0; i < parents.length; i++) {
        delete parents[i].doc[parents[i].key];
        delete parents[i].doc[parents[i].foreignKey];
        if (deletedDocs.indexOf(parents[i]) === -1) {
          promises.push(parents[i].doc.save());
        }
      }
    });

    util.loopKeys(self.__proto__._parents._hasMany, function(hasMany, key) { // eslint-disable-line
      let parents = hasMany[key];
      for (let i = 0; i < parents.length; i++) {
        for (let j = 0; j < parents[i].doc[parents[i].key].length; j++) {
          if (parents[i].doc[parents[i].key][j] === self) {
            util.loopKeys(parents[i].doc.__proto__._hasMany, function(joined, joinKey) { // eslint-disable-line
              for (let k = 0; k < joined[joinKey].length; k++) {
                if (joined[joinKey][k].doc === self) {
                  joined[joinKey].splice(k, 1);
                  return false;
                }
              }
            });
            parents[i].doc[parents[i].key].splice(j, 1);
            break;
          }
        }
      }
    });

    util.loopKeys(self.__proto__._parents._belongsLinks, function(belongsLinks, key) { // eslint-disable-line
      let parents = belongsLinks[key];
      for (let i = 0; i < parents.length; i++) {
        for (let j = 0; j < parents[i].doc[parents[i].key].length; j++) {
          if (parents[i].doc[parents[i].key][j] === self) {
            parents[i].doc[parents[i].key].splice(j, 1);
            break;
          }
        }
      }
    });
  }

  if (deleteSelf !== false) {
    if (self.isSaved() === true) {
      promises.push(new Promise(function(resolve, reject) {
        r.table(model._name).get(self[model._pk]).delete().run().then(function(result) {
          self._setUnSaved();
          self.emit('deleted', self);
          resolve(self);
        }).error(reject);
      }));
    }
    // else we don't throw an error, should we?
  }

  let p = new Promise(function(resolve, reject) {
    Promise.all(promises).then(function(result) {
      resolve(self);
    }).error(function(error) {
      reject(error);
    });
  });
  return p.nodeify(callback);
};

/*
 * Delete this document and purge the database by doing range update to clean
 * the foreign keys.
 * @param {Function=} callback
 * @return {Promise=} Return a promise if no callback is provided
 */
Document.prototype.purge = function(callback) {
  let self = this;

  let model = self._getModel(); // instance of Model
  let r = model._thinky.r;

  // Clean parent for hasOne
  // doc.otherDoc.delete()
  util.loopKeys(self.__proto__._parents._hasOne, function(hasOne, key) { // eslint-disable-line
    for (let i = 0; i < hasOne[key].length; i++) {
      let parentDoc = hasOne[key][i].doc; // A doc that belongs to otherDoc (aka this)
      delete parentDoc[hasOne[key][i].key]; // Delete reference to otherDoc (aka this)
    }
  });

  // Clean parent for belongsTo
  // doc.otherDoc.delete()
  util.loopKeys(self.__proto__._parents._belongsTo, function(belongsTo, key) { // eslint-disable-line
    for (let i = 0; i < belongsTo[key].length; i++) {
      let parentDoc = belongsTo[key][i].doc;
      delete parentDoc[belongsTo[key][i].key];
      delete parentDoc[belongsTo[key][i].foreignKey];
    }
  });

  // Clean parent for hasMany
  util.loopKeys(self.__proto__._parents._hasMany, function(hasMany, key) { // eslint-disable-line
    for (let i = 0; i < hasMany[key].length; i++) {
      let parentDoc = hasMany[key][i].doc;
      let field = hasMany[key][i].key;
      for (let j = 0; j < parentDoc[field].length; j++) {
        if (parentDoc[field][j] === this) {
          parentDoc[field].splice(j, 1);
          break;
        }
      }
    }
  });


  // Clean parent for hasAndBelongsToMany
  util.loopKeys(self.__proto__._parents._belongsLinks, function(belongsLinks, key) { // eslint-disable-line
    for (let i = 0; i < belongsLinks[key].length; i++) {
      let parentDoc = belongsLinks[key][i].doc;
      let field = belongsLinks[key][i].key;
      for (let j = 0; j < parentDoc[field].length; j++) {
        if (parentDoc[field][j] === this) {
          parentDoc[field].splice(j, 1);
          break;
        }
      }
    }
  });

  // Purge the database
  let promises = [];
  util.loopKeys(self._getModel()._joins, function(joins, field) {
    let join = joins[field];
    let joinedModel = join.model;

    if ((join.type === 'hasOne') || (join.type === 'hasMany')) {
      promises.push(r.table(joinedModel.getTableName()).getAll(self[join.leftKey], {index: join.rightKey}).replace(function(doc) {
        return doc.without(join.rightKey);
      }).run());
    } else if (join.type === 'hasAndBelongsToMany') {
      if (self.getModel()._getModel()._pk === join.leftKey) {
        // [1]
        promises.push(r.table(join.link).getAll(self[join.leftKey], {index: self.getModel().getTableName() + '_' + join.leftKey}).delete().run());
      }
    }

    // nothing to do for "belongsTo"
  });

  util.loopKeys(self._getModel()._reverseJoins, function(reverseJoins, field) {
    let join = reverseJoins[field];
    let joinedModel = join.model; // model where belongsTo/hasAndBelongsToMany was called

    if (join.type === 'belongsTo') {
      // What was called is joinedModel.belongsTo(self, fieldDoc, leftKey, rightKey)
      promises.push(r.table(joinedModel.getTableName()).getAll(self[join.rightKey], {index: join.leftKey}).replace(function(doc) {
        return doc.without(join.leftKey);
      }).run());
    } else if (join.type === 'hasAndBelongsToMany') {
      // Purge only if the key is a primary key
      // What was called is joinedModel.hasAndBelongsToMany(self, fieldDoc, leftKey, rightKey)
      if (self.getModel()._getModel()._pk === join.leftKey) {
        promises.push(r.table(join.link).getAll(self[join.rightKey], {index: self.getModel().getTableName() + '_' + join.rightKey}).delete().run());
      }
    }
    // nothing to do for "belongsTo"
  });

  // Delete itself
  promises.push(self.delete());

  return new Promise(function(resolve, reject) {
    Promise.all(promises).then(function() {
      resolve(self);
    }).error(reject);
  }).nodeify(callback);
};

Document.prototype.removeRelation = function() {
  let self = this;
  let pk = self._getModel()._pk;
  let query = self.getModel().get(this[pk]);
  return query.removeRelation.apply(query, arguments);
};

/**
 * Perform a `merge` of `obj` in this document. Extra keys will be removed.
 */
Document.prototype._merge = function(obj) {
  let self = this;
  util.loopKeys(self, function(_self, key) {
    if ((obj[key] === undefined) && (self._getModel()._joins[key] === undefined)) {
      delete self[key];
    }
  });
  util.loopKeys(obj, function(_obj, key) {
    self[key] = obj[key];
  });
  return self;
};

/**
 * Perform a `merge` of `obj` in this document. Extra keys will not be removed.
 */
Document.prototype.merge = function(obj) {
  let self = this;
  util.loopKeys(obj, function(_obj, key) {
    // Recursively merge only if both fields are objects, else we'll overwrite the field
    if (util.isPlainObject(obj[key]) && util.isPlainObject(self[key])) {
      Document.prototype.merge.call(self[key], obj[key]);
    } else {
      self[key] = obj[key];
    }
  });
  return self;
};

/**
 * Set the atom feed and update the document for each change
 */
Document.prototype._setFeed = function(feed) {
  let self = this;
  self.__proto__._feed = feed; // eslint-disable-line
  self.__proto__._active = true; // eslint-disable-line
  feed.each(function(err, change) {
    if (err) {
      self.__proto__._active = false; // eslint-disable-line
      self.emit('error', err);
    } else {
      if (change.new_val === null) {
        // Delete all the fields
        self._merge({});
        self._setOldValue(change.old_val);
        self._setUnSaved();
        self.emit('change', self);
      } else {
        self._merge(change.new_val);
        self._setOldValue(change.old_val);
        self.setSaved();
        self.emit('change', self);
      }
    }
  });
};

Document.prototype.getFeed = function() {
  return this.__proto__._feed; // eslint-disable-line
};

Document.prototype.closeFeed = function() {
  return this.__proto__._feed.close(); // eslint-disable-line
};

/**
 * Have the model emit 'retrieved' with the current document and
 * recurse to have all joined models do the same.
 */
Document.prototype._emitRetrieve = function() {
  let self = this;
  self.getModel().emit('retrieved', self);
  util.loopKeys(self._getModel()._joins, function(joins, key) {
    if ((joins[key].type === 'hasOne') || (joins[key].type === 'belongsTo')) {
      if ((self[key] != null) && (typeof self[key]._emitRetrieve === 'function')) { // eslint-disable-line
        self[key]._emitRetrieve();
      }
    } else if ((joins[key].type === 'hasMany') || (joins[key].type === 'hasAndBelongsToMany')) {
      if (Array.isArray(self[key])) {
        for (let i = 0; i < self[key].length; i++) {
          if (typeof self[key][i]._emitRetrieve === 'function') {
            self[key][i]._emitRetrieve();
          }
        }
      }
    }
  });
};

module.exports = Document;