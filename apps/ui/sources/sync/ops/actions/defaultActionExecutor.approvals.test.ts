import { beforeEach, describe, expect, it, vi } from 'vitest';

type TestState = {
    settings: any;
    sessions: Record<string, any>;
    artifacts: Record<string, any>;
};

let state: TestState = {
    settings: {},
    sessions: {},
    artifacts: {},
};

const patchSessionMetadataWithRetry = vi.fn(async () => {});
const sessionRename = vi.fn(async () => ({ success: true as const }));
const sessionStopWithServerScope = vi.fn(async () => ({ success: true as const }));
const updateArtifactWithHeader = vi.fn(async () => {});
const sessionExecutionRunStart = vi.fn(async () => ({}));

vi.mock('@/sync/ops/sessionExecutionRuns', () => ({
    sessionExecutionRunStart,
    sessionExecutionRunList: vi.fn(async () => ({})),
    sessionExecutionRunGet: vi.fn(async () => ({})),
    sessionExecutionRunSend: vi.fn(async () => ({})),
    sessionExecutionRunStop: vi.fn(async () => ({})),
    sessionExecutionRunAction: vi.fn(async () => ({})),
}));

vi.mock('@/sync/ops/sessions', () => ({
    forkSession: vi.fn(),
    rollbackSessionConversation: vi.fn(),
    sessionRename,
    sessionStopWithServerScope,
}));

vi.mock('@/sync/ops/sessionHandoffs', () => ({
    completeSessionHandoff: vi.fn(),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc', () => ({
    sessionRpcWithServerScope: vi.fn(),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionSendMessage', () => ({
    sendSessionMessageWithServerScope: vi.fn(async () => ({ ok: true })),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: vi.fn(),
}));

vi.mock('@/voice/activity/voiceActivityController', () => ({
    voiceActivityController: { clearSession: vi.fn() },
}));

vi.mock('@/voice/session/voiceSession', () => ({
    voiceSessionManager: { stopSession: vi.fn() },
}));

vi.mock('@/voice/agent/teleportVoiceAgentToSessionRoot', () => ({
    teleportVoiceAgentToSessionRoot: vi.fn(),
}));

vi.mock('@/voice/persistence/resetVoiceAgentPersistenceState', () => ({
    resetVoiceAgentPersistenceState: vi.fn(),
}));

vi.mock('@/voice/tools/actionImpl/openSession', () => ({
    openSessionForVoiceTool: vi.fn(),
}));

vi.mock('@/voice/tools/actionImpl/spawnSession', () => ({
    spawnSessionForVoiceTool: vi.fn(),
}));

vi.mock('@/voice/tools/actionImpl/spawnSessionPicker', () => ({
    spawnSessionWithPickerForVoiceTool: vi.fn(),
}));

vi.mock('@/voice/tools/actionImpl/sessionTargets', () => ({
    setPrimaryActionSessionId: vi.fn(),
    setTrackedSessionIds: vi.fn(),
}));

vi.mock('@/voice/tools/actionImpl/sessionList', () => ({
    listSessionsForVoiceTool: vi.fn(async () => ({ sessions: [] })),
}));

vi.mock('@/voice/tools/actionImpl/sessionActivity', () => ({
    getSessionActivityForVoiceTool: vi.fn(async () => ({})),
}));

vi.mock('@/voice/tools/actionImpl/sessionRecentMessages', () => ({
    getSessionRecentMessagesForVoiceTool: vi.fn(async () => ({})),
}));

vi.mock('@/voice/tools/actionImpl/pathsListRecent', () => ({
    listRecentPathsForVoiceTool: vi.fn(async () => ({ items: [] })),
}));

vi.mock('@/voice/tools/actionImpl/machinesList', () => ({
    listMachinesForVoiceTool: vi.fn(async () => ({ items: [] })),
}));

vi.mock('@/voice/tools/actionImpl/serversList', () => ({
    listServersForVoiceTool: vi.fn(async () => ({ items: [] })),
}));

vi.mock('@/voice/tools/actionImpl/reviewEnginesList', () => ({
    listReviewEnginesForVoiceTool: vi.fn(async () => ({ items: [] })),
}));

vi.mock('@/voice/tools/actionImpl/agentCatalogList', () => ({
    listAgentBackendsForVoiceTool: vi.fn(async () => ({ items: [] })),
    listAgentModelsForVoiceTool: vi.fn(async () => ({ items: [] })),
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        createArtifactWithHeader: vi.fn(async () => 'artifact-created'),
        fetchArtifactWithBody: vi.fn(async () => null),
        updateArtifactWithHeader,
        patchSessionMetadataWithRetry,
    },
}));

vi.mock('@/sync/engine/overrides/acpSessionModeOverridePublish', () => ({
    publishAcpSessionModeOverrideToMetadata: vi.fn(),
}));

vi.mock('@/sync/ops/promptLibrary/promptDocs', () => ({
    updatePromptDoc: vi.fn(),
}));

vi.mock('@/sync/ops/promptLibrary/promptBundles', () => ({
    updateSkillPromptBundle: vi.fn(),
}));

