import { describe, expect, it, vi } from 'vitest';

const settingsSeenByAgent = vi.hoisted(() => new Map<string, unknown>());

vi.mock('@/agents/catalog/catalog', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/agents/catalog/catalog')>(),
    canSelectAgentWithoutDetectedCli: (input: { agentId: string; pluginSettings?: unknown }) => {
        settingsSeenByAgent.set(`select:${input.agentId}`, input.pluginSettings ?? null);
        return false;
    },
    getAgentCore: () => ({ sessionStorage: { direct: false } }),
    getAgentBehavior: () => ({}),
    getAgentResumeExperimentsFromSettings: (
        agentId: string,
        _settings: unknown,
        _machineId: unknown,
        pluginSettings: unknown,
    ) => {
        settingsSeenByAgent.set(`experiments:${agentId}`, pluginSettings ?? null);
        return { enabled: true, switches: {} };
    },
    getNewSessionRelevantInstallableDepKeys: (input: { agentId: string; pluginSettings?: unknown }) => {
        settingsSeenByAgent.set(`deps:${input.agentId}`, input.pluginSettings ?? null);
        return input.pluginSettings ? ['owned'] : [];
    },
    isBundledAgentId: () => false,
}));

import { resolveNewSessionDeclarationAvailabilityFacts } from './useNewSessionAvailabilityState';

describe('New Session Agent Settings isolation', () => {
    it('never projects the selected qualified Agent Settings into a sibling Agent', () => {
        settingsSeenByAgent.clear();
        const selectedSettings = { account: { 'shared-local-id': 'alpha' } } as const;
        const result = resolveNewSessionDeclarationAvailabilityFacts({
            resolvedBackendEntries: [
                {
                    kind: 'agent',
                    agentId: 'plugin.alpha/agent',
                    backendTargetKey: 'agent:plugin.alpha/agent',
                },
                {
                    kind: 'agent',
                    agentId: 'plugin.beta/agent',
                    backendTargetKey: 'agent:plugin.beta/agent',
                },
            ] as any,
            selectedMachineId: 'machine-1',
            settings: {} as any,
            pluginSettings: selectedSettings,
            pluginSettingsAgentId: 'plugin.alpha/agent',
            pluginSettingsReadiness: { status: 'ready' } as any,
            resumeSessionId: null,
            externalSessionsFeatureEnabled: false,
            backendNewSessionOptionStateByTargetKey: {},
        });

        expect(settingsSeenByAgent.get('deps:plugin.alpha/agent')).toBe(selectedSettings);
        expect(settingsSeenByAgent.get('deps:plugin.beta/agent')).toBeNull();
        expect(settingsSeenByAgent.get('select:plugin.beta/agent')).toBeNull();
        expect(result.installableDepKeyCountByAgentId).toMatchObject({
            'plugin.alpha/agent': 1,
            'plugin.beta/agent': 0,
        });
    });
});
