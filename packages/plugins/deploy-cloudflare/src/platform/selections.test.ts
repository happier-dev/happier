import { expect, it } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { HttpRequest } from '@happier-dev/plugin-sdk/http';
import type { ActionsService } from '@happier-dev/plugin-sdk/actions';
import * as entry from '../index.js';

const action = 'cloudflare-named/selections-read';
const accountId = 'a'.repeat(32), zoneId = 'b'.repeat(32);
const credentialRef = { service: { pluginId: entry.manifest.id, localId: 'cloudflare' }, accountId: 'selected-profile' };
const input = { credentialRef, accountId, zoneId, hostname: 'app.example.test',
  connector: { imageRef: 'registry.example.test/cloudflared:reviewed', version: '2026.10.0' } };
const zoneListInput = { credentialRef, accountId, hostname: input.hostname, connector: input.connector };
const zone = { id: zoneId, name: 'example.test', account: { id: accountId }, status: 'active', paused: false, type: 'full' };
const tunnel = { id: '11111111-1111-4111-8111-111111111111', name: 'deliberate-tunnel', account_tag: accountId,
  config_src: 'cloudflare', deleted_at: null, status: 'inactive' };
const defaults = { accountId, connector: { imageRef: 'cloudflare/cloudflared:2026.10.0', version: '2026.10.0' } };
const connectorDiscovery = { kind: 'unavailable', reason: 'connector_discovery_unavailable' };
const selection = { provider: { kind: 'builtin', id: 'cloudflareNamed' },
  config: { hostname: input.hostname, controller: { accountId, zoneId, connector: input.connector,
    tunnel: { kind: 'adopt', tunnelId: tunnel.id, name: tunnel.name }, owned: [], dnsOwnership: [] } },
  credentialRefs: [{ purpose: 'tunnel.manage', credentialRef: { kind: 'connectedAccount', account: credentialRef } }] };

// Native Cloudflare v4 zone/list envelopes; HTTP is the only replaced boundary.
async function fixture() {
  const requests: HttpRequest[] = [];
  const metadataReads: unknown[] = [];
  let selectedProviderAccountId: string | null = accountId;
  // Core Actions cross the plugin host boundary; the SDK testkit retains the real plugin activation and invocation.
  const actions = new Proxy({} as ActionsService, { get(_target, property) {
    if (property !== 'execute') return () => { throw new Error('Unexpected host Action operation'); };
    return async (id: string, value: unknown, options?: { signal?: AbortSignal }) => {
      metadataReads.push({ id, value });
      options?.signal?.throwIfAborted();
      if (id !== 'connectedServices.accounts.list') throw new Error('Unexpected host Action');
      return { accounts: [{ account: { ref: credentialRef, status: 'connected', authenticationModeId: 'token',
        configurationReady: true, configurationRevision: 'config', revisionSemantics: 'revisioned', credentialRevision: 'credential',
        scopes: [], providerIdentity: { accountId: selectedProviderAccountId } }, health: 'healthy' }],
        pools: [], source: { completeness: 'complete', observedAtMs: null }, healthBasis: 'credentials' };
    };
  } });
  let zoneResult: unknown = zone;
  let zoneStatus = 200;
  const pages = new Map<number, unknown>([[1, { success: true, result: [tunnel], result_info: { page: 1, total_pages: 1 } }]]);
  let listStatus = 200, listFailure: Error | undefined, waitForList: Promise<void> | undefined;
  let listEntered = () => {};
  const entered = new Promise<void>(resolve => { listEntered = resolve; });
  const http = createPluginHttpFixture({ async request(request) {
    requests.push(request);
    const url = new URL(request.url);
    if (url.pathname === `/client/v4/zones/${zoneId}`) return { status: zoneStatus, headers: {},
      body: new TextEncoder().encode(JSON.stringify({ success: true, result: zoneResult })) };
    if (url.pathname !== '/client/v4/zones' && url.pathname !== `/client/v4/accounts/${accountId}/cfd_tunnel`) {
      throw new Error('Unexpected vendor endpoint');
    }
    listEntered();
    if (waitForList) await waitForList;
    if (listFailure) throw listFailure;
    const page = Number(url.searchParams.get('page'));
    return { status: listStatus, headers: {}, body: new TextEncoder().encode(JSON.stringify(
      pages.get(page) ?? { success: true, result: [] })) };
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http, actions } });
  const controller = new AbortController();
  return { kit, requests, metadataReads, providerAccount: (value: string | null) => { selectedProviderAccountId = value; }, controller, entered, invoke: (value: unknown = input) => kit.invokeAction(action, value, { signal: controller.signal }),
    zone: (value: unknown, status = 200) => { zoneResult = value; zoneStatus = status; }, page: (page: number, value: unknown) => { pages.set(page, value); },
    status: (value: number) => { listStatus = value; }, fail: (value?: Error) => { listFailure = value; },
    hold: (value: Promise<void>) => { waitForList = value; } };
}

