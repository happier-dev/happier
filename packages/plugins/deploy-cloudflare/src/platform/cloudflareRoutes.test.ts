import { describe, expect, it, vi } from 'vitest';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import type { AccessProviderRefV1 } from '@happier-dev/plugin-sdk/access-providers';
import * as entry from '../index.js';
import type { HttpService, PluginFetchCredentialBinding } from '@happier-dev/plugin-sdk/http';
import { reconcileOwnedCloudflareRoutes, type CloudflareRouteRequest } from './cloudflareRoutes.js';
const disableOwnedCloudflareRoutes = (input: Omit<CloudflareRouteRequest, 'desired'>) => reconcileOwnedCloudflareRoutes({ ...input, desired: [] });

const accountId = 'a'.repeat(32), zoneId = 'b'.repeat(32), tunnelId = '61bc2c65-9253-4917-8f74-05587547bfa2';
const hostname = 'app.example.test', service = 'http://happier-caddy:8080';
const collection = `https://api.cloudflare.com/client/v4/accounts/${accountId}/cfd_tunnel`;
const root = `${collection}/${tunnelId}`;
const connectorToken = 'private-connector-custody-sentinel';
const dnsRoot = `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`;
const foreign = { hostname: 'foreign.example.test', service: 'http://foreign:8000', originRequest: { connectTimeout: 7 } };
const unrelatedDns = { id: 'record-foreign', name: foreign.hostname, type: 'A', content: '192.0.2.8', ttl: 300 };
const fallback = { service: 'http_status:403', originRequest: { noTLSVerify: false } };
// This is the admitted host HTTP boundary's opaque binding, never a raw token.
const credentialBindings = {
  GET: { kind: 'connectedAccountPurpose', purpose: 'tunnel.manage',
    origin: 'https://api.cloudflare.com', method: 'GET', headerNames: ['authorization'] },
  PUT: { kind: 'connectedAccountPurpose', purpose: 'tunnel.manage',
    origin: 'https://api.cloudflare.com', method: 'PUT', headerNames: ['authorization'] },
  POST: { kind: 'connectedAccountPurpose', purpose: 'tunnel.manage',
    origin: 'https://api.cloudflare.com', method: 'POST', headerNames: ['authorization'] },
  DELETE: { kind: 'connectedAccountPurpose', purpose: 'tunnel.manage',
    origin: 'https://api.cloudflare.com', method: 'DELETE', headerNames: ['authorization'] },
} as const satisfies CloudflareRouteRequest['credentialBindings'];
type FixtureOptions = { installed?: boolean; dnsInstalled?: boolean; foreignDns?: boolean; localTunnel?: boolean;
  putLost?: boolean; dnsLost?: boolean; dnsVerificationLost?: boolean; dnsAcknowledgement?: 'missing-id' | 'wrong-target';
  putAcknowledgementMismatch?: boolean; denied?: boolean; abort?: AbortController;
  pagedForeignDns?: boolean; retainedDnsReadLost?: boolean; foreignPath?: boolean; readLost?: boolean; malformedJson?: boolean;
  createLost?: boolean; tokenLost?: boolean; tokenResult?: unknown; canonicalRemote?: boolean;
  tunnelName?: string; wrongAccount?: boolean; tunnelPages?: readonly (readonly Record<string, unknown>[])[];
  wrongService?: boolean; omitPagination?: boolean; dnsPages?: readonly (readonly Record<string, unknown>[])[] };

