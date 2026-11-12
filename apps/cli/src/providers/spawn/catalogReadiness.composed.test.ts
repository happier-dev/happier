import { createServer } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { accountSettingsParse, ProviderConnectionIdSchema } from '@happier-dev/protocol';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, ProviderConnectionsRowMutationV1Schema } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { normalizeCustomProviderTemplateV1 } from '@happier-dev/protocol/providers/connections/normalizeCustomTemplateV1';
import { parseProviderActionRequestV1 } from '@happier-dev/protocol/providers/providerActionsV1';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { readLeasedAgentProviderBindingAdapter } from '@/plugins/runtime/providerBindings/adapter';
import * as persistence from '@/persistence';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { getActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { emptyAccountSettingsHistoryCaptureResponse } from '@/settings/accountSettings/emptyAccountSettingsHistoryCapture.testkit';
import { createCliAccountProviderActionExecuteV1 } from '../connections/accountActions';
import { resolveProviderModelCompatibility } from '../catalog/compatibility';
import { resolveProviderConnectionForMachine } from '../registry/resolve';
import { refreshActiveProviderConnectionsCatalog, refreshDemandedActiveProviderConnectionsCatalog } from '../settings/hydrate';
import { readProviderSettingsForCli } from '../settings/read';
import { createRuntimeProviderSpawnAuthorizationAttempt } from './authorize';
import { prepareDirectProviderLaunch } from '../lifecycle/prepareDirectLaunch';

afterEach(() => { vi.restoreAllMocks(); resetActiveAccountSettingsSnapshotForTests(); });

it.each(['ready', 'unavailable', 'cancelled'] as const)(
  'settles a freshly authored custom Codex binding through its existing catalog refresh: %s', async outcome => {
  const credentials = { token: 'custom-spawn-readiness-fixture', encryption: null };
  const readCredentials = vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(null);
  let catalog = DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1;
  let revision = 0;
  let rowReads = 0;
  let holdRead = false;
  let enterRead!: () => void;
  let releaseRead!: () => void;
  const entered = new Promise<void>(resolve => { enterRead = resolve; });
  const held = new Promise<void>(resolve => { releaseRead = resolve; });
  let boundaryError: unknown;
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    try {
      if (request.url === '/v1/account/encryption/currentness') {
        response.end(JSON.stringify({ mode: 'plain', version: 1, settingsVersion: 1,
          signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
      } else if (request.url === '/v1/account/profile') {
        // Optional External Session discovery is outside this catalog boundary.
        response.statusCode = 403;
        response.end(JSON.stringify({ error: 'forbidden' }));
      } else if (request.url === '/v2/account/settings') {
        response.end(JSON.stringify({ version: 1, content: { t: 'plain', v: {} } }));
      } else if (request.url === '/v2/account/settings/history') {
        response.end(JSON.stringify({ snapshots: [] }));
      } else if (request.url === '/v1/account/entity-rows/provider-connections' && request.method === 'GET') {
        rowReads++;
        if (holdRead) { enterRead(); await held; }
        if (holdRead && outcome === 'unavailable') {
          response.statusCode = 503;
          response.end(JSON.stringify({ error: 'unavailable' }));
        } else response.end(JSON.stringify({ status: 'present', revision, content: { t: 'plain', v: catalog } }));
      } else if (request.url === '/v1/account/entity-rows/provider-connections' && request.method === 'POST') {
        let body = '';
        for await (const chunk of request) body += String(chunk);
        const mutation = ProviderConnectionsRowMutationV1Schema.parse(JSON.parse(body));
        expect(mutation.expectedRevision).toBe(revision);
        if (mutation.content?.t !== 'plain') throw new Error('Expected Plain fixture catalog');
        catalog = mutation.content.v;
        revision++;
        response.end(JSON.stringify({ status: 'updated', revision, cursor: revision }));
      } else {
        const history = emptyAccountSettingsHistoryCaptureResponse(request.url ?? '');
        if (!history) throw new Error(`Unexpected catalog boundary: ${request.method} ${request.url}`);
        response.statusCode = history.status;
        response.end(JSON.stringify(history.data));
      }
    } catch (error) {
      boundaryError = error;
      response.statusCode = 500;
      response.end(JSON.stringify({ error: 'invalid-fixture-request' }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected loopback catalog boundary');
  const base = `http://127.0.0.1:${address.port}`;
  const runtime = await createAdmittedPluginRuntimeFixture({ runtimeOptions: { pluginIds: ['happier.agent.codex'] } });
  let attempt: Awaited<ReturnType<typeof createRuntimeProviderSpawnAuthorizationAttempt>> | undefined;
  let refreshing: Promise<unknown> | undefined;
  try {
    await runWithServerHttpBaseUrl(base, async () => {
      // These credentials belong only to the loopback Account catalog, after runtime fixture admission.
      readCredentials.mockResolvedValue(credentials);
      const scopeKey = resolveAccountSettingsScopeKey(credentials);
      setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
        settingsVersion: 1, loadedAtMs: 1, scopeKey, settingsSecretsReadKeys: [],
        providerConnectionsCatalog: { status: 'ready', revision, catalog } });
      const execute = createCliAccountProviderActionExecuteV1({ credentials, serverHttpBaseUrl: base });
      const connectionId = ProviderConnectionIdSchema.parse('pc_fresh_custom_spawn');
      const agentTargetKey = 'agent:happier.agent.codex/codex';
      const model = { id: 'gpt-5', name: 'GPT-5' };
      const created = await execute(parseProviderActionRequestV1('providers.connections.create_custom', {
        action: 'createCustom', connectionId, savedSecretId: null, enable: true,
        template: normalizeCustomProviderTemplateV1({ name: 'Fresh custom Responses', protocol: 'openai-responses',
          baseUrl: 'https://custom.example/v1', catalog: 'manual' }), manualModels: [model],
      }), { surface: 'cli' });
      expect(created).toMatchObject({ ok: true, result: { created: true, connection: { connectionId } } });
      const snapshot = getActiveAccountSettingsSnapshot();
      if (!snapshot) throw new Error('Expected authored catalog snapshot');
      const providerSettings = readProviderSettingsForCli(snapshot).settings;
      const registry = runtime.registry.contributes;
      const resolved = resolveProviderConnectionForMachine({ connectionId, machineId: 'machine-a', providerSettings,
        registry, dnsEvidenceByEndpointUrl: new Map([['https://custom.example/v1', ['1.1.1.1']]]) });
      if (resolved.status !== 'resolved') throw new Error(`Authored custom connection: ${resolved.status}`);
      await runtime.registry.acquireAgentCatalogEntry('codex');
      const adapter = readLeasedAgentProviderBindingAdapter({ lease: runtime.lease, agentId: 'codex' });
      if (!adapter) throw new Error('Expected actual Codex Provider binding');
      const compatibility = resolveProviderModelCompatibility({ record: resolved.record, providerSettings,
        agentTargetKey, model, support: adapter.support, adapterVersion: adapter.adapter.adapterVersion });
      expect(compatibility.result.status).toBe('experimental');
      expect(await execute(parseProviderActionRequestV1('providers.models.experimental.confirm', {
        action: 'confirmExperimental', connectionId, expectedConnectionRevision: resolved.record.connection.revision,
        agentTargetKey, modelId: compatibility.result.status === 'experimental' && compatibility.result.confirmationScope.kind === 'connection' ? null : model.id,
        compatibilityFingerprint: compatibility.compatibilityFingerprint,
      }), { surface: 'cli' })).toMatchObject({ ok: true });
      const cancellation = new AbortController();
      if (outcome === 'cancelled') {
        holdRead = true;
        const beforeRefresh = rowReads;
        refreshing = refreshActiveProviderConnectionsCatalog({ credentials });
        await entered;
        let cleanupCount = 0;
        const pending = prepareDirectProviderLaunch({
          signal: cancellation.signal,
          selection: { v: 1, updatedAt: 1, ref: { agentTargetKey, providerConnectionId: connectionId, modelId: model.id } },
          machineId: 'machine-a', agentId: 'codex', backendTarget: { kind: 'backend', backendId: 'codex' },
          scope: { kind: 'session', sessionId: 'cancelled-custom-session' },
          previousBinding: null, confirmation: null, connectedServices: null, featureEnabled: true,
        }, {
          // OS-owned launch resources must settle before cancellation leaves the corridor.
          initialResources: [{ onFailure: () => { cleanupCount++; }, onExit: () => { cleanupCount++; } }],
          resolvePrerequisites: async () => { throw new Error('Cancelled catalog admission reached launch prerequisites'); },
          createAuthorizationAttempt: context => createRuntimeProviderSpawnAuthorizationAttempt({
            ...context, signal: cancellation.signal, lease: runtime.lease,
            getAccountSettingsSnapshot: getActiveAccountSettingsSnapshot,
            resolveAddresses: async () => ['1.1.1.1'], materializationBaseDir: runtime.happyHomeDir, sessionId: 'cancelled-custom-session',
          }),
        });
        cancellation.abort();
        await expect(pending).rejects.toMatchObject({ name: 'ProviderOperationAbandonedError', reason: 'cancelled' });
        expect(cleanupCount).toBe(1);
        expect(rowReads - beforeRefresh).toBe(1);
        releaseRead();
        await refreshing;
        holdRead = false;
        const fresh = await createRuntimeProviderSpawnAuthorizationAttempt({
          selection: { v: 1, updatedAt: 1, ref: { agentTargetKey, providerConnectionId: connectionId, modelId: model.id } },
          machineId: 'machine-a', agentTargetKey, agentId: 'codex', lease: runtime.lease,
          getAccountSettingsSnapshot: getActiveAccountSettingsSnapshot,
          resolveAddresses: async () => ['1.1.1.1'], materializationBaseDir: runtime.happyHomeDir, sessionId: 'fresh-after-cancel',
        });
        expect(fresh).toMatchObject({ ok: true });
        if (!fresh.ok || !('materializeAfterHooks' in fresh.attempt)) throw new Error('Expected fresh external Codex binding');
        try { await expect(fresh.attempt.materializeAfterHooks()).resolves.toMatchObject({ ok: true }); }
        finally { fresh.attempt.cleanupOnFailure(); }
        expect(boundaryError).toBeUndefined();
        return;
      }
      const beforeRefresh = rowReads;
      holdRead = true;
      // The Account-change owner withdraws authority before the next admission.
      refreshing = refreshDemandedActiveProviderConnectionsCatalog({ token: credentials.token });
      await entered;
      expect(getActiveAccountSettingsSnapshot()?.providerConnectionsCatalog?.status).toBe('loading');
      const pendingAdmission = createRuntimeProviderSpawnAuthorizationAttempt({
        signal: cancellation.signal,
        selection: { v: 1, updatedAt: 1, ref: { agentTargetKey, providerConnectionId: connectionId, modelId: model.id } },
        machineId: 'machine-a', agentTargetKey, agentId: 'codex', lease: runtime.lease,
        getAccountSettingsSnapshot: getActiveAccountSettingsSnapshot,
        resolveAddresses: async () => ['1.1.1.1'], materializationBaseDir: runtime.happyHomeDir, sessionId: 'fresh-custom-session',
      });
      releaseRead();
      attempt = await pendingAdmission;
      await refreshing;
      expect(rowReads - beforeRefresh).toBe(1);
      if (outcome === 'unavailable') {
        expect(attempt).toMatchObject({ ok: false, error: { connectionId,
          code: 'provider_catalog_unavailable' } });
        expect(boundaryError).toBeUndefined();
        return;
      }
      expect(attempt).toMatchObject({ ok: true });
      if (!attempt.ok || !('materializeAfterHooks' in attempt.attempt)) throw new Error('Expected external Codex binding');
      const materialized = await attempt.attempt.materializeAfterHooks();
      expect(materialized.ok ? null : materialized.error).toBeNull();
      expect(materialized).toMatchObject({ ok: true, sessionBindingMetadata: { connectionId, model: { id: model.id } } });
      holdRead = false;
      // A subsequent admission observes the changed Account grant.
      expect(await execute(parseProviderActionRequestV1('providers.connections.enabled.set', {
        action: 'setEnabled', scope: 'account', connectionId, enabled: false,
      }), { surface: 'cli' })).toMatchObject({ ok: true });
      await expect(createRuntimeProviderSpawnAuthorizationAttempt({
        selection: { v: 1, updatedAt: 1, ref: { agentTargetKey, providerConnectionId: connectionId, modelId: model.id } },
        machineId: 'machine-a', agentTargetKey, agentId: 'codex', lease: runtime.lease,
        getAccountSettingsSnapshot: getActiveAccountSettingsSnapshot,
        resolveAddresses: async () => ['1.1.1.1'], materializationBaseDir: runtime.happyHomeDir, sessionId: 'disabled-custom-session',
      })).resolves.toMatchObject({ ok: false,
        error: { code: 'provider_connection_disabled', connectionId, retryable: false } });
      expect(boundaryError).toBeUndefined();
    });
  } finally {
    releaseRead();
    await refreshing;
    if (attempt?.ok) attempt.attempt.cleanupOnFailure();
    await runtime.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
