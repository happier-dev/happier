import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';

const pickerControlsMock = vi.hoisted(() => vi.fn((params: unknown) => ({ params })));

vi.mock('@/components/sessions/new/hooks/screenModel/useNewSessionAgentPickerControls', () => ({
    useNewSessionAgentPickerControls: (params: unknown) => pickerControlsMock(params),
}));

vi.mock('@/agents/catalog/catalog', () => ({
    isBundledAgentId: (value: unknown) => value === 'gemini' || value === 'opencode',
    getAgentCore: (agentType: string) => ({
        model: {
            defaultMode: agentType === 'gemini' ? 'gemini-2.5-pro' : 'default',
            allowedModes: [],
            supportsFreeform: true,
            freeformModelIdPrefixes: agentType === 'gemini'
                ? ['gemini-', 'models/gemini-', 'publishers/google/models/gemini-']
                : undefined,
            dynamicProbe: 'auto',
        },
    }),
}));

import { useNewSessionAgentSelectionModelModeReconciliation } from './useNewSessionAgentSelectionModelModeReconciliation';

type ReconciliationParams = Parameters<typeof useNewSessionAgentSelectionModelModeReconciliation>[0];

describe('useNewSessionAgentSelectionModelModeReconciliation', () => {
    it('clears stale custom modelMode when preflight model discovery is unavailable', async () => {
        const setModelMode = vi.fn();
        const params: ReconciliationParams = {
            agentType: 'opencode',
            preflightModels: {
                availableModels: [],
                supportsFreeform: false,
                unavailable: true,
            },
            preflightModelsTargetKey: 'backend:opencode',
            selectedBackendEntry: null,
            selectedBackendTargetKey: 'backend:opencode',
            useProfiles: false,
            selectedProfileId: null,
            profileMap: new Map(),
            resolvedBackendEntries: [],
            getCompatibleProfileBackendEntries: () => [],
            isBackendEntrySelectable: () => true,
            setBackendTarget: vi.fn(),
            modelMode: 'opencode/big-pickle',
            setModelMode,
            acpSessionModeId: null,
            setAcpSessionModeId: vi.fn(),
            sessionConfigOptionOverrides: null,
            setSessionConfigOptionOverrides: vi.fn(),
            selectedMachineId: 'machine-1',
            capabilityServerId: 'server-1',
            selectedPath: '/repo',
            settings: {} as ReconciliationParams['settings'],
        };

        await renderHook(() => useNewSessionAgentSelectionModelModeReconciliation(params));

        expect(setModelMode).toHaveBeenCalledWith('default');
    });

    it('clears stale freeform modelMode when a constrained provider prefix rejects it after preflight', async () => {
        const setModelMode = vi.fn();
        const params: ReconciliationParams = {
            agentType: 'gemini',
            preflightModels: {
                availableModels: [{ id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' }],
                supportsFreeform: true,
                unavailable: false,
            },
            preflightModelsTargetKey: 'backend:gemini',
            selectedBackendEntry: null,
            selectedBackendTargetKey: 'backend:gemini',
            useProfiles: false,
            selectedProfileId: null,
            profileMap: new Map(),
            resolvedBackendEntries: [],
            getCompatibleProfileBackendEntries: () => [],
            isBackendEntrySelectable: () => true,
            setBackendTarget: vi.fn(),
            modelMode: 'gpt-5.5',
            setModelMode,
            acpSessionModeId: null,
            setAcpSessionModeId: vi.fn(),
            sessionConfigOptionOverrides: null,
            setSessionConfigOptionOverrides: vi.fn(),
            selectedMachineId: 'machine-1',
            capabilityServerId: 'server-1',
            selectedPath: '/repo',
            settings: {} as ReconciliationParams['settings'],
        };

        await renderHook(() => useNewSessionAgentSelectionModelModeReconciliation(params));

        expect(setModelMode).toHaveBeenCalledWith('gemini-2.5-pro');
    });
});
