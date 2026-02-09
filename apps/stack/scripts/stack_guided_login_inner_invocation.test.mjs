import test from 'node:test';
import assert from 'node:assert/strict';

import { buildStackAuthLoginInvocation } from './utils/auth/stack_guided_login.mjs';
import { getStackRootFromMeta } from './testkit/auth_testkit.mjs';

test('guided stack auth login invokes core happier auth login directly', () => {
  const rootDir = getStackRootFromMeta(import.meta.url);
  const webappUrl = 'http://localhost:1234';
  const inv = buildStackAuthLoginInvocation({ rootDir, stackName: 'main', webappUrl });
  assert.ok(Array.isArray(inv?.args));
  assert.match(String(inv.args[0] ?? ''), /apps\/cli\/bin\/happier\.mjs$/);
  assert.equal(inv.args[1], 'auth');
  assert.ok(inv.args.includes('login'));
  assert.equal(inv?.env?.HAPPIER_WEBAPP_URL, webappUrl);
  assert.notEqual(inv?.env?.HAPPIER_STACK_AUTH_INNER, '1');
});

test('guided stack auth login defaults stack name to main and preserves invocation ordering', () => {
  const rootDir = getStackRootFromMeta(import.meta.url);
  const webappUrl = 'http://localhost:4321';
  const inv = buildStackAuthLoginInvocation({ rootDir, stackName: '   ', webappUrl });
  assert.equal(inv.args[1], 'auth');
  assert.equal(inv.args[2], 'login');
  assert.equal(inv.env.HAPPIER_WEBAPP_URL, webappUrl);
});

test('guided stack auth login invocation merges caller env', () => {
  const rootDir = getStackRootFromMeta(import.meta.url);
  const inv = buildStackAuthLoginInvocation({
    rootDir,
    stackName: 'feature-1',
    webappUrl: 'http://localhost:5555',
    env: { CUSTOM_FLAG: 'yes', HAPPIER_STACK_AUTH_INNER: '0' },
  });
  assert.equal(inv.env.CUSTOM_FLAG, 'yes');
  assert.equal(inv.env.HAPPIER_STACK_AUTH_INNER, '0');
});

test('guided stack auth login invocation rejects empty webappUrl', () => {
  const rootDir = getStackRootFromMeta(import.meta.url);
  assert.throws(
    () => buildStackAuthLoginInvocation({ rootDir, stackName: 'main', webappUrl: '   ' }),
    /requires a webappUrl/i
  );
});
