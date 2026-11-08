import { afterAll, expect, it } from 'vitest';
import { buildDeferredDaemonProjectionSections, DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { createRegistryHostV1, HAPPIER_PICKS_SOURCE_ID, listRegistrySourcesV1, projectPluginRegistrySourceDeclarationV1, REGISTRY_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/registries';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { normalizePluginUiProjection } from '@/sync/domains/plugins/ui/projection';
import { projectPluginRegistrySources } from '@/registries/pluginRegistrySources';
import { createUiRegistryHttpV1 } from '@/registries/registryHttpV1';
import { PLUGIN_UI_SECTIONS } from '@/sync/domains/plugins/ui/projectionSections';

const network = await installSessionOpsNetworkBoundary();
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { clearDaemonMergedProjectionCacheForTests, loadDaemonMergedProjectionCacheEntry } = await import('./loadDaemonMergedProjectionInputs');
afterAll(() => network.dispose());

it('keeps bundled PostgreSQL in the AppShell catalog when the remote marketplace is unreachable', async () => {
    storage.setState(storage.getInitialState(), true);
    clearDaemonMergedProjectionCacheForTests();
    const home = await network.addHome('https://picker-data.test', 'picker-account');
    const pluginId = 'happier.deployment.templates';
    const source = { ...projectPluginRegistrySourceDeclarationV1({ pluginId, pluginVersion: '0.0.0', definition: {
        id: 'data-services', title: 'Data services', format: 'happier-catalog', kinds: ['app'],
        packageContent: { path: 'resources/registry/apps.json' },
    } }), occurrenceId: `${pluginId}:32` };
    const deferred = buildDeferredDaemonProjectionSections(DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
        protocolVersion: 1, projectionDigest: 'a'.repeat(64), projection: {
            v: 2, generation: 1, installedPackagesById: {}, agentsById: {}, actionsById: {}, resourcesById: {}, settingsById: {},
            familiesById: { registrySources: { family: 'registrySources', entriesById: { [source.id]: source } } }, diagnostics: [],
        },
    }));
    network.setRpcAckResponder(async call => {
        const request = call.payload as Readonly<{ sectionRead?: { digest: string; offset: number; includeDigests?: readonly string[] } }>;
        const read = request.sectionRead;
        return { ok: true, result: read ? deferred.read(read.digest, read.offset, read.includeDigests) : deferred.manifest };
    });
    const params = { machineId: 'picker-machine', serverId: home.id, sections: PLUGIN_UI_SECTIONS, reuseFreshReady: true };
    const answer = await loadDaemonMergedProjectionCacheEntry(params);
    expect(answer).toMatchObject({ kind: 'ready' });
    if (!answer || answer.kind !== 'ready') throw new Error('AppShell projection did not settle');
    const pluginSources = projectPluginRegistrySources(normalizePluginUiProjection(answer.inputs.pluginProjectionV2!));
    const sources = listRegistrySourcesV1({ record: { v: 2, sources: [], disabledSourceIds: [] }, pluginSources });
    // HTTP and packaged-content transport are the only substituted boundaries.
    // Source admission, section hydration, normalization and registry listing stay real.
    const host = createRegistryHostV1({ host: 'web', readSources: async () => sources,
        http: createUiRegistryHttpV1(async () => new Response(null, { status: 503 })),
        daemonFetch: async request => {
            if (request.op !== 'list' || request.sourceId !== source.id) throw new Error('Unexpected packaged catalog request');
            return { op: 'list', page: { sourceId: source.id, status: { state: 'ok', fetchedAt: 1 }, items: [{
                sourceId: source.id, kind: 'app', itemId: 'postgresql', title: 'PostgreSQL', appMetadata: { category: 'database' },
            }], nextCursor: null } };
        },
    });
    const list = async () => REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.list'].parse(await host.execute('registries.items.list', {
        kind: 'app', sourceIds: [HAPPIER_PICKS_SOURCE_ID, source.id],
    }));
    const result = await list();
    expect(result.pages.flatMap(page => page.items)).toContainEqual(expect.objectContaining({
        sourceId: source.id, itemId: 'postgresql', appMetadata: { category: 'database' },
    }));
    expect(result.pages.filter(page => page.status.state !== 'ok')).toMatchObject([
        { sourceId: HAPPIER_PICKS_SOURCE_ID, status: { state: 'unreachable' } },
    ]);
    expect(await list()).toEqual(result);
});