function fixture(options: FixtureOptions = {}) {
  let config = { ingress: options.installed ? [foreign,
    ...(options.foreignPath ? [{ hostname, path: '/retained/.*', service: 'http://retained:8080' }] : []),
    { hostname, service: options.wrongService ? 'http://foreign:9000' : service }, fallback] : [foreign, fallback], originRequest: { connectTimeout: 10 } };
  const records = new Map<string, Record<string, unknown>>([[unrelatedDns.id, { ...unrelatedDns }]]);
  if (options.dnsInstalled || options.foreignDns) records.set('record-owned', { id: 'record-owned', name: hostname,
    type: 'CNAME', content: options.foreignDns ? 'foreign.example.test' : `${tunnelId}.cfargotunnel.com`, proxied: true, ttl: 1 });
  let configReads = 0, dnsPageReads = 0;
  const requests: { method: string; url: string; body: unknown; credentialBinding: PluginFetchCredentialBinding | undefined }[] = [];
  const http: Pick<HttpService, 'request'> = { async request(input, requestOptions) {
    expect(requestOptions?.signal).toBeDefined();
    requestOptions?.signal?.throwIfAborted();
    expect(input.redirect).toBe('error');
    expect(input.headers ?? {}).not.toHaveProperty('authorization');
    const method = input.method ?? 'GET';
    const body: unknown = input.body ? JSON.parse(new TextDecoder().decode(input.body)) : undefined;
    requests.push({ method, url: input.url, body, credentialBinding: input.credentialBinding });
    if (options.malformedJson) return { status: 200, finalUrl: input.url, headers: {},
      body: new TextEncoder().encode('{invalid-provider-json') };
    if (options.readLost && method === 'GET') throw new Error('synthetic-private-native-error');
    let result: unknown;
    let result_info: unknown;
    if (input.url.startsWith(`${collection}?`) && method === 'GET') {
      const query = new URL(input.url).searchParams;
      expect(query.get('name')).toBe('reviewed-tunnel');
      expect(query.get('is_deleted')).toBe('false');
      const page = Number(query.get('page'));
      const pages = options.tunnelPages ?? [[{ id: tunnelId, account_tag: accountId,
        name: 'reviewed-tunnel', deleted_at: null, config_src: 'cloudflare' }]];
      result = pages[page - 1] ?? [];
      if (!options.omitPagination) result_info = { page, per_page: 1, total_count: pages.length };
    } else if (input.url === collection && method === 'POST') {
      if (options.createLost) throw new Error(connectorToken);
      result = { id: tunnelId };
    } else if (input.url === `${root}/token` && method === 'GET') {
      if (options.tokenLost) throw new Error(connectorToken);
      result = options.tokenResult === undefined ? connectorToken : options.tokenResult;
    } else if (input.url === root && method === 'GET') result = {
      id: tunnelId, account_tag: options.wrongAccount ? 'c'.repeat(32) : accountId,
      name: options.tunnelName ?? 'reviewed-tunnel', deleted_at: null,
      ...(options.canonicalRemote ? { config_src: options.localTunnel ? 'local' : 'cloudflare' } : { remote_config: !options.localTunnel }),
    };
    else if (input.url === `${root}/configurations`) {
      if (method === 'GET') {
        configReads += 1;
        result = { version: 1, config };
      } else if (method === 'PUT') {
        if (options.denied) return { status: 403, finalUrl: input.url, headers: {}, body: new TextEncoder().encode(JSON.stringify({ success: false, errors: [{ message: 'synthetic-private-native-error' }] })) };
        config = (body as { config: typeof config }).config;
        if (options.putLost) throw new Error('synthetic-private-native-error');
        result = { version: 2, config: options.putAcknowledgementMismatch ? { ingress: [fallback] } : config };
      } else throw new Error('Unexpected config method');
    } else if (input.url.startsWith(`${dnsRoot}?`) && method === 'GET') {
      const query = new URL(input.url).searchParams;
      expect(query.get('name')).toBe(hostname);
      const page = Number(query.get('page'));
      dnsPageReads += 1;
      result = options.dnsPages ? options.dnsPages[page - 1] ?? []
        : options.pagedForeignDns ? page === 1 ? [] : [{ id: 'foreign-dns', name: hostname, type: 'A', content: '192.0.2.8' }]
          : page === 1 ? [...records.values()].filter(record => record.name === hostname) : [];
      if (!options.omitPagination) result_info = { page, total_pages: options.pagedForeignDns ? 2 : 1 };
    } else if (input.url === dnsRoot && method === 'POST') {
      const record = { ...(body as Record<string, unknown>), id: 'record-new' };
      records.set(record.id, record);
      if (options.dnsLost) throw new Error('synthetic-private-native-error');
      result = options.dnsAcknowledgement === 'missing-id' ? body
        : options.dnsAcknowledgement === 'wrong-target' ? { ...record, content: 'foreign.example.test' } : record;
    } else if (input.url === `${dnsRoot}/record-owned` && method === 'GET') {
      if (options.retainedDnsReadLost) throw new Error('retained DNS read unavailable');
      result = records.get('record-owned');
    }
    else if (input.url === `${dnsRoot}/record-owned` && method === 'DELETE') {
      records.delete('record-owned'); result = { id: 'record-owned' };
    } else if (input.url === `${dnsRoot}/record-new` && method === 'GET') {
      if (options.dnsVerificationLost) throw new Error('synthetic-private-native-error');
      result = records.get('record-new');
    }
    else throw new Error(`Unexpected boundary request ${method} ${input.url}`);
    if (options.abort && method === 'PUT') options.abort.abort();
    return { status: 200, finalUrl: input.url, headers: {},
      body: new TextEncoder().encode(JSON.stringify({ success: true, result, ...(result_info ? { result_info } : {}) })) };
  } };
  const request: CloudflareRouteRequest = { http, credentialBindings, signal: options.abort?.signal ?? new AbortController().signal,
    accountId, zoneId, tunnelId, owned: options.installed ? [{ hostname, expectedService: service }] : [],
    desired: [{ hostname, service }], dnsOwnership: options.dnsInstalled ? [{ hostname, recordId: 'record-owned' }] : [] };
  return { request, requests, configuration: () => config, configReads: () => configReads,
    record: () => records.get(options.dnsInstalled || options.foreignDns ? 'record-owned' : 'record-new') ?? null,
    dnsRecords: () => [...records.values()],
    mutations: () => requests.filter(request => request.method !== 'GET') };
}

