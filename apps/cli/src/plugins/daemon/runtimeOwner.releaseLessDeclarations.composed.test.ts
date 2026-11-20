import axios from 'axios';
import * as fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema, PluginManifestV2Schema } from '@happier-dev/protocol';
import { PLUGIN_MANIFEST as LIMA_MANIFEST } from '@happier-dev/plugins-machine-lima/manifest';
import { createPluginReloadController } from '@/plugins/runtime/reload/controller';
import { createDaemonPluginRegistryRuntimeLifecycle } from '@/plugins/runtime/reload/registryRuntimeLifecycle';
import { createPluginRegistryStateStore } from '@/plugins/store/registry/currentState';
import type { AccountPluginDataStorageHostDependencies } from '@/plugins/runtime/context/accountPluginDataStorage';
import type { StoredCredentials } from '@/persistence';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { logger } from '@/ui/logger';
import { resolveSessionCreationAgentTarget } from '@/session/creation/resolveSessionCreationAgentTarget';
import { projectAccountPluginCensusLaunchError } from '@/plugins/projection/registry/builtIn/enablement';
import { projectSessionSpawnFailure } from '@/session/creation/projectSessionSpawnFailure';
import { resolveRunnerAgentSessionDescriptorForLease } from '@/daemon/spawn/prepareAgentRuntimeSessionBridge';
import type { StablePluginConnectedAccountsOwner } from '@/plugins/runtime/invocation/services/connectedAccounts';
import { createDaemonPluginAvailabilityReporter } from '@/plugins/availability/daemonReporter';
import { buildPluginProjectionV2 } from '@/plugins/projection/registry/projection/v2';
import { executeAppliedDaemonPluginActionWithController } from './controlRoutes';
import { createDaemonPluginRuntimeOwner } from './runtimeOwner';
import { createDaemonPluginRegistryProjectionInvalidation } from '@/daemon/pluginRegistryProjectionInvalidation';
import type { DaemonState } from '@/api/types';
import { publishPluginAccountAvailabilityChanges, publishPluginAccountCollectionWatchInvalidation, retirePluginAccountCollectionWatchScope } from '@/plugins/runtime/context/pluginAccountSettingsChangeBroker';
import { readRequestedIntentPluginIds } from '@/testkit/http/accountPluginAvailability';
import { createBundledPluginPublicationFsFixture } from '@/plugins/projection/registry/builtIn/locators.testkit';

// Model a cold daemon with no last-green UI graph at the filesystem boundary.
// Discovery, runtime construction, source admission and availability stay real.
beforeEach(() => {
    // Install after imports: the publication policy itself imports node:fs, so
    // importing its fixture inside a node:fs module factory creates a cycle.
    const publication = createBundledPluginPublicationFsFixture({ ...fs });
    vi.spyOn(fs, 'readFileSync').mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => (
        String(args[0]).replaceAll('\\', '/').endsWith('/dist/happier-plugin-ui/ui-artifacts.json')
            ? JSON.stringify({ version: 2, entries: [] })
            : publication.readFileSync(...args)
    )) as typeof fs.readFileSync);
});

afterEach(() => vi.restoreAllMocks());

