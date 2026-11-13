import { expect, it } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk';
import { createPluginTestkit, type PluginTestServicesFixture } from '@happier-dev/plugin-sdk/testing';
import * as entry from './index.js';

const launch = {"environmentId": "environment-one"};
const resource = {"sandboxId": "sandbox-one", "environmentId": "environment-one", "managedId": "managed-one"};

it.each(["acquire", "destroy", "put-file"])('preserves an authored native refusal through the public %s Action', async role => {
  const refusal = new PluginError({ code: 'plugin_fetch_interceptor_failed', message: 'Reconnect the provider account',
    failureCause: { phase: 'dispatch', errorClass: 'Error', errorCode: null, httpStatus: null },
    retryable: true, details: { phase: 'activation', requiredFact: 'connected account' }, remediation: { kind: 'retry' } });
  // Substitute only credential materialization and the host HTTP boundary.
  const services = {
    connectedAccounts: { materialize: async () => ({ kind: 'httpHeaders', headers: { authorization: 'Bearer test-token', 'x-api-key': 'test-key' } }) },
    http: { request: async () => { throw refusal; } },
  } as unknown as PluginTestServicesFixture;
  const kit = await createPluginTestkit({ manifest: entry.PLUGIN.manifest, module: entry.PLUGIN, services });
  try {
    const input = role === 'acquire' ? { launch, managedId: 'managed-one' }
      : role === 'power' ? { resource, intent: "stop" }
      : role === 'put-file' ? { resource, guestPath: '/tmp/file', bytesBase64: 'aGk=' } : { resource };
    await expect(kit.invokeAction(role, input, { surface: 'plugin' })).rejects.toMatchObject({ data: refusal.data });
  } finally { await kit.dispose(); }
});