describe('Cloudflare controller owned route lifecycle', () => {
  // TEMPLATE-DOMAIN-1105: Remove recovers remote ownership after local
  // preparation was lost; its exact reviewed name never authorizes a create.
  it.each([
    { label: 'absent exact name', options: { tunnelPages: [[{ id: 'other', name: 'reviewed-tunnel-suffix' }]] }, expected: 'absent' },
    { label: 'owned config and DNS', options: { installed: true, dnsInstalled: true }, expected: 'removed' },
    { label: 'DNS left after partial config cleanup', options: { dnsInstalled: true }, expected: 'removed' },
    { label: 'config left before DNS creation', options: { installed: true }, expected: 'removed' },
    { label: 'foreign route service', options: { installed: true, dnsInstalled: true, wrongService: true }, expected: 'conflict' },
    { label: 'foreign DNS target', options: { installed: true, foreignDns: true }, expected: 'conflict' },
    { label: 'matching name on a later page', options: { installed: true, dnsInstalled: true, tunnelPages: [
      [{ id: 'other', name: 'reviewed-tunnel-suffix' }],
      [{ id: tunnelId, account_tag: accountId, name: 'reviewed-tunnel', deleted_at: null, config_src: 'cloudflare' }],
    ] }, expected: 'removed' },
    { label: 'ambiguous exact names across pages', options: { tunnelPages: [
      [{ id: tunnelId, account_tag: accountId, name: 'reviewed-tunnel', deleted_at: null, config_src: 'cloudflare' }],
      [{ id: 'other', account_tag: accountId, name: 'reviewed-tunnel', deleted_at: null, config_src: 'cloudflare' }],
    ] }, expected: 'conflict' },
    { label: 'ambiguous exact names without pagination metadata', options: { omitPagination: true, tunnelPages: [
      [{ id: tunnelId, account_tag: accountId, name: 'reviewed-tunnel', deleted_at: null, config_src: 'cloudflare' }],
      [{ id: 'other', account_tag: accountId, name: 'reviewed-tunnel', deleted_at: null, config_src: 'cloudflare' }],
    ] }, expected: 'conflict' },
  ] satisfies readonly { label: string; options: FixtureOptions; expected: string }[])(
    'removes by reviewed name without preparation: $label', async ({ options, expected }) => {
      const state = fixture(options);
      const http = createPluginHttpFixture({ request: (request, requestOptions) => state.request.http.request(request, requestOptions) });
      const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
      try {
        const result = await kit.invokeAction('cloudflare-named/disable', {
          credentialRef: { service: { pluginId: entry.manifest.id, localId: 'cloudflare' }, accountId: 'selected-profile' },
          accountId, zoneId, tunnelName: 'reviewed-tunnel', owned: [{ hostname, expectedService: service }], dnsOwnership: [],
        });
        if (expected === 'conflict') {
          expect(result).toEqual({ kind: 'refused', code: 'route_conflict' });
          expect(state.mutations()).toEqual([]);
        } else {
          expect(result).toEqual({ kind: 'verified', ...(expected === 'absent' ? {} : { tunnelId }), dnsOwnership: [] });
          if (expected === 'absent') expect(state.mutations()).toEqual([]);
          else {
            expect(state.configuration().ingress).toEqual([foreign, fallback]);
            expect(state.dnsRecords()).toEqual([unrelatedDns]);
          }
        }
        expect(state.mutations().every(request => request.method !== 'POST' && request.url !== root)).toBe(true);
        for (const request of state.requests) expect(request.credentialBinding)
          .toEqual(credentialBindings[request.method as keyof typeof credentialBindings]);
      } finally { await kit.dispose(); }
    });

  it('still refuses unrecorded DNS IDs for prepared removal', async () => {
    const state = fixture({ installed: true, dnsInstalled: true });
    expect(await disableOwnedCloudflareRoutes({ ...state.request, dnsOwnership: [] }))
      .toEqual({ kind: 'refused', code: 'route_conflict' });
    expect(state.mutations()).toEqual([]);
  });

  it('preserves foreign DNS on later pages when pagination metadata is omitted', async () => {
    const state = fixture({ installed: true, dnsInstalled: true, omitPagination: true, dnsPages: [
      [{ id: 'record-owned', name: hostname, type: 'CNAME', content: `${tunnelId}.cfargotunnel.com`, proxied: true }],
      [{ id: 'foreign-dns', name: hostname, type: 'A', content: '192.0.2.8' }],
    ] });
    expect(await disableOwnedCloudflareRoutes(state.request)).toEqual({ kind: 'refused', code: 'route_conflict' });
    expect(state.record()).not.toBeNull();
    expect(state.mutations()).toEqual([]);
  });

  it('forwards the exact admitted credential binding while merging native config and creating its proxied CNAME', async () => {
    const state = fixture();
    expect(await reconcileOwnedCloudflareRoutes(state.request)).toEqual({ kind: 'verified', tunnelId,
      dnsOwnership: [{ hostname, recordId: 'record-new' }] });
    expect(state.configuration()).toEqual({ ingress: [foreign, { hostname, service }, fallback], originRequest: { connectTimeout: 10 } });
    expect(state.record()).toMatchObject({ name: hostname, type: 'CNAME', content: `${tunnelId}.cfargotunnel.com`, proxied: true });
    expect(state.mutations().map(request => request.method)).toEqual(['PUT', 'POST']);
    for (const request of state.requests) expect(request.credentialBinding,
      JSON.stringify({ expected: credentialBindings[request.method as keyof typeof credentialBindings], actual: request.credentialBinding ?? null }))
      .toBe(credentialBindings[request.method as keyof typeof credentialBindings]);
    expect(JSON.stringify(state.requests.map(({ method, url, body }) => ({ method, url, body })))).not.toMatch(/\/token|"token"|authorization|secret/);
  });

  it('keeps an equal second apply read-only without claiming connector or app readiness', async () => {
    const state = fixture({ installed: true, dnsInstalled: true });
    const result = await reconcileOwnedCloudflareRoutes(state.request);
    expect(result).toEqual({ kind: 'verified', tunnelId, dnsOwnership: [{ hostname, recordId: 'record-owned' }] });
    expect(state.mutations()).toEqual([]);
    expect(result).not.toHaveProperty('enabled');
    expect(result).not.toHaveProperty('healthy');
  });

  it.each([{ localTunnel: true }, { foreignDns: true }])('refuses conflicting native ownership before any write: %j', async options => {
    const state = fixture(options);
    expect(await reconcileOwnedCloudflareRoutes(state.request)).toMatchObject({ kind: 'refused' });
    expect(state.mutations()).toEqual([]);
  });

  it.each([{ putLost: true }, { dnsLost: true }])('does not replay a transport-unknown native mutation or leak native error bodies: %j', async options => {
    const state = fixture(options);
    const result = await reconcileOwnedCloudflareRoutes(state.request);
    expect(result).toEqual({ kind: 'unknown', code: 'outcome_unknown' });
    expect(state.mutations().filter(request => request.method === 'PUT')).toHaveLength(1);
    expect(state.mutations().filter(request => request.method === 'POST')).toHaveLength(options.dnsLost ? 1 : 0);
    expect(JSON.stringify(result)).not.toContain('synthetic-private-native-error');
  });

  it('settles an acknowledged DNS creation with one write request when the record GET is unavailable', async () => {
    const state = fixture({ dnsVerificationLost: true });
    const result = await reconcileOwnedCloudflareRoutes(state.request);
    expect.soft(result).toEqual({ kind: 'verified', tunnelId,
      dnsOwnership: [{ hostname, recordId: 'record-new' }] });
    expect(state.record()).toMatchObject({ id: 'record-new', name: hostname });
    expect(state.mutations().map(request => request.method)).toEqual(['PUT', 'POST']);
    const writeIndex = state.requests.findIndex(request => request.method === 'POST' && request.url === dnsRoot);
    expect(writeIndex).toBeGreaterThanOrEqual(0);
    expect(state.requests.slice(writeIndex).map(({ method, url }) => ({ method, url })))
      .toEqual([{ method: 'POST', url: dnsRoot }]);
    expect(JSON.stringify(result)).not.toContain('synthetic-private-native-error');
  });

  it.each(['missing-id', 'wrong-target'] as const)('does not accept a malformed DNS creation acknowledgement: %s', async dnsAcknowledgement => {
    const state = fixture({ dnsAcknowledgement });
    expect(await reconcileOwnedCloudflareRoutes(state.request)).toEqual({ kind: 'unknown', code: 'outcome_unknown' });
    expect(state.mutations().map(request => request.method)).toEqual(['PUT', 'POST']);
  });

  it('disables only owned hostname/DNS through public Account activation and preserves foreign config order', async () => {
    const state = fixture({ installed: true, dnsInstalled: true });
    const http = createPluginHttpFixture({ request: (request, options) => state.request.http.request(request, options) });
    const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
    try {
      expect(await kit.invokeAction('cloudflare-named/disable', {
        credentialRef: { service: { pluginId: entry.manifest.id, localId: 'cloudflare' }, accountId: 'selected-profile' },
        accountId, zoneId, tunnelId, owned: state.request.owned, dnsOwnership: state.request.dnsOwnership,
      })).toEqual({ kind: 'verified', tunnelId, dnsOwnership: [] });
      expect(state.configuration()).toEqual({ ingress: [foreign, fallback], originRequest: { connectTimeout: 10 } });
      expect(state.record()).toBeNull();
      expect(state.dnsRecords()).toEqual([unrelatedDns]);
      expect(state.mutations().map(request => request.url)).toEqual([`${root}/configurations`, `${dnsRoot}/record-owned`]);
      expect(state.mutations().map(request => request.method)).toEqual(['PUT', 'DELETE']);
      for (const request of state.requests) expect(request.credentialBinding)
        .toEqual(credentialBindings[request.method as keyof typeof credentialBindings]);
    } finally { await kit.dispose(); }
  });

  it('N33 merges from one configuration GET and trusts the PUT acknowledgement without rereading its own write', async () => {
    const state = fixture();
    expect(await reconcileOwnedCloudflareRoutes(state.request)).toEqual({ kind: 'verified', tunnelId,
      dnsOwnership: [{ hostname, recordId: 'record-new' }] });
    expect(state.configuration()).toEqual({ ingress: [foreign, { hostname, service }, fallback], originRequest: { connectTimeout: 10 } });
    expect(state.configReads()).toBe(1);
    expect(state.requests.filter(request => request.url === `${root}/configurations`).map(request => request.method)).toEqual(['GET', 'PUT']);
  });

  it('N33 settles a mismatched PUT acknowledgement as unknown without a DNS write or false success', async () => {
    const state = fixture({ putAcknowledgementMismatch: true });
    const result = await reconcileOwnedCloudflareRoutes(state.request);
    expect(result, JSON.stringify({ actual: result, expected: { kind: 'unknown', code: 'outcome_unknown' } }))
      .toEqual({ kind: 'unknown', code: 'outcome_unknown' });
    expect(state.mutations().map(request => request.method)).toEqual(['PUT']);
    expect(state.configReads()).toBe(1);
  });

  it('preserves permission refusal and stops before DNS effects', async () => {
    const state = fixture({ denied: true });
    expect(await reconcileOwnedCloudflareRoutes(state.request)).toEqual({ kind: 'refused', code: 'denied' });
    expect(state.mutations().map(request => request.method)).toEqual(['PUT']);
  });

  it('cancels before the first request and keeps a cancellation after mutation unknown', async () => {
    const initial = new AbortController(); initial.abort();
    const cancelled = fixture();
    expect(await reconcileOwnedCloudflareRoutes({ ...cancelled.request, signal: initial.signal })).toEqual({ kind: 'refused', code: 'cancelled' });
    expect(cancelled.requests).toEqual([]);
    const after = fixture({ abort: new AbortController() });
    expect(await reconcileOwnedCloudflareRoutes(after.request)).toEqual({ kind: 'unknown', code: 'outcome_unknown' });
    expect(after.mutations().map(request => request.method)).toEqual(['PUT']);
  });

  it('reads every exact-name DNS page before deciding absence or performing any mutation', async () => {
    const state = fixture({ pagedForeignDns: true });
    expect(await reconcileOwnedCloudflareRoutes(state.request)).toEqual({ kind: 'refused', code: 'route_conflict' });
    expect(state.requests.filter(request => request.url.startsWith(`${dnsRoot}?`))).toHaveLength(2);
    expect(state.mutations()).toEqual([]);
  });

  it('settles an applied route change from admitted DNS ownership when the redundant record GET is unavailable', async () => {
    const state = fixture({ installed: true, dnsInstalled: true, retainedDnsReadLost: true });
    const nextService = 'http://replacement-caddy:8080';
    expect(await reconcileOwnedCloudflareRoutes({ ...state.request, desired: [{ hostname, service: nextService }] }))
      .toEqual({ kind: 'verified', tunnelId, dnsOwnership: [{ hostname, recordId: 'record-owned' }] });
    expect(state.configuration().ingress).toContainEqual({ hostname, service: nextService });
    expect(state.requests.filter(request => request.url.startsWith(dnsRoot)).map(({ method, url }) => ({ method, url })))
      .toEqual([{ method: 'GET', url: `${dnsRoot}?name=${hostname}&page=1` }]);
    expect(state.mutations().map(request => request.method)).toEqual(['PUT']);
  });

  it('removes an owned path without deleting DNS still used by a foreign path at the same hostname', async () => {
    const state = fixture({ installed: true, dnsInstalled: true, foreignPath: true });
    expect(await disableOwnedCloudflareRoutes(state.request)).toEqual({ kind: 'verified', tunnelId,
      dnsOwnership: [{ hostname, recordId: 'record-owned' }] });
    expect(state.configuration().ingress).toEqual([foreign,
      { hostname, path: '/retained/.*', service: 'http://retained:8080' }, fallback]);
    expect(state.record()).not.toBeNull();
    expect(state.mutations().map(request => request.method)).toEqual(['PUT']);
  });

  it('keeps a failed native read unknown and performs no writes or automatic retries', async () => {
    const state = fixture({ readLost: true });
    expect(await reconcileOwnedCloudflareRoutes(state.request)).toEqual({ kind: 'unknown', code: 'provider_unavailable' });
    expect(state.requests).toHaveLength(1);
  });

  it('refuses malformed provider JSON before mutation with a typed provider-output error', async () => {
    const state = fixture({ malformedJson: true });
    const result = await reconcileOwnedCloudflareRoutes(state.request);
    expect(result, JSON.stringify({ actual: result, expected: { kind: 'refused', code: 'invalid_provider_output' } }))
      .toEqual({ kind: 'refused', code: 'invalid_provider_output',
        providerOutput: 'GET /accounts/{account_id}/cfd_tunnel/{tunnel_id}: $ expected JSON' });
    expect(state.mutations()).toEqual([]);
    expect(state.requests).toHaveLength(1);
  });
});