it('uses the selected connection and canonical connector defaults with only a hostname supplied', async () => {
  const state = await fixture();
  try {
    state.page(1, { success: true, result: [zone], result_info: { page: 1, total_pages: 1 } });
    const inventory = await state.invoke({ credentialRef, hostname: input.hostname });
    expect(inventory).toMatchObject({ kind: 'ready', zones: [{ zoneId, name: zone.name }], options: [],
      defaults });
    expect(state.metadataReads).toEqual([{ id: 'connectedServices.accounts.list', value: { service: credentialRef.service } }]);
    expect(new URL(state.requests[0]!.url).searchParams.get('account.id')).toBe(accountId);
    if (!inventory || typeof inventory !== 'object' || Array.isArray(inventory) || !inventory.defaults
      || typeof inventory.defaults !== 'object' || Array.isArray(inventory.defaults)) throw new Error('Missing producer defaults');
    state.page(1, { success: true, result: [tunnel], result_info: { page: 1, total_pages: 1 } });
    const selected = await state.invoke({ credentialRef, hostname: input.hostname, zoneId });
    expect(selected).toMatchObject({ kind: 'ready', defaults: inventory.defaults,
      options: [{ selection: { config: { controller: { accountId, connector: inventory.defaults.connector } } } }] });
  } finally { await state.kit.dispose(); }
});

it('reports missing selected provider account metadata without using the profile id or contacting Cloudflare', async () => {
  const state = await fixture();
  try {
    state.providerAccount(null);
    expect(await state.invoke({ credentialRef, hostname: input.hostname })).toMatchObject({ kind: 'unavailable',
      options: [], reason: 'account_id_unavailable', requiredFact: 'cloudflareAccountId', remedy: expect.any(String), defaults: { connector: { imageRef: expect.any(String), version: expect.any(String) } } });
    expect(state.requests).toEqual([]);
    expect(await state.invoke()).toEqual({ kind: 'ready', options: [{ label: tunnel.name, selection }],
      defaults: { connector: defaults.connector }, connectorDiscovery });
  } finally { await state.kit.dispose(); }
});

it('registers one read-only Account Action producing complete deliberate selections without claiming a running connector', async () => {
  const state = await fixture();
  try {
    state.providerAccount('c'.repeat(32));
    expect(await state.invoke()).toEqual({ kind: 'ready', options: [{ label: tunnel.name, selection }],
      defaults: { ...defaults, accountId: 'c'.repeat(32) }, connectorDiscovery });
    expect(entry.manifest.contributes.actions.find(row => row.id === action)).toMatchObject({ readOnly: true,
      execution: { target: 'account' }, surfaces: expect.arrayContaining(['ui']), hostAccess: ['tunnel.manage', 'cloudflare-api'] });
    expect(state.requests.map(request => new URL(request.url).pathname)).toEqual([
      `/client/v4/zones/${zoneId}`, `/client/v4/accounts/${accountId}/cfd_tunnel`]);
    for (const request of state.requests) {
      expect(request).toMatchObject({ method: 'GET', redirect: 'error', credentialBinding: {
        kind: 'connectedAccountPurpose', purpose: 'tunnel.manage', method: 'GET', headerNames: ['authorization'] } });
      expect(request.headers ?? {}).not.toHaveProperty('authorization');
    }
  } finally { await state.kit.dispose(); }
});

