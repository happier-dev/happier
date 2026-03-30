import { beforeEach, describe, expect, it, vi } from 'vitest';

const capturedDeps = vi.hoisted<{ current: any | null }>(() => ({ current: null }));
const writePromptLibraryArtifactToExternalAssetMock = vi.hoisted(() => vi.fn(async () => ({
    ok: true as const,
    nextPromptExternalLinks: { v: 1 as const, links: [] },
})));
const installPromptRegistryItemMock = vi.hoisted(() => vi.fn(async () => ({
    ok: true as const,
    artifactId: 'bundle-1',
    exported: true,
    routeKind: 'bundle' as const,
})));
const applySettingsLocalMock = vi.hoisted(() => vi.fn());
const updateArtifactWithHeaderMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('@happier-dev/protocol', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        createActionExecutor: (deps: unknown) => {
            capturedDeps.current = deps;
            return { execute: vi.fn() };
        },
        isActionEnabledByActionsSettings: () => true,
    };
});

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    storage: {
        getState: () => ({
            settings: {
                promptExternalLinksV1: { v: 1, links: [] },
            },
            applySettingsLocal: applySettingsLocalMock,
            sessions: {},
        }),
    },
});
});

vi.mock('@/sync/ops/sessionExecutionRuns', () => ({
    sessionExecutionRunAction: vi.fn(),
    sessionExecutionRunGet: vi.fn(),
    sessionExecutionRunList: vi.fn(),
    sessionExecutionRunSend: vi.fn(),
    sessionExecutionRunStart: vi.fn(),
    sessionExecutionRunStop: vi.fn(),
}));

vi.mock('@/sync/ops/sessions', () => ({
    forkSession: vi.fn(),
    rollbackSessionConversation: vi.fn(),
    sessionRename: vi.fn(async () => ({ success: true })),
}));
vi.mock('@/sync/ops/sessionHandoffs', () => ({ completeSessionHandoff: vi.fn() }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc', () => ({ sessionRpcWithServerScope: vi.fn() }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionSendMessage', () => ({ sendSessionMessageWithServerScope: vi.fn() }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: vi.fn() }));
vi.mock('@/voice/activity/voiceActivityController', () => ({ voiceActivityController: { clearSession: vi.fn() } }));
vi.mock('@/voice/session/voiceSession', () => ({ voiceSessionManager: { stop: vi.fn() } }));
vi.mock('@/voice/agent/voiceAgentGlobalSessionId', () => ({ VOICE_AGENT_GLOBAL_SESSION_ID: 'voice-global' }));
vi.mock('@/voice/agent/teleportVoiceAgentToSessionRoot', () => ({ teleportVoiceAgentToSessionRoot: vi.fn() }));
vi.mock('@/voice/tools/actionImpl/openSession', () => ({ openSessionForVoiceTool: vi.fn() }));
vi.mock('@/voice/tools/actionImpl/spawnSession', () => ({ spawnSessionForVoiceTool: vi.fn() }));
vi.mock('@/voice/tools/actionImpl/spawnSessionPicker', () => ({ spawnSessionWithPickerForVoiceTool: vi.fn() }));
vi.mock('@/voice/tools/actionImpl/sessionTargets', () => ({ setPrimaryActionSessionId: vi.fn(), setTrackedSessionIds: vi.fn() }));
vi.mock('@/voice/tools/actionImpl/sessionList', () => ({ listSessionsForVoiceTool: vi.fn() }));
vi.mock('@/voice/tools/actionImpl/sessionActivity', () => ({ getSessionActivityForVoiceTool: vi.fn() }));
vi.mock('@/voice/tools/actionImpl/sessionRecentMessages', () => ({ getSessionRecentMessagesForVoiceTool: vi.fn() }));
vi.mock('@/voice/tools/actionImpl/pathsListRecent', () => ({ listRecentPathsForVoiceTool: vi.fn() }));
vi.mock('@/voice/tools/actionImpl/machinesList', () => ({ listMachinesForVoiceTool: vi.fn() }));
vi.mock('@/voice/tools/actionImpl/serversList', () => ({ listServersForVoiceTool: vi.fn() }));
vi.mock('@/voice/tools/actionImpl/reviewEnginesList', () => ({ listReviewEnginesForVoiceTool: vi.fn() }));
vi.mock('@/voice/tools/actionImpl/agentCatalogList', () => ({
    listAgentBackendsForVoiceTool: vi.fn(),
    listAgentModelsForVoiceTool: vi.fn(),
}));
vi.mock('@/sync/sync', () => ({
    sync: {
        createArtifactWithHeader: vi.fn(),
        fetchArtifactWithBody: vi.fn(),
        updateArtifactWithHeader: updateArtifactWithHeaderMock,
    },
}));
vi.mock('@/sync/engine/overrides/acpSessionModeOverridePublish', () => ({ publishAcpSessionModeOverrideToMetadata: vi.fn() }));
vi.mock('@/sync/ops/promptLibrary/promptDocs', () => ({ updatePromptDoc: vi.fn() }));
vi.mock('@/sync/ops/promptLibrary/promptBundles', () => ({ updateSkillPromptBundle: vi.fn() }));
vi.mock('./sessionModeActionSupport', () => ({
    isRequestedSessionModeSupported: vi.fn(() => true),
    isSessionModeActionAvailable: vi.fn(() => true),
    normalizeRequestedSessionModeId: vi.fn((value) => value),
    resolveSessionModeActionControl: vi.fn(() => ({})),
    serializeSessionModeActionOptions: vi.fn(() => []),
}));

