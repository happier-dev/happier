import { expect, it } from 'vitest';
import { projectPluginRegistrySourceDeclarationV1 } from '@happier-dev/protocol/registries';
import { normalizePluginInstalledUiDeclarations } from '@/sync/domains/plugins/ui/projection';
import { unionPluginUiProjections } from '@/sync/domains/plugins/ui/projectionUnion';
import { projectPluginRegistrySources } from './pluginRegistrySources';
import type { StorageState } from '@/sync/store/types';

const pluginId = 'com.acme.sources';
const origin = (machineId: string) => ({ serverIdentityId: 'srv_registry_sources', materializationRef: {
    machineId, pluginId, materializationId: machineId,
} });
const member = (machineId: string, url = `https://github.com/acme/${machineId}`) => ({ machineId, serverId: 'srv_registry_sources', phase: 'current' as const,
    interactionEnabled: true, selectableExecutionOrigins: [origin(machineId)],
    projection: { ...normalizePluginInstalledUiDeclarations({}, undefined, { id: pluginId, displayName: 'Acme sources',
        version: '1.0.0', enabled: true, occurrenceId: machineId, source: { kind: 'path', locator: `/plugins/${machineId}` } }, [{
        ...projectPluginRegistrySourceDeclarationV1({ pluginId, pluginVersion: '1.0.0', definition: {
            id: 'skills', title: 'Team skills', format: 'git', kinds: ['skill'], url,
        } }), occurrenceId: machineId, executionOrigin: origin(machineId),
    }]), generation: 1 },
});

it('keeps every admitted packaged supplier across Machine-local occurrence ids', () => {
    const source = projectPluginRegistrySourceDeclarationV1({ pluginId, pluginVersion: '1.0.0', definition: {
        id: 'apps', title: 'Apps', format: 'happier-catalog', kinds: ['app'], packageContent: { path: 'resources/apps.json' },
    } });
    const projection = normalizePluginInstalledUiDeclarations({}, undefined, { id: pluginId, displayName: 'Acme sources',
        version: '1.0.0', enabled: true, occurrenceId: 'first', source: { kind: 'path', locator: '/plugins/first' } },
    [{ ...source, occurrenceId: 'first', executionOrigin: origin('first') }]);
    expect(projectPluginRegistrySources(projection)).toMatchObject([{ packageContent: {
        pluginId, pluginVersion: '1.0.0', occurrenceId: 'first', path: 'resources/apps.json',
    }, origin: { suppliers: [] } }]);
    const second = normalizePluginInstalledUiDeclarations({}, undefined, { id: pluginId, displayName: 'Acme sources',
        version: '1.0.0', enabled: true, occurrenceId: 'second', source: { kind: 'path', locator: '/plugins/second' } },
    [{ ...source, occurrenceId: 'second', executionOrigin: origin('second') }]);
    const combined = unionPluginUiProjections([
        { ...member('first'), projection: { ...projection, generation: 1 } },
        { ...member('second'), projection: { ...second, generation: 1 } },
    ], new Map([[pluginId, origin('first')]])).pluginUiProjection;
    expect(projectPluginRegistrySources(combined)).toMatchObject([{ packageContent: { occurrenceId: 'first' },
        origin: { suppliers: ['first', 'second'] } }]);
    const cold = normalizePluginInstalledUiDeclarations({}, undefined, { id: pluginId, displayName: 'Acme sources',
        version: '1.0.0', enabled: true, source: { kind: 'path', locator: '/plugins/first' } }, [source]);
    expect(projectPluginRegistrySources(cold)).toEqual([]);
});

it.each([false, true])('keeps matching offline suppliers of the chosen source and refuses unresolved conflicts (reversed: %s)', reverse => {
    const members = [member('first'), member('second'), {
        ...member('retained', 'https://github.com/acme/second'), phase: 'retainedOffline' as const, interactionEnabled: false,
    }];
    if (reverse) members.reverse();
    const conflict = unionPluginUiProjections(members).pluginUiProjection;
    expect(() => projectPluginRegistrySources(conflict)).toThrow();
    const selected = unionPluginUiProjections(members, new Map([[pluginId, origin('second')]])).pluginUiProjection;
    const sources = projectPluginRegistrySources(selected);
    expect(sources).toMatchObject([{ url: 'https://github.com/acme/second',
        origin: { kind: 'plugin', suppliers: expect.arrayContaining(['second', 'retained']) } }]);
    const source = sources[0];
    if (source?.origin.kind !== 'plugin') throw new Error('Expected a plugin-owned source');
    expect(source.origin.suppliers).not.toContain('first');
});

