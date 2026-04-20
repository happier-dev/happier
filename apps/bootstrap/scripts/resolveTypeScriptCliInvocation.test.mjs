import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveTypeScriptCliInvocation } from './resolveTypeScriptCliInvocation.mjs';

test('resolveTypeScriptCliInvocation prefers the JavaScript TypeScript CLI entrypoint over shell-wrapper bin paths', () => {
  const invocation = resolveTypeScriptCliInvocation({
    repoRoot: '/repo',
    processExecPath: '/node',
    requireResolve: (request) => {
      if (request === 'typescript/lib/tsc.js') {
        return '/repo/node_modules/typescript/lib/tsc.js';
      }
      throw new Error(`Unexpected request: ${request}`);
    },
    existsSync: () => false,
    platform: 'linux',
  });

  assert.deepEqual(invocation, {
    command: '/node',
    argsPrefix: ['/repo/node_modules/typescript/lib/tsc.js'],
  });
});

test('resolveTypeScriptCliInvocation falls back to the workspace bin path when the JavaScript CLI entrypoint cannot be resolved', () => {
  const invocation = resolveTypeScriptCliInvocation({
    repoRoot: '/repo',
    processExecPath: '/node',
    requireResolve: () => {
      throw new Error('missing typescript package');
    },
    existsSync: (path) => path === '/repo/node_modules/.bin/tsc',
    platform: 'linux',
  });

  assert.deepEqual(invocation, {
    command: '/repo/node_modules/.bin/tsc',
    argsPrefix: [],
  });
});