describe('Cloudflare controller create/adopt through the activated Account Action', () => {
  const action = 'cloudflare-named/configure';
  const grants = [
    { machineId: 'member-a', installationId: 'installation-a', grantRef: 'opaque-member-a-grant' },
    { machineId: 'member-b', installationId: 'installation-b', grantRef: 'opaque-member-b-grant' },
  ];
  const credentialRef = { service: { pluginId: entry.manifest.id, localId: 'cloudflare' }, accountId: 'selected-profile' };

  // Only vendor HTTP and the invocation-private host custody service are
  // replaced. Public activation, schema admission and owned route logic run.
  async function controller(options: FixtureOptions & { noGrant?: boolean; grantError?: Error } = {}) {
    const state = fixture(options);
    const buffers: Uint8Array[] = [], material: number[][] = [];
    const http = createPluginHttpFixture({ request: (request, requestOptions) => {
      if (request.method === 'PUT') expect(buffers.every(bytes => bytes.every(byte => byte === 0))).toBe(true);
      return state.request.http.request(request, requestOptions);
    } });
    const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
    const registered: unknown = kit.registration('actions', action);
    if (typeof registered !== 'function') { await kit.dispose(); throw new Error('Missing activated Cloudflare create/adopt Action'); }
    const write = vi.fn(async (request: Readonly<{ token: Uint8Array;
      subject: Readonly<{ provider: AccessProviderRefV1; connectorId: string }> }>) => {
      state.request.signal.throwIfAborted();
      buffers.push(request.token);
      material.push([...request.token]);
      if (options.grantError) throw options.grantError;
      return { grants };
    });
    const unavailable = (): never => { throw new Error('Unexpected service'); };
    // A local structural variable keeps this RED compilable before the new
    // optional SDK member lands; it mirrors the agreed public service shape.
    const services = { http, ...(!options.noGrant ? { machineConnectorSecrets: { write } } : {}),
      get secrets() { return unavailable(); },
      get connectedAccounts() { return unavailable(); },
      get storage() { return unavailable(); }, get settings() { return unavailable(); },
      get actions() { return unavailable(); }, get targetedContributions() { return unavailable(); } };
    const context: PluginAccountActionContext = { plugin: { id: entry.manifest.id, version: entry.manifest.version },
      contribution: { id: action, qualifiedId: `${entry.manifest.id}/${action}` }, surface: 'cli', invokedAtMs: 1,
      signal: state.request.signal, services };
    const input = { credentialRef, accountId, zoneId,
      tunnel: { kind: 'adopt', tunnelId, name: 'reviewed-tunnel' },
      owned: state.request.owned, desired: state.request.desired, dnsOwnership: state.request.dnsOwnership };
    return { ...state, kit, input, write, buffers, material,
      // Registration erases its generic handler type; this is the same public
      // Account invocation boundary used by the selected-zone owner fixture.
      invoke: (value: JsonValue = input) => registered(value, context) };
  }

  it.each(['create', 'adopt'] as const)('prepares %s through owned routes and private custody without reporting native readiness', async kind => {
    const state = await controller({ canonicalRemote: true });
    try {
      const tunnel = kind === 'create' ? { kind, name: 'reviewed-tunnel' } : state.input.tunnel;
      const result = await state.invoke({ ...state.input, tunnel });
      expect(result).toEqual({ kind: 'prepared', tunnelId, grants, dnsOwnership: [{ hostname, recordId: 'record-new' }] });
      expect(state.material).toEqual([[...new TextEncoder().encode(connectorToken)]]);
      expect(state.write).toHaveBeenCalledTimes(1);
      expect(state.write).toHaveBeenCalledWith({ token: expect.any(Uint8Array),
        subject: { provider: { kind: 'builtin', id: 'cloudflareNamed' }, connectorId: tunnelId } });
      expect(state.buffers.every(bytes => bytes.every(byte => byte === 0))).toBe(true);
      expect(state.configuration()).toEqual({ ingress: [foreign, { hostname, service }, fallback], originRequest: { connectTimeout: 10 } });
      expect(state.configReads()).toBe(1);
      expect(state.requests.filter(request => request.url === collection)).toEqual(kind === 'create'
        ? [expect.objectContaining({ method: 'POST', body: { name: 'reviewed-tunnel', config_src: 'cloudflare' } })] : []);
      expect(JSON.stringify({ result, requests: state.requests })).not.toContain(connectorToken);
      expect(result).not.toHaveProperty('enabled');
      expect(result).not.toHaveProperty('healthy');
      for (const request of state.requests) expect(request.credentialBinding).toEqual(credentialBindings[request.method as keyof typeof credentialBindings]);
    } finally { await state.kit.dispose(); }
  });

  it('requires the admitted controller grant service before any vendor effect and refuses portable execution', async () => {
    const state = await controller({ noGrant: true });
    try {
      await expect(state.invoke()).rejects.toMatchObject({ code: 'controller_services_unavailable' });
      await expect(state.kit.invokeAction(action, state.input)).rejects.toMatchObject({ code: 'controller_services_unavailable' });
      expect(state.requests).toEqual([]);
    } finally { await state.kit.dispose(); }
  });

  it.each([{ localTunnel: true }, { wrongAccount: true }, { tunnelName: 'foreign-tunnel' }, { foreignDns: true }])(
    'refuses a selected tunnel or route ownership mismatch before token acquisition: %j', async options => {
      const state = await controller({ ...options, canonicalRemote: true });
      try {
        expect(await state.invoke()).toEqual({ kind: 'refused', code: 'route_conflict', tunnelId });
        expect(state.write).not.toHaveBeenCalled();
        expect(state.requests.some(request => request.url.endsWith('/token'))).toBe(false);
        expect(state.mutations()).toEqual([]);
      } finally { await state.kit.dispose(); }
    });

  it('never retries a lost create or discloses its native error, and keeps known partial coordinates for deliberate adoption', async () => {
    const lost = await controller({ createLost: true });
    try {
      expect(await lost.invoke({ ...lost.input, tunnel: { kind: 'create', name: 'reviewed-tunnel' } }))
        .toEqual({ kind: 'unknown', code: 'outcome_unknown' });
      expect(lost.requests.map(request => request.method)).toEqual(['POST']);
      expect(lost.write).not.toHaveBeenCalled();
    } finally { await lost.kit.dispose(); }
    const partial = await controller({ canonicalRemote: true, grantError: new Error(connectorToken) });
    try {
      const result = await partial.invoke({ ...partial.input, tunnel: { kind: 'create', name: 'reviewed-tunnel' } });
      expect(result).toEqual({ kind: 'unknown', code: 'connector_grant_unavailable', tunnelId });
      expect(JSON.stringify(result)).not.toContain(connectorToken);
      expect(partial.buffers.every(bytes => bytes.every(byte => byte === 0))).toBe(true);
      expect(partial.requests.some(request => request.url === root && request.method === 'DELETE')).toBe(false);
    } finally { await partial.kit.dispose(); }
  });

  it.each([
    { label: 'malformed token envelope', options: { tokenResult: { token: connectorToken } }, expected: { kind: 'refused', code: 'invalid_provider_output',
      providerOutput: 'GET /accounts/{account_id}/cfd_tunnel/{tunnel_id}/token: result expected nonempty string' } },
    { label: 'lost token response', options: { tokenLost: true }, expected: { kind: 'unknown', code: 'provider_unavailable' } },
  ])('never seals $label', async ({ options, expected }) => {
    const state = await controller({ ...options, canonicalRemote: true });
    try {
      const result = await state.invoke();
      expect(result).toEqual({ ...expected, tunnelId });
      expect(JSON.stringify(result)).not.toContain(connectorToken);
      expect(state.write).not.toHaveBeenCalled();
    } finally { await state.kit.dispose(); }
  });

  it('retains only sealed recovery custody after cancellation of an acknowledged route mutation, without guessed rollback', async () => {
    const abort = new AbortController();
    const state = await controller({ canonicalRemote: true, abort });
    try {
      expect(await state.invoke()).toMatchObject({ kind: 'unknown', code: 'outcome_unknown', tunnelId, grants });
      expect(state.material).toEqual([[...new TextEncoder().encode(connectorToken)]]);
      expect(state.buffers.every(bytes => bytes.every(byte => byte === 0))).toBe(true);
      expect(state.mutations().map(request => request.method)).toEqual(['PUT']);
    } finally { await state.kit.dispose(); }
  });

  it('prepares the Account Action from acknowledged DNS ownership when a later record GET is unavailable', async () => {
    const state = await controller({ canonicalRemote: true, dnsVerificationLost: true });
    try {
      expect(await state.invoke()).toEqual({ kind: 'prepared', tunnelId, grants,
        dnsOwnership: [{ hostname, recordId: 'record-new' }] });
      expect(state.buffers.every(bytes => bytes.every(byte => byte === 0))).toBe(true);
      expect(state.mutations().map(request => request.method)).toEqual(['PUT', 'POST']);
      expect(state.requests.filter(request => request.url === `${dnsRoot}/record-new`)).toHaveLength(0);
    } finally { await state.kit.dispose(); }
  });

  it('keeps raw tokens, caller purpose and Machine authority outside its closed Action input', async () => {
    const state = await controller();
    try {
      for (const extra of [{ token: connectorToken }, { purpose: 'deploy.manage' }, { machineId: 'other-machine' }]) {
        await expect(state.kit.invokeAction(action, { ...state.input, ...extra })).rejects.toThrow();
      }
      expect(state.requests).toEqual([]);
    } finally { await state.kit.dispose(); }
  });
});
