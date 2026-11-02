import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const formatBundlingError = require('metro/private/lib/formatBundlingError').default;
const { attachImportStackToRootMessage } = require(join(
  dirname(require.resolve('@expo/cli/package.json')),
  'build/src/start/server/metro/metroErrorInterface.js',
));

test('a Node resolution error remains reportable after Expo replaces its stack with an import trace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'metro-bundling-error-'));
  try {
    const packageDir = join(root, 'node_modules', 'resolution-fixture');
    await mkdir(packageDir, { recursive: true });
    await writeFile(join(packageDir, 'package.json'), JSON.stringify({
      name: 'resolution-fixture', exports: { '.': './index.js' },
    }));
    const fixtureRequire = createRequire(join(root, 'entry.cjs'));
    let resolutionError;
    try {
      fixtureRequire('resolution-fixture/unexported');
      assert.fail('the unexported subpath must fail resolution');
    } catch (error) {
      assert.equal(error.code, 'ERR_PACKAGE_PATH_NOT_EXPORTED');
      resolutionError = error;
    }
    attachImportStackToRootMessage(resolutionError, 'Import stack:\n entry.cjs');
    assert.equal(resolutionError.stack, undefined);
    const result = formatBundlingError(resolutionError);
    assert.equal(result.type, 'InternalError');
    assert.deepEqual(result.errors, []);
    assert.ok(result.message.includes(resolutionError.message));
    assert.doesNotThrow(() => JSON.stringify(result));
    assert.doesNotThrow(() => formatBundlingError(resolutionError));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('unparseable stacks preserve the bundling diagnostic without inventing a source location', () => {
  for (const stack of ['', 'unsupported stack format']) {
    const error = new Error('resolution failed');
    error.stack = stack;
    const result = formatBundlingError(error);
    assert.equal(result.type, 'InternalError');
    assert.deepEqual(result.errors, []);
    assert.ok(result.message.includes(error.message));
    assert.ok(!result.message.includes('undefined'));
  }
});

test('ordinary stacks and typed resolution diagnostics retain their existing details', () => {
  const error = new Error('ordinary diagnostic');
  error.stack = 'Error: ordinary diagnostic\n    at bundleEntry (/workspace/entry.js:7:3)';
  assert.ok(formatBundlingError(error).message.includes('/workspace/entry.js (7:3)'));
  const typed = Object.assign(new Error('module unavailable'), {
    type: 'NotFoundError', filename: 'entry.js', lineNumber: 7,
  });
  delete typed.stack;
  const result = formatBundlingError(typed);
  assert.equal(result.type, 'NotFoundError');
  assert.deepEqual(result.errors, [{ description: typed.message, filename: 'entry.js', lineNumber: 7 }]);
});