it.each([false, true])('rebuilds only matching suppliers when an unselected retained declaration changes (reversed: %s)', reverse => {
    const current = member('current', 'https://github.com/acme/current');
    const retained = { ...member('retained', 'https://github.com/acme/current'),
        phase: 'retainedOffline' as const, interactionEnabled: false };
    const project = (offline: typeof retained) => projectPluginRegistrySources(unionPluginUiProjections(
        reverse ? [offline, current] : [current, offline],
    ).pluginUiProjection);
    expect(project(retained)).toMatchObject([{ url: 'https://github.com/acme/current',
        origin: { kind: 'plugin', suppliers: expect.arrayContaining(['current', 'retained']) } }]);
    const refreshed = { ...retained, projection: member('retained', 'https://github.com/acme/other').projection };
    expect(project(refreshed)).toMatchObject([{ url: 'https://github.com/acme/current',
        origin: { kind: 'plugin', suppliers: ['current'] } }]);
});

// REVIEW-DELTA2 N1: the registry wait answers by the registry selection's own rule (built-in, plugin and user sources,
// enabled only), not by plugin declarations alone.
it('the registry wait ends on a user starter source and keeps waiting past a disabled plugin one', async () => {
    const applied = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
    const { EMPTY_PLUGIN_UI_PROJECTION } = await import('@/sync/domains/plugins/ui/projection');
    const { publishCommittedAppShellPluginUiProjection } = await import('@/components/appShell/plugins/committedPluginUiProjection');
    const { applyPromptLibraryCatalogAcknowledgedRecord, resetPromptLibraryCatalogSnapshotsForTests } = await import('@/sync/store/settings/promptLibraryCatalogSnapshot');
    const { getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
    const { registerStorageStateReader } = await import('@/sync/domains/state/storageStateReaderBridge');
    const { waitForRegistrySourcesOfKind } = await import('./pluginRegistrySources');
    // The active Account, as the app shell holds it once a Home is applied.
    const previousApplied = applied.getAppliedActiveServerSnapshot();
    const previousAvailable = applied.isAppliedActiveServerRuntimeAvailable();
    applied.publishAppliedActiveServerSnapshot({ serverId: 'home', serverUrl: 'https://home.test', generation: 1 });
    // Only the registered Store's profile scope is read here; the full Store is not part of this owner.
    registerStorageStateReader(() => ({ profileScope: { serverId: 'home', accountId: 'alice' } }) as unknown as StorageState);
    const starters = projectPluginRegistrySourceDeclarationV1({ pluginId: 'happier.deployment.templates', pluginVersion: '1.0.0',
        definition: { id: 'starters', title: 'Starters', format: 'happier-catalog', kinds: ['starter'], url: 'https://starters.test/catalog.json' } });
    let projection = EMPTY_PLUGIN_UI_PROJECTION;
    let pending = true;
    const listeners = new Set<() => void>();
    const unpublish = publishCommittedAppShellPluginUiProjection(() => projection, undefined,
        listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, undefined, undefined, () => pending);
    const settledNow = async (wait: Promise<void>) => {
        let done = false;
        void wait.then(() => { done = true; });
        await new Promise(resolve => setTimeout(resolve, 0));
        return done;
    };
    try {
        const scope = getActiveServerAccountScope();
        if (!scope) throw new Error('Expected the active Account scope');
        // A user-added starter source is known to the selection, so a Machine still owing its sources holds nothing up.
        applyPromptLibraryCatalogAcknowledgedRecord(scope, { key: 'registry-sources', value: { v: 2, disabledSourceIds: [], sources: [{
            id: 'user-starters', title: 'My starters', format: 'happier-catalog', kinds: ['starter'],
            url: 'https://mine.test/catalog.json', enabled: true, addedAt: 1 }] } }, 5, true);
        expect(await settledNow(waitForRegistrySourcesOfKind('starter'))).toBe(true);
        // The plugin's starter source is disabled, so the selection still has none: the wait holds for the Machine.
        projection = { ...EMPTY_PLUGIN_UI_PROJECTION, registrySourcesById: { [starters.id]: starters } };
        applyPromptLibraryCatalogAcknowledgedRecord(scope, { key: 'registry-sources', value: { v: 2, disabledSourceIds: projectPluginRegistrySources(projection).map(source => source.id),
            sources: [] } }, 6, true);
        const held = waitForRegistrySourcesOfKind('starter');
        expect(await settledNow(held)).toBe(false);
        pending = false;
        for (const listener of listeners) listener();
        await held;
    } finally {
        unpublish();
        resetPromptLibraryCatalogSnapshotsForTests();
        registerStorageStateReader(() => null as unknown as StorageState);
        applied.publishAppliedActiveServerSnapshot(previousApplied, previousAvailable);
    }
});
