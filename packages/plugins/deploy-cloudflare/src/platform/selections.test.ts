import { expect, it } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { HttpRequest } from '@happier-dev/plugin-sdk/http';
import * as entry from '../index.js';

const action = 'cloudflare-named/selections-read';
const accountId = 'a'.repeat(32), zoneId = 'b'.repeat(32);
const credentialRef = { service: { pluginId: entry.manifest.id, localId: 'cloudflare' }, accountId: 'selected-profile' };
const input = { credentialRef, accountId, zoneId, hostname: 'app.example.test',
  connector: { imageRef: 'registry.example.test/cloudflared:reviewed', version: '2026.10.0' } };
const zone = { id: zoneId, name: 'example.test', account: { id: accountId }, status: 'active', paused: false, type: 'full' };
const tunnel = { id: '11111111-1111-4111-8111-111111111111', name: 'deliberate-tunnel', account_tag: accountId,
  config_src: 'cloudflare', deleted_at: null, status: 'inactive' };
const connectorDiscovery = { kind: 'unavailable', reason: 'connector_discovery_unavailable' };
const selection = { provider: { kind: 'builtin', id: 'cloudflareNamed' },
  config: { hostname: input.hostname, controller: { accountId, zoneId, connector: input.connector,
    tunnel: { kind: 'adopt', tunnelId: tunnel.id, name: tunnel.name }, owned: [], dnsOwnership: [] } },
  credentialRefs: [{ purpose: 'tunnel.manage', credentialRef: { kind: 'connectedAccount', account: credentialRef } }] };

// Native Cloudflare v4 zone/list envelopes; HTTP is the only replaced boundary.
async function fixture() {
  const requests: HttpRequest[] = [];
  let zoneResult: unknown = zone;
  const pages = new Map<number, unknown>([[1, { success: true, result: [tunnel], result_info: { page: 1, total_pages: 1 } }]]);
  let listStatus = 200, listFailure: Error | undefined, waitForList: Promise<void> | undefined;
  let listEntered = () => {};
  const entered = new Promise<void>(resolve => { listEntered = resolve; });
  const http = createPluginHttpFixture({ async request(request) {
    requests.push(request);
    const url = new URL(request.url);
    if (url.pathname === `/client/v4/zones/${zoneId}`) return { status: 200, headers: {},
      body: new TextEncoder().encode(JSON.stringify({ success: true, result: zoneResult })) };
    if (url.pathname !== `/client/v4/accounts/${accountId}/cfd_tunnel`) throw new Error('Unexpected vendor endpoint');
    listEntered();
    if (waitForList) await waitForList;
    if (listFailure) throw listFailure;
    const page = Number(url.searchParams.get('page'));
    return { status: listStatus, headers: {}, body: new TextEncoder().encode(JSON.stringify(
      pages.get(page) ?? { success: true, result: [] })) };
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
  const controller = new AbortController();
  return { kit, requests, controller, entered, invoke: () => kit.invokeAction(action, input, { signal: controller.signal }),
    zone: (value: unknown) => { zoneResult = value; }, page: (page: number, value: unknown) => { pages.set(page, value); },
    status: (value: number) => { listStatus = value; }, fail: (value?: Error) => { listFailure = value; },
    hold: (value: Promise<void>) => { waitForList = value; } };
}

it('registers one read-only Account Action producing complete deliberate selections without claiming a running connector', async () => {
  const state = await fixture();
  try {
    expect(await state.invoke()).toEqual({ kind: 'ready', options: [{ label: tunnel.name, selection }], connectorDiscovery });
    expect(entry.manifest.contributes.actions.find(row => row.id === action)).toMatchObject({ readOnly: true,
      execution: { target: 'account' }, hostAccess: ['tunnel.manage', 'cloudflare-api'] });
    expect(state.requests.map(request => new URL(request.url).pathname)).toEqual([
      `/client/v4/zones/${zoneId}`, `/client/v4/accounts/${accountId}/cfd_tunnel`]);
    for (const request of state.requests) {
      expect(request).toMatchObject({ method: 'GET', redirect: 'error', credentialBinding: {
        kind: 'connectedAccountPurpose', purpose: 'tunnel.manage', method: 'GET', headerNames: ['authorization'] } });
      expect(request.headers ?? {}).not.toHaveProperty('authorization');
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
    expect(await state.invoke()).toEqual({ kind: 'ready', options: [{ label: tunnel.name, selection }], connectorDiscovery });
    expect(state.requests.slice(1).map(request => new URL(request.url).searchParams.get('page'))).toEqual(['1', '2']);
    expect(state.requests.slice(1).every(request => new URL(request.url).searchParams.get('is_deleted') === 'false')).toBe(true);
  } finally { await state.kit.dispose(); }
});

it('uses the native empty page as the end when optional pagination metadata is omitted', async () => {
  const state = await fixture();
  try {
    state.page(1, { success: true, result: [{ ...tunnel, config_src: undefined, remote_config: true, status: 'down' }] });
    expect(await state.invoke()).toEqual({ kind: 'ready', options: [{ label: tunnel.name, selection }], connectorDiscovery });
    expect(state.requests.slice(1).map(request => new URL(request.url).searchParams.get('page'))).toEqual(['1', '2']);
  } finally { await state.kit.dispose(); }
});

it('settles an empty vendor inventory as ready without inventing connector absence', async () => {
  const state = await fixture();
  try {
    state.page(1, { success: true, result: [] });
    expect(await state.invoke()).toEqual({ kind: 'ready', options: [], connectorDiscovery });
  } finally { await state.kit.dispose(); }
});

it('keeps the canonical selected-zone refusal and never lists tunnels for an unsuitable zone', async () => {
  const state = await fixture();
  try {
    state.zone({ ...zone, paused: true });
    expect(await state.invoke()).toEqual({ kind: 'unavailable', options: [], reason: 'zone_paused', connectorDiscovery });
    expect(state.requests).toHaveLength(1);
    state.zone({ ...zone, name: 'other.test' });
    expect(await state.invoke()).toEqual({ kind: 'unavailable', options: [], reason: 'hostname_outside_zone', connectorDiscovery });
    expect(state.requests).toHaveLength(2);
  } finally { await state.kit.dispose(); }
});

it('reports denied older credentials, malformed lists and failed reads as unavailable without partial choices', async () => {
  const state = await fixture();
  try {
    state.status(403);
    expect(await state.invoke()).toEqual({ kind: 'unavailable', options: [], reason: 'denied', connectorDiscovery });
    state.status(200);
    for (const page of [{ success: true, result: null }, { success: true, result: [null] },
      { success: true, result: [{ ...tunnel, name: null }] },
      { success: true, result: [tunnel], result_info: { page: 2, total_pages: 2 } }]) {
      state.page(1, page);
      expect(await state.invoke()).toEqual({ kind: 'unavailable', options: [], reason: 'invalid_provider_output', connectorDiscovery });
    }
    state.fail(new Error('private-provider-detail'));
    expect(await state.invoke()).toEqual({ kind: 'unavailable', options: [], reason: 'provider_unavailable', connectorDiscovery });
    state.fail(new PluginError({ code: 'credential_unavailable' }));
    await expect(state.invoke()).rejects.toMatchObject({ code: 'credential_unavailable' });
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