vi.mock('@/sync/ops/promptLibrary/exportPromptLibraryArtifact', () => ({
    writePromptLibraryArtifactToExternalAsset: writePromptLibraryArtifactToExternalAssetMock,
}));

vi.mock('@/sync/ops/promptLibrary/installPromptRegistryItem', () => ({
    installPromptRegistryItem: installPromptRegistryItemMock,
}));

describe('createDefaultActionExecutor (prompt library routing)', () => {
    beforeEach(() => {
        capturedDeps.current = null;
        writePromptLibraryArtifactToExternalAssetMock.mockClear();
        installPromptRegistryItemMock.mockClear();
        applySettingsLocalMock.mockClear();
        updateArtifactWithHeaderMock.mockClear();
    });

    it('passes serverId through prompt asset export operations', async () => {
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        createDefaultActionExecutor();

        await capturedDeps.current.promptAssetExport({
            artifactId: 'doc-1',
            machineId: 'machine-1',
            assetTypeId: 'claude.command',
            scope: 'user',
            targetPath: 'review.md',
            serverId: 'server-1',
        });

        expect(writePromptLibraryArtifactToExternalAssetMock).toHaveBeenCalledWith(expect.objectContaining({
            artifactId: 'doc-1',
            machineId: 'machine-1',
            assetTypeId: 'claude.command',
            scope: 'user',
            targetInput: 'review.md',
            serverId: 'server-1',
        }));
    });

    it('passes serverId through prompt registry install operations', async () => {
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        createDefaultActionExecutor();

        await capturedDeps.current.promptRegistryInstall({
            machineId: 'machine-1',
            sourceId: 'skills_sh:featured',
            itemId: 'skills_sh:featured:item-1',
            configuredSources: [],
            serverId: 'server-1',
        });

        expect(installPromptRegistryItemMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            sourceId: 'skills_sh:featured',
            itemId: 'skills_sh:featured:item-1',
            serverId: 'server-1',
        }));
    });

    it('preserves serverId in approval headers when updating approval artifacts', async () => {
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        createDefaultActionExecutor();

        await capturedDeps.current.approvalsUpdate({
            artifactId: 'approval-1',
            request: {
                v: 1,
                status: 'approved',
                createdAtMs: 1,
                updatedAtMs: 2,
                createdBy: { surface: 'system', sessionId: 'session-1' },
                actionId: 'prompt_asset.export',
                actionArgs: {},
                summary: 'Export prompt',
                serverId: 'server-1',
                decision: { kind: 'approve', decidedAtMs: 2 },
            },
        });

        expect(updateArtifactWithHeaderMock).toHaveBeenCalledWith(
            'approval-1',
            expect.objectContaining({
                kind: 'approval_request.v1',
                approvalStatus: 'approved',
                serverId: 'server-1',
            }),
            expect.any(String),
        );
    });
});
