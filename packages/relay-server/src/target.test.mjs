import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { resolveServerRunnerTarget, resolveRunnerCacheRoot } from './target.mjs';

test('resolveServerRunnerTarget maps linux platforms to linux assets', () => {
  assert.deepEqual(resolveServerRunnerTarget({ platform: 'linux', arch: 'x64' }), {
    os: 'linux',
    arch: 'x64',
    exeName: 'happier-server',
  });
});

test('resolveServerRunnerTarget maps darwin platforms to darwin assets', () => {
  assert.deepEqual(resolveServerRunnerTarget({ platform: 'darwin', arch: 'arm64' }), {
    os: 'darwin',
    arch: 'arm64',
    exeName: 'happier-server',
  });
});

test('resolveServerRunnerTarget maps win32 platforms to windows assets', () => {
  assert.deepEqual(resolveServerRunnerTarget({ platform: 'win32', arch: 'x64' }), {
    os: 'windows',
    arch: 'x64',
    exeName: 'happier-server.exe',
  });
});

test('resolveServerRunnerTarget rejects unsupported platform/arch combinations', () => {
  assert.throws(() => resolveServerRunnerTarget({ platform: 'freebsd', arch: 'x64' }), /Unsupported platform/i);
  assert.throws(() => resolveServerRunnerTarget({ platform: 'win32', arch: 'arm64' }), /Unsupported architecture/i);
});

test('resolveRunnerCacheRoot uses platform-specific defaults', () => {
  assert.equal(
    resolveRunnerCacheRoot({ platform: 'linux', homedir: '/home/me', env: {} }),
    join('/home/me', '.cache')
  );
  assert.equal(
    resolveRunnerCacheRoot({ platform: 'linux', homedir: '/home/me', env: { XDG_CACHE_HOME: '/tmp/xdg' } }),
    '/tmp/xdg'
  );
  assert.equal(
    resolveRunnerCacheRoot({ platform: 'darwin', homedir: '/Users/me', env: {} }),
    join('/Users/me', 'Library', 'Caches')
  );
  assert.equal(
    resolveRunnerCacheRoot({ platform: 'win32', homedir: 'C:\\\\Users\\\\me', env: { LOCALAPPDATA: 'C:\\\\Local' } }),
    'C:\\\\Local'
  );
});

