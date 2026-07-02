import { describe, expect, it, vi } from 'vitest';

import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';

const PI_BACKEND_ID = 'pi';
const PI_PLUGIN_ID = 'happier.agent.pi';

async function createPiOnlyContributionRegistry(): Promise<ResolvedContributionRegistry> {
    const { resolveBuiltInContributions } = await import('@/plugins/projection/registry/resolveBuiltInContributions');
    const builtInContributions = resolveBuiltInContributions();
    const provider = builtInContributions.providers.find((entry) => entry.id === PI_BACKEND_ID);
    const backend = builtInContributions.backends.find((entry) => entry.id === PI_BACKEND_ID);
    const activationTargets = builtInContributions.activationTargets?.filter((target) => target.pluginId === PI_PLUGIN_ID) ?? [];

    if (!provider || !backend || activationTargets.length !== 1) {
        throw new Error('Expected generated Pi provider, backend, and activation target contributions');
    }

    return {
        providers: Object.freeze([provider]),
        backends: Object.freeze([backend]),
        actions: Object.freeze([]),
        resources: Object.freeze([]),
        uiDescriptors: Object.freeze([]),
        notifications: Object.freeze([]),
        notificationChannels: Object.freeze([]),
        events: Object.freeze([]),
        executionRunProfiles: Object.freeze([]),
        installables: Object.freeze([]),
        requestInterceptors: Object.freeze([]),
        scmHostingProviders: Object.freeze([]),
        scmBackends: Object.freeze([]),
        connectedAccountDescriptors: Object.freeze([]),
        activationTargets: Object.freeze(activationTargets),
        hookRegistrations: Object.freeze([]),
        surfaceHandlersByBackendId: new Map(),
        catalogEntriesById: Object.freeze(provider.catalogEntry ? { [provider.catalogEntry.id]: provider.catalogEntry } : {}),
        providerDefinitionsById: new Map([[provider.id, provider]]),
        backendDefinitionsById: new Map([[backend.id, backend]]),
        pluginDiagnosticsByPluginId: Object.freeze({}),
    };
}

describe('Pi runtimeCore execution runs', () => {
    it('creates a plugin-owned execution-run host backend without host-runtime type recovery', async () => {
        vi.resetModules();
        const requireExecutionRunHostRuntime = vi.fn(() => {
            throw new Error('Pi runtimeCore should not need execution-run host-runtime recovery');
        });
        vi.doMock('@/agent/runtime/bridges/executionRun/executionRunHostRuntime', async (importOriginal) => ({
            ...(await importOriginal<typeof import('@/agent/runtime/bridges/executionRun/executionRunHostRuntime')>()),
            requireExecutionRunHostRuntime,
        }));

        const { resolveBackendEngineAdapterResolution } = await import('@/agent/runtime/registry/engineRegistry');
        const resolution = await resolveBackendEngineAdapterResolution(PI_BACKEND_ID, {
            contributes: await createPiOnlyContributionRegistry(),
        });

        expect(resolution?.selectedSource).toBe('plugin');
        const executionRunBackend = resolution?.engineAdapter.runtimeCore.createExecutionRunBackend({
            cwd: process.cwd(),
            backendId: PI_BACKEND_ID,
            permissionMode: 'read_only',
            accountSettings: null,
            start: { intent: 'review', retentionPolicy: 'ephemeral' },
        });
        expect(executionRunBackend).toEqual(expect.objectContaining({
            readResumeSupport: expect.any(Function),
            provisionSession: expect.any(Function),
            sendPrompt: expect.any(Function),
            sendSteerPrompt: expect.any(Function),
            cancel: expect.any(Function),
            subscribeMessages: expect.any(Function),
            waitForTurnCompletion: expect.any(Function),
            dispose: expect.any(Function),
        }));
        expect(requireExecutionRunHostRuntime).not.toHaveBeenCalled();

        vi.doUnmock('@/agent/runtime/bridges/executionRun/executionRunHostRuntime');
        vi.resetModules();
    });

    it('keeps the legacy Pi catalog entry from exposing host getRuntimeCore', async () => {
        const { agent } = await import('@/backends/pi');

        expect('getRuntimeCore' in agent).toBe(false);
        expect(agent).toMatchObject({
            id: PI_BACKEND_ID,
            getAcpBackendFactory: expect.any(Function),
        });
    });
});
