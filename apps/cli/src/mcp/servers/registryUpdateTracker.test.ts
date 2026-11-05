import { once } from 'node:events';
import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { McpServerCatalogV1Schema, McpServerCatalogRowMutationV1Schema, openMcpServerCatalogContentV1,
  type McpServerCatalogV1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { RegistryUpstreamV1Schema, REGISTRY_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/registries';
import { PromptLibraryRowsListResponseV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot, subscribeActiveAccountSettingsKeys } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createCliMcpServerStore } from '@/settings/mcp/mcpServerStore';
import { createCliRegistryUpdateCheck } from '@/registries/updates/createCliRegistryUpdateCheck';
import { createMcpRegistryUpdateTracker } from './registryUpdateTracker';
import { manifest as machineServicesManifest } from '../../../../../packages/plugins/machine-services/src/manifest';
import { AutomationEventAdmitInputV1Schema } from '@happier-dev/protocol/automations/automationActionSpecsV1';
import { MCP_SERVER_CATALOG_ACCOUNT_KEY_V1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { runCheckpointedPluginEventObserverV1, type BackgroundServiceContext,
  type PluginCheckpointedEventSourceDefinitionV1 } from '@happier-dev/plugin-sdk/background-services';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { projectAccountEntitiesInvalidationForHost } from '@/daemon/events/accountEntityInvalidation';
import { MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/mcp/servers/serverActionsV1';

afterEach(() => { resetActiveAccountSettingsSnapshotForTests(); vi.unstubAllGlobals(); });

function initialCatalog() {
  const entry = { id: 'registered', name: 'registered', transport: 'stdio', stdio: { command: 'echo', args: ['v1'] },
    env: { PUBLIC: { t: 'literal', v: 'kept' } }, tools: { default: 'ask', overrides: { write: 'off' } },
    createdAt: 1, updatedAt: 2 };
  return McpServerCatalogV1Schema.parse({ v: 1, servers: [
    { ...entry, origin: { kind: 'registry', provenance: { sourceId: 'builtin:mcp-registry', format: 'mcp-registry',
      sourceUrl: 'https://registry.modelcontextprotocol.io', itemId: 'example/server',
      ref: { kind: 'version', version: 'v1' }, importedAt: 1 } } },
    { ...entry, id: 'custom', name: 'custom' },
    { ...entry, id: 'found', name: 'found', origin: { kind: 'machine', machineId: 'machine', agentId: 'claude' } },
  ], bindings: [{ id: 'rule', serverId: 'registered', enabled: false, target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1 }] });
}

async function withAccount(run: (fixture: {
  tracker: ReturnType<typeof createMcpRegistryUpdateTracker>;
  checker: ReturnType<typeof createCliRegistryUpdateCheck>;
  catalog(): McpServerCatalogV1; revision(): number; writes(): number;
  replace(catalog: McpServerCatalogV1): void;
  onWrite(callback: () => void): void;
}) => Promise<void>) {
  let catalog = initialCatalog();
  let revision = 1;
  let writes = 0;
  let race: (() => void) | undefined;
  const errors: unknown[] = [];
  // Only the Home HTTP/persistent-row boundary is substituted. The captured
  // CLI store, mode admission, mutation reducer, encryption and CAS are real.
  const http = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    try {
      if (request.url === '/v1/account/encryption/currentness') {
        response.end(JSON.stringify({ mode: 'plain', version: 1, settingsVersion: 7, updatedAt: 1,
          signingKeyFingerprint: null, contentKeyFingerprint: null }));
      } else if (request.url === '/v1/account/entity-rows/mcp' && request.method === 'GET') {
        response.end(JSON.stringify({ status: 'present', revision, content: { t: 'plain', v: catalog } }));
      } else if (request.url === '/v1/account/entity-rows/mcp' && request.method === 'POST') {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const mutation = McpServerCatalogRowMutationV1Schema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        writes++;
        const concurrent = race; race = undefined; concurrent?.();
        if (mutation.expectedRevision !== revision) {
          response.statusCode = 409;
          response.end(JSON.stringify({ status: 'conflict', revision }));
        } else {
          const opened = openMcpServerCatalogContentV1({ mode: 'plain', material: null, content: mutation.content });
          if (opened.status !== 'opened') throw new Error('Invalid catalog write');
          catalog = opened.catalog;
          response.end(JSON.stringify({ status: 'updated', revision: ++revision, cursor: revision }));
        }
      } else if (request.url === '/v2/account/settings') {
        response.end(JSON.stringify({ content: { t: 'plain', v: { mcpServersStrictMode: false } }, version: 7 }));
      } else if (request.url === '/v1/account/entity-rows/prompt-library') {
        response.end(JSON.stringify(PromptLibraryRowsListResponseV1Schema.parse({ status: 'listed', rows: [{
          key: 'registry-sources', revision: 1, content: { t: 'plain', v: { key: 'registry-sources',
            value: { v: 2, sources: [], disabledSourceIds: [] } } },
        }] })));
      } else if (request.url?.startsWith('/v2/account/settings/history')) {
        response.end(JSON.stringify({ snapshots: [] }));
      } else {
        response.statusCode = 404; response.end('{}');
      }
    } catch (error) {
      errors.push(error); response.statusCode = 500; response.end('{}');
    }
  });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('Missing Account fixture address');
  const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'tracker-account' })).toString('base64url')}.signature`, encryption: null };
  const raw = { mcpServersStrictMode: false };
  setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse(raw), rawSettings: raw,
    settingsVersion: 7, settingsSecretsReadKeys: [], loadedAtMs: 1, scopeKey: resolveAccountSettingsScopeKey(credentials) });
  try {
    await runWithServerHttpBaseUrl(`http://127.0.0.1:${address.port}`, async () => {
      const store = createCliMcpServerStore({ credentials, hasPendingCleanup: () => true });
      const tracker = createMcpRegistryUpdateTracker({ store });
      await run({ tracker, checker: createCliRegistryUpdateCheck({ credentials }),
        catalog: () => catalog, revision: () => revision, writes: () => writes,
        replace: value => { catalog = McpServerCatalogV1Schema.parse(value); revision++; },
        onWrite: callback => { race = callback; } });
    });
    expect(errors).toEqual([]);
  } finally {
    await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
  }
}

