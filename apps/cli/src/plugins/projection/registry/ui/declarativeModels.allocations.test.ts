import { Session } from 'node:inspector/promises';
import { expect, it } from 'vitest';

import { createResolvedContributionRegistry } from '../createResolvedContributionRegistry';
import type { ResolvedActionContribution, ResolvedUiRendererV2Contribution } from '../types';
import { resolveDeclarativeProjectionModels } from './declarativeModels';

function action(pluginId: string, id: string): ResolvedActionContribution {
    return {
        provenance: 'external', source: { kind: 'path' }, pluginId,
        definition: {
            kindVersion: 1, id, title: id, description: id, safety: 'safe', dangerLevel: 'safe',
            placements: [], slash: null, bindings: null, examples: null, inputHints: null, inputSchema: {},
            execution: { target: 'daemon' }, scopes: [], connectedAccountPurposeBindings: [],
            surfaces: { ui: true, voice: false, agent: false, mcp: false, cli: false, rpc: false, api: false, plugin: false },
        },
    };
}

function fixture(rendererCount: number) {
    const renderers = Array.from({ length: rendererCount }, (_, index): ResolvedUiRendererV2Contribution => ({
        provenance: 'external', source: { kind: 'path' }, pluginId: 'acme.forms',
        identity: { pluginId: 'acme.forms', localId: `form-${index}` }, manifestPath: '/forms/plugin.json',
        definition: { id: `form-${index}`, kind: 'declarative', root: { kind: 'action', action: 'save', label: 'Save' } },
    }));
    return createResolvedContributionRegistry({
        // The affected #164 guest has 807 bundled Actions. Other plugins' Actions
        // must not be copied and validated again for every forms renderer.
        actions: [action('acme.forms', 'save'), action('acme.forms', 'dynamic-only'),
            ...Array.from({ length: 807 }, (_, index) => action('acme.foreign', `action-${index}`))],
        uiRenderersV2: renderers,
    });
}

it('allocates for each renderer own Action inventory rather than multiplying the global catalog', async () => {
    const small = fixture(1);
    const large = fixture(6);
    const project = (registry: typeof small) => resolveDeclarativeProjectionModels({
        registry, readPluginOccurrenceId: () => 'occurrence',
    });
    const models = project(large);
    expect(Object.keys(models)).toHaveLength(6);
    for (const model of Object.values(models)) {
        // Dynamic documents retain every admitted own Action, including those
        // absent from the initial root. Filtering the root alone is incorrect.
        expect(model.declarativeInventory.actions.map(({ qualifiedId }) => qualifiedId).sort())
            .toEqual(['acme.forms/dynamic-only', 'acme.forms/save']);
    }

    const session = new Session();
    session.connect();
    try {
        await session.post('HeapProfiler.enable');
        const allocations = async (registry: typeof small) => {
            for (let index = 0; index < 3; index++) project(registry);
            await session.post('HeapProfiler.collectGarbage');
            await session.post('HeapProfiler.startSampling', {
                samplingInterval: 4096, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true,
            });
            for (let index = 0; index < 10; index++) project(registry);
            const { profile } = await session.post('HeapProfiler.stopSampling');
            return { count: profile.samples.length, bytes: profile.samples.reduce((sum, sample) => sum + sample.size, 0) };
        };
        let smallCount = Infinity;
        let largeCount = Infinity;
        let smallBytes = Infinity;
        let largeBytes = Infinity;
        for (let round = 0; round < 3; round++) {
            const one = await allocations(small);
            const many = await allocations(large);
            smallCount = Math.min(smallCount, one.count);
            largeCount = Math.min(largeCount, many.count);
            smallBytes = Math.min(smallBytes, one.bytes);
            largeBytes = Math.min(largeBytes, many.bytes);
        }
        console.info(JSON.stringify({ foreignActions: 807, renderers: [1, 6], smallCount, largeCount, smallBytes, largeBytes }));
        // Adding small forms must not multiply the unrelated catalog by six.
        // This permits the forms' real additional work and sampling variation.
        expect(largeCount).toBeLessThan(smallCount * 2);
    } finally {
        session.disconnect();
    }
});
