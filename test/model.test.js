'use strict';
const Errors = require('../lib/errors'),
      TestFixture = require('./test-fixture'),
      type = require('../lib/type'),
      assert = require('assert'),
      util = require('./util');

let test = new TestFixture();
describe('models', () => {
  before(() => test.setup());
  after(() => test.teardown());

  describe('createModel', function() {
    afterEach(() => test.cleanTables());
    it('Create a new model', function() {
      let model = test.thinky.createModel(util.s8(), { id: String, name: String });
      assert(model);
    });

    it('Check if the table was created', function(done) {
      let modelName = util.s8();
      let model = test.thinky.createModel(modelName, { id: String, name: String });
      model.once('ready', () => {
        test.r.tableList().run()
          .then(result => {
            assert.notEqual(result.indexOf(modelName), -1);
            done();
          });
      });
    });

    it('Create multiple models', function(done) {
      let model1 = test.thinky.createModel(util.s8(), { id: String, name: String });
      let model2 = test.thinky.createModel(util.s8(), { id: String, name: String });

      assert(model1 !== model2);

      // TODO: Remove when tableWait is implemented on the server
      // Make sure that modelNames[1] is ready for the next tests
      // (since we do not recreate the tables)
      model2.once('ready', () => done());
    });

    it('Check if the table was created', function(done) {
      let model = test.thinky.createModel('nonExistingTable', { id: String, name: String }, { init: false });
      return model.get(1).run()
        .then(() => done(new Error('Expecting error')))
        .error(e => {
          assert(e.message.match(/^Table `.*` does not exist in/));
          done();
        });
    });
  });

  describe('[_]getModel', function() {
    afterEach(() => test.cleanTables());
    it('_getModel', function() {
      let model = test.thinky.createModel(util.s8(), { id: String, name: String }, { init: false });
      assert(model._getModel().hasOwnProperty('_name'));
    });

    it('getTableName', function() {
      let modelName = util.s8();
      let model = test.thinky.createModel(modelName, { id: String, name: String }, { init: false });
      assert(model.__proto__.__proto__.hasOwnProperty('getTableName')); // eslint-disable-line
      assert.equal(model.getTableName(), modelName);
    });
  });

  describe('Model', function() {
    after(() => test.cleanTables()
      .then(() => {
        delete test.Model;
        delete test.modelName;
      }));

    before(() => {
      test.modelName = util.s8();
      test.Model = test.thinky.createModel(test.modelName, { str: String });
    });

    it('Create a new instance of the Model', function() {
      let str = util.s8();
      let doc = new test.Model({ str: str });

      assert(util.isPlainObject(doc));
      assert.equal(doc.str, str);
    });

    it('Create multiple instances from the same document', function() {
      let values = { str: util.s8(), num: util.random() };
      let doc = new test.Model(values);
      let otherDoc = new test.Model(values);

      assert.strictEqual(doc, values);
      assert.notStrictEqual(doc, otherDoc);
      doc.str = doc.str + util.s8();
      assert.notEqual(doc.str, otherDoc.str);

      let anotherDoc = new test.Model(values);
      assert.notStrictEqual(anotherDoc, otherDoc);
      assert.notStrictEqual(anotherDoc, doc);
    });

    it('Create two instances with the same argument of the Model', function() {
      let docValues = { str: util.s8() };
      let doc1 = new test.Model(docValues);
      let doc2 = new test.Model(docValues);

      assert.notStrictEqual(doc1, doc2);
    });

    it('Two instances should be different', function() {
      let str1 = util.s8();
      let str2 = util.s8();
      let doc1 = new test.Model({ str: str1 });
      assert.equal(doc1.str, str1);

      let doc2 = new test.Model({ str: str2 });
      assert.equal(doc2.str, str2);

      assert.equal(doc1.str, str1);
      assert.notEqual(doc1, doc2);
    });

    it('Two instances should have different prototypes', function() {
      let doc1 = new test.Model({ str: util.s8() });
      let doc2 = new test.Model({ str: util.s8() });

      assert.notEqual(doc1.__proto__, doc2.__proto__);  // eslint-disable-line
    });

    it('Two instances should have the same model', function() {
      let doc1 = new test.Model({ str: util.s8() });
      let doc2 = new test.Model({ str: util.s8() });

      assert.equal(doc1.getModel(), doc2.getModel());
    });

    it('Docs from different models should not interfer', function() {
      let str = util.s8();
      let doc = new test.Model({ str: str });
      let otherModelName = util.s8();
      let OtherModel = test.thinky.createModel(otherModelName, { str: String });

      let otherStr = util.s8();
      let otherDoc = new OtherModel({str: otherStr});

      assert.equal(doc.str, str);
      assert.equal(otherDoc.str, otherStr);

      assert.notEqual(otherDoc.getModel(), doc.getModel());
      assert.equal(doc.getModel().getTableName(), test.modelName);
      assert.equal(otherDoc.getModel().getTableName(), otherModelName);
    });
  });

  describe('Batch insert', function() {
    afterEach(() => test.cleanTables());
    it('insert should work with a single doc', function() {
      let Model = test.thinky.createModel(util.s8(), {
        id: String,
        num: Number
      });

      return Model.save({ id: 'foo' })
        .then(result => assert.deepEqual(result, { id: 'foo' }));
    });

    it('Batch insert should work', function() {
      let Model = test.thinky.createModel(util.s8(), {
        id: String,
        num: Number
      });

      let docs = [];
      for (let i = 0; i < 10; i++) {
        docs.push({ num: i });
      }

      return Model.save(docs)
        .then(result => {
          assert.strictEqual(result, docs);
          for (let i = 0; i < 10; i++) {
            assert.equal(typeof docs[i].id, 'string');
            assert(docs[i].isSaved());
          }
        });
    });

    it('Batch insert should validate fields before saving', function(done) {
      let Model = test.thinky.createModel(util.s8(), {
        id: String,
        num: Number
      });

      return Model.save([ { id: 4 } ])
        .error(err => {
          assert.equal(err.message, 'One of the documents is not valid. Original error:\nValue for [id] must be a string or null.');
          assert(err instanceof Errors.ValidationError);
          done();
        });
    });

    it('Batch insert should properly error is __one__ insert fails', function(done) {
      let Model = test.thinky.createModel(util.s8(), {
        id: String,
        num: Number
      });

      return Model.save([ { id: '4' } ])
        .then(result => {
          assert.equal(result[0].id, 4);
          let docs = [];
          for (let i = 0; i < 10; i++) {
            docs.push({num: i, id: '' + i});
          }

          return Model.save(docs);
        })
        .then(() => done(new Error('Was expecting an error')))
        .error(e => {
          assert(e.message.match(/An error occurred during the batch insert/));
          done();
        });
    });

    it('Should generate savable copies', function() {
      let Model = test.thinky.createModel(util.s8(), {
        id: String,
        location: type.point()
      });

      return Model.save({ id: 'foo', location: [1, 2] })
        .then(result => {
          assert.equal(result.id, 'foo');
          assert.equal(result.location.$reql_type$, 'GEOMETRY');
        });
    });

    it('Model.save should handle options - update', function() {
      let Model = test.thinky.createModel(util.s8(), {
        id: String,
        num: Number
      });

      return Model.save({ id: 'foo' })
        .then(result => {
          assert.equal(result.id, 'foo');
          return Model.save({ id: 'foo', bar: 'buzz' }, { conflict: 'update' });
        })
        .then(result => assert.deepEqual(result, { id: 'foo', bar: 'buzz' }));
    });

    it('Model.save should handle options - replace', function() {
      let Model = test.thinky.createModel(util.s8(), {
        id: String,
        num: Number
      });

      return Model.save({ id: 'foo', bar: 'buzz' })
        .then(result => {
          assert.equal(result.id, 'foo');
          return Model.save({ id: 'foo' }, { conflict: 'replace' });
        })
        .then(result => assert.deepEqual(result, { id: 'foo' }));
    });
  });

  describe('Joins', function() {
    afterEach(() => test.cleanTables());
    it('hasOne should save the join', function() {
      let model = test.thinky.createModel(util.s8(), { id: String });
      let otherModel = test.thinky.createModel(util.s8(), { id: String, otherId: String });
      model.hasOne(otherModel, 'otherDoc', 'id', 'otherId');
      assert(model._getModel()._joins.otherDoc);
    });

    it('hasOne should throw if it uses a field already used by another relation', function(done) {
      let model = test.thinky.createModel(util.s8(), { id: String }, { init: false });
      let otherModel = test.thinky.createModel(util.s8(), { id: String, otherId: String }, { init: false });
      let anotherModel = test.thinky.createModel(util.s8(), { id: String, otherId: String }, { init: false });

      model.hasOne(otherModel, 'otherDoc', 'id', 'otherId', {init: false});

      try {
        model.hasOne(anotherModel, 'otherDoc', 'id', 'otherId');
      } catch (err) {
        assert.equal(err.message, 'The field `otherDoc` is already used by another relation.');
        done();
      }
    });

    it('belongsTo should throw if it uses a field already used by another relation', function(done) {
      let model = test.thinky.createModel(util.s8(), { id: String }, { init: false });
      let otherModel = test.thinky.createModel(util.s8(), { id: String, otherId: String }, { init: false });
      let anotherModel = test.thinky.createModel(util.s8(), { id: String, otherId: String }, { init: false });

      model.belongsTo(otherModel, 'otherDoc', 'id', 'otherId', { init: false });
      try {
        model.belongsTo(anotherModel, 'otherDoc', 'id', 'otherId');
      } catch (err) {
        assert.equal(err.message, 'The field `otherDoc` is already used by another relation.');
        done();
      }
    });

    it('hasMany should throw if it uses a field already used by another relation', function(done) {
      let model = test.thinky.createModel(util.s8(), { id: String }, { init: false });
      let otherModel = test.thinky.createModel(util.s8(), { id: String, otherId: String }, { init: false });
      let anotherModel = test.thinky.createModel(util.s8(), { id: String, otherId: String }, { init: false });

      model.hasMany(otherModel, 'otherDoc', 'id', 'otherId', { init: false });
      try {
        model.hasMany(anotherModel, 'otherDoc', 'id', 'otherId');
      } catch (err) {
        assert.equal(err.message, 'The field `otherDoc` is already used by another relation.');
        done();
      }
    });

    it('hasAndBelongsToMany should throw if it uses a field already used by another relation', function(done) {
      let model = test.thinky.createModel(util.s8(), { id: String }, { init: false });
      let otherModel = test.thinky.createModel(util.s8(), { id: String, otherId: String }, { init: false });
      let anotherModel = test.thinky.createModel(util.s8(), { id: String, otherId: String }, { init: false });

      model.hasAndBelongsToMany(otherModel, 'otherDoc', 'id', 'otherId', { init: false });
      try {
        model.hasAndBelongsToMany(anotherModel, 'otherDoc', 'id', 'otherId');
      } catch (err) {
        assert.equal(err.message, 'The field `otherDoc` is already used by another relation.');
        // Wait for the link table to be ready since we wont' drop/recreate the table
        test.thinky.models[model._getModel()._joins.otherDoc.link].once('ready', () => {
          // TODO Remove when tableWait is implemented on the server
          done();
        });
      }
    });

    it('hasOne should throw if the first argument is not a model', function(done) {
      let model = test.thinky.createModel(util.s8(), { id: String}, { init: false });

      try {
        model.hasOne(() => {}, 'otherDoc', 'otherId', 'id');
      } catch (err) {
        assert.equal(err.message, 'First argument of `hasOne` must be a Model');
        done();
      }
    });

    it('belongsTo should throw if the first argument is not a model', function(done) {
      let model = test.thinky.createModel(util.s8(), { id: String }, { init: false });

      try {
        model.belongsTo(() => {}, 'otherDoc', 'otherId', 'id');
      } catch (err) {
        assert.equal(err.message, 'First argument of `belongsTo` must be a Model');
        done();
      }
    });

    it('hasMany should throw if the first argument is not a model', function(done) {
      let model = test.thinky.createModel(util.s8(), { id: String }, { init: false });

      try {
        model.hasMany(() => {}, 'otherDoc', 'otherId', 'id');
      } catch (err) {
        assert.equal(err.message, 'First argument of `hasMany` must be a Model');
        done();
      }
    });

    it('hasAndBelongsToMany should throw if the first argument is not a model', function(done) {
      let model = test.thinky.createModel(util.s8(), { id: String }, { init: false });

      try {
        model.hasAndBelongsToMany(() => {}, 'otherDoc', 'otherId', 'id');
      } catch (err) {
        assert.equal(err.message, 'First argument of `hasAndBelongsToMany` must be a Model');
        done();
      }
    });

    it('hasOne should create an index on the other model', function(done) {
      let model = test.thinky.createModel(util.s8(), { id: String, foreignKeyName: String });
      let foreignKey = util.s8();
      let schema = { id: String };
      schema[foreignKey] = String;
      let otherModel = test.thinky.createModel(util.s8(), schema);
      model.hasOne(otherModel, 'otherDoc', 'modelId', foreignKey);

      let r = test.r;
      otherModel.once('ready', () => {
        r.table(otherModel.getTableName()).indexList().run()
          .then(result => r.table(otherModel.getTableName()).indexWait(foreignKey).run())
          .then(() => done());
      });
    });

    it('BelongsTo should create an index on the other model', function(done) {
      let model = test.thinky.createModel(util.s8(), { id: String, otherId: String });
      let foreignKey = util.s8();
      let schema = {id: String};
      schema[foreignKey] = String;
      let otherModel = test.thinky.createModel(util.s8(), schema);
      model.belongsTo(otherModel, 'otherDoc', foreignKey, 'otherId');

      let r = test.r;
      otherModel.once('ready', () => {
        r.table(otherModel.getTableName()).indexList().run()
          .then(result => r.table(otherModel.getTableName()).indexWait('otherId').run())
          .then(() => done());
      });
    });

    it('hasMany should create an index on the other model', function(done) {
      let model = test.thinky.createModel(util.s8(), { id: String });
      let foreignKey = util.s8();
      let schema = {id: String};
      schema[foreignKey] = String;
      let otherModel = test.thinky.createModel(util.s8(), schema);
      model.hasMany(otherModel, 'otherDocs', 'modelId', foreignKey);

      let r = test.r;
      otherModel.once('ready', () => {
        r.table(otherModel.getTableName()).indexList().run()
          .then(result => r.table(otherModel.getTableName()).indexWait(foreignKey).run())
          .then(() => done());
      });
    });

    it('hasAndBelongsToMany should create an index on this table', function(done) {
      let model = test.thinky.createModel(util.s8(), { id: String, notid1: String });
      let otherModel = test.thinky.createModel(util.s8(), { id: String, notid2: String });
      model.hasAndBelongsToMany(otherModel, 'otherDocs', 'notid1', 'notid2');

      // let linkName;
      // if (model.getTableName() < otherModel.getTableName()) {
      //   linkName = model.getTableName() + '_' + otherModel.getTableName();
      // } else {
      //   linkName = otherModel.getTableName() + '_' + model.getTableName();
      // }

      let r = test.r;
      model.once('ready', () => {
        r.table(model.getTableName()).indexList().run()
          .then(result => r.table(model.getTableName()).indexWait('notid1').run())
          .then(() => done());
      });
    });

    it('hasAndBelongsToMany should create an index on the joined table', function(done) {
      let model = test.thinky.createModel(util.s8(), { id: String, notid1: String });
      let otherModel = test.thinky.createModel(util.s8(), { id: String, notid2: String });
      model.hasAndBelongsToMany(otherModel, 'otherDocs', 'notid1', 'notid2');

      // let linkName;
      // if (model.getTableName() < otherModel.getTableName()) {
      //   linkName = model.getTableName() + '_' + otherModel.getTableName();
      // } else {
      //   linkName = otherModel.getTableName() + '_' + model.getTableName();
      // }

      let r = test.r;
      otherModel.once('ready', () => {
        r.table(otherModel.getTableName()).indexList().run()
          .then(result => r.table(otherModel.getTableName()).indexWait('notid2').run())
          .then(() => done());
      });
    });

    it('hasAndBelongsToMany should create a linked table with indexes', function(done) {
      let model = test.thinky.createModel(util.s8(), { id: String, notid1: String });
      let otherModel = test.thinky.createModel(util.s8(), { id: String, notid2: String });
      model.hasAndBelongsToMany(otherModel, 'otherDocs', 'notid1', 'notid2');

      let linkName;
      if (model.getTableName() < otherModel.getTableName()) {
        linkName = model.getTableName() + '_' + otherModel.getTableName();
      } else {
        linkName = otherModel.getTableName() + '_' + model.getTableName();
      }

      let r = test.r;
      model.once('ready', () => {
        r.table(linkName).indexList().run()
          .then(result => r.table(otherModel.getTableName()).indexWait('notid2').run())
          .then(() => done());
      });
    });

    it('_apply is reserved ', function() {
      let model = test.thinky.createModel(util.s8(), { id: String, notid1: String }, { init: false });
      let otherModel = test.thinky.createModel(util.s8(), { id: String, notid2: String }, { init: false });

      assert.throws(() => {
        model.hasOne(otherModel, '_apply', 'notid1', 'notid2', { init: false });
      }, error => {
        return (error instanceof Error) && (error.message === 'The field `_apply` is reserved by thinky. Please use another one.');
      });

      assert.throws(() => {
        model.hasMany(otherModel, '_apply', 'notid1', 'notid2', { init: false });
      }, error => {
        return (error instanceof Error) && (error.message === 'The field `_apply` is reserved by thinky. Please use another one.');
      });

      assert.throws(() => {
        model.belongsTo(otherModel, '_apply', 'notid1', 'notid2', { init: false });
      }, error => {
        return (error instanceof Error) && (error.message === 'The field `_apply` is reserved by thinky. Please use another one.');
      });

      assert.throws(() => {
        model.hasAndBelongsToMany(otherModel, '_apply', 'notid1', 'notid2', { init: false });
      }, error => {
        return (error instanceof Error) && (error.message === 'The field `_apply` is reserved by thinky. Please use another one.');
      });
    });
  });

  describe('define', function() {
    afterEach(() => test.cleanTables());
    it('Should be added on the document', function(done) {
      let Model = test.thinky.createModel(util.s8(), { id: String, num: Number }, { init: false });
      Model.define('foo', () => done());
      let doc = new Model({});
      doc.foo();
    });

    it('this should refer to the doc', function(done) {
      let str = util.s8();
      let Model = test.thinky.createModel(util.s8(), { id: String, num: Number }, { init: false });
      Model.define('foo', function() { assert.equal(this.id, str); done(); });
      let doc = new Model({id: str});
      doc.foo();
    });
  });

  describe('static', function() {
    afterEach(() => test.cleanTables());
    it('Should be added on the model', function(done) {
      let Model = test.thinky.createModel(util.s8(), { id: String, num: Number }, { init: false });
      Model.defineStatic('foo', () => done());
      Model.foo();
    });

    it('this should refer to the model', function(done) {
      let Model = test.thinky.createModel(util.s8(), { id: String, num: Number }, { init: false });
      Model.defineStatic('foo', function() { this.bar(); });
      Model.defineStatic('bar', () => done());
      Model.foo();
    });

    it('Should be added on the model\'s queries', function() {
      let Model = test.thinky.createModel(util.s8(), { id: String });
      let Other = test.thinky.createModel(util.s8(), { id: String });

      Model.hasOne(Other, 'other', 'id', 'modelId');
      Other.belongsTo(Model, 'model', 'modelId', 'id');

      Other.defineStatic('foo', function() {
        return this.merge({ bar: true });
      });

      let doc1 = new Model({});
      let doc2 = new Other({ model: doc1 });

      return doc2.saveAll()
        .then(() => Model.getJoin({ other: { _apply: query => query.foo() } }).run())
        .then(docs => assert.equal(docs[0].other.bar, true));
    });
  });

  describe('ensureIndex', function() {
    afterEach(() => test.cleanTables());
    it('should add an index', function() {
      let Model = test.thinky.createModel(util.s8(), { id: String, num: Number });
      Model.ensureIndex('num');
      let doc = new Model({});
      return doc.save()
        .then(result => Model.orderBy({ index: 'num' }).run());
    });

    it('should add an index with multi', function() {
      let Model = test.thinky.createModel(util.s8(), { id: String, nums: [ Number ] });
      Model.ensureIndex('nums', doc => doc('nums'), { multi: true });
      let doc = new Model({ nums: [1, 2, 3] });

      return doc.save()
        .then(result => Model.getAll(1, { index: 'nums' }).run())
        .then(result => {
          assert.equal(result.length, 1);
          return Model.getAll(2, { index: 'nums' }).run();
        })
        .then(result => assert.equal(result.length, 1));
    });

    it('should accept ensureIndex(name, opts)', function() {
      let Model = test.thinky.createModel(util.s8(), { id: String, location: type.point() });
      Model.ensureIndex('location', { geo: true });
      let doc = new Model({location: [ 1, 2 ]});

      let r = test.r;
      return doc.save()
        .then(result => Model.getIntersecting(r.circle([1, 2], 1), { index: 'location' }).run())
        .then(result => {
          assert.equal(result.length, 1);
          return Model.getIntersecting(r.circle([3, 2], 1), { index: 'location' }).run();
        })
        .then(result => assert.equal(result.length, 0));
    });
  });

  describe('virtual', function() {
    afterEach(() => test.cleanTables());
    it('pass schema validation', function() {
      test.thinky.createModel(util.s8(), {
        id: String,
        num: Number,
        numVirtual: {
          _type: 'virtual'
        }
      });
    });

    it('Generate fields', function() {
      let Model = test.thinky.createModel(util.s8(), {
        id: String,
        num: Number,
        numVirtual: {
          _type: 'virtual',
          default: function() {
            return this.num + 2;
          }
        }
      });

      let doc = new Model({ num: 1 });
      assert.equal(doc.numVirtual, 3);
    });

    it('Generate fields -- manually', function() {
      let Model = test.thinky.createModel(util.s8(), {
        id: String,
        num: Number,
        numVirtual: {
          _type: 'virtual',
          default: function() {
            return this.num + 2;
          }
        }
      });

      let doc = new Model({ num: 1 });
      assert.equal(doc.numVirtual, 3);
      doc.num = 2;
      assert.equal(doc.numVirtual, 3);
      doc.generateVirtualValues();
      assert.equal(doc.numVirtual, 4);
    });

    it('Validate fields', function() {
      let Model = test.thinky.createModel(util.s8(), {
        id: String,
        num: Number,
        numVirtual: {
          _type: 'virtual'
        }
      });

      let doc = new Model({ num: 1 });
      doc.validate();
    });

    it('Virtual fields should not be saved', function() {
      let Model = test.thinky.createModel(util.s8(), {
        id: Number,
        num: Number,
        numVirtual: {
          _type: 'virtual'
        }
      });

      let doc = new Model({ id: 1, num: 1, numVirtual: 3 });
      return doc.save()
        .then(result => Model.get(1).execute())
        .then(result => assert.equal(result.numVirtual, undefined));
    });

    it('Virtual fields should not be saved but still regenerated once retrieved', function() {
      let Model = test.thinky.createModel(util.s8(), {
        id: Number,
        num: Number,
        numVirtual: {
          _type: 'virtual',
          default: function() {
            return this.num + 2;
          }
        }
      });

      let doc = new Model({ id: 1, num: 1 });
      assert.equal(doc.numVirtual, 3);
      return doc.save()
        .then(result => {
          assert.equal(result.numVirtual, 3);
          return Model.get(1).execute();
        })
        .then(result => {
          assert.equal(result.numVirtual, undefined);
          return Model.get(1).run();
        })
        .then(result => assert.equal(result.numVirtual, 3));
    });

    it('Virtual fields should not be saved but should be put back later (if no default)', function() {
      let Model = test.thinky.createModel(util.s8(), {
        id: Number,
        num: Number,
        numVirtual: {
          _type: 'virtual'
        }
      });

      let doc = new Model({ id: 1, num: 1, numVirtual: 10 });
      return doc.save()
        .then(result => {
          assert.equal(result.numVirtual, 10);
          return Model.get(1).execute();
        })
        .then(result => assert.equal(result.numVirtual, undefined));
    });

    it('Virtual fields should be genrated after other default values', function() {
      let Model = test.thinky.createModel(util.s8(), {
        id: Number,
        anumVirtual: {
          _type: 'virtual',
          default: function() {
            return this.num + 1;
          }
        },
        num: {
          _type: Number,
          default: function() {
            return 2;
          }
        },
        numVirtual: {
          _type: 'virtual',
          default: function() {
            return this.num + 1;
          }
        }
      });

      let doc = new Model({ id: 1 });
      assert.equal(doc.numVirtual, 3);
      assert.equal(doc.anumVirtual, 3);
    });

    it('Virtual fields should be not be generated if a parent is undefined', function() {
      let Model = test.thinky.createModel(util.s8(), {
        id: Number,
        nested: {
          field: {
            _type: 'virtual',
            default: function() {
              return 3;
            }
          }
        }
      });

      let doc = new Model({ id: 1 });
      doc.generateVirtualValues();
      assert.equal(doc.nested, undefined);
    });

    it('Virtual fields should not throw if a parent has the wrong type', function() {
      let Model = test.thinky.createModel(util.s8(), {
        id: Number,
        ar: type.array().schema({
          num: type.number().default(3)
        }).options({ enforce_type: 'none' })
      });

      let doc = new Model({ id: 1, ar: 3 });
      doc._generateDefault();
      assert.equal(doc.ar, 3);
    });

    it('Virtual fields should work in nested arrays', function() {
      let Model = test.thinky.createModel(util.s8(), {
        nested: [
          {
            foo: String,
            bar: type.virtual().default(function() {
              return 'buzz';
            })
          }
        ]
      });

      let doc = new Model({
        nested: [
          {
            foo: 'hello'
          }
        ]
      });

      assert.equal(doc.nested[0].bar, 'buzz');
    });
  });
});
