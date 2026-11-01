import { expect, it } from 'vitest';
import * as github from '@happier-dev/plugins-scm-github';

import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginRegistryStateStore } from '@/plugins/store/registry/currentState';
import { createDaemonPluginRegistryRuntimeLifecycle } from './registryRuntimeLifecycle';

it('keeps bundled GitHub activation and authentication current across unchanged admission refreshes', async () => {
    const pluginId = github.manifest.id;
    const fixture = await createAdmittedPluginRuntimeFixture({ runtimeOptions: { pluginIds: [pluginId] } });
    try {
        const { controller, registry, happyHomeDir } = fixture;
        const occurrenceId = controller.readCurrentPluginOccurrenceId?.(pluginId);
        expect(occurrenceId).toBeTruthy();
        const service = { pluginId, localId: 'github-account' };
        const incumbent = await registry.resolveConnectedAccountRuntime?.(service);
        expect(incumbent?.isCurrent()).toBe(true);
        const store = createPluginRegistryStateStore({
            happyHomeDir,
            runtimeLifecycle: createDaemonPluginRegistryRuntimeLifecycle({ happyHomeDir, reloadController: controller }),
        });
        await store.refreshRuntime([pluginId]);
        await store.refreshRuntime([pluginId]);
        const current = await controller.acquireRuntimeRegistry();
        try {
            expect(controller.readCurrentPluginOccurrenceId?.(pluginId)).toBe(occurrenceId);
            expect(incumbent?.isCurrent()).toBe(true);
            const successor = await current.registry.resolveConnectedAccountRuntime?.(service);
            expect(successor?.isCurrent()).toBe(true);
            expect(successor?.runtime).toBe(incumbent?.runtime);
            expect(current.registry.targetActivationFacts?.filter(fact => fact.pluginId === pluginId))
                .toEqual(registry.targetActivationFacts.filter(fact => fact.pluginId === pluginId));
        } finally { await current.release(); }
    } finally { await fixture.dispose(); }
});