describe('MCP registry update tracker', () => {
  it('returns an empty check for an authoritative empty Account catalog without registry fetches or writes', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => { throw new Error('Unexpected registry fetch'); }));
    await withAccount(async fixture => {
      fixture.replace({ v: 1, servers: [], bindings: [] });
      expect(await fixture.tracker.list()).toEqual([]);
      expect((await fixture.checker.checkNow({ kind: 'mcpServer' })).results).toEqual([]);
      expect(fixture.writes()).toBe(0);
    });
  });

  it('checks MCP updates through the production checker composition and persists its strict result', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async request => {
      const url = new URL(String(request));
      if (url.origin !== 'https://registry.modelcontextprotocol.io') throw new Error('Unexpected registry HTTP request');
      return Response.json({ servers: [{ server: { name: 'example/server', description: 'Example server', version: 'v2',
        packages: [{ registryType: 'npm', identifier: 'example-server', version: '2.0.0', transport: { type: 'stdio' } }] },
        _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active', isLatest: true } } }], metadata: { count: 1 } });
    }));
    await withAccount(async fixture => {
      const result = await fixture.checker.checkNow({ kind: 'mcpServer', keys: ['registered'] });
      expect(REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.updates.check'].parse(result)).toMatchObject({ results: [{
        kind: 'mcpServer', key: 'registered', upstream: { state: 'update_available', latest: { kind: 'version', version: 'v2' } },
      }] });
      expect(fixture.catalog().servers[0]!.origin).toMatchObject({ upstream: result.results[0]!.upstream });
      const origin = fixture.catalog().servers[0]!.origin;
      expect(origin).toMatchObject({ upstreamObservedAt: expect.any(Number) });
      await fixture.checker.checkNow({ kind: 'mcpServer', keys: ['registered'] });
      expect(fixture.catalog().servers[0]!.origin).toEqual(origin);
      expect(fixture.writes()).toBe(1);
    });
  });

  it('rereads and emits only a changed MCP server while preserving admission replay and reconnect catch-up', async () => {
    expect(machineServicesManifest.contributes?.events?.some(event => event.id === 'mcp-update-available')).toBe(true);
    const { createMcpUpdateEventSourceAdapter } = await import('../../../../../packages/plugins/machine-services/src/mcpUpdateEvents');
    await withAccount(async fixture => {
      const upstream = RegistryUpstreamV1Schema.parse({ state: 'update_available', latest: { kind: 'version', version: 'v2' } });
      await fixture.tracker.record([{ key: 'registered', upstream }]);
      const server = fixture.catalog().servers[0]!;
      const servers = Array.from({ length: 64 }, (_, index) => ({ ...server, id: index === 0 ? 'registered' : `registered-${index}`, name: `registered-${index}` }));
      fixture.replace({ ...fixture.catalog(), servers });
      await fixture.tracker.record([{ key: 'registered', upstream: { ...upstream, latest: { kind: 'version', version: 'v2.1' } } }]);
      const materialization = { pluginId: machineServicesManifest.id, machineId: 'observer', materializationId: 'installed' };
      const definition: PluginCheckpointedEventSourceDefinitionV1 = { automationId: '11111111-1111-4111-8111-111111111111',
        triggerId: 'update-trigger', triggerRevision: 1, sourceSelectorId: '22222222-2222-4222-8222-222222222222',
        eventRef: { pluginId: machineServicesManifest.id, localId: 'mcp-update-available' }, sourceInstanceId: 'mcp-update:source', sourceContractVersion: 1,
        sourceConfig: { v: 1, mcpServerId: 'registered', observingSince: 0 },
        observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: materialization }, filter: null, maximumObservationAgeMs: null };
      const definitions = servers.map(server => ({ ...definition, sourceInstanceId: `mcp-update:${server.id}`,
        sourceConfig: { v: 1, mcpServerId: server.id, observingSince: 0 } }));
      const admissions: ReturnType<typeof AutomationEventAdmitInputV1Schema.parse>[] = [];
      type Listener = (event: { payload: JsonValue }) => void | Promise<void>;
      const listeners = new Map<string, Set<Listener>>();
      let safe = false;
      // Only Host Actions and delivery are substituted; reads consume the real
      // registry tracker's committed catalog through the strict read schema.
      const execute = vi.fn(async (id: string, input: Record<string, unknown>) => {
        if (id === 'automation.event.sources.list') return { kind: 'page', revision: '1', definitions, nextCursor: null };
        if (id === 'automation.event.source.status.report') return { kind: 'reported' };
        if (id === 'mcp.servers.read') return MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.read'].parse({ status: 'present', server: fixture.catalog().servers.find(server => server.id === input.serverId), bindings: [],
          revision: fixture.revision(), authority: 'active', complete: true, diagnostics: [] });
        if (id === 'automation.event.admit') { admissions.push(AutomationEventAdmitInputV1Schema.parse(input));
          return { results: safe ? [{ kind: 'admitted', checkpointSafe: true, runId: 'run' }] : [] }; }
        throw new Error(`Unexpected Action ${id}`);
      });
      const context = { plugin: { id: machineServicesManifest.id, version: machineServicesManifest.version },
        contribution: { id: 'mcp-update-observer', qualifiedId: `${machineServicesManifest.id}/backgroundServices/mcp-update-observer` },
        surface: 'background', invokedAtMs: Date.now(), materialization, signal: new AbortController().signal,
        services: { actions: { execute }, events: { host: { subscribe(target: { eventId: string }, listener: (event: { payload: JsonValue }) => void | Promise<void>) {
          const group = listeners.get(target.eventId) ?? new Set<Listener>();
          listeners.set(target.eventId, group); group.add(listener); return { dispose() { group.delete(listener); } };
        } } } } } as unknown as BackgroundServiceContext;
      const adapter = createMcpUpdateEventSourceAdapter(context.services.events.host);
      const subscription = adapter.subscribeWake?.(async () => {});
      const cycle = (source = adapter) => runCheckpointedPluginEventObserverV1({ context, source, mode: 'once' });
      const reads = () => execute.mock.calls.filter(([id]) => id === 'mcp.servers.read').length;
      const releasePublication = subscribeActiveAccountSettingsKeys({ facets: ['mcpServerCatalog'] }, (previous, next) => {
        const event = projectAccountEntitiesInvalidationForHost({ t: 'account-change', entityIds: [MCP_SERVER_CATALOG_ACCOUNT_KEY_V1] }, {
          previous: previous?.mcpServerCatalog, next: next?.mcpServerCatalog,
        });
        if (event) for (const listener of listeners.get(event.eventId) ?? []) void listener(event);
      });
      try {
        await cycle(); safe = true; await cycle();
        expect(admissions).toHaveLength(servers.length * 2);
        expect(admissions.slice(0, servers.length)).toEqual(admissions.slice(servers.length));
        expect(admissions[0].payload).toEqual({ mcpServerId: 'registered', observedAt: expect.any(Number),
          installedRefDigest: expect.any(String), upstreamRefDigest: expect.any(String) });
        await cycle();
        expect(admissions).toHaveLength(servers.length * 2);
        expect(reads()).toBe(servers.length);
        const beforeReads = reads();
        const beforeAdmissions = admissions.length;
        await fixture.tracker.record([{ key: 'registered', upstream: { ...upstream, latest: { kind: 'version', version: 'v3' } } }]);
        await cycle();
        expect(reads() - beforeReads).toBe(1);
        expect(admissions.length - beforeAdmissions).toBe(1);
        expect(admissions.at(-1)?.occurrenceId).not.toBe(admissions[0].occurrenceId);
        const changedReads = reads();
        const changedAdmissions = admissions.length;
        for (let index = 0; index < 3; index++) {
          await fixture.tracker.record([{ key: 'registered', upstream: { ...upstream, latest: { kind: 'version', version: 'v3' } } }]);
          const unrelated = projectAccountEntitiesInvalidationForHost({ t: 'account-change', entityIds: ['unrelated-row'] });
          if (unrelated) for (const listener of listeners.get(unrelated.eventId) ?? []) await listener(unrelated);
          await cycle();
        }
        expect(reads() - changedReads).toBe(0);
        expect(admissions.length - changedAdmissions).toBe(0);
        await fixture.tracker.record([{ key: 'registered', upstream: { ...upstream, latest: { kind: 'version', version: 'v4' } } }]);
        for (const listener of listeners.get('@happier/automation/event-sources-invalidated') ?? []) await listener({ payload: { reason: 'reconnect' } });
        await cycle();
        expect(reads() - changedReads).toBe(servers.length);
        expect(admissions.at(-servers.length)?.occurrenceId).not.toBe(admissions[0].occurrenceId);
        await cycle(createMcpUpdateEventSourceAdapter(context.services.events.host));
        expect(admissions.at(-servers.length)?.occurrenceId).toBe(admissions.at(-servers.length * 2)?.occurrenceId);
      } finally { releasePublication(); subscription?.dispose(); }
    });
  });

  it('lists actual registry origins and persists only changed upstream facts through the Account CAS', async () => {
    await withAccount(async fixture => {
      const { tracker } = fixture;
      const original = fixture.catalog();
      expect(tracker.kind).toBe('mcpServer');
      expect(await tracker.list()).toEqual([{ key: 'registered', provenance: original.servers[0]!.origin?.kind === 'registry'
        ? original.servers[0]!.origin.provenance : undefined }]);
      const upstream = RegistryUpstreamV1Schema.parse({ state: 'update_available', latest: { kind: 'version', version: 'v2' } });
      await tracker.record([{ key: 'registered', upstream }, { key: 'custom', upstream }]);
      expect(fixture.revision()).toBe(2);
      const entry = fixture.catalog().servers[0]!;
      expect(entry).toEqual({ ...original.servers[0], updatedAt: expect.any(Number), origin: { ...original.servers[0]!.origin, upstream, upstreamObservedAt: expect.any(Number) } });
      expect(entry.updatedAt).toBeGreaterThan(original.servers[0]!.updatedAt);
      expect(fixture.catalog().bindings).toEqual(original.bindings);
      expect(RegistryUpstreamV1Schema.parse(entry.origin?.kind === 'registry' ? entry.origin.upstream : undefined)).toEqual(upstream);
      await tracker.list();
      await tracker.record([{ key: 'registered', upstream }]);
      expect(fixture.writes()).toBe(1);
      await tracker.record([{ key: 'registered', upstream: { ...upstream, latest: { kind: 'version', version: 'v3' } } }]);
      await tracker.record([{ key: 'registered', upstream: { state: 'removed_from_source' } }]);
      expect(fixture.catalog().servers[0]!.origin).toEqual({ ...original.servers[0]!.origin, upstream: { state: 'removed_from_source' }, upstreamObservedAt: expect.any(Number) });
      expect(fixture.writes()).toBe(3);
    });
  });

  it('retains distinct observation identities when upstream changes twice in one clock tick', async () => {
    await withAccount(async fixture => {
      const clock = vi.spyOn(Date, 'now').mockReturnValue(50);
      try {
        const upstream = RegistryUpstreamV1Schema.parse({ state: 'update_available', latest: { kind: 'version', version: 'v2' } });
        await fixture.tracker.record([{ key: 'registered', upstream }]);
        const first = fixture.catalog().servers[0]!.origin;
        await fixture.tracker.record([{ key: 'registered', upstream: { state: 'current', latest: { kind: 'version', version: 'v1' } } }]);
        await fixture.tracker.record([{ key: 'registered', upstream }]);
        const next = fixture.catalog().servers[0]!.origin;
        expect(first?.kind).toBe('registry'); expect(next?.kind).toBe('registry');
        if (first?.kind !== 'registry' || next?.kind !== 'registry') throw new Error('Expected registry origin');
        expect(next.upstreamObservedAt).toBeGreaterThan(first.upstreamObservedAt!);
      } finally { clock.mockRestore(); }
    });
  });

  it('absorbs a duplicate observation after a lost CAS and preserves the competing writer configuration', async () => {
    await withAccount(async fixture => {
      await fixture.tracker.list();
      const upstream = RegistryUpstreamV1Schema.parse({ state: 'current', latest: { kind: 'version', version: 'v1' } });
      fixture.onWrite(() => fixture.replace({ ...fixture.catalog(), servers: fixture.catalog().servers.map(entry => entry.id === 'registered'
        ? { ...entry, title: 'Concurrent edit', origin: entry.origin?.kind === 'registry' ? { ...entry.origin, upstream } : entry.origin } : entry) }));
      await fixture.tracker.record([{ key: 'registered', upstream }]);
      expect(fixture.catalog().servers[0]!.title).toBe('Concurrent edit');
      expect(fixture.revision()).toBe(2);
      expect(fixture.writes()).toBe(1);
      await fixture.tracker.record([{ key: 'registered', upstream }]);
      expect(fixture.writes()).toBe(1);
    });
  });

  it('does not attach an obsolete lookup to a server whose registry version changed during the check', async () => {
    await withAccount(async fixture => {
      const [listed] = await fixture.tracker.list();
      expect(listed).toBeDefined();
      fixture.replace({ ...fixture.catalog(), servers: fixture.catalog().servers.map(entry => entry.id === 'registered'
        && entry.origin?.kind === 'registry' ? { ...entry, origin: { ...entry.origin,
          provenance: { ...entry.origin.provenance, ref: { kind: 'version', version: 'v2' } } } } : entry) });
      await fixture.tracker.record([{ key: 'registered', provenance: listed!.provenance,
        upstream: { state: 'update_available', latest: { kind: 'version', version: 'v2' } } }]);
      expect(fixture.writes()).toBe(0);
      expect(fixture.catalog().servers[0]!.origin).toMatchObject({ provenance: { ref: { version: 'v2' } } });
    });
  });

  it('reports a nonduplicate CAS conflict and lets a fresh check preserve the concurrent edit', async () => {
    await withAccount(async fixture => {
      await fixture.tracker.list();
      const upstream = RegistryUpstreamV1Schema.parse({ state: 'update_available', latest: { kind: 'version', version: 'v2' } });
      fixture.onWrite(() => fixture.replace({ ...fixture.catalog(), servers: fixture.catalog().servers.map(entry => entry.id === 'registered'
        ? { ...entry, title: 'Concurrent edit' } : entry) }));
      await expect(fixture.tracker.record([{ key: 'registered', upstream }])).rejects.toMatchObject({ code: 'mcp_registry_update_conflict' });
      expect(fixture.catalog().servers[0]!.title).toBe('Concurrent edit');
      expect(fixture.catalog().servers[0]!.origin).not.toHaveProperty('upstream');
      await fixture.tracker.list();
      await fixture.tracker.record([{ key: 'registered', upstream }]);
      expect(fixture.catalog().servers[0]).toMatchObject({ title: 'Concurrent edit', origin: { upstream } });
      expect(fixture.revision()).toBe(3);
    });
  });
});
