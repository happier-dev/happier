import fastify from 'fastify';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { PluginAvailabilityActionHttpPathsV1, PluginAvailabilityIntentsListActionInputV1Schema, PLUGIN_ACCOUNT_AVAILABILITY_INTENT_PAGE_SIZE } from '@happier-dev/protocol/plugins/availability';
import { createManifestTargetedContributionsService, mergeTargetedContributionManifestDeclarations } from '@happier-dev/cli-common/plugins/registration';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { PLUGIN_MANIFEST, TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1 } from '@happier-dev/plugins-triage/manifest';
import type { RpcHandler } from '@/api/rpc/types';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { createAccountMachineSourceDeclarationReader } from '@/plugins/runtime/invocation/actions/accountMachineSourceDeclarations';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { registerAccountHomeHttp } from '@/session/actions/widgetApproval.testkit';
import { registerAuthoredAccountActionRelease } from '@/plugins/runtime/accountPluginActions.testkit';
import { manifest as admittedSourceManifest } from '@/plugins/runtime/accountMachineActionIntent.fixture';
import { createRetainedAccountExecutionRuntime } from '@/plugins/runtime/accountExecutionRuntime';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { executeAccountPluginAction } from '@/session/actions/executeAccountPluginAction';
import { registerDaemonContributionRegistryProjectionHandler } from './daemonContributionRegistryProjection';
import { createTriageListEntriesActionHandler } from '../../../../../packages/plugins/triage/src/actions/listEntries';
import { createTriageReobserveEntryActionHandler } from '../../../../../packages/plugins/triage/src/actions/reobserveEntry';
import { createTriageReadPullRequestStatusActionHandler } from '../../../../../packages/plugins/triage/src/actions/readPullRequestStatus';
import type { TriageDataActionContext } from '../../../../../packages/plugins/triage/src/actions/dataContext';
import { createTestkitCorpusCollections } from '../../../../../packages/plugins/triage/src/corpus/testkit/corpusCollections.test-support';
import { toCorpusStoredValue } from '../../../../../packages/plugins/triage/src/corpus/collections/rowCodec';
import { CORPUS_SOURCE_INSTANCE_LIFECYCLE } from '../../../../../packages/plugins/triage/src/corpus/collections/ids';

const { machineRpc } = vi.hoisted(() => ({ machineRpc: vi.fn<typeof import('@/session/transport/rpc/machineRpc').callExactMachineRpc>() }));
// Only the Home HTTP and Machine RPC transports are substituted. Admission,
// producer serialization, Account readback, target admission and Triage stay real.
vi.mock('@/session/transport/rpc/machineRpc', () => ({ callExactMachineRpc: machineRpc }));
afterEach(() => { vi.restoreAllMocks(); machineRpc.mockReset(); });

