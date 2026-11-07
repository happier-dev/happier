import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { createDefaultExportCustomSerializer } = require('@expo/metro-config/build/serializer/withExpoSerializers');

function fixture() {
  let sourceReads = 0;
  const module = {
    path: '/fixture.js',
    dependencies: new Map(),
    getSource() {
      sourceReads += 1;
      return Buffer.from('globalThis.fixture = true;');
    },
    output: [{ type: 'js/module', data: { code: '__d(function() {});', map: [], lineCount: 1 } }],
  };
  const graph = { dependencies: new Map([[module.path, module]]), transformOptions: { dev: false } };
  const serializer = createDefaultExportCustomSerializer({
    serializer: { customSerializer: { __originalSerializer: async () => 'globalThis.fixture = true;' } },
  });
  const options = {
    createModuleId: () => 0,
    processModuleFilter: () => true,
    shouldAddToIgnoreList: () => false,
    projectRoot: '/',
    modulesOnly: true,
    runModule: false,
    inlineSourceMap: false,
  };
  return { graph, serializer, options, reads: () => sourceReads };
}

test('production dev-server bundle does not synchronously reread sources for an unrequested map', async () => {
  const f = fixture();
  const result = await f.serializer('/fixture.js', [], f.graph, {
    ...f.options, sourceUrl: 'http://localhost:8081/index.bundle?platform=web&dev=false',
  });
  assert.equal(f.reads(), 0);
  assert.equal(typeof result === 'string' ? result : result.code, 'globalThis.fixture = true;');
});

test('an explicit dev-server map request still includes sources', async () => {
  const f = fixture();
  const result = await f.serializer('/fixture.js', [], f.graph, {
    ...f.options, sourceUrl: 'http://localhost:8081/index.map?platform=web&dev=false',
  });
  assert.equal(f.reads(), 1);
  assert.deepEqual(JSON.parse(result.map).sourcesContent, ['globalThis.fixture = true;']);
});

test('an export with serializer output still includes its map', async () => {
  const f = fixture();
  const result = await f.serializer('/fixture.js', [], f.graph, {
    ...f.options, sourceUrl: 'http://localhost:8081/index.bundle?platform=web&dev=false',
    serializerOptions: { output: 'bundle' },
  });
  assert.equal(f.reads(), 1);
  assert.ok(result.map);
});

test('an inline-source-map bundle still includes its map', async () => {
  const f = fixture();
  const result = await f.serializer('/fixture.js', [], f.graph, {
    ...f.options, inlineSourceMap: true,
    sourceUrl: 'http://localhost:8081/index.bundle?platform=web&dev=false',
  });
  assert.equal(f.reads(), 1);
  assert.ok(result.map);
});
