import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';
import { WEB_TEXTAREA_AUTOSIZE_VALUE_LENGTH_LIMIT } from '@/components/ui/forms/largeTextInputPolicy';
import { DEFAULT_NEW_SESSION_AUTOMATION_DRAFT } from '@/sync/domains/automations/automationDraft';
import { settingsDefaults } from '@/sync/domains/settings/settings';

import { useNewSessionAuthoringState } from './useNewSessionAuthoringState';
import { createNewSessionPromptStore } from '@/components/sessions/new/hooks/screenModel/newSessionPromptStore';

const buildNewSessionAuthoringContextMock = vi.hoisted(() => vi.fn());
const buildLiveNewSessionAuthoringDraftFromResolvedInputsMock = vi.hoisted(() => vi.fn((params: Record<string, unknown>) => ({
    directory: params.directory,
    prompt: params.prompt,
    displayText: params.displayText ?? '',
})));
const saveNewSessionDraftMock = vi.hoisted(() => vi.fn());
const clearNewSessionDraftMock = vi.hoisted(() => vi.fn());
const writeNewSessionDraftMock = vi.hoisted(() => vi.fn());
const writeSessionDraftLocalSupplementMock = vi.hoisted(() => vi.fn());
const flushSessionDraftMock = vi.hoisted(() => vi.fn(async () => ({ status: 'clean' as const })));

vi.mock('@/components/sessions/authoring/context/buildNewSessionAuthoringContext', () => ({
    buildNewSessionAuthoringContext: (...args: unknown[]) => buildNewSessionAuthoringContextMock(...args),
}));

vi.mock('@/components/sessions/authoring/draft/sessionAuthoringDraftAdapters', () => ({
    buildLiveNewSessionAuthoringDraftFromResolvedInputs: (params: Record<string, unknown>) => buildLiveNewSessionAuthoringDraftFromResolvedInputsMock(params),
    buildNewSessionAuthoringDraftFromResolvedInputs: vi.fn(() => ({ directory: '/repo', prompt: '' })),
    buildPersistedNewSessionDraftFromAuthoringDraft: vi.fn(() => ({ selectedPath: '/repo' })),
}));

vi.mock('@/sync/domains/state/persistence', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/domains/state/persistence')>(),
    saveNewSessionDraft: (...args: unknown[]) => saveNewSessionDraftMock(...args),
    clearNewSessionDraft: (...args: unknown[]) => clearNewSessionDraftMock(...args),
}));

vi.mock('@/sync/ops/sessionDrafts/sessionDraftRepository', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/ops/sessionDrafts/sessionDraftRepository')>(),
    writeNewSessionDraft: (params: unknown) => writeNewSessionDraftMock(params),
    writeSessionDraftLocalSupplement: (params: unknown) => writeSessionDraftLocalSupplementMock(params),
    flushSessionDraft: (_params: unknown) => flushSessionDraftMock(),
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
        buildLiveNewSessionAuthoringDraftFromResolvedInputsMock.mockClear();
        saveNewSessionDraftMock.mockReset();
        clearNewSessionDraftMock.mockReset();
        writeNewSessionDraftMock.mockReset();
        writeSessionDraftLocalSupplementMock.mockReset();
        flushSessionDraftMock.mockReset();
        flushSessionDraftMock.mockResolvedValue({ status: 'clean' });

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

    it('persists through the exact-address repository owner', async () => {
        const hook = await renderHook(() => useNewSessionAuthoringState({
            automationDraft: DEFAULT_NEW_SESSION_AUTOMATION_DRAFT,
            automationFeatureEnabled: false,
            selectedMachineId: null,
            selectedMachine: null,
            selectedPath: '/repo',
            checkoutCreationDraft: null,
            promptStore: createNewSessionPromptStore(''),
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
            targetServerId: null,
            windowsRemoteSessionLaunchModeOverride: null,
            acpSessionModeId: null,
            sessionConfigOptionOverrides: null,
            automationEditId: null,
            automationRequestedByRoute: false,
            selectedSecretId: null,
            selectedSecretIdByProfileIdByEnvVarName: {},
            getSessionOnlySecretValueEncByProfileIdByEnvVarName: () => ({}),
            agentNewSessionOptionStateByAgentId: {},
            draftScope: { serverId: 'server-a', accountId: 'account-a' },
            draftId: '8e0a5dd1-b1df-43dd-b51e-b7787b30362e',
        }));

        hook.getCurrent().stageDraftIfEnabled({ selectedPath: '/repo' } as never);

        expect(writeNewSessionDraftMock).toHaveBeenCalledWith(expect.objectContaining({
            scope: { serverId: 'server-a', accountId: 'account-a' },
            draftId: '8e0a5dd1-b1df-43dd-b51e-b7787b30362e',
            materializationIntent: 'userEdit',
        }));
        expect(saveNewSessionDraftMock).not.toHaveBeenCalled();
        expect(flushSessionDraftMock).not.toHaveBeenCalled();

        hook.getCurrent().persistDraftIfEnabled({ selectedPath: '/repo' } as never);
        expect(flushSessionDraftMock).toHaveBeenCalledTimes(1);

        await hook.unmount();
    });

    it('keeps the live prompt as canonical edit state without passing duplicate display text', async () => {
        const prompt = `  ${'x'.repeat(WEB_TEXTAREA_AUTOSIZE_VALUE_LENGTH_LIMIT + 1)}  `;
        buildNewSessionAuthoringContextMock.mockImplementation(({ buildDraft }) => ({
            draft: buildDraft(DEFAULT_NEW_SESSION_AUTOMATION_DRAFT),
            effectiveAutomationDraft: DEFAULT_NEW_SESSION_AUTOMATION_DRAFT,
            canSubmit: true,
        }));

        const hook = await renderHook(() => useNewSessionAuthoringState({
            automationDraft: DEFAULT_NEW_SESSION_AUTOMATION_DRAFT,
            automationFeatureEnabled: false,
            selectedMachineId: null,
            selectedMachine: null,
            selectedPath: '/repo',
            checkoutCreationDraft: null,
            promptStore: createNewSessionPromptStore(prompt),
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
            targetServerId: null,
            windowsRemoteSessionLaunchModeOverride: null,
            acpSessionModeId: null,
            sessionConfigOptionOverrides: null,
            automationEditId: null,
            automationRequestedByRoute: false,
            selectedSecretId: null,
            selectedSecretIdByProfileIdByEnvVarName: {},
            getSessionOnlySecretValueEncByProfileIdByEnvVarName: () => ({}),
            agentNewSessionOptionStateByAgentId: {},
            draftScope: null,
            draftId: '8e0a5dd1-b1df-43dd-b51e-b7787b30362e',
        }));

        const buildDraftParams = buildLiveNewSessionAuthoringDraftFromResolvedInputsMock.mock.calls[0]?.[0] as Record<string, unknown>;

        expect(buildDraftParams.prompt).toBe(prompt);
        expect(Object.prototype.hasOwnProperty.call(buildDraftParams, 'displayText')).toBe(false);
        expect(hook.getCurrent().currentAuthoringDraft).toEqual(expect.objectContaining({
            prompt,
            displayText: '',
        }));

        await hook.unmount();
    });
});
