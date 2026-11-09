import * as React from 'react';
import { act } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { renderHook } from '@/dev/testkit';
import { publishDaemonMergedProjectionInputs } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import * as unions from '@/sync/domains/plugins/ui/projectionUnion';
import { createAppShellPluginUiProjectionPublication } from './appShellPluginUiProjectionPublication';

it('keeps a mounted Triage declaration quiet across unrelated registry family publications', async () => {
    const factory = vi.spyOn(unions, 'createPluginUiProjectionUnionPublication');
    const owner = createAppShellPluginUiProjectionPublication();
    const pluginId = 'acme.triage';
    const entryId = `translations:${pluginId}`;
    const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1,
        installedPackagesById: { [pluginId]: { id: pluginId, displayName: 'Triage', version: '1.0.0',
            enabled: true, source: { kind: 'localPath', locator: pluginId } } },
        familiesById: { pluginUi: { family: 'pluginUi', entriesById: { [entryId]: {
            id: entryId, pluginId, occurrenceId: 'triage-current', contributionKind: 'translations', locales: ['en'], bundles: { en: { title: 'Triage' } },
        } } } },
    });
    let inputs = publishDaemonMergedProjectionInputs({ projection });
    owner.publishSources({ accountLifetime: null, availabilityInputs: null, hostBundledUiEnabled: false,
        activeServerId: null, serverProfilesGeneration: 0, activeInventoryLoaded: true,
        onlineMachineIds: ['machine'], selectableMachineIds: ['machine'] });
    const report = () => owner.publishMachineCurrentness('machine', null, {
        pluginUiProjection: inputs.pluginUiProjection, pluginBrowserProjection: null, phase: 'current', interactionEnabled: true,
        machineId: 'machine', serverId: null, platform: 'web', accountLifetime: null,
    });
    report();
    const created = factory.mock.results.at(-1);
    if (created?.type !== 'return') throw new Error('Missing real union publication');
    const recomputes = vi.spyOn(created.value, 'publish');
    let renders = 0;
    const mounted = await renderHook(() => {
        renders++;
        return React.useSyncExternalStore(listener => owner.subscribe(listener, 'committed'),
            () => owner.getSnapshot().pluginUiProjection?.translationsByPluginId[pluginId]);
    });
    const initialRenders = renders;
    const initial = mounted.getCurrent();
    const label = process.env.UNION_CHURN_PROFILE;
    const session = label ? new (await import('node:inspector')).Session() : undefined;
    const post = (method: string) => new Promise<unknown>((resolve, reject) =>
        session!.post(method, (error, result) => error ? reject(error) : resolve(result)));
    if (session) { session.connect(); await post('Profiler.enable'); await post('Profiler.start'); }
    try {
        for (let arrival = 1; arrival <= 24; arrival++) {
            inputs = publishDaemonMergedProjectionInputs({ projection: PluginProjectionV2Schema.parse({ ...projection,
                generation: arrival + 1, familiesById: { ...projection.familiesById,
                    ...(arrival % 2 ? { connectedAccounts: { family: 'connectedAccounts', entriesById: {} } } : {}) },
            }) }, inputs);
            await act(async () => { report(); });
        }
        expect.soft(recomputes).toHaveBeenCalledTimes(0);
        expect.soft(renders - initialRenders).toBe(0);
        expect.soft(mounted.getCurrent()).toBe(initial);
        recomputes.mockClear();
        inputs = publishDaemonMergedProjectionInputs({ projection: PluginProjectionV2Schema.parse({ ...projection,
            generation: 26, familiesById: { pluginUi: { family: 'pluginUi', entriesById: {
                [entryId]: { ...projection.familiesById.pluginUi!.entriesById[entryId], bundles: { en: { title: 'Changed' } } },
            } } },
        }) }, inputs);
        await act(async () => { report(); });
        expect(recomputes).toHaveBeenCalledTimes(1);
        expect(renders - initialRenders).toBe(1);
        expect(mounted.getCurrent()?.bundles).toEqual({ en: { title: 'Changed' } });
    } finally {
        if (session) {
            const result = await post('Profiler.stop');
            session.disconnect();
            const fs = await import('node:fs');
            const path = await import('node:path');
            const destination = path.resolve(process.cwd(), '../../.project/tmp/UNION-CHURN');
            fs.mkdirSync(destination, { recursive: true });
            fs.writeFileSync(path.join(destination, `${label}.cpuprofile`), JSON.stringify((result as { profile: unknown }).profile));
        }
        await mounted.unmount(); recomputes.mockRestore(); factory.mockRestore(); owner.dispose();
    }
});
