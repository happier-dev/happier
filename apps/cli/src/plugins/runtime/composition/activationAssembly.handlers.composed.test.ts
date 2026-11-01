import { expect, it } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol';

import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createCommittedContributedActionInvoker } from '../invocation/actions/createCommittedContributedActionDeps';
import { resolveExecutablePluginRuntimeRegistry } from '../resolveExecutablePluginRuntimeRegistry';

it('keeps retained Action handlers callable after the predecessor runtime releases them', async () => {
    const pluginId = 'acme.retained-handlers';
    const fixture = await createAuthoredAdmittedPluginRuntimeFixture({
        coldStart: true,
        plugins: [{
            manifest: createPluginManifestV2Fixture({
                id: pluginId,
                contributes: { actions: [{
                    id: 'read', title: 'Read', scopes: ['global'], surfaces: ['cli'],
                    execution: { target: 'daemon' }, placementBindings: ['commandPalette'], dangerLevel: 'safe',
                }] },
            }),
            files: { 'daemon.mjs': [
                'let active = false;',
                'let reads = 0;',
                'export function activate(api) {',
                '  if (active) throw new Error("overlapping activation");',
                '  active = true;',
                '  api.actions.register("read", async () => ({ active, reads: ++reads }));',
                '  return () => { active = false; };',
                '}',
            ].join('\n') },
        }],
    });
    let successor: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | undefined;
    const execute = (registry: typeof fixture.registry) => createActionExecutor({
        ...createUnavailableActionTransportDeps(),
        invokeContributedAction: createCommittedContributedActionInvoker({
            acquireRuntimeRegistryLease: async () => ({ registry, source: 'ephemeral', durableRevision: -1, release: async () => {} }),
        }),
    }).execute('action.invoke', { action: { pluginId, localId: 'read' }, input: {} }, { surface: 'cli' });
    try {
        expect(await execute(fixture.registry)).toMatchObject({ ok: true, result: { active: true, reads: 1 } });
        const component = fixture.registry.retainPluginActivationComponent?.(pluginId);
        if (!component) throw new Error('Missing activated component');
        successor = await resolveExecutablePluginRuntimeRegistry({
            happyHomeDir: fixture.happyHomeDir,
            contributes: fixture.registry.contributes,
            generationAuthority: fixture.committed,
            generation: fixture.registry.generation + 1,
            pluginIds: [pluginId],
            retainedActivationRegistryLeases: [component],
        });
        expect(await execute(successor)).toMatchObject({ ok: true, result: { active: true, reads: 2 } });
        await fixture.registry.dispose();
        expect(await execute(successor)).toMatchObject({ ok: true, result: { active: true, reads: 3 } });
    } finally {
        await successor?.dispose();
        await fixture.dispose();
    }
});