it('lists every native zone page for the configured Account when no zone is supplied', async () => {
  const state = await fixture();
  const otherZone = { id: 'c'.repeat(32), name: 'other.test' };
  try {
    state.page(1, { success: true, result: [zone], result_info: { page: 1, total_pages: 2 } });
    state.page(2, { success: true, result: [otherZone], result_info: { page: 2, total_pages: 2 } });
    expect(await state.invoke(zoneListInput)).toEqual({ kind: 'ready',
      zones: [{ zoneId, name: zone.name }, { zoneId: otherZone.id, name: otherZone.name }], options: [], defaults, connectorDiscovery });
    expect(state.requests.map(request => {
      const url = new URL(request.url);
      return { path: url.pathname, accountId: url.searchParams.get('account.id'), page: url.searchParams.get('page') };
    })).toEqual([{ path: '/client/v4/zones', accountId, page: '1' }, { path: '/client/v4/zones', accountId, page: '2' }]);
    expect(state.requests[0]).toMatchObject({ method: 'GET', redirect: 'error', credentialBinding: {
      kind: 'connectedAccountPurpose', purpose: 'tunnel.manage', method: 'GET', headerNames: ['authorization'] } });
    expect(state.requests[0].headers ?? {}).not.toHaveProperty('authorization');
  } finally { await state.kit.dispose(); }
});

it('distinguishes credential, zone-scope, provider-status and HTTP network failures with actionable recovery', async () => {
  const state = await fixture();
  try {
    for (const [status, reason, requiredFact] of [
      [401, 'credential_unavailable', 'cloudflareCredential'],
      [403, 'zone_list_unavailable', 'cloudflareZoneRead'],
      [429, 'provider_unavailable', 'cloudflareProviderResponse'],
    ] as const) {
      state.status(status);
      expect(await state.invoke(zoneListInput)).toMatchObject({ kind: 'unavailable', options: [],
        reason, providerStatus: status, requiredFact, remedy: expect.any(String), defaults, connectorDiscovery });
    }
    state.status(200);
    state.fail(Object.assign(new Error('private-token-value'), { code: 'ECONNRESET' }));
    const failed = await state.invoke(zoneListInput);
    expect(failed).toMatchObject({ kind: 'unavailable', reason: 'network_unavailable',
      requiredFact: 'cloudflareNetwork', remedy: expect.any(String) });
    expect(JSON.stringify(failed)).not.toContain('private-token-value');
    state.fail();
    state.zone(zone, 401);
    expect(await state.invoke()).toMatchObject({ reason: 'credential_unavailable', providerStatus: 401,
      requiredFact: 'cloudflareCredential', remedy: expect.any(String) });
    state.zone(zone, 403);
    expect(await state.invoke()).toMatchObject({ reason: 'denied', providerStatus: 403,
      requiredFact: 'cloudflarePermissions', remedy: expect.any(String) });
  } finally { await state.kit.dispose(); }
});

it('settles zone pagination without metadata and rejects malformed pages without partial zones', async () => {
  const state = await fixture();
  try {
    state.page(1, { success: true, result: [zone] });
    expect(await state.invoke(zoneListInput)).toEqual({ kind: 'ready', zones: [{ zoneId, name: zone.name }],
      options: [], defaults, connectorDiscovery });
    expect(state.requests.map(request => new URL(request.url).searchParams.get('page'))).toEqual(['1', '2']);
    for (const page of [{ success: true, result: null }, { success: true, result: [null] },
      { success: true, result: [{ ...zone, name: null }] },
      { success: true, result: [zone], result_info: { page: 2, total_pages: 2 } }]) {
      state.page(1, page);
      expect(await state.invoke(zoneListInput)).toMatchObject({ kind: 'unavailable', options: [],
        reason: 'invalid_provider_output', defaults, connectorDiscovery });
    }
  } finally { await state.kit.dispose(); }
});

it('reads every native page before filtering eligible remote tunnels for the explicitly validated zone', async () => {
  const state = await fixture();
  try {
    state.page(1, { success: true, result: [
      { ...tunnel, config_src: 'local' }, { ...tunnel, account_tag: 'c'.repeat(32) },
      { ...tunnel, deleted_at: '2026-11-01T00:00:00Z' },
    ], result_info: { page: 1, per_page: 3, total_count: 4 } });
    state.page(2, { success: true, result: [tunnel], result_info: { page: 2, per_page: 3, total_count: 4 } });
    expect(await state.invoke()).toEqual({ kind: 'ready', options: [{ label: tunnel.name, selection }], defaults, connectorDiscovery });
    expect(state.requests.slice(1).map(request => new URL(request.url).searchParams.get('page'))).toEqual(['1', '2']);
    expect(state.requests.slice(1).every(request => new URL(request.url).searchParams.get('is_deleted') === 'false')).toBe(true);
  } finally { await state.kit.dispose(); }
});

