import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

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
const reviewCommentExecute = vi.fn(async () => ({ items: [], cursor: null }));
const executeAccountPluginDataEraseAction = vi.fn(async () => ({
    status: 'completed' as const,
    settings: { status: 'completed' as const, changed: true },
    data: { status: 'completed' as const, changed: false },
}));

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
    getSessionTranscriptForVoiceTool: vi.fn(async () => ({})),
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

vi.mock('@/sync/state/acpSessionModeOverridePublish', () => ({
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
    readMachineControlTargetForSession: vi.fn(() => null),
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

vi.mock('@/sync/domains/reviews/comments/api', () => ({
    createReviewCommentsHttpActionExecutor: vi.fn(() => reviewCommentExecute),
}));

vi.mock('@/sync/domains/plugins/settings/accountPluginDataEraseAction', () => ({
    executeAccountPluginDataEraseAction,
}));

vi.mock('@/agents/registry/generatedBundledPluginEntries.uiBehaviorOverrides', () => ({
    BUNDLED_CANONICAL_AGENT_UI_BEHAVIOR_DESCRIPTORS: Object.freeze({}),
    BUNDLED_CANONICAL_AGENT_UI_BEHAVIOR_OVERRIDES: Object.freeze({}),
}));

async function getSessionRpcWithServerScopeMock() {
    const { sessionRpcWithServerScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc');
    return vi.mocked(sessionRpcWithServerScope);
}

async function getSendSessionMessageWithServerScopeMock() {
    const { sendSessionMessageWithServerScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionSendMessage');
    return vi.mocked(sendSessionMessageWithServerScope);
}

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
        reviewCommentExecute.mockClear();
        executeAccountPluginDataEraseAction.mockClear();
    });

    it('routes durable review-comment actions through the shared HTTP action executor', async () => {
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        const executor = createDefaultActionExecutor();

        const res = await executor.execute(
            'reviews.comments.list' as any,
            { projectId: 'project-1', states: ['open'] },
            { surface: 'ui' },
        );

        expect(res).toEqual({ ok: true, result: { items: [], cursor: null } });
        expect(reviewCommentExecute).toHaveBeenCalledWith(
            'reviews.comments.list',
            { projectId: 'project-1', states: ['open'], includeHistory: false, limit: 50 },
        );
    });

    it('routes the host-present Account plugin erase action without forwarding generic retry identity metadata', async () => {
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        const executor = createDefaultActionExecutor();
        const controller = new AbortController();

        await expect(executor.execute(
            'account.plugins.data.erase' as any,
            { pluginId: 'example.orphaned-plugin' },
            {
                surface: 'ui',
                actionCaller: { kind: 'host' },
                actionRequestId: 'plugin-data-erase-operation-1',
                signal: controller.signal,
            },
        )).resolves.toEqual({
            ok: true,
            result: {
                status: 'completed',
                settings: { status: 'completed', changed: true },
                data: { status: 'completed', changed: false },
            },
        });

        expect(executeAccountPluginDataEraseAction).toHaveBeenCalledExactlyOnceWith(
            { pluginId: 'example.orphaned-plugin' },
            {
                signal: controller.signal,
            },
        );
    });

    it('routes permission responses through the canonical session permission RPC method', async () => {
        const sessionRpcWithServerScope = await getSessionRpcWithServerScopeMock();
        sessionRpcWithServerScope.mockReset();
        sessionRpcWithServerScope.mockResolvedValueOnce({ ok: false, errorCode: 'permission_request_not_found' });

        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        const executor = createDefaultActionExecutor({
            resolveServerIdForSessionId: (sessionId) => sessionId === 's1' ? 'srv-main' : null,
        });

        const res = await executor.execute(
            'session.permission.respond' as any,
            { sessionId: 's1', requestId: 'req-1', decision: 'deny' },
            { surface: 'ui' },
        );

        expect(res).toEqual({
            ok: false,
            errorCode: 'permission_request_not_found',
            error: 'permission_request_not_found',
        });
        expect(sessionRpcWithServerScope).toHaveBeenCalledWith({
            sessionId: 's1',
            serverId: 'srv-main',
            method: RPC_METHODS.SESSION_PERMISSION_RESPOND,
            payload: { id: 'req-1', approved: false },
        });
    });

    it('routes owner remote grant management through the canonical session Action transport', async () => {
        const sessionRpcWithServerScope = await getSessionRpcWithServerScopeMock();
        sessionRpcWithServerScope.mockReset();
        sessionRpcWithServerScope.mockResolvedValueOnce({
            grants: [],
            nextCursor: null,
        });

        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        const executor = createDefaultActionExecutor({
            resolveServerIdForSessionId: (sessionId) => sessionId === 's1' ? 'srv-main' : null,
        });

        const res = await executor.execute(
            'session.permission.remote.grants.list' as any,
            { sessionId: 's1' },
            { surface: 'ui' },
        );

        expect(res).toEqual({
            ok: true,
            result: {
                grants: [],
                nextCursor: null,
            },
        });
        expect(sessionRpcWithServerScope).toHaveBeenCalledWith({
            sessionId: 's1',
            serverId: 'srv-main',
            method: 'session.permission.remote.grants.list',
            payload: { sessionId: 's1', limit: 50 },
        });
    });

    it('routes user-action answers through the canonical session user-action RPC method', async () => {
        const sessionRpcWithServerScope = await getSessionRpcWithServerScopeMock();
        sessionRpcWithServerScope.mockReset();
        sessionRpcWithServerScope.mockResolvedValueOnce({ ok: true, status: 'accepted' });

        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        const executor = createDefaultActionExecutor({
            resolveServerIdForSessionId: (sessionId) => sessionId === 's1' ? 'srv-main' : null,
        });

        const res = await executor.execute(
            'session.user_action.answer' as any,
            {
                sessionId: 's1',
                requestId: 'user-action-1',
                decision: 'approve',
                answers: [{
                    question: 'Where should this run?',
                    values: ['Washington, D.C.', 'Virginia', 'A custom, exact answer'],
                }],
                reason: ' approved from UI ',
                updatedPermissions: { allowedTools: ['shell'] },
            },
            { surface: 'ui' },
        );

        expect(res).toEqual({ ok: true, result: { ok: true, status: 'accepted' } });
        expect(sessionRpcWithServerScope).toHaveBeenCalledWith({
            sessionId: 's1',
            serverId: 'srv-main',
            method: RPC_METHODS.SESSION_USER_ACTION_ANSWER,
            payload: {
                id: 'user-action-1',
                approved: true,
                answers: {
                    'Where should this run?': ['Washington, D.C.', 'Virginia', 'A custom, exact answer'],
                },
                reason: 'approved from UI',
                updatedPermissions: { allowedTools: ['shell'] },
            },
        });
    });

    it('routes session.message.send through the active readiness barrier', async () => {
        const sendSessionMessageWithServerScope = await getSendSessionMessageWithServerScopeMock();
        sendSessionMessageWithServerScope.mockReset();
        sendSessionMessageWithServerScope.mockResolvedValueOnce({ ok: true });

        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        const executor = createDefaultActionExecutor({
            resolveServerIdForSessionId: (sessionId) => sessionId === 's1' ? 'srv-main' : null,
        });

        const res = await executor.execute(
            'session.message.send' as any,
            { sessionId: 's1', message: 'Hello from action' },
            { surface: 'ui' },
        );

        expect(res).toEqual({ ok: true, result: { ok: true } });
        expect(sendSessionMessageWithServerScope).toHaveBeenCalledWith({
            sessionId: 's1',
            message: 'Hello from action',
            serverId: 'srv-main',
            requestedAction: { v: 1, kind: 'steer_if_active' },
        });
    });

    it('executes approved session.title.set requests when the approval was created from the MCP surface', async () => {
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        const executor = createDefaultActionExecutor();

        const res = await executor.execute(
            'approval.request.decide' as any,
            { artifactId: 'artifact-1', decision: 'approve' },
            { surface: 'ui' },
        );

        expect(res.ok).toBe(true);
        expect((res as any).result?.status).toBe('executed');
        expect(patchSessionMetadataWithRetry).toHaveBeenCalledTimes(1);
    });

    it('routes surfaced ui actions through approvals when settings require approval for that surface', async () => {
        state.settings.actionsSettingsV1.actions['review.start'] = {
            enabledPlacements: [],
            disabledSurfaces: [],
            disabledPlacements: [],
            approvalRequiredSurfaces: ['ui'],
        };
        sessionExecutionRunStart.mockClear();

        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        const executor = createDefaultActionExecutor();

        const res = await executor.execute(
            'review.start' as any,
            { sessionId: 's1', engineIds: ['codex'], instructions: 'Needs approval' },
            { surface: 'ui' },
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
            { surface: 'ui' },
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
            { surface: 'ui' },
        );

        expect(res.ok).toBe(true);
        expect((res as any).result?.status).toBe('executed');
        expect(sessionStopWithServerScope).toHaveBeenCalledWith('s1', { serverId: undefined });
    });
});
