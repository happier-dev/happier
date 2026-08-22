import { describe, expect, it } from 'vitest';

import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';

import { createPluginReloadController } from './controller';

type RunningSessionDisposition = 'retainRunningSessions' | 'revokeRunningSessions';

function createRuntimeRegistry(
    retirePluginConsumers: (pluginIds: readonly string[]) => void = () => undefined,
): ResolvedExecutablePluginRuntimeRegistry {
    return {
        contributes: {
            agents: Object.freeze([]),
            providers: Object.freeze([]),
            actions: Object.freeze([]),
            resources: Object.freeze([]),
            uiViewsV2: Object.freeze([]),
            uiRenderersV2: Object.freeze([]),
            uiTranslationsV2: Object.freeze([]),
            activationTargets: Object.freeze([]),
            catalogEntriesById: Object.freeze({}),
            agentDefinitionsById: new Map(),
            pluginDiagnosticsByPluginId: Object.freeze({}),
        },
        hookHandlersByHookId: new Map(),
        agentRuntimesByAgentId: new Map(),
        scmHostingProvidersById: new Map(),
        pluginDiagnosticsByPluginId: Object.freeze({}),
        activatedPluginIds: new Set(),
        activateContributionsOnDemand: async () => [],
        resolvePromptAssetBlocks: async () => [],
        retireConsumers: () => undefined,
        retirePluginConsumers,
        addRuntimeDisposable: (_pluginId, disposable) => disposable,
        createAgentInvocationServices: async () => createUnavailablePluginServices(),
        dispose: async () => undefined,
    };
}

describe('createPluginReloadController running Session disposition', () => {
    it('uses the authenticated cause for identical contribution shapes instead of treating absence as hard revocation', async () => {
        const controller = createPluginReloadController({
            resolveRuntimeRegistry: async () => createRuntimeRegistry(),
        });
        const observedDispositions: unknown[] = [];
        controller.subscribe((result) => {
            observedDispositions.push(Reflect.get(result, 'runningSessionDisposition'));
        });
        const initialLease = await controller.acquireRuntimeRegistry();
        await initialLease.release();
        observedDispositions.length = 0;

        type CauseAwareAdoption = Parameters<typeof controller.adoptPreparedRuntimeRegistry>[0] & Readonly<{
            runningSessionDisposition: RunningSessionDisposition;
        }>;
        const adopt = controller.adoptPreparedRuntimeRegistry as unknown as (
            adoption: CauseAwareAdoption,
        ) => ReturnType<typeof controller.adoptPreparedRuntimeRegistry>;

        const ordinaryResult = await adopt({
            registry: createRuntimeRegistry(),
            changedPluginIds: ['acme.agent'],
            durableRevision: 2,
            runningSessionDisposition: 'retainRunningSessions',
        });
        expect.soft(Reflect.get(ordinaryResult, 'runningSessionDisposition'))
            .toBe('retainRunningSessions');

        const hardResult = await adopt({
            registry: createRuntimeRegistry(),
            changedPluginIds: ['acme.agent'],
            durableRevision: 3,
            runningSessionDisposition: 'revokeRunningSessions',
        });
        expect.soft(Reflect.get(hardResult, 'runningSessionDisposition'))
            .toBe('revokeRunningSessions');
        expect.soft(observedDispositions).toEqual([
            'retainRunningSessions',
            'revokeRunningSessions',
        ]);

        await controller.shutdown();
    });
});
