import test from 'node:test';
import assert from 'node:assert/strict';

import { bundledWorkspacePackages, syncBundledWorkspaceDist } from './buildSharedDeps.mjs';

test('buildSharedDeps builds every bundled workspace package needed by the published CLI', () => {
  assert.deepEqual(bundledWorkspacePackages, ['agents', 'cli-common', 'protocol', 'release-runtime']);
});

test('syncBundledWorkspaceDist defaults include release-runtime', () => {
  const copyCalls = [];
  const writeCalls = [];

  syncBundledWorkspaceDist({
    repoRoot: '/repo',
    existsSync: (candidate) =>
      [
        '/repo/apps/cli/node_modules/@happier-dev/release-runtime/dist',
        '/repo/apps/cli/node_modules/@happier-dev/release-runtime/package.json',
      ].includes(String(candidate)),
    cpSync: (src, dest, opts) => {
      copyCalls.push({ src: String(src), dest: String(dest), opts });
    },
    readFileSync: () =>
      JSON.stringify({
        name: '@happier-dev/release-runtime',
        version: '0.0.0',
        type: 'module',
        exports: { './github': { default: './dist/github.js' } },
      }),
    writeFileSync: (path, payload) => {
      writeCalls.push({ path: String(path), payload: String(payload) });
    },
  });

  assert.deepEqual(copyCalls, [
    {
      src: '/repo/packages/release-runtime/dist',
      dest: '/repo/apps/cli/node_modules/@happier-dev/release-runtime/dist',
      opts: { recursive: true, force: true },
    },
  ]);

  assert.equal(writeCalls.length, 1);
  assert.equal(writeCalls[0]?.path, '/repo/apps/cli/node_modules/@happier-dev/release-runtime/package.json');
  assert.match(writeCalls[0]?.payload ?? '', /"name": "@happier-dev\/release-runtime"/);
  assert.match(writeCalls[0]?.payload ?? '', /"private": true/);
});
