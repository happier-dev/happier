import assert from 'node:assert/strict';
import test from 'node:test';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { PLUGIN, manifest } from '../.happier-plugin/daemon.js';

test('built author entry preserves unknown allocation recovery without a second paid create', async () => {
  // Agent37 HTTP is the only replaced boundary; no real account is contacted.
  const requests = [];
  const kit = await createPluginTestkit({ manifest, module: PLUGIN, services: {
    connectedAccounts: { materialize: async () => ({ kind: 'httpHeaders', headers: { authorization: 'Bearer constructed-key' } }) },
    http: { request: async request => {
      requests.push(request);
      assert.equal(request.url, 'https://api.agent37.com/v1/instances');
      assert.equal(request.method, 'POST');
      throw new TypeError('response lost after allocation');
    } },
  } });
  const launch = { kind: 'performance', size: '2-4', region: 'eu' };
  const operation = { kind: 'acquire', launch, managedId: 'author-journey' };
  try {
    const acquired = await kit.invokeAction('acquire', { launch, managedId: operation.managedId }, { surface: 'plugin' });
    assert.equal(acquired.kind, 'unknown');
    assert.equal(acquired.recovery.consoleUrl, 'https://www.agent37.com/dashboard');
    assert.deepEqual(await kit.invokeAction('reconcile', { nativeOperation: operation }, { surface: 'plugin' }), acquired);
    assert.equal((await kit.invokeAction('destroy', { nativeOperation: operation }, { surface: 'plugin' })).kind, 'unknown');
    assert.equal(requests.length, 1);
    assert.deepEqual(JSON.parse(new TextDecoder().decode(requests[0].body)), {
      template: 'agent37-base', type: 'performance', region: 'eu',
      resources: { cpu: 2, memory: 4, disk: 12 }, mount_path: '/root', auto_sleep: false,
    });
  } finally { await kit.dispose(); }
});
