import * as React from 'react';
import { act } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { renderHook } from '@/dev/testkit';
import { EMPTY_PLUGIN_UI_PROJECTION, type PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import type { PluginUiProjectionCurrentness } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import * as unions from '@/sync/domains/plugins/ui/projectionUnion';
import { createAppShellPluginUiProjectionPublication, type AppShellPluginUiProjectionSources } from './appShellPluginUiProjectionPublication';

it('does no catalog work for cold establishing reports and merges only the Machine whose facts change', async () => {
    // Cold Home census from the Providers QA Account.
    const machines = Array.from({ length: 483 }, (_, index) => `machine-${index}`);
    const ids = Array.from({ length: 66 }, (_, index) => `acme.cold-${index}`);
    const model: PluginUiProjectionModel = Object.freeze({ ...EMPTY_PLUGIN_UI_PROJECTION, generation: 1,
        installedPackagesById: Object.fromEntries(ids.map(id => [id, { id, displayName: id, version: '1.0.0',
            enabled: true, source: { kind: 'localPath' as const, locator: id } }])),
        translationsByPluginId: Object.fromEntries(ids.map(id => [id, { id: `translations:${id}`, pluginId: id,
            contributionKind: 'translations' as const, locales: ['en'], bundles: { en: { title: id } } }])),
    });
    const report = (machineId: string): PluginUiProjectionCurrentness => ({ machineId, serverId: null,
        accountLifetime: null, platform: 'web', phase: 'establishing', interactionEnabled: false,
        pluginUiProjection: null, pluginBrowserProjection: null, connectedAccountProjection: null });
    let peerCatalogReads = 0;
    const descriptorReport = (machineId: string): PluginUiProjectionCurrentness => ({
        ...report(machineId),
        get pluginUiProjection() {
            if (machineId !== machines[0]) peerCatalogReads++;
            return null;
        },
        connectedAccountProjection: { kind: 'ready', descriptors: [] },
    });
    const unionFactory = vi.spyOn(unions, 'createPluginUiProjectionUnionPublication');
    const mergeFactory = vi.spyOn(unions, 'createInstalledPluginUiProjectionPublication');
    const owner = createAppShellPluginUiProjectionPublication();
    owner.publishSources({ accountLifetime: null, availabilityInputs: { materializations: [], installedPlugins: undefined,
        accountUiProjection: model }, hostBundledUiEnabled: true, activeServerId: null, serverProfilesGeneration: 0,
        activeInventoryLoaded: true, onlineMachineIds: machines, selectableMachineIds: machines });
    const created = unionFactory.mock.results.at(-1);
    if (created?.type !== 'return') throw new Error('Missing real union publication');
    const derivations = vi.spyOn(created.value, 'publish');
    const merges = mergeFactory.mock.results.flatMap(result => result.type === 'return' ? [vi.spyOn(result.value, 'publish')] : []);
    const mergeCount = () => merges.reduce((total, merge) => total + merge.mock.calls.length, 0);
    const clear = () => { derivations.mockClear(); for (const merge of merges) merge.mockClear(); };
    let publications = 0;
    const stop = owner.subscribe(() => { publications++; }, 'committed');
    let renders = 0;
    const mounted = await renderHook(() => {
        renders++;
        return React.useSyncExternalStore(listener => owner.subscribe(listener, 'committed'),
            () => owner.getSnapshot().pluginUiProjection?.translationsByPluginId[ids[1]!]);
    });
    const initial = owner.getSnapshot();
    const initialRenders = renders;
    try {
        await act(async () => { for (const machineId of machines) owner.publishMachineCurrentness(machineId, null, report(machineId)); });
        const cold = { arrivals: machines.length, derivations: derivations.mock.calls.length, merges: mergeCount(), publications };
        expect.soft(cold.derivations).toBe(0);
        expect.soft(cold.merges).toBe(0);
        expect.soft(cold.publications).toBe(0);
        expect.soft(owner.getSnapshot().pluginUiProjection).toBe(initial.pluginUiProjection);
        expect.soft(owner.getSnapshot().currentnessForActiveAccountByMachineId.size).toBe(machines.length);
        clear();
        await act(async () => { for (const machineId of machines) owner.publishMachineCurrentness(machineId, null,
            descriptorReport(machineId)); });
        const descriptors = { arrivals: machines.length, derivations: derivations.mock.calls.length, merges: mergeCount() };
        expect.soft(descriptors.derivations).toBe(0);
        expect.soft(descriptors.merges).toBe(0);
        peerCatalogReads = 0;
        await act(async () => { owner.publishMachineCurrentness(machines[0]!, null,
            { ...descriptorReport(machines[0]!), phase: 'unavailable' }); });
        const phaseEdit = { peerCatalogReads };
        expect.soft(phaseEdit.peerCatalogReads).toBe(0);
        expect(owner.getSnapshot().currentnessForActiveAccountByMachineId.get(machines[0]!)?.phase).toBe('unavailable');
        clear();
        await act(async () => { owner.publishMachineCurrentness(machines[0]!, null,
            { ...report(machines[0]!), pluginUiProjection: model, phase: 'current', interactionEnabled: true }); });
        const changed = { arrivals: 1, derivations: derivations.mock.calls.length, merges: mergeCount() };
        expect.soft(changed.derivations).toBe(1);
        // One Machine merge and the Account merge.
        expect.soft(changed.merges).toBe(2);
        expect(owner.getSnapshot().projectionUnion.phase).toBe('current');
        expect(owner.getSnapshot().currentnessForActiveAccountByMachineId.get(machines[0]!)?.interactionEnabled).toBe(true);
        const edited: PluginUiProjectionModel = { ...model, translationsByPluginId: { ...model.translationsByPluginId,
            [ids[0]!]: { ...model.translationsByPluginId[ids[0]!]!, bundles: { en: { title: 'Edited' } } } } };
        clear();
        await act(async () => { owner.publishSources({ accountLifetime: null, availabilityInputs: { materializations: [],
            installedPlugins: undefined, accountUiProjection: edited }, hostBundledUiEnabled: true, activeServerId: null,
            serverProfilesGeneration: 0, activeInventoryLoaded: true, onlineMachineIds: machines, selectableMachineIds: machines }); });
        const sourceEdit = { machineMerges: mergeCount() - 1 };
        expect.soft(sourceEdit.machineMerges).toBe(0);
        expect(owner.getSnapshot().pluginUiProjection?.translationsByPluginId[ids[0]!]?.bundles).toEqual({ en: { title: 'Edited' } });
        expect(mounted.getCurrent()).toBe(initial.pluginUiProjection?.translationsByPluginId[ids[1]!]);
        expect(renders - initialRenders).toBe(0);
        if (process.env.PLUGIN_UI_COLD_COUNTS) console.info(JSON.stringify({ cold, descriptors, phaseEdit, changed, sourceEdit }));
    } finally {
        await mounted.unmount(); stop(); owner.dispose();
        for (const merge of merges) merge.mockRestore();
        derivations.mockRestore(); unionFactory.mockRestore(); mergeFactory.mockRestore();
    }
});


it('commits one catalog hydration publication and keeps equal replays silent', async () => {
    const owner = createAppShellPluginUiProjectionPublication();
    const sources: AppShellPluginUiProjectionSources = {
        accountLifetime: null, availabilityInputs: null, hostBundledUiEnabled: true, activeServerId: null,
        serverProfilesGeneration: 0, activeInventoryLoaded: false, onlineMachineIds: ['machine'],
        selectableMachineIds: ['machine'],
    };
    owner.publishSources(sources);
    const publishAccountCensus = () => owner.publishSources({
        ...sources,
        activeInventoryLoaded: true,
        availabilityInputs: { materializations: [], installedPlugins: undefined, accountUiProjection: EMPTY_PLUGIN_UI_PROJECTION },
    });
    const report: PluginUiProjectionCurrentness = {
        pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION, pluginBrowserProjection: null, phase: 'current',
        interactionEnabled: true, machineId: 'machine', serverId: null, platform: 'web', accountLifetime: null,
    };
    let commits = 0;
    const mounted = await renderHook(() => {
        const snapshot = React.useSyncExternalStore(owner.subscribe, owner.getSnapshot);
        React.useLayoutEffect(() => { commits++; });
        return snapshot;
    });
    const publications: ReturnType<typeof owner.getSnapshot>[] = [];
    const stop = owner.subscribe(() => publications.push(owner.getSnapshot()));
    try {
        const beforeHydration = commits;
        await act(async () => {
            publishAccountCensus();
            owner.publishMachineCurrentness('machine', null, report);
            expect(owner.getSnapshot().currentnessForActiveAccountByMachineId.get('machine')).toBe(report);
        });
        const hydrated = mounted.getCurrent();
        expect(hydrated.accountCensusPending).toBe(false);
        expect(hydrated.currentnessForActiveAccountByMachineId.get('machine')).toBe(report);
        expect.soft(publications).toHaveLength(1);
        expect.soft(publications[0]).toBe(hydrated);
        expect.soft(commits - beforeHydration).toBe(1);

        publications.length = 0;
        const beforeReplay = commits;
        await act(async () => {
            publishAccountCensus();
            owner.publishMachineCurrentness('machine', null, { ...report });
        });
        expect.soft(publications).toHaveLength(0);
        expect.soft(commits - beforeReplay).toBe(0);
        expect(mounted.getCurrent()).toBe(hydrated);
    } finally {
        stop();
        await mounted.unmount();
        owner.dispose();
    }
});
