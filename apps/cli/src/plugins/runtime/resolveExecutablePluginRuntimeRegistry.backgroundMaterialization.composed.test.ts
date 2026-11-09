import { describe, expect, it } from 'vitest';
import { definePlugin } from '@happier-dev/plugin-sdk';
import type { BackgroundServiceContext } from '@happier-dev/plugin-sdk/background-services';

import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';

describe('admitted background observer materialization', () => {
    it.each(['machine-observer', null])('stamps its own admitted host, including unavailable identity (%s)', async machineId => {
        const observed: Array<BackgroundServiceContext['materialization'] | null> = [];
        let started!: () => void;
        const ran = new Promise<void>(resolve => { started = resolve; });
        const plugin = definePlugin({
            id: 'acme.observer-host', version: '1.0.0', entrypoints: { daemon: './daemon.mjs' },
            backgroundServices: [{ declaration: { id: 'observe' }, runner: async context => {
                observed.push(context.materialization ?? null);
                started();
            } }],
        });
        const fixture = await createAuthoredAdmittedPluginRuntimeFixture({
            plugins: [{ manifest: plugin.manifest, files: { 'daemon.mjs': 'export function activate() {}' },
                instantiateCommittedModule: () => ({ activate: plugin.activate }) }],
            async resolveContributes(happyHomeDir) {
                return createResolvedContributionRegistry(projectLoadedPluginContributes({
                    loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'builtin',
                }));
            },
            runtimeOptions: { resolveCurrentMachineId: () => machineId },
        });
        try {
            fixture.registry.startAdoptedBackgroundServices?.();
            await ran;
            const materialization = fixture.registry.resolveCurrentPluginMaterializationRef?.(plugin.manifest.id);
            if (machineId) {
                expect(materialization).toMatchObject({ machineId, pluginId: plugin.manifest.id });
            } else {
                expect(materialization).toBeNull();
            }
            expect(observed).toEqual([materialization]);
        } finally {
            await fixture.dispose();
        }
    });
});
