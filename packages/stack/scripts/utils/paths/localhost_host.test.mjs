import test from 'node:test';
import assert from 'node:assert/strict';
import { preferStackLocalhostUrl, resolveLocalhostHost } from './localhost_host.mjs';

test('preferStackLocalhostUrl rewrites *.localhost to LAN IP when bind mode is lan', async () => {
  const env = {
    HAPPY_STACKS_STACK: 'dev-auth',
    HAPPY_STACKS_BIND_MODE: 'lan',
    // Override LAN host so test is deterministic.
    HAPPY_STACKS_LAN_HOST: '192.168.5.15',
  };
  const url = await preferStackLocalhostUrl('http://happy-dev-auth.localhost:18137', { stackName: 'dev-auth', env });
  assert.equal(url, 'http://192.168.5.15:18137');
});

test('resolveLocalhostHost returns LAN IP when bind mode is lan', () => {
  const env = { HAPPY_STACKS_BIND_MODE: 'lan', HAPPY_STACKS_LAN_HOST: '192.168.5.15' };
  assert.equal(resolveLocalhostHost({ stackMode: true, stackName: 'dev-auth', env }), '192.168.5.15');
});

