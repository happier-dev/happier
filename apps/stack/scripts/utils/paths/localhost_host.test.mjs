import test from 'node:test';
import assert from 'node:assert/strict';
import { preferStackLocalhostUrl, resolveLocalhostHost } from './localhost_host.mjs';

test('preferStackLocalhostUrl rewrites *.localhost to LAN IP when bind mode is lan', async () => {
  const env = {
    HAPPIER_STACK_STACK: 'dev-auth',
    HAPPIER_STACK_BIND_MODE: 'lan',
    // Override LAN host so test is deterministic.
    HAPPIER_STACK_LAN_HOST: '192.168.5.15',
  };
  const url = await preferStackLocalhostUrl('http://happy-dev-auth.localhost:18137', { stackName: 'dev-auth', env });
  assert.equal(url, 'http://192.168.5.15:18137');
});

test('resolveLocalhostHost returns LAN IP when bind mode is lan', () => {
  const env = { HAPPIER_STACK_BIND_MODE: 'lan', HAPPIER_STACK_LAN_HOST: '192.168.5.15' };
  assert.equal(resolveLocalhostHost({ stackMode: true, stackName: 'dev-auth', env }), '192.168.5.15');
});

test('resolveLocalhostHost uses happier-<stack>.localhost by default', () => {
  const env = {};
  assert.equal(resolveLocalhostHost({ stackMode: true, stackName: 'dev-auth', env }), 'happier-dev-auth.localhost');
});

test('resolveLocalhostHost supports legacy prefix via HAPPIER_STACK_LOCALHOST_SUBDOMAIN_PREFIX=happy', () => {
  const env = { HAPPIER_STACK_LOCALHOST_SUBDOMAIN_PREFIX: 'happy' };
  assert.equal(resolveLocalhostHost({ stackMode: true, stackName: 'dev-auth', env }), 'happy-dev-auth.localhost');
});

test('resolveLocalhostHost falls back to happier prefix for invalid override values', () => {
  const env = { HAPPIER_STACK_LOCALHOST_SUBDOMAIN_PREFIX: 'invalid-prefix' };
  assert.equal(resolveLocalhostHost({ stackMode: true, stackName: 'dev-auth', env }), 'happier-dev-auth.localhost');
});

test('resolveLocalhostHost returns localhost for non-stack and main stack contexts', () => {
  assert.equal(resolveLocalhostHost({ stackMode: false, stackName: 'dev-auth', env: {} }), 'localhost');
  assert.equal(resolveLocalhostHost({ stackMode: true, stackName: 'main', env: {} }), 'localhost');
});

test('preferStackLocalhostUrl respects localhost subdomain disable policy', async () => {
  const env = { HAPPIER_STACK_LOCALHOST_SUBDOMAINS: 'false' };
  const raw = 'http://localhost:18137';
  const url = await preferStackLocalhostUrl(raw, { stackName: 'dev-auth', env });
  assert.equal(url, raw);
});

test('preferStackLocalhostUrl preserves non-http schemes and non-loopback hosts', async () => {
  const env = { HAPPIER_STACK_BIND_MODE: 'lan', HAPPIER_STACK_LAN_HOST: '192.168.5.15' };
  assert.equal(
    await preferStackLocalhostUrl('ws://localhost:18137', { stackName: 'dev-auth', env }),
    'ws://localhost:18137'
  );
  assert.equal(
    await preferStackLocalhostUrl('https://example.com:18137', { stackName: 'dev-auth', env }),
    'https://example.com:18137'
  );
});
