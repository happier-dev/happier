import triagePackage from '../../../../../../packages/plugins/triage/package.json';
import { TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1 } from '../../../../../../packages/plugins/triage/src/actions/listEntriesProtocol';
import { afterEach, expect, it, vi } from 'vitest';
import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import type { PluginAccountApi } from '@happier-dev/plugin-sdk';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { createHomeHubArtifactHttpBoundary } from './homeHubArtifactHttpBoundary';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from './serverAccountConnectionHarness';
import { installPortableAccountPluginReleaseForTest } from './portableAccountPlugin';
import { PluginAvailabilityActionHttpPathsV1, PluginAvailabilityCollectionWritersClaimActionInputV1Schema,
    PluginAvailabilityCollectionWritersClaimActionOutputV1Schema, PluginAccountAvailabilityIntentReadResponseV1Schema } from '@happier-dev/protocol/plugins/availability';
import { normalizePluginAccountCollectionContractsV1 } from '@happier-dev/protocol/plugins/data/collectionsV1';

vi.mock('socket.io-client', async importOriginal => (
    await import('./serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));

installDisconnectedServerSocketBoundary(configureConnectedServerSocketBoundary);
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
afterEach(async () => { await connection?.dispose(); connection = undefined; });

function portablePlugin(id: string) {
    const parsed = parsePluginManifest({ schemaVersion: 2, id, version: '1.0.0', displayName: id,
        runtime: { apiVersion: 1 }, contributes: { actions: [{ id: 'read', title: 'Read',
            scopes: ['global'], surfaces: ['ui', 'plugin'], dangerLevel: 'safe', readOnly: true, placementBindings: [],
            execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activate' } },
        }] } });
    if (!parsed.ok) throw new Error(`Invalid portable fixture: ${JSON.stringify(parsed)}`);
    return { manifest: parsed.manifest, activate(api: PluginAccountApi) {
        api.actions.register('read', async () => ({ pluginId: id }));
    } };
}

it('admits authored Triage Collections at Home and retains source custody through real Availability refresh', async () => {
    const [{ PLUGIN_MANIFEST: manifest }, { activate }, { prepareSourceDeclaredAccountPluginsForTest },
        { readPluginAccountAvailability }, { getSyncSingleton }] = await Promise.all([
        import('../../../../../../packages/plugins/triage/src/manifest'),
        import('../../../../../../packages/plugins/triage/src/accountRuntime'),
        import('./portableAccountPlugin'), import('@/sync/domains/plugins/availability/projection'), import('@/sync/runtime/getSyncSingleton'),
    ]);
    const { prepareUiTriageActionPluginsForTest } = await import('../triageActionClientIntegrationTestkit');
    await prepareUiTriageActionPluginsForTest();
    const install = await prepareSourceDeclaredAccountPluginsForTest([{ packageName: triagePackage.name, manifest, activate }]);
    const accountId = 'source-triage-account';
    const home = createHomeHubArtifactHttpBoundary(accountId);
    let claimed: ReturnType<typeof PluginAvailabilityCollectionWritersClaimActionInputV1Schema.parse> | undefined;
    const refs = normalizePluginAccountCollectionContractsV1({ pluginId: manifest.id,
        contributions: manifest.contributes.accountCollections }).map(({ pluginId, collectionId, schemaVersion, contractDigest }) =>
        ({ pluginId, collectionId, schemaVersion, contractDigest }));
    const intent = () => ({ pluginId: manifest.id, desiredVersion: null, enabled: true,
        offlineUiHosting: 'disabled', writableCollections: refs, revision: 'source-claim' });
    connection = await restoreServerAccountForTest({ serverUrl: 'http://source-triage.test', accountId,
        request: async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.collectionWriters.claim']) {
                claimed = PluginAvailabilityCollectionWritersClaimActionInputV1Schema.parse(JSON.parse(String(init?.body)));
                return Response.json(PluginAvailabilityCollectionWritersClaimActionOutputV1Schema.parse({ intent: intent() }));
            }
            if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read']) {
                return Response.json({ availabilityCursor: 1, snapshots: [], inventoryComplete: true, releases: [] });
            }
            if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list']) {
                return Response.json({ availabilityCursor: 1, pluginIds: claimed ? [manifest.id] : [], failedPluginIds: [],
                    intentReads: claimed ? [{ pluginId: manifest.id, response: PluginAccountAvailabilityIntentReadResponseV1Schema.parse({
                        availabilityCursor: 1, hostingCapability: { enabled: false }, intent: intent(), release: null,
                        uiArtifacts: [], packageAssets: [],
                    }) }] : [] });
            }
            return home.request(url, init);
        } });
    const accountLifetime = captureActiveServerAccountScopeLifetime();
    if (!accountLifetime) throw new Error('Expected restored Account lifetime');
    const installed = await install({ accountLifetime, publishProjection: true });
    try {
        const read = () => readPluginAccountAvailability(accountLifetime.scope);
        expect(read().readCurrentAccountExecution(manifest.id)).toMatchObject({ kind: 'available', release: null,
            sourceCustody: { kind: 'bundled_first_party', packagedRuntime: { kind: 'source_declaration' } } });
        expect(claimed?.manifest.id).toBe(manifest.id);
        await getSyncSingleton().refreshPluginAccountAvailability();
        expect(read().readCurrentAccountKvCapability({ pluginId: manifest.id })).toMatchObject({ kind: 'available' });
        for (const ref of refs) expect(read().readCurrentCollectionContract({ pluginId: manifest.id,
            collectionId: ref.collectionId, ref })).toMatchObject({ kind: 'available' });
        expect(read().readAccountUiProjection()?.actionsById[`${manifest.id}/${TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1}`]?.available).toBe(true);
    } finally { await installed.dispose(); }
});

