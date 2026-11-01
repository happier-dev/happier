import axios from 'axios';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema, PluginManifestV2Schema } from '@happier-dev/protocol';
import { PLUGIN_MANIFEST as LIMA_MANIFEST } from '@happier-dev/plugins-machine-lima/manifest';
import { createPluginReloadController } from '@/plugins/runtime/reload/controller';
import type { StoredCredentials } from '@/persistence';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { logger } from '@/ui/logger';
import type { StablePluginConnectedAccountsOwner } from '@/plugins/runtime/invocation/services/connectedAccounts';
import { createDaemonPluginAvailabilityReporter } from '@/plugins/availability/daemonReporter';
import { buildPluginProjectionV2 } from '@/plugins/projection/registry/projection/v2';
import { createDaemonPluginRuntimeOwner } from './runtimeOwner';
import { PluginAvailabilityIntentsListActionInputV1Schema } from '@happier-dev/protocol/plugins/availability';
import { publishPluginAccountAvailabilityChanges, publishPluginAccountCollectionWatchInvalidation, retirePluginAccountCollectionWatchScope } from '@/plugins/runtime/context/pluginAccountSettingsChangeBroker';

// Model a cold daemon with no last-green UI graph at the filesystem boundary.
// Discovery, runtime construction, source admission and availability stay real.
vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>();
    const { createBundledPluginPublicationFsFixture } = await import('@/plugins/projection/registry/builtIn/locators.testkit');
    const publication = createBundledPluginPublicationFsFixture(actual);
    return {
        ...publication,
        readFileSync: (...args: Parameters<typeof actual.readFileSync>) => (
            String(args[0]).replaceAll('\\', '/').endsWith('/dist/happier-plugin-ui/ui-artifacts.json')
                ? JSON.stringify({ version: 2, entries: [] })
                : publication.readFileSync(...args)
        ),
    };
});

afterEach(() => vi.restoreAllMocks());

describe('daemon release-less declaration publication', () => {
    it.each(['normal', 'pluginRecovery'] as const)('starts without a last-green UI graph in %s and preserves Account admission', async startupMode => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-native-declaration-'));
        const manifest = PluginManifestV2Schema.parse(LIMA_MANIFEST);
        expect(manifest.hostAccess.required.some(access => access.capability === 'storage.account')).toBe(false);
        expect(manifest.contributes.accountCollections).toEqual([]);
        const credentials = { token: 'declaration-account', encryption: null } satisfies StoredCredentials;
        const events: string[] = [];
        const claims: unknown[] = [];
        let accountPluginEnabled = startupMode === 'normal';
        const diagnostics = vi.spyOn(logger, 'debug');
        const controller = createPluginReloadController({ happyHomeDir });
        let owner: ReturnType<typeof createDaemonPluginRuntimeOwner> | undefined;
        try {
            // Substitute only the Availability HTTP boundary; the real reporter,
            // registry, source admission and Account claim owner remain composed.
            vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
                if (String(url).endsWith('/intents/list')) {
                    const pluginIds = [...(PluginAvailabilityIntentsListActionInputV1Schema.parse(body).knownPluginIds ?? [])];
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
            owner = createDaemonPluginRuntimeOwner({ happyHomeDir, startupMode, staleCandidateCleanup: 'disabled', reloadController: controller,
                connectedAccounts, availabilityReporter: reporter, accountStorageDependencies: {
                    readCredentials: async () => credentials, isCurrentAccount: () => true,
                    resolveAccountScopeKey: () => resolveAccountSettingsScopeKey(credentials),
                    resolveBaseUrl: () => 'https://declaration.example.test',
                    http: {
                        get: async () => { throw new Error('Declaration publication must not read Account data'); },
                        post: async (url, body) => {
                            expect(url).toBe('https://declaration.example.test/v1/plugins/availability/collection-writers/claim');
                            const claim = JSON.parse(body);
                            if (claim.manifest.id === manifest.id) { claims.push(claim); events.push('lima-claim'); }
                            return { status: 200, data: {} };
                        },
                    },
                } });
            await owner.initialize();
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
            expect(controller.getState().activeRegistry?.activatedPluginIds.has(manifest.id)).toBe(false);
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
            await controller.getState().activeRegistry?.claimReleaseLessDeclarations();
            // Disable/re-enable rebuilds the real registry and storage host. The
            // unchanged declaration keeps this daemon's successful admission.
            expect(claims).toHaveLength(1);
            expect(claims[0]).toMatchObject({ manifest: { id: manifest.id, version: manifest.version } });
            retirePluginAccountCollectionWatchScope('another-account');
            retirePluginAccountCollectionWatchScope(resolveAccountSettingsScopeKey(credentials));
        } finally {
            await owner?.changeService.shutdown();
            await controller.shutdown();
            await rm(happyHomeDir, { recursive: true, force: true });
        }
    }, 120_000);
});
