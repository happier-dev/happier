import { expect, it } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { HttpRequest } from '@happier-dev/plugin-sdk/http';
import * as entry from '../index.js';

const action = 'cloudflare-named/zone-read';
const accountId = 'a'.repeat(32), zoneId = 'b'.repeat(32);
const input = { credentialRef: { service: { pluginId: entry.manifest.id, localId: 'cloudflare' }, accountId: 'selected-profile' }, accountId, zoneId };
const zone = { id: zoneId, name: 'example.test', account: { id: accountId }, status: 'active', paused: false, type: 'full' };

// Constructed from Cloudflare v4 GET /zones/{zone_id}; only HTTP is replaced.
async function fixture() {
  const requests: HttpRequest[] = [];
  let status = 200, result: unknown = zone;
  let failure: Error | undefined;
  const http = createPluginHttpFixture({ async request(request) {
    requests.push(request);
    if (failure) throw failure;
    return { status, headers: {}, body: new TextEncoder().encode(JSON.stringify({ success: status === 200, result })) };
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
  const registered = kit.registration('actions', action);
  expect(registered, 'activated selected-zone producer').toBeDefined();
  if (!registered) { await kit.dispose(); throw new Error('Missing selected-zone Action'); }
  const controller = new AbortController();
  return { kit, requests, controller, invoke: () => kit.invokeAction(action, input, { signal: controller.signal }),
    respond: (value: unknown, code = 200) => { result = value; status = code; failure = undefined; },
    fail: (error: Error) => { failure = error; } };
}

it('activates a selected-zone Account read with one purpose-bound GET and no inferred/list-order default', async () => {
  const state = await fixture();
  try {
    expect(await state.invoke()).toEqual({ kind: 'ready', zones: [{ accountId, zoneId, name: 'example.test' }], defaultZoneId: zoneId });
    expect(state.requests).toHaveLength(1);
    expect(state.requests[0]).toMatchObject({ method: 'GET', url: `https://api.cloudflare.com/client/v4/zones/${zoneId}`,
      credentialBinding: { kind: 'connectedAccountPurpose', purpose: 'tunnel.manage', origin: 'https://api.cloudflare.com', method: 'GET', headerNames: ['authorization'] } });
    expect(state.requests[0].headers ?? {}).not.toHaveProperty('authorization');
    expect(entry.manifest.contributes.actions.find(row => row.id === action)).toMatchObject({ readOnly: true, hostAccess: ['tunnel.manage', 'cloudflare-api'] });
  } finally { await state.kit.dispose(); }
});

it('returns no automatic default for inactive, paused, external-DNS, mismatched or incomplete zone observations', async () => {
  const state = await fixture();
  try {
    for (const result of [{ ...zone, status: 'pending' }, { ...zone, paused: true }, { ...zone, type: 'partial' },
      { ...zone, account: { id: 'c'.repeat(32) } }, { ...zone, id: 'd'.repeat(32) }, { ...zone, paused: undefined }]) {
      state.respond(result);
      expect(await state.invoke()).toMatchObject({ kind: 'unavailable', zones: [] });
    }
    state.respond({ ...zone, type: 'partial' });
    expect(await state.invoke()).toMatchObject({ reason: 'external_dns_setup_required' });
  } finally { await state.kit.dispose(); }
});

it('keeps refusal, failed-read recovery and cancellation on the existing HTTP owner boundary', async () => {
  const state = await fixture();
  try {
    state.respond(null, 403);
    expect(await state.invoke()).toMatchObject({ kind: 'unavailable', zones: [], reason: 'denied' });
    state.fail(new Error('private-provider-detail'));
    expect(await state.invoke()).toMatchObject({ kind: 'unavailable', zones: [], reason: 'provider_unavailable' });
    state.respond(zone);
    expect(await state.invoke()).toMatchObject({ kind: 'ready', defaultZoneId: zoneId });
    const ownerError = new PluginError({ code: 'credential_unavailable' });
    state.fail(ownerError);
    await expect(state.invoke()).rejects.toMatchObject({ code: ownerError.code, retryable: false });
    state.controller.abort();
    const count = state.requests.length;
    await expect(state.invoke()).rejects.toMatchObject({ code: 'plugin_action_aborted' });
    expect(state.requests).toHaveLength(count);
  } finally { await state.kit.dispose(); }
});