vi.mock('@/sync/ops/promptLibrary/exportPromptLibraryArtifact', () => ({
    writePromptLibraryArtifactToExternalAsset: vi.fn(async () => ({ ok: true, nextPromptExternalLinks: null })),
}));

vi.mock('@/sync/ops/promptLibrary/installPromptRegistryItem', () => ({
    installPromptRegistryItem: vi.fn(async () => ({ ok: true, artifactId: 'a1', exported: true })),
}));

vi.mock('@/sync/domains/sessionRollback/rollbackUiSupport', () => ({
    canRollbackConversation: vi.fn(() => true),
}));

vi.mock('@/sync/ops/sessionMachineTarget', () => ({
    readMachineTargetForSession: vi.fn(() => null),
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    storage: {
            getState: () => state,
            applySettingsLocal: vi.fn(),
            updateArtifact: vi.fn(),
        },
});
});

describe('createDefaultActionExecutor approvals', () => {
    beforeEach(() => {
        state = {
            settings: {
                actionsSettingsV1: {
                    v: 1,
                    actions: {
                        'session.title.set': {
                            enabledPlacements: [],
                            disabledSurfaces: [],
                            disabledPlacements: [],
                            approvalRequiredSurfaces: [],
                        },
                    },
                },
            },
            sessions: { s1: { id: 's1' } },
            artifacts: {
                'artifact-1': {
                    id: 'artifact-1',
                    body: JSON.stringify({
                        v: 1,
                        status: 'open',
                        createdAtMs: 1,
                        updatedAtMs: 1,
                        createdBy: { surface: 'mcp', sessionId: 's1' },
                        requestedSurface: 'mcp',
                        actionId: 'session.title.set',
                        actionArgs: { sessionId: 's1', title: 'Renamed from approval' },
                        summary: 'Set session title',
                    }),
                },
            },
        };
        sessionRename.mockClear();
        patchSessionMetadataWithRetry.mockClear();
        updateArtifactWithHeader.mockClear();
    });

    it('executes approved session.title.set requests when the approval was created from the MCP surface', async () => {
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        const executor = createDefaultActionExecutor();

        const res = await executor.execute(
            'approval.request.decide' as any,
            { artifactId: 'artifact-1', decision: 'approve' },
            { surface: 'ui_button' },
        );

        expect(res.ok).toBe(true);
        expect((res as any).result?.status).toBe('executed');
        expect(patchSessionMetadataWithRetry).toHaveBeenCalledTimes(1);
    });

    it('routes surfaced ui_button actions through approvals when settings require approval for that surface', async () => {
        state.settings.actionsSettingsV1.actions['review.start'] = {
            enabledPlacements: [],
            disabledSurfaces: [],
            disabledPlacements: [],
            approvalRequiredSurfaces: ['ui_button'],
        };
        sessionExecutionRunStart.mockClear();

        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        const executor = createDefaultActionExecutor();

        const res = await executor.execute(
            'review.start' as any,
            { sessionId: 's1', engineIds: ['codex'], instructions: 'Needs approval' },
            { surface: 'ui_button' },
        );

        expect(res.ok).toBe(true);
        expect((res as any).result).toEqual(expect.objectContaining({
            kind: 'approval_request_created',
            artifactId: 'artifact-created',
            actionId: 'review.start',
        }));
        expect(sessionExecutionRunStart).not.toHaveBeenCalled();
    });

    it('executes session.title.set approvals even when the session is missing locally', async () => {
        state.sessions = {};
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        const executor = createDefaultActionExecutor();

        const res = await executor.execute(
            'approval.request.decide' as any,
            { artifactId: 'artifact-1', decision: 'approve' },
            { surface: 'ui_button' },
        );

        expect(res.ok).toBe(true);
        expect((res as any).result?.status).toBe('executed');
        expect(patchSessionMetadataWithRetry).toHaveBeenCalledTimes(1);
    });

    it('executes approved session.stop requests when the approval was created from the MCP surface', async () => {
        state.settings.actionsSettingsV1.actions['session.stop'] = {
            enabledPlacements: [],
            disabledSurfaces: [],
            disabledPlacements: [],
            approvalRequiredSurfaces: [],
        };
        state.artifacts['artifact-stop'] = {
            id: 'artifact-stop',
            body: JSON.stringify({
                v: 1,
                status: 'open',
                createdAtMs: 1,
                updatedAtMs: 1,
                createdBy: { surface: 'mcp', sessionId: 's1' },
                requestedSurface: 'mcp',
                actionId: 'session.stop',
                actionArgs: { sessionId: 's1' },
                summary: 'Stop session',
            }),
        };
        sessionStopWithServerScope.mockClear();

        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        const executor = createDefaultActionExecutor();

        const res = await executor.execute(
            'approval.request.decide' as any,
            { artifactId: 'artifact-stop', decision: 'approve' },
            { surface: 'ui_button' },
        );

        expect(res.ok).toBe(true);
        expect((res as any).result?.status).toBe('executed');
        expect(sessionStopWithServerScope).toHaveBeenCalledWith('s1', { serverId: undefined });
    });
});
