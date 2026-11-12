import { expect, it } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk';
import { createPluginTestkit, type PluginTestServicesFixture } from '@happier-dev/plugin-sdk/testing';
import * as entry from './index.js';

const launch = {"templateId": "base", "timeoutSeconds": 300};
const resource = {"sandboxId": "sandbox-one", "managedId": "managed-one", "timeoutSeconds": 300};

it.each(["acquire", "power", "destroy", "put-file"])('preserves an authored native refusal through the public %s Action', async role => {
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
      : role === 'power' ? { resource, intent: "suspend" }
      : role === 'put-file' ? { resource, guestPath: '/tmp/file', bytesBase64: 'aGk=' } : { resource };
    await expect(kit.invokeAction(role, input, { surface: 'plugin' })).rejects.toMatchObject({ data: refusal.data });
  } finally { await kit.dispose(); }
});


it.each(['acquire', 'power', 'destroy', 'put-file'])('keeps an observed vendor HTTP failure as the typed %s result', async role => {
  const services = {
    connectedAccounts: { materialize: async () => ({ kind: 'httpHeaders', headers: { authorization: 'Bearer test-token', 'x-api-key': 'test-key' } }) },
    http: { request: async (request: { url: string }) => ({ finalUrl: request.url, status: 503, headers: {}, body: new Uint8Array() }) },
  } as unknown as PluginTestServicesFixture;
  const kit = await createPluginTestkit({ manifest: entry.PLUGIN.manifest, module: entry.PLUGIN, services });
  try {
    const input = role === 'acquire' ? { launch, managedId: 'managed-one' }
      : role === 'power' ? { resource, intent: 'suspend' }
      : role === 'put-file' ? { resource, guestPath: '/tmp/file', bytesBase64: 'aGk=' } : { resource };
    expect(await kit.invokeAction(role, input, { surface: 'plugin' })).toMatchObject({ kind: role === 'acquire' ? 'pending' : 'unknown' });
  } finally { await kit.dispose(); }
});

it('keeps a malformed native guest response as an uncertain file result', async () => {
  const services = {
    connectedAccounts: { materialize: async () => ({ kind: 'httpHeaders', headers: { 'x-api-key': 'test-key' } }) },
    http: { request: async (request: { url: string }) => ({ finalUrl: request.url, status: 200, headers: {}, body: new TextEncoder().encode('{}') }) },
  } as unknown as PluginTestServicesFixture;
  const kit = await createPluginTestkit({ manifest: entry.PLUGIN.manifest, module: entry.PLUGIN, services });
  try {
    expect(await kit.invokeAction('put-file', { resource, guestPath: '/tmp/file', bytesBase64: 'aGk=' }, { surface: 'plugin' })).toMatchObject({ kind: 'unknown' });
  } finally { await kit.dispose(); }
});


it.each(['exec', 'bootstrap'])('retains the native HTTP code through the public %s failure', async role => {
  const services = {
    connectedAccounts: { materialize: async () => ({ kind: 'httpHeaders', headers: { authorization: 'Bearer test-token', 'x-api-key': 'test-key' } }) },
    http: { request: async (request: { url: string }) => ({ finalUrl: request.url, status: 503, headers: {}, body: new Uint8Array() }) },
  } as unknown as PluginTestServicesFixture;
  const kit = await createPluginTestkit({ manifest: entry.PLUGIN.manifest, module: entry.PLUGIN, services });
  try {
    const input = role === 'exec' ? { resource, argv: ['true'] } : { resource };
    await expect(kit.invokeAction(role, input, { surface: 'plugin' })).rejects.toMatchObject({ code: 'e2b_http_503' });
  } finally { await kit.dispose(); }
});
