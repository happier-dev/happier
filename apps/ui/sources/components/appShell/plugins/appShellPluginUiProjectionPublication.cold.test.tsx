import * as React from 'react';
import { act } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { renderHook } from '@/dev/testkit';
import { EMPTY_PLUGIN_UI_PROJECTION, type PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import type { PluginUiProjectionCurrentness } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import * as unions from '@/sync/domains/plugins/ui/projectionUnion';
import { createAppShellPluginUiProjectionPublication } from './appShellPluginUiProjectionPublication';

it('does no catalog work for cold establishing reports and merges only the Machine whose facts change', async () => {
    // Reuse the established publication census: 148 Machines and 66 plugins.
    const machines = Array.from({ length: 148 }, (_, index) => `machine-${index}`);
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
            { ...report(machineId), connectedAccountProjection: { kind: 'ready', descriptors: [] } }); });
        const descriptors = { arrivals: machines.length, derivations: derivations.mock.calls.length, merges: mergeCount() };
        expect.soft(descriptors.derivations).toBe(0);
        expect.soft(descriptors.merges).toBe(0);
        clear();
        await act(async () => { owner.publishMachineCurrentness(machines[0]!, null,
            { ...report(machines[0]!), pluginUiProjection: model, phase: 'current', interactionEnabled: true }); });
        const changed = { arrivals: 1, derivations: derivations.mock.calls.length, merges: mergeCount() };
        expect.soft(changed.derivations).toBe(1);
        // One Machine merge and the Account merge; never the 147 unrelated Machines.
        expect.soft(changed.merges).toBe(2);
        expect(owner.getSnapshot().projectionUnion.phase).toBe('current');
        expect(owner.getSnapshot().currentnessForActiveAccountByMachineId.get(machines[0]!)?.interactionEnabled).toBe(true);
        const edited: PluginUiProjectionModel = { ...model, translationsByPluginId: { ...model.translationsByPluginId,
            [ids[0]!]: { ...model.translationsByPluginId[ids[0]!]!, bundles: { en: { title: 'Edited' } } } } };
        await act(async () => { owner.publishSources({ accountLifetime: null, availabilityInputs: { materializations: [],
            installedPlugins: undefined, accountUiProjection: edited }, hostBundledUiEnabled: true, activeServerId: null,
            serverProfilesGeneration: 0, activeInventoryLoaded: true, onlineMachineIds: machines, selectableMachineIds: machines }); });
        expect(owner.getSnapshot().pluginUiProjection?.translationsByPluginId[ids[0]!]?.bundles).toEqual({ en: { title: 'Edited' } });
        expect(mounted.getCurrent()).toBe(initial.pluginUiProjection?.translationsByPluginId[ids[1]!]);
        expect(renders - initialRenders).toBe(0);
        if (process.env.PLUGIN_UI_COLD_COUNTS) console.info(JSON.stringify({ cold, descriptors, changed }));
    } finally {
        await mounted.unmount(); stop(); owner.dispose();
        for (const merge of merges) merge.mockRestore();
        derivations.mockRestore(); unionFactory.mockRestore(); mergeFactory.mockRestore();
    }
});