it('admits and keeps both portable Account executables in one published action set', async () => {
    const accountId = 'portable-plugins-account';
    connection = await restoreServerAccountForTest({ serverUrl: 'http://portable-plugins.test', accountId,
        request: createHomeHubArtifactHttpBoundary(accountId).request });
    const accountLifetime = captureActiveServerAccountScopeLifetime();
    if (!accountLifetime) throw new Error('Expected restored Account lifetime');
    const first = portablePlugin('example.portable-first');
    const second = portablePlugin('example.portable-second');
    const installed = await installPortableAccountPluginReleaseForTest({ ...first, additionalPlugins: [second],
        accountLifetime, publishProjection: true });
    try {
        const { readPluginAccountAvailability } = await import('@/sync/domains/plugins/availability/projection');
        const admitted = readPluginAccountAvailability(accountLifetime.scope).readAccountUiProjection();
        const { resolvePluginUiClientActionRegistration } = await import('@/components/plugins/reactNative/clientExecutableContributions');
        const { resolvePluginUiClientExecutablePlatform } = await import('@/sync/domains/plugins/ui/projection');
        for (const plugin of [first, second, first]) {
            const action = installed.projection.actionsById[`${plugin.manifest.id}/read`];
            expect(action, `Expected the complete portable set to contain ${plugin.manifest.id}`).toBeDefined();
            expect(admitted?.actionsById[`${plugin.manifest.id}/read`]?.available).toBe(true);
            const registered = resolvePluginUiClientActionRegistration({ action: action!, platform: resolvePluginUiClientExecutablePlatform() });
            expect(registered).not.toBeNull();
            const handler = registered?.handler;
            if (typeof handler !== 'function') throw new Error('Expected authored Account handler');
            expect(await Reflect.apply(handler, undefined, [{}])).toEqual({ pluginId: plugin.manifest.id });
        }
    } finally { await installed.dispose(); }
});

it('places an Account Action locally through the shared native HTTP adapter until test cleanup', async () => {
    const nativeTransfer = await import('@/utils/platform/tauri/transferFetch');
    const originalAdapter = nativeTransfer.resolveTauriRuntimeFetch;
    const { installNativeRuntimeFetchBoundaryForTest } = await import('./nativeRuntimeFetch');
    const { standardCleanup } = await import('../cleanup/standardCleanup');
    const { executeAccountActionAtRuntimeHost } = await import('@/components/plugins/surfaces/accountActionPlacement');
    installNativeRuntimeFetchBoundaryForTest();
    installNativeRuntimeFetchBoundaryForTest();
    try {
        const result = await executeAccountActionAtRuntimeHost({ accountScope: { serverId: 'native-fixture', accountId: 'account' },
            action: { pluginId: 'example.native-fixture', localId: 'read' },
            execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activate' } },
            input: {}, context: { surface: 'ui' }, signal: new AbortController().signal,
            executeLocal: () => ({ placement: 'native-ui' }) });
        expect(result).toEqual({ placement: 'native-ui' });
    } finally { standardCleanup(); }
    expect(nativeTransfer.resolveTauriRuntimeFetch).toBe(originalAdapter);
});
