import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';
import { DEFAULT_NEW_SESSION_AUTOMATION_DRAFT } from '@/sync/domains/automations/automationDraft';
import { settingsDefaults } from '@/sync/domains/settings/settings';

import { useNewSessionAuthoringState } from './useNewSessionAuthoringState';

const buildNewSessionAuthoringContextMock = vi.hoisted(() => vi.fn());
const saveNewSessionDraftMock = vi.hoisted(() => vi.fn());
const clearNewSessionDraftMock = vi.hoisted(() => vi.fn());

vi.mock('@/components/sessions/authoring/context/buildNewSessionAuthoringContext', () => ({
    buildNewSessionAuthoringContext: (...args: unknown[]) => buildNewSessionAuthoringContextMock(...args),
}));

vi.mock('@/components/sessions/authoring/draft/sessionAuthoringDraftAdapters', () => ({
    buildNewSessionAuthoringDraftFromResolvedInputs: vi.fn(() => ({ directory: '/repo', prompt: '' })),
    buildPersistedNewSessionDraftFromAuthoringDraft: vi.fn(() => ({ selectedPath: '/repo' })),
}));

vi.mock('@/sync/domains/state/persistence', () => ({
    saveNewSessionDraft: (...args: unknown[]) => saveNewSessionDraftMock(...args),
    clearNewSessionDraft: (...args: unknown[]) => clearNewSessionDraftMock(...args),
}));

vi.mock('@/sync/domains/settings/terminalSettings', () => ({
    resolveTerminalSpawnOptions: vi.fn(() => null),
}));

vi.mock('@/sync/domains/sessionAuthoring/sessionAuthoringNormalization', () => ({
    normalizeSessionAuthoringConnectedServices: vi.fn(() => null),
}));

describe('useNewSessionAuthoringState', () => {
    beforeEach(() => {
        buildNewSessionAuthoringContextMock.mockReset();
        saveNewSessionDraftMock.mockReset();
        clearNewSessionDraftMock.mockReset();

        buildNewSessionAuthoringContextMock.mockReturnValue({
            draft: {
                directory: '/repo',
                prompt: '',
            },
            effectiveAutomationDraft: DEFAULT_NEW_SESSION_AUTOMATION_DRAFT,
            canSubmit: true,
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('preserves legacy unscoped draft persistence when no draft scope is active', async () => {
        const hook = await renderHook(() => useNewSessionAuthoringState({
            automationDraft: DEFAULT_NEW_SESSION_AUTOMATION_DRAFT,
            automationFeatureEnabled: false,
            selectedMachineId: null,
            selectedMachine: null,
            selectedPath: '/repo',
            checkoutCreationDraft: null,
            sessionPrompt: '',
            agentType: 'claude',
            backendTarget: null,
            transcriptStorage: null,
            useProfiles: false,
            selectedProfileId: null,
            resumeSessionId: '',
            permissionMode: 'default',
            modelMode: 'default',
            mcpSelection: null,
            agentNewSessionOptions: null,
            settings: settingsDefaults,
            effectiveWindowsRemoteSessionLaunchMode: null,
            acpSessionModeId: null,
            sessionConfigOptionOverrides: null,
            automationEditId: null,
            automationRequestedByRoute: false,
            selectedSecretId: null,
            selectedSecretIdByProfileIdByEnvVarName: {},
            getSessionOnlySecretValueEncByProfileIdByEnvVarName: () => ({}),
            agentNewSessionOptionStateByAgentId: {},
            draftScope: null,
        }));

        hook.getCurrent().persistDraftIfEnabled({ selectedPath: '/repo' } as never);

        expect(saveNewSessionDraftMock).toHaveBeenCalledWith({ selectedPath: '/repo' });
        expect(clearNewSessionDraftMock).not.toHaveBeenCalled();

        await hook.unmount();
    });
});
