import { createRuntimeProviderModelManagementServices } from '../modelManagement/runtimeServices';
import { createProviderProbeHttpClient } from '../probe/client';
import { createProviderRuntimeStateStore } from '../runtimeState';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { accountSettingsParse, ProviderConnectionIdSchema, formatSharedSavedSecretRefV1, sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, ProviderConnectionsRowMutationV1Schema } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { parseProviderActionRequestV1 } from '@happier-dev/protocol/providers/providerActionsV1';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { projectAccountRowsReadHttpResponse } from '@/workspaces/projectAccountRows.testkit';
import { withRealForegroundAdmissionFixture } from '@/daemon/agentRuntime/foregroundAdmission.testkit';
import { readLeasedAgentProviderBindingAdapter } from '@/plugins/runtime/providerBindings/adapter';
import * as persistence from '@/persistence';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { getActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { emptyAccountSettingsHistoryCaptureResponse } from '@/settings/accountSettings/emptyAccountSettingsHistoryCapture.testkit';
import { createCliAccountProviderActionExecuteV1 } from '../connections/accountActions';
import { resolveProviderConnectionForMachine } from '../registry/resolve';
import { readProviderSettingsForCli } from '../settings/read';
import { createRuntimeProviderSpawnAuthorizationAttempt } from './authorize';

afterEach(() => { vi.restoreAllMocks(); resetActiveAccountSettingsSnapshotForTests(); });

it.each(['pi', 'codex'] as const)(
  'launches the normally confirmed %s probe model from a cold requester Home', async agentId => {
    const modelId = agentId === 'pi' ? 'meta/llama-3.3-70b' : 'openai/gpt-4.1-mini';
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`, encryption: null };
    const secretContent = sealSavedSecretResourceStoredContentV1({ resourceId: 'confirmation-fixture', mode: 'plain', content: { v: 1, name: 'Test', kind: 'apiKey', value: 'test-only-secret' } });
    const readCredentials = vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(null);
    let catalog = DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1;
    let revision = 0;
    let boundaryError: unknown;
    const server = createServer(async (request, response) => {
      response.setHeader('Content-Type', 'application/json');
      try {
        if (request.url?.startsWith(PROJECT_ACCOUNT_ROWS_ROUTE_V1)) {
          let body = '';
          for await (const chunk of request) body += String(chunk);
          const reply = projectAccountRowsReadHttpResponse([], request.url, JSON.parse(body));
          response.statusCode = reply.status;
          response.end(JSON.stringify(reply.data));
        } else if (request.url === '/v1/plugins/availability/intents/list') {
          response.statusCode = 403; response.end(JSON.stringify({ error: 'forbidden' }));
        } else if (request.url === '/v1/account/saved-secrets/resources') {
          response.end(JSON.stringify({ resources: [{ ref: formatSharedSavedSecretRefV1('confirmation-fixture'), source: 'shared_resource', relationship: 'owner', name: 'Test', kind: 'apiKey', ownerAccountId: 'owner', revision: 1, materialStatus: 'ready', capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } }] }));
        } else if (request.url?.startsWith('/v1/account/saved-secrets/resources/materials')) {
          response.end(JSON.stringify({ resources: [{ resourceId: 'confirmation-fixture', encryptionMode: 'plain', recipientEnvelope: null, entry: { ref: formatSharedSavedSecretRefV1('confirmation-fixture'), source: 'shared_resource', relationship: 'owner', name: 'Test', kind: 'apiKey', ownerAccountId: 'owner', revision: 1, materialStatus: 'ready', capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } }, storedContent: secretContent }] }));
        } else if (request.url === '/v1/features') {
          response.end(JSON.stringify({ features: { providers: { enabled: true }, teams: { enabled: true } }, capabilities: {} }));
        } else if (request.url === '/v1/account/encryption') {
          response.end(JSON.stringify({ mode: 'plain', updatedAt: 1 }));
        } else if (request.url === '/v1/account/encryption/currentness') {
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
          response.end(JSON.stringify({ status: 'present', revision, content: { t: 'plain', v: catalog } }));
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
    try {
      await withRealForegroundAdmissionFixture({ runtimeOptions: { pluginIds: ['happier.agent.' + agentId, 'happier.provider.vercel-ai-gateway'] } }, async foreground => {
        const runtime = foreground.runtime;
        let attempt: Awaited<ReturnType<typeof createRuntimeProviderSpawnAuthorizationAttempt>> | undefined;
        try {
          await runWithServerHttpBaseUrl(base, async () => {
            // These credentials belong only to the loopback Account catalog, after runtime fixture admission.
            readCredentials.mockResolvedValue(credentials);
            const scopeKey = resolveAccountSettingsScopeKey(credentials);
            setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
              settingsVersion: 1, loadedAtMs: 1, scopeKey, settingsSecretsReadKeys: [],
              providerConnectionsCatalog: { status: 'ready', revision, catalog }, savedSecretCatalogState: 'ready', savedSecretResources: [{ resourceId: 'confirmation-fixture', ownerAccountId: 'owner', displayName: 'Test', kind: 'apiKey', encryptionMode: 'plain', revision: 1, materialStatus: 'ready', storedContent: secretContent }] });
            const execute = createCliAccountProviderActionExecuteV1({ credentials, serverHttpBaseUrl: base });
            const connectionId = ProviderConnectionIdSchema.parse('pc_vercel_confirmation');
            const agentTargetKey = `agent:happier.agent.${agentId}/${agentId}`;
            const model = { id: modelId, name: modelId };
            catalog = { ...catalog, connections: [{ v: 1, id: connectionId,
              source: { kind: 'contribution', contributionKey: 'happier.provider.vercel-ai-gateway/vercel-ai-gateway' },
              role: 'named', displayName: 'Vercel', displayNameMode: 'custom', revision: 1, createdAt: 1, updatedAt: 1 }],
              secretBindingsByConnectionId: { [connectionId]: { account: { apiKey: formatSharedSavedSecretRefV1('confirmation-fixture') } } } };
            revision++;
            const initial = getActiveAccountSettingsSnapshot()!;
            setActiveAccountSettingsSnapshot({ ...initial, settingsVersion: initial.settingsVersion + revision, providerConnectionsCatalog: { status: 'ready', revision, catalog } });
            const snapshot = getActiveAccountSettingsSnapshot();
            if (!snapshot) throw new Error('Expected authored catalog snapshot');
            const providerSettings = readProviderSettingsForCli(snapshot).settings;
            const registry = runtime.registry.contributes;
            const resolved = resolveProviderConnectionForMachine({ connectionId, machineId: 'machine-a', providerSettings,
              registry, dnsEvidenceByEndpointUrl: new Map(['https://ai-gateway.vercel.sh/claude-code', 'https://ai-gateway.vercel.sh/codex/v1', 'https://ai-gateway.vercel.sh/coding-agent/v1'].map(url => [url, ['1.1.1.1']])) });
            if (resolved.status !== 'resolved') throw new Error(`Authored Vercel connection: ${resolved.status}`);
            revision++;
            catalog = { ...catalog, accountGrants: [{ v: 1, connectionId, connectionSecurityFingerprint: resolved.record.connectionSecurityFingerprint, confirmedAt: 1 }] };
            setActiveAccountSettingsSnapshot({ ...initial, settingsVersion: initial.settingsVersion + revision, providerConnectionsCatalog: { status: 'ready', revision, catalog } });
            await runtime.registry.acquireAgentCatalogEntry(agentId);
            const adapter = readLeasedAgentProviderBindingAdapter({ lease: runtime.lease, agentId });
            if (!adapter) throw new Error(`Expected actual ${agentId} Provider binding`);
            const runtimeStore = createProviderRuntimeStateStore({ happyHomeDir: join(runtime.happyHomeDir, 'source'), machineId: 'machine-a' });
            const services = createRuntimeProviderModelManagementServices({ machineId: 'machine-a', runtimeStore,
              acquireRuntimeLease: async () => runtime.lease, featureGate: { isEnabled: () => true },
              getAccountSettingsSnapshot: getActiveAccountSettingsSnapshot, resolveAddresses: async () => ['1.1.1.1'],
              client: createProviderProbeHttpClient({ resolveAddresses: async () => ['1.1.1.1'], transport: async () => ({
                status: 200, headers: { 'content-type': 'application/json' },
                body: Buffer.from(JSON.stringify({ data: [{ ...model, type: 'language', tags: ['tool-use'] }] })),
              }) }), modelSettingsMutation: async () => { throw new Error('Use Account mutation'); } });
            const projection = await services.projectModels({ machineId: 'machine-a', agentTargetKey, sourceConnectionId: connectionId, mode: 'management' });
            if (boundaryError) throw boundaryError;
            if (projection.status !== 'success') throw new Error(JSON.stringify(projection));
            const row = projection.groups.flatMap(group => group.rows).find(row => row.descriptor.id === modelId);
            if (!row) throw new Error(JSON.stringify({ failures: projection.refreshFailures, hidden: projection.hiddenSources, groups: projection.groups.map(group => ({ authorization: group.authorization, rows: group.rows.map(row => row.descriptor.id) })), runtime: (await runtimeStore.read()).catalogs.map(c => c.state) }));
            const compatibility = row.compatibility;
            expect(compatibility.result.status).toBe('experimental');
            if (compatibility.result.status !== 'experimental') throw new Error('Expected confirmation requirement');
            const launchStore = createProviderRuntimeStateStore({ happyHomeDir: join(runtime.happyHomeDir, 'requester'), machineId: 'machine-a' });
            const cancellation = new AbortController();
            const admit = (sessionId: string) => createRuntimeProviderSpawnAuthorizationAttempt({
              signal: cancellation.signal,
              selection: { v: 1, updatedAt: 1, ref: { agentTargetKey, providerConnectionId: connectionId, modelId: model.id } },
              machineId: 'machine-a', agentTargetKey, agentId, lease: runtime.lease, runtimeStateStore: launchStore,
              readModelProjection: (request, signal) => services.projectModels(request, signal),
              getAccountSettingsSnapshot: getActiveAccountSettingsSnapshot,
              resolveAddresses: async () => ['1.1.1.1'], materializationBaseDir: runtime.happyHomeDir, sessionId,
            });
            await expect(admit('unconfirmed-session')).resolves.toMatchObject({ ok: false,
              error: { code: 'provider_compatibility_unverified' } });
            const confirmation = await execute(parseProviderActionRequestV1('providers.models.experimental.confirm', {
              action: 'confirmExperimental', connectionId, expectedConnectionRevision: resolved.record.connection.revision,
              agentTargetKey, modelId: compatibility.result.confirmationScope.kind === 'connection' ? null : compatibility.result.confirmationScope.modelId,
              compatibilityFingerprint: compatibility.compatibilityFingerprint,
            }), { surface: 'cli' });
            if (!confirmation.ok) throw new Error(JSON.stringify({ confirmation, boundaryError: boundaryError instanceof Error ? boundaryError.message : boundaryError }));
            expect(confirmation).toMatchObject({ ok: true });
            const confirmedProjection = await services.projectModels({ machineId: 'machine-a', agentTargetKey, sourceConnectionId: connectionId, mode: 'management' });
            expect(confirmedProjection).toMatchObject({ status: 'success', groups: [expect.objectContaining({ rows: [expect.objectContaining({ compatibility: expect.objectContaining({ confirmed: true }) })] })] });
            attempt = await admit('confirmed-session');
            if (!attempt.ok) throw new Error(JSON.stringify(attempt.error));
            expect(attempt).toMatchObject({ ok: true });
            if (!attempt.ok || !('materializeAfterHooks' in attempt.attempt)) throw new Error('Expected external Provider binding');
            const materialized = await attempt.attempt.materializeAfterHooks();
            expect(materialized.ok ? null : materialized.error).toBeNull();
            expect(materialized).toMatchObject({ ok: true, sessionBindingMetadata: { connectionId, model: { id: model.id } } });
            const foregroundAdmission = await foreground.prepare({
              machineId: 'machine-a', agentId, sessionId: 'foreground-confirmed-session',
              backendTarget: { kind: 'backend', backendId: agentId, sourceKind: 'built_in' },
              selection: { v: 1, updatedAt: 1, ref: { agentTargetKey, providerConnectionId: connectionId, modelId: model.id } },
            }, { signal: cancellation.signal, readModelProjection: (request, signal) => services.projectModels(request, signal) });
            if (boundaryError) throw boundaryError;
            expect(foregroundAdmission, JSON.stringify(foregroundAdmission)).toMatchObject({ ok: true });
            if (foregroundAdmission.ok) await foregroundAdmission.prepared.cleanup();
            // A subsequent admission observes the changed Account grant.
            expect(await execute(parseProviderActionRequestV1('providers.connections.enabled.set', {
              action: 'setEnabled', scope: 'account', connectionId, enabled: false,
            }), { surface: 'cli' })).toMatchObject({ ok: true });
            await expect(admit('disabled-session')).resolves.toMatchObject({ ok: false,
              error: { code: 'provider_connection_disabled', connectionId, retryable: false } });
            expect(boundaryError).toBeUndefined();
          });
        } finally {
          if (attempt?.ok) attempt.attempt.cleanupOnFailure();
        }
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  },
);