describe('daemon release-less declaration publication', () => {
    it.each([
        ['normal', 'declaration-publication'],
        ['normal', 'availability-recovery'],
        ['pluginRecovery', 'availability-recovery'],
    ] as const)('starts without a last-green UI graph in %s: %s and preserves Account admission', async (startupMode, journey) => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-native-declaration-'));
        const manifest = PluginManifestV2Schema.parse(LIMA_MANIFEST);
        expect(manifest.hostAccess.required.some(access => access.capability === 'storage.account')).toBe(false);
        expect(manifest.contributes.accountCollections).toEqual([]);
        const credentials = { token: `declaration-account-${startupMode}-${journey}`, encryption: null } satisfies StoredCredentials;
        const events: string[] = [];
        const claims: unknown[] = [];
        const claimsByPlugin = new Map<string, number>();
        let accountPluginEnabled = startupMode === 'normal';
        let accountReadable = journey !== 'declaration-publication';
        let accountReadErrorCode = 'ECONNREFUSED';
        const accountReadStates: boolean[] = [];
        let holdFailedCensus: (() => Promise<void>) | undefined;
        const diagnostics = vi.spyOn(logger, 'debug');
        const controller = createPluginReloadController({ happyHomeDir });
        let owner: ReturnType<typeof createDaemonPluginRuntimeOwner> | undefined;
        let publishedState: DaemonState | null = null;
        let publishedCatalog: Awaited<ReturnType<NonNullable<typeof owner>['readCatalog']>> = [];
        const pendingProjectionPublications = new Set<Promise<void>>();
        const projectionPublication = createDaemonPluginRegistryProjectionInvalidation({
            // Daemon-state transport is the boundary. Its catalog consumer only
            // reads when the production invalidation owner publishes a change.
            getApiMachine: () => ({ updateDaemonState: update => {
                publishedState = update(publishedState);
                const publication = owner
                    ? owner.readCatalog().then(catalog => { publishedCatalog = catalog; })
                    : Promise.resolve();
                pendingProjectionPublications.add(publication);
                return publication.finally(() => { pendingProjectionPublications.delete(publication); });
            } }),
            isDaemonQuiescing: () => false,
            onPublicationFailure: error => { throw error; },
        });
        try {
            // Substitute only the Availability HTTP boundary; the real reporter,
            // registry, source admission and Account claim owner remain composed.
            vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
                if (String(url).endsWith('/intents/list')) {
                    accountReadStates.push(accountReadable);
                    const heldFailure = holdFailedCensus;
                    holdFailedCensus = undefined;
                    if (heldFailure) {
                        await heldFailure();
                        throw new axios.AxiosError('Previous connection was refused', 'ECONNREFUSED');
                    }
                    if (!accountReadable) {
                        if (accountReadErrorCode === 'ECONNREFUSED') throw new axios.AxiosError('Home is reloading', accountReadErrorCode);
                        throw Object.assign(new axios.AxiosError('Account temporarily unavailable during reconnect'), {
                            response: { status: 503, data: { errorCode: accountReadErrorCode } },
                            requestId: '0b54db2b-c37b-4cc0-9ad3-a8c54aab2616',
                        });
                    }
                    const pluginIds = readRequestedIntentPluginIds(body);
                    return { data: { availabilityCursor: 17, pluginIds, failedPluginIds: [], intentReads: pluginIds.map(pluginId => ({ pluginId,
                        response: { availabilityCursor: 17, hostingCapability: { enabled: false }, release: null, uiArtifacts: [], packageAssets: [],
                            intent: pluginId === manifest.id ? { pluginId, desiredVersion: null, enabled: accountPluginEnabled,
                                offlineUiHosting: 'disabled', writableCollections: [], revision: accountPluginEnabled ? '1' : '2' } : null },
                    })) } };
                }
                events.push('materializations');
                return { data: { revision: 1, outcome: 'replaced' }, status: 200, statusText: 'OK', headers: {}, config: { headers: new axios.AxiosHeaders() } };
            });
            const reporter = createDaemonPluginAvailabilityReporter({ credentials, getMachineId: () => 'declaration-controller',
                serverFeaturesSnapshotStore: { getSnapshot: () => ({ status: 'ready', features: FeaturesResponseSchema.parse({ features: {},
                    capabilities: { serverIdentity: { serverIdentityId: 'srv_declaration' } } }) }) } });
            // Lima declaration publication has no Connected Account purpose.
            // Unrelated bundled startup services see unavailable credentials.
            const unused = async (): Promise<never> => { throw new Error('Unexpected Connected Account operation'); };
            const connectedAccounts: StablePluginConnectedAccountsOwner = {
                getBinding: unused, requestSelection: unused, materialize: unused,
                listAccounts: unused, materializeListedAccount: unused, watch: () => { throw new Error('Unexpected Connected Account watch'); },
            };
            const accountStorageDependencies: AccountPluginDataStorageHostDependencies = {
                readCredentials: async () => credentials, isCurrentAccount: () => true,
                resolveAccountScopeKey: () => resolveAccountSettingsScopeKey(credentials),
                resolveBaseUrl: () => 'https://declaration.example.test',
                resolveAccountEncryptionCurrentness: async () => ({
                    mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
                    recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' },
                }),
                http: {
                    get: async () => { throw new Error('Declaration publication must not read Account data'); },
                    post: async (url, body) => {
                        expect(url).toBe('https://declaration.example.test/v1/plugins/availability/collection-writers/claim');
                        const claim = JSON.parse(body);
                        // A cold Home asks for the admitted declaration body
                        // after the publisher's digest lookup misses.
                        if (!claim.manifest) return { status: 404, data: { error: 'plugin_declaration_not_found' } };
                        claimsByPlugin.set(claim.manifest.id, (claimsByPlugin.get(claim.manifest.id) ?? 0) + 1);
                        if (claim.manifest.id === manifest.id) { claims.push(claim); events.push('lima-claim'); }
                        return { status: 200, data: {} };
                    },
                },
            };
            owner = createDaemonPluginRuntimeOwner({ happyHomeDir, startupMode, staleCandidateCleanup: 'disabled', reloadController: controller,
                connectedAccounts, availabilityReporter: reporter, accountStorageDependencies,
                onDurableRegistryApplied: projectionPublication.invalidateProjection,
                onRuntimeProjectionInvalidated: projectionPublication.invalidateProjection });
            if (!accountReadable) {
                const coldCensusStarted = Promise.withResolvers<void>();
                const releaseColdCensus = Promise.withResolvers<void>();
                holdFailedCensus = async () => {
                    coldCensusStarted.resolve();
                    await releaseColdCensus.promise;
                };
                const initialized = owner.initialize();
                await coldCensusStarted.promise;
                accountReadable = true;
                const reconnected = owner.recoverAccountCensusAfterConnect();
                releaseColdCensus.resolve();
                await Promise.all([initialized, reconnected]);
                expect(accountReadStates).toEqual([false, true]);
            } else {
                await owner.initialize();
            }
            const runtime = controller.getState().activeRegistry;
            expect(runtime).not.toBeNull();
            if (!runtime) throw new Error('Expected a published daemon registry');
            expect(runtime.contributes.pluginEnablementById?.[manifest.id])
                .toEqual({ accountEnabled: accountPluginEnabled, machineEnabled: true, enabled: accountPluginEnabled });
            const projection = buildPluginProjectionV2({ registry: runtime.contributes, generation: 1 });
            const ui = projection.familiesById.pluginUi;
            if (ui?.family !== 'pluginUi') throw new Error('Expected the daemon UI projection');
            expect(Object.values(ui.entriesById)).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    pluginId: 'happier.triage', contributionKind: 'reactNativeBundle',
                    runtime: expect.objectContaining({ state: 'blocked',
                        decision: expect.objectContaining({ reason: 'generated_react_native_artifact_missing' }),
                    }),
                }),
            ]));
            await vi.waitFor(() => expect(events, JSON.stringify(diagnostics.mock.calls)).toContain('materializations'));
            if (accountPluginEnabled) {
                // The serving declaration includes admission's schema projection;
                // the author module can differ from the bundled locator snapshot.
                const publishedManifest = runtime.readReleaseLessMaterializations?.()
                    .find(entry => entry.pluginId === manifest.id)?.declaredManifest;
                expect(publishedManifest).toBeDefined();
                await vi.waitFor(() => expect(claims).toEqual([{ manifest: publishedManifest }]));
                expect(events.indexOf('lima-claim')).toBeGreaterThan(events.indexOf('materializations'));
            } else expect(claims).toEqual([]);
            await runtime.claimReleaseLessDeclarations();
            // r1117auto1 published Google as trusted but omitted its declaration,
            // so the Home refused the exact caller's credential review request.
            expect(claimsByPlugin.get('happier.voice.google')).toBe(1);
            expect(claimsByPlugin.size).toBeGreaterThan(1);
            expect([...claimsByPlugin.values()]).toEqual(Array.from(claimsByPlugin, () => 1));
            const startupClaims = new Map(claimsByPlugin);
            // Machine-online transport recovery reports the current inventory.
            // N admitted declarations must produce zero further claim requests.
            for (let reconnect = 0; reconnect < 3; reconnect += 1) {
                await owner.reportCurrentAvailability();
                await runtime.claimReleaseLessDeclarations();
                expect(claimsByPlugin).toEqual(startupClaims);
            }
            console.info('WRITER_CLAIM_RECONNECT_MEASUREMENT', JSON.stringify({ plugins: startupClaims.size,
                startupClaims: [...startupClaims.values()].reduce((sum, count) => sum + count, 0),
                reconnects: 3, additionalClaims: [...claimsByPlugin.values()].reduce((sum, count) => sum + count, 0)
                    - [...startupClaims.values()].reduce((sum, count) => sum + count, 0) }));
            if (journey === 'declaration-publication') return;
            expect(controller.getState().activeRegistry?.activatedPluginIds.has(manifest.id)).toBe(false);
            const assertServingAvailability = async () => {
                expect((await owner!.readCatalog()).find(entry => entry.pluginId === manifest.id))
                    .toMatchObject({ accountEnabled: accountPluginEnabled, machineEnabled: true, enabled: accountPluginEnabled });
                const current = controller.getState();
                const serving = current.activeRegistry;
                if (!serving) throw new Error('Expected a serving daemon registry');
                const servingProjection = buildPluginProjectionV2({ registry: serving.contributes, generation: current.generation });
                const entries = Object.values(servingProjection.familiesById)
                    .flatMap(family => Object.values(family.entriesById))
                    .filter(entry => entry.pluginId === manifest.id);
                if (accountPluginEnabled) expect(entries.length).toBeGreaterThan(0);
                else expect(entries).toEqual([]);
            };
            await assertServingAvailability();
            await vi.waitFor(() => expect(publishedCatalog.find(entry => entry.pluginId === manifest.id)?.enabled).toBe(accountPluginEnabled));
            const publishedBeforeChange = projectionPublication.readRevision();
            // The first Account change must replace the cold serving snapshot;
            // no unchanged refresh or Machine mutation primes this path.
            const beforeRefresh = controller.getState();
            const change = { cursor: 17, kind: 'pluginDomain' as const, entityId: `pluginDomain/${manifest.id}/availability`, changedAt: 1,
                hint: { pluginDomain: 'availability' as const, pluginId: manifest.id } };
            publishPluginAccountAvailabilityChanges('another-account', [change]);
            expect(controller.getState().generation).toBe(beforeRefresh.generation);
            accountPluginEnabled = !accountPluginEnabled;
            publishPluginAccountAvailabilityChanges(resolveAccountSettingsScopeKey(credentials), [change]);
            await vi.waitFor(() => expect(controller.getState().generation).toBeGreaterThan(beforeRefresh.generation), { timeout: 120_000 });
            expect(controller.getState().activeRegistry).not.toBe(beforeRefresh.activeRegistry);
            expect(controller.getState().activeRegistry?.contributes.pluginEnablementById?.[manifest.id])
                .toEqual({ accountEnabled: accountPluginEnabled, machineEnabled: true, enabled: accountPluginEnabled });
            expect(controller.getState().activeRegistry?.contributes.pluginDeclarations?.some(plugin => plugin.pluginId === manifest.id)).toBe(accountPluginEnabled);
            await assertServingAvailability();
            expect(projectionPublication.readRevision()).toBeGreaterThan(publishedBeforeChange);
            await vi.waitFor(() => expect(publishedCatalog.find(entry => entry.pluginId === manifest.id))
                .toMatchObject({ accountEnabled: accountPluginEnabled, machineEnabled: true, enabled: accountPluginEnabled }));
            const refreshStore = createPluginRegistryStateStore({ happyHomeDir,
                runtimeLifecycle: createDaemonPluginRegistryRuntimeLifecycle({ happyHomeDir, startupMode,
                    reloadController: controller, connectedAccounts, accountStorageDependencies,
                    onRuntimeProjectionInvalidated: projectionPublication.invalidateProjection }) });
            const beforeUnchangedRefresh = controller.getState();
            const beforeUnchangedPublication = projectionPublication.readRevision();
            await refreshStore.refreshRuntime([manifest.id]);
            expect(controller.getState().generation).toBe(beforeUnchangedRefresh.generation);
            expect(controller.getState().activeRegistry).toBe(beforeUnchangedRefresh.activeRegistry);
            expect(projectionPublication.readRevision()).toBe(beforeUnchangedPublication);
            const changedGeneration = controller.getState().generation;
            accountPluginEnabled = !accountPluginEnabled;
            // A cursor-gone reconnect has no exact plugin hints, so its existing
            // reset must re-read availability through the same admission owner.
            publishPluginAccountCollectionWatchInvalidation({ accountScopeKey: resolveAccountSettingsScopeKey(credentials),
                kind: 'reset', changeCursor: 10 });
            await vi.waitFor(() => expect(controller.getState().generation).toBeGreaterThan(changedGeneration), { timeout: 120_000 });
            expect(controller.getState().activeRegistry?.contributes.pluginEnablementById?.[manifest.id])
                .toEqual({ accountEnabled: accountPluginEnabled, machineEnabled: true, enabled: accountPluginEnabled });
            expect(controller.getState().activeRegistry?.contributes.pluginDeclarations?.some(plugin => plugin.pluginId === manifest.id)).toBe(accountPluginEnabled);
            await assertServingAvailability();
            await controller.getState().activeRegistry?.claimReleaseLessDeclarations();
            // Disable/re-enable rebuilds the real registry and storage host. The
            // unchanged declaration keeps this daemon's successful admission.
            expect(claims).toHaveLength(1);
            expect(claims[0]).toMatchObject({ manifest: { id: manifest.id, version: manifest.version } });
            const target = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } };
            accountReadable = false;
            accountReadErrorCode = 'database_connection_unavailable';
            await refreshStore.refreshRuntime([manifest.id]);
            const unavailable = controller.getState().activeRegistry!;
            expect(unavailable.contributes.pluginEnablementById?.[target.identity.pluginId])
                .toMatchObject({ enabled: false, unavailableCode: 'plugin_account_census_failed',
                    unavailableCause: { errorClass: 'AxiosError', errorCode: 'database_connection_unavailable', phase: 'plugins.account_census', httpStatus: 503 },
                    unavailableRequestId: '0b54db2b-c37b-4cc0-9ad3-a8c54aab2616' });
            let launchError;
            try {
                resolveSessionCreationAgentTarget(target, unavailable.contributes);
            } catch (error) {
                launchError = projectAccountPluginCensusLaunchError(error);
            }
            expect(projectSessionSpawnFailure({ errorCode: 'spawn_failed', errorMessage: launchError?.message, errorDetail: launchError }))
                .toMatchObject({ type: 'error', code: 'spawn_failed', retryable: true,
                    launchError: { code: 'plugin_account_census_failed', failureCause: { retryable: true,
                        actionCause: { phase: 'plugins.account_census', errorCode: 'database_connection_unavailable', httpStatus: 503 },
                        requestId: '0b54db2b-c37b-4cc0-9ad3-a8c54aab2616' } } });
            const readCensusDiagnostic = async () => (await owner!.readCatalog()).find(row => row.pluginId === target.identity.pluginId)
                ?.contributionIntrospection.diagnostics.find(row => row.data.code === 'plugin_runtime_capability_missing')?.data.details;
            expect(await readCensusDiagnostic()).toMatchObject({ failureCause: { errorCode: 'database_connection_unavailable', httpStatus: 503 } });
            // A connected daemon with an unavailable Home shares a single retry
            // across overlapping executable requests and preserves the cause.
            accountReadErrorCode = 'ECONNREFUSED';
            const retryStarted = Promise.withResolvers<void>();
            const releaseRetry = Promise.withResolvers<void>();
            holdFailedCensus = async () => {
                retryStarted.resolve();
                await releaseRetry.promise;
            };
            const readsBeforeDemand = accountReadStates.length;
            const invoke = () => executeAppliedDaemonPluginActionWithController({
                actionId: 'happier.machine.lima/check', input: {}, surface: 'cli',
            }, controller);
            const requests = [invoke(), invoke()];
            const retried = await Promise.race([retryStarted.promise.then(() => true), requests[0]!.then(() => false)]);
            releaseRetry.resolve();
            const attempts = await Promise.all(requests);
            expect(retried).toBe(true);
            expect(accountReadStates.length - readsBeforeDemand).toBe(1);
            for (const attempt of attempts) {
                expect(attempt).toMatchObject({ matched: true, result: {
                    ok: false, errorCode: 'plugin_account_census_failed', retryable: true,
                    actionHandlerInvocation: 'notStarted',
                    data: { failureCause: { errorCode: 'ECONNREFUSED', phase: 'plugins.account_census' } },
                } });
            }
            accountReadable = true;
            await controller.recoverFailedAccountCensus();
            expect(resolveSessionCreationAgentTarget(target, controller.getState().activeRegistry!.contributes))
                .toMatchObject({ agentId: 'codex' });
            await controller.recoverFailedAccountCensus();
            expect(accountReadStates.length - readsBeforeDemand).toBe(2);
            // Remaining unavailable is not unchanged: the currently reported
            // cause must replace the preceding census's catalog diagnostic.
            accountReadable = false;
            accountReadErrorCode = 'database_connection_unavailable';
            await refreshStore.refreshRuntime([manifest.id]);
            expect(await readCensusDiagnostic()).toMatchObject({ failureCause: { errorCode: 'database_connection_unavailable' } });
            accountReadable = true;
            const readsBeforeRecovery = accountReadStates.length;
            expect((await owner.readCatalog()).find(row => row.pluginId === target.identity.pluginId))
                .toMatchObject({ enabled: false });
            expect(accountReadStates.length).toBe(readsBeforeRecovery);

            await owner.recoverAccountCensusAfterConnect();
            expect(accountReadStates.length - readsBeforeRecovery).toBe(1);
            expect((await owner.readCatalog()).find(row => row.pluginId === target.identity.pluginId))
                .toMatchObject({ enabled: true });
            await owner.recoverAccountCensusAfterConnect();
            expect(accountReadStates.length - readsBeforeRecovery).toBe(1);
            expect(resolveSessionCreationAgentTarget(target, controller.getState().activeRegistry!.contributes))
                .toMatchObject({ agentId: 'codex' });
            // A push can still be settling when the Machine reconnects. That
            // older failure must not survive the newer connection's recovery.
            const staleCensusStarted = Promise.withResolvers<void>();
            const releaseStaleCensus = Promise.withResolvers<void>();
            holdFailedCensus = async () => {
                staleCensusStarted.resolve();
                await releaseStaleCensus.promise;
            };
            const readsBeforeOverlappingReconnect = accountReadStates.length;
            publishPluginAccountAvailabilityChanges(resolveAccountSettingsScopeKey(credentials), [{ ...change, cursor: 18 }]);
            await staleCensusStarted.promise;
            const overlappingReconnect = owner.recoverAccountCensusAfterConnect();
            releaseStaleCensus.resolve();
            await overlappingReconnect;
            expect(accountReadStates.length - readsBeforeOverlappingReconnect).toBe(2);
            expect(resolveSessionCreationAgentTarget(target, controller.getState().activeRegistry!.contributes))
                .toMatchObject({ agentId: 'codex' });

            const readsBeforeHealthyRead = accountReadStates.length;
            await owner.readCatalog();
            expect(accountReadStates.length).toBe(readsBeforeHealthyRead);
            accountReadable = false;
            await refreshStore.refreshRuntime([manifest.id]);
            accountReadable = true;
            // A single-plugin live signal must also recover the other bundled
            // rows withdrawn by the failed whole-Account census.
            publishPluginAccountAvailabilityChanges(resolveAccountSettingsScopeKey(credentials), [{ ...change, cursor: 19 }]);
            await vi.waitFor(() => expect(controller.getState().activeRegistry?.contributes.pluginEnablementById?.[target.identity.pluginId]?.enabled,
                `Account reads: ${JSON.stringify(accountReadStates)}; refresh failures: ${JSON.stringify(diagnostics.mock.calls.filter(call => String(call[0]).includes('refresh failed')))}`)
                .toBe(true), { timeout: 120_000 });
            expect(resolveSessionCreationAgentTarget(target, controller.getState().activeRegistry!.contributes))
                .toMatchObject({ agentId: 'codex' });
            const spawnLease = await controller.acquireRuntimeRegistry();
            try {
                expect(await resolveRunnerAgentSessionDescriptorForLease({ target: {
                    kind: 'backend', sourceKind: 'built_in', backendId: 'codex',
                }, lease: spawnLease })).toMatchObject({ pluginId: target.identity.pluginId, backendId: 'codex' });
            } finally { await spawnLease.release(); }
            // A projection read begun during unavailable admission can finish
            // recovering after the live signal first publishes a healthy row.
            // Settle those actual transport operations before measuring the
            // following unchanged refresh.
            while (pendingProjectionPublications.size > 0) await Promise.all(pendingProjectionPublications);
            const recovered = controller.getState();
            const recoveredPublication = projectionPublication.readRevision();
            await refreshStore.refreshRuntime([manifest.id]);
            expect(controller.getState().generation).toBe(recovered.generation);
            expect(controller.getState().activeRegistry).toBe(recovered.activeRegistry);
            expect(projectionPublication.readRevision()).toBe(recoveredPublication);
            retirePluginAccountCollectionWatchScope('another-account');
            retirePluginAccountCollectionWatchScope(resolveAccountSettingsScopeKey(credentials));
        } finally {
            await owner?.changeService.shutdown();
            await controller.shutdown();
            await rm(happyHomeDir, { recursive: true, force: true });
        }
    // This includes two full bundled-Account admission transitions in addition
    // to the original declaration-only transitions.
    }, 300_000);
});