it('uses the native empty page as the end when optional pagination metadata is omitted', async () => {
  const state = await fixture();
  try {
    state.page(1, { success: true, result: [{ ...tunnel, config_src: undefined, remote_config: true, status: 'down' }] });
    expect(await state.invoke()).toEqual({ kind: 'ready', options: [{ label: tunnel.name, selection }], defaults, connectorDiscovery });
    expect(state.requests.slice(1).map(request => new URL(request.url).searchParams.get('page'))).toEqual(['1', '2']);
  } finally { await state.kit.dispose(); }
});

it('settles an empty vendor inventory as ready without inventing connector absence', async () => {
  const state = await fixture();
  try {
    state.page(1, { success: true, result: [] });
    expect(await state.invoke()).toEqual({ kind: 'ready', options: [], defaults, connectorDiscovery });
  } finally { await state.kit.dispose(); }
});

it('keeps the canonical selected-zone refusal and never lists tunnels for an unsuitable zone', async () => {
  const state = await fixture();
  try {
    state.zone({ ...zone, paused: true });
    expect(await state.invoke()).toMatchObject({ kind: 'unavailable', options: [], reason: 'zone_paused', defaults, connectorDiscovery });
    expect(state.requests).toHaveLength(1);
    state.zone({ ...zone, name: 'other.test' });
    expect(await state.invoke()).toMatchObject({ kind: 'unavailable', options: [], reason: 'hostname_outside_zone', defaults, connectorDiscovery });
    expect(state.requests).toHaveLength(2);
  } finally { await state.kit.dispose(); }
});

it('reports denied older credentials, malformed lists and failed reads as unavailable without partial choices', async () => {
  const state = await fixture();
  try {
    state.status(403);
    expect(await state.invoke()).toMatchObject({ kind: 'unavailable', options: [], reason: 'denied', defaults, connectorDiscovery });
    state.status(200);
    for (const page of [{ success: true, result: null }, { success: true, result: [null] },
      { success: true, result: [{ ...tunnel, name: null }] },
      { success: true, result: [tunnel], result_info: { page: 2, total_pages: 2 } }]) {
      state.page(1, page);
      expect(await state.invoke()).toMatchObject({ kind: 'unavailable', options: [], reason: 'invalid_provider_output', defaults, connectorDiscovery });
    }
    state.fail(new Error('private-provider-detail'));
    expect(await state.invoke()).toMatchObject({ kind: 'unavailable', options: [], reason: 'network_unavailable', requiredFact: 'cloudflareNetwork', remedy: expect.any(String), defaults, connectorDiscovery });
    state.fail(new PluginError({ code: 'credential_unavailable' }));
    await expect(state.invoke()).rejects.toMatchObject({ code: 'credential_unavailable' });
  } finally { await state.kit.dispose(); }
});

it('preserves host HTTP PluginError codes and causes while authoring missing read recovery', async () => {
  const state = await fixture();
  try {
    const failureCause = { phase: 'connected_account.http.execute', errorClass: 'TypeError', errorCode: 'ECONNRESET', httpStatus: null } as const;
    state.fail(new PluginError({ code: 'outcome_unknown', failureCause }));
    await expect(state.invoke(zoneListInput)).rejects.toMatchObject({ code: 'outcome_unknown',
      data: { failureCause, details: { requiredFact: 'cloudflareNetwork', remedy: expect.any(String) } } });
    state.fail(new PluginError({ code: 'credential_unavailable' }));
    await expect(state.invoke(zoneListInput)).rejects.toMatchObject({ code: 'credential_unavailable',
      data: { details: { requiredFact: 'cloudflareCredential', remedy: expect.any(String) } } });
    const details = { requiredFact: 'credentialMaterial', remedy: 'Reconnect the selected account.', source: 'owner' };
    state.fail(new PluginError({ code: 'credential_unavailable', details }));
    await expect(state.invoke(zoneListInput)).rejects.toMatchObject({ code: 'credential_unavailable', data: { details } });
    state.fail(new PluginError({ code: 'denied' }));
    await expect(state.invoke(zoneListInput)).rejects.toMatchObject({ code: 'denied', data: { code: 'denied' } });
  } finally { await state.kit.dispose(); }
});

it('keeps a pending read pending and propagates cancellation before publishing choices', async () => {
  const state = await fixture();
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  state.hold(held);
  try {
    let settled = false;
    const invocation = state.invoke().finally(() => { settled = true; });
    await state.entered;
    expect(settled).toBe(false);
    state.controller.abort();
    release();
    await expect(invocation).rejects.toMatchObject({ code: 'plugin_action_aborted' });
  } finally { release(); await state.kit.dispose(); }
});