it('carries actual disabled GitHub admission through Machine RPC into cold, exact and native Triage reads', async () => {
    const sourceId = 'happier.scm.forge.github';
    const targetId = 'happier.triage';
    const endpoint = 'http://disabled-triage-source.test';
    const app = fastify();
    app.post(PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list'], async request => {
        const input = PluginAvailabilityIntentsListActionInputV1Schema.parse(request.body);
        const pluginIds = (input.pluginIds ?? input.knownPluginIds ?? []).slice(0, PLUGIN_ACCOUNT_AVAILABILITY_INTENT_PAGE_SIZE);
        return { availabilityCursor: 1, pluginIds, failedPluginIds: [],
            ...(((input.pluginIds ?? input.knownPluginIds)?.length ?? 0) > pluginIds.length ? { nextCursor: pluginIds.at(-1) } : {}),
            intentReads: pluginIds.map(pluginId => ({ pluginId, response: { availabilityCursor: 1, hostingCapability: { enabled: false },
            intent: pluginId === sourceId ? { pluginId, desiredVersion: null, enabled: false,
                offlineUiHosting: 'disabled', writableCollections: [], revision: '1' } : null,
            release: null, uiArtifacts: [], packageAssets: [],
        } })) };
    });
    await app.ready();
    const restore = installAxiosFastifyAdapter({ app, origin: endpoint });
    let fixture: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | undefined;
    try {
        fixture = await createAdmittedPluginRuntimeFixture({ runtimeOptions: {
            pluginIds: [sourceId], accountStorageDependencies: {
                readCredentials: async () => ({ token: 'fixture', encryption: null }), resolveBaseUrl: () => endpoint,
            },
        } });
        expect(fixture.registry.readPluginOccurrenceId?.(sourceId)).toBeNull();
        expect(fixture.registry.contributes.unavailablePlugins).toContainEqual({ pluginId: sourceId, code: 'plugin_disabled' });
        const handlers = new Map<string, RpcHandler>();
        registerDaemonContributionRegistryProjectionHandler({ registerHandler(method, handler) { handlers.set(method, handler); } }, {
            resolveRuntimeRegistry: async () => fixture!.registry,
        });
        machineRpc.mockImplementation(async request => {
            const handler = handlers.get(request.method);
            if (!handler) throw new Error('Source declaration RPC was not registered');
            return JSON.parse(JSON.stringify(await handler(request.request)));
        });
        const readMachine = createAccountMachineSourceDeclarationReader({
            credentials: { token: 'fixture', encryption: null }, serverUrl: endpoint,
        });
        const manifest = normalizePluginManifestV2(PLUGIN_MANIFEST);
        const accountDeclarations = [{ manifest, occurrenceId: 'account-target', sourceCustody: {
            kind: 'account_release' as const, pluginId: targetId, version: manifest.version, archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
        } }];
        const targeted = createManifestTargetedContributionsService({
            readCurrentDeclarations: async () => {
                const snapshot = await readMachine({ machineId: 'machine-source', targetPluginId: targetId });
                return { declarations: mergeTargetedContributionManifestDeclarations({
                    targetPluginId: targetId, accountDeclarations, machineDeclarations: snapshot.declarations,
                }), unavailablePlugins: snapshot.unavailablePlugins };
            },
            subscribeToCatalogChanges: () => () => {},
        }).bind({ pluginId: targetId, signal: new AbortController().signal, isCurrent: () => true });
        const source = { pluginId: sourceId, localId: 'github-forge' };
        const vector = createTriageSourceV1Fixture();
        const configured = { ...vector.configuredInstance, instance: { ...vector.configuredInstance.instance, source } };
        const { collections, control } = createTestkitCorpusCollections();
        const seeded = control.sourceInstances.seed(toCorpusStoredValue({
            instanceTag: 'a'.repeat(43), sourceQualifiedId: `${sourceId}/${source.localId}`,
            lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active, configuredAtMs: 1, configured,
        }));
        // Canonical Collection testkit supplies persistence at this host-context boundary.
        const context = { requestId: 'disabled-source-invocation', signal: new AbortController().signal, surface: 'cli', services: {
            storage: { account: { collection: () => collections.sourceInstances } }, targetedContributions: targeted,
            actions: { executeAdmittedTargetedOperation: async () => { throw new Error('Disabled source invoked'); } },
        } } as unknown as TriageDataActionContext;
        const failure = { class: 'unknown', code: 'plugin_disabled', detail: sourceId, requestId: 'disabled-source-invocation' };
        for (const limit of [0, 10]) {
            const listed = await createTriageListEntriesActionHandler()({ v: 1,
                sources: { kind: 'selected', sourceInstances: [{ sourceInstanceId: configured.instance.sourceInstanceId, configurationRowId: seeded.rowId }] },
                limit, order: 'newest',
            }, context);
            expect(listed.configuredSources).toMatchObject([{ available: false, availabilityFailure: failure }]);
        }
        const exact = { v: 1 as const, entryRef: { ...vector.detailInput.observation.entryRef, source },
            sourceInstanceId: configured.instance.sourceInstanceId, sourceInstanceRowId: seeded.rowId };
        expect(await createTriageReobserveEntryActionHandler()(exact, context)).toEqual({ kind: 'unavailable', failure });
        expect(await createTriageReadPullRequestStatusActionHandler()(exact, context)).toEqual({ kind: 'unavailable', failure });
        const observation = targeted.observeForSelf(TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1, { onInvalidated() {} });
        try {
            expect((await observation.readCurrent()).unavailablePlugins).toContainEqual({ pluginId: sourceId, code: 'plugin_disabled' });
        } finally { observation.dispose(); }
        expect(machineRpc.mock.calls.some(([request]) => request.method === RPC_METHODS.DAEMON_PLUGIN_UI_TARGETED_CONTRIBUTIONS_READ
            && typeof request.request === 'object' && request.request !== null && 'knownSourceRevision' in request.request)).toBe(true);

        // Also reach the snapshot through actual Account activation, invocation
        // service construction and Machine selection, rather than a test carrier.
        const accountApp = fastify();
        const accountEndpoint = 'http://disabled-account-source.test';
        const features = registerAccountHomeHttp(accountApp, { accountId: 'owner', serverId: 'disabled-source-home' });
        const { pluginId } = await registerAuthoredAccountActionRelease(accountApp, 'owner', { primary: {
            manifest: admittedSourceManifest,
            projectRoot: resolve(import.meta.dirname, '../../../../../packages/plugin-sdk/fixtures/account-actions'),
            entryPath: resolve(import.meta.dirname, '../../plugins/runtime/accountMachineActionIntent.fixture.ts'),
        } });
        await accountApp.ready();
        const restoreAccount = installAxiosFastifyAdapter({ app: accountApp, origin: accountEndpoint });
        const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(features));
        const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`,
            encryption: null, credentialProvenance: 'stored_session' as const };
        const host = { token: credentials.token, credentials, sessionId: 'cli-global', mode: 'plain' as const, ctx: null,
            serverHttpBaseUrl: accountEndpoint, runtimeActionMachineId: 'machine-source',
            serverId: 'disabled-source-home', serverIdentityId: 'disabled-source-home' };
        const { deps } = createCliActionExecutorHarness(host);
        const retained = createRetainedAccountExecutionRuntime(() => ({ accountExecution: { credentials,
            serverUrl: accountEndpoint, serverId: 'disabled-source-home', machineId: 'machine-source', isCurrent: () => true } }));
        try {
            const result = await executeAccountPluginAction({ host, deps, accountRuntime: retained, actionId: 'action.invoke',
                input: { action: { pluginId, localId: 'diagnostics' }, input: { key: sourceId } },
                context: { surface: 'ui', authority: 'present_user', actionRequestId: '4d13dc15-d859-4c0e-9abe-d561a12894d5',
                    runtimeAccountId: 'owner', serverId: 'disabled-source-home', serverIdentityId: 'disabled-source-home' },
            });
            expect(result).toMatchObject({ matched: true, result: { ok: true, result: { key: 'plugin_disabled', machine: true } } });
        } finally { await retained.dispose(); fetch.mockRestore(); restoreAccount(); await accountApp.close(); }
    } finally { await fixture?.dispose(); restore(); await app.close(); }
}, 120_000);
