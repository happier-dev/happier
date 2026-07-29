import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveTypeScriptCliInvocation } from './resolveTypeScriptCliInvocation.mjs';

test('resolves the native TypeScript CLI from its exported package manifest', () => {
  const resolutions = [];
  const invocation = resolveTypeScriptCliInvocation({
    processExecPath: '/managed/node',
    requireResolve(specifier) {
      resolutions.push(specifier);
      return '/repo/node_modules/@typescript/native/package.json';
    },
    readFileSyncImpl(path, encoding) {
      assert.equal(path, '/repo/node_modules/@typescript/native/package.json');
      assert.equal(encoding, 'utf8');
      return JSON.stringify({ bin: { tsc: './bin/tsc' } });
    },
  });

  assert.deepEqual(resolutions, ['@typescript/native/package.json']);
  assert.deepEqual(invocation, {
    command: '/managed/node',
    argsPrefix: ['/repo/node_modules/@typescript/native/bin/tsc'],
  });
});

test('fails closed when the native package does not declare a tsc entrypoint', () => {
  assert.throws(
    () => resolveTypeScriptCliInvocation({
      requireResolve: () => '/repo/node_modules/@typescript/native/package.json',
      readFileSyncImpl: () => JSON.stringify({ bin: {} }),
    }),
    /does not declare a tsc binary/i,
  );
});
