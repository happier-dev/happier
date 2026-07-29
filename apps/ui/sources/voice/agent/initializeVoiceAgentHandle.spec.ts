import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAgentCore } from '@/agents/catalog/catalog';
import { installVoiceAgentCommonModuleMocks } from './voiceAgentTestHelpers';

const start = vi.fn(async (_params: any) => ({ voiceAgentId: 'voice-agent-1' }));
const ensureVoiceAgentInstallablesBackground = vi.fn(async (_args: unknown) => {});
const assertDaemonVoiceAgentRuntimeSupported = vi.fn(async () => {});
const resolveVoiceAgentInitialContexts = vi.fn((_sessionId: string, _options?: Readonly<{ targetSessionId?: string | null }>) => ({
    bootstrapInitialContext: 'bootstrap-context',
    deferredTargetSessionContext: '',
}));
const sessionExecutionRunList = vi.fn(async (_sessionId: string, _params?: any) => ({ runs: [] }));
const sessionExecutionRunGet = vi.fn(async (_sessionId: string, _params?: any) => null);
const sessionExecutionRunStop = vi.fn(async (_sessionId: string, _params?: any) => ({ ok: true }));
const patchSessionMetadataWithRetry = vi.fn(async (_sessionId: string, updater: (metadata: any) => any) => {
    const session = state.sessions[_sessionId];
    session.metadata = updater(session.metadata);
});
const ensureSessionVisibleForMessageRoute = vi.fn(async (_sessionId: string, _options?: { forceRefresh?: boolean }) => {});
const refreshSessionMessages = vi.fn(async (_sessionId: string) => {});
const getState = vi.fn(() => state);

const state: any = {
    settings: {
        voice: {
            providerId: 'local_conversation',
            providers: {
                local_conversation: { schemaVersion: 1, config: {
                    agent: {
                        backend: 'daemon',
                        agentSource: 'session',
                        chatModelSource: 'custom',
                        chatModelId: 'default',
                        commitModelSource: 'chat',
                        commitModelId: 'default',
                        transcript: { persistenceMode: 'ephemeral', epoch: 0 },
                    },
                    networkTimeoutMs: 15_000,
                } },
            },
        },
    },
    sessions: {
        s1: {
            id: 's1',
            active: true,
            presence: 'online',
            modelMode: 'default',
            metadata: {
                flavor: 'claude',
                profileId: 'raw-profile',
            },
        },
    },
    sessionListRenderables: {
        s1: {
            id: 's1',
            active: true,
            presence: 'online',
            modelMode: 'default',
            metadata: {
                flavor: 'codex',
                profileId: 'cached-profile',
            },
        },
    },
    sessionListIndexByServerId: {
        'server-a': [
            {
                type: 'session',
                sessionId: 's1',
                serverId: 'server-a',
                serverName: 'Server A',
            },
        ],
    },
    concurrentSessionListCacheByServerId: {},
    machines: {},
    machineListByServerId: {},
    sessionMessages: {},
};

installVoiceAgentCommonModuleMocks({
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            storage: {
                getState,
            },
        });
    },
});

vi.mock('@/voice/agent/assertDaemonVoiceAgentRuntimeSupported', () => ({
    assertDaemonVoiceAgentRuntimeSupported: () => assertDaemonVoiceAgentRuntimeSupported(),
}));

vi.mock('@/voice/agent/ensureVoiceAgentInstallablesBackground', () => ({
    ensureVoiceAgentInstallablesBackground: (args: unknown) => ensureVoiceAgentInstallablesBackground(args),
}));

vi.mock('@/voice/agent/resolveVoiceAgentInitialContexts', () => ({
    resolveVoiceAgentInitialContexts: (sessionId: string, options?: Readonly<{ targetSessionId?: string | null }>) =>
        resolveVoiceAgentInitialContexts(sessionId, options),
}));

vi.mock('@/sync/ops/sessionExecutionRuns', () => ({
    sessionExecutionRunGet: (sessionId: string, params?: any) => sessionExecutionRunGet(sessionId, params),
    sessionExecutionRunList: (sessionId: string, params?: any) => sessionExecutionRunList(sessionId, params),
    sessionExecutionRunStop: (sessionId: string, params?: any) => sessionExecutionRunStop(sessionId, params),
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        ensureSessionVisibleForMessageRoute: (sessionId: string, options?: { forceRefresh?: boolean }) =>
            ensureSessionVisibleForMessageRoute(sessionId, options),
        refreshSessionMessages: (sessionId: string) => refreshSessionMessages(sessionId),
        patchSessionMetadataWithRetry: (sessionId: string, updater: (metadata: any) => any) =>
            patchSessionMetadataWithRetry(sessionId, updater),
    },
}));

vi.mock('@/sync/domains/features/featureDecisionInputs', () => ({
    resolveRuntimeFeatureDecision: vi.fn(async () => ({
        featureId: 'voice.agent',
        state: 'enabled',
        blockedBy: null,
        blockerCode: 'none',
        diagnostics: [],
        evaluatedAt: 1,
        scope: { scopeKind: 'runtime' },
    })),
    isRuntimeFeatureEnabled: vi.fn(async () => true),
}));

vi.mock('@/voice/agent/resolveVoiceAgentBootstrapTimeoutMs', () => ({
    resolveVoiceAgentBootstrapTimeoutMs: () => 60_000,
}));

vi.mock('@/voice/agent/resolveVoiceAgentModels', () => ({
    resolveDaemonVoiceAgentModelIds: vi.fn(),
}));

vi.mock('@/voice/context/buildVoiceInitialContext', () => ({
    buildVoiceInitialContext: () => 'bootstrap-context',
}));

describe('initializeVoiceAgentHandle', () => {
    beforeEach(() => {
        start.mockClear();
        ensureVoiceAgentInstallablesBackground.mockClear();
        assertDaemonVoiceAgentRuntimeSupported.mockClear();
        resolveVoiceAgentInitialContexts.mockClear();
        sessionExecutionRunList.mockClear();
        sessionExecutionRunGet.mockClear();
        sessionExecutionRunStop.mockClear();
        patchSessionMetadataWithRetry.mockClear();
        ensureSessionVisibleForMessageRoute.mockClear();
        refreshSessionMessages.mockClear();
        state.sessions.s1.metadata = {
            flavor: 'claude',
            profileId: 'raw-profile',
        };
        state.sessionListRenderables.s1.metadata = {
            flavor: 'codex',
            profileId: 'cached-profile',
        };
    });

    it('prefers visible lookup session metadata when deriving daemon startup models and profile data', async () => {
        const { initializeVoiceAgentHandle } = await import('./initializeVoiceAgentHandle');

        const handle = await initializeVoiceAgentHandle({
            sessionId: 's1',
            getDaemonVoiceAgentClient: () => ({
                start,
                sendTurn: vi.fn(),
                welcome: vi.fn(),
                startTurnStream: vi.fn(),
                readTurnStream: vi.fn(),
                cancelTurnStream: vi.fn(),
                commit: vi.fn(),
                stop: vi.fn(),
            }),
            getOpenAiCompatVoiceAgentClient: () => ({
                start: vi.fn(),
                sendTurn: vi.fn(),
                welcome: vi.fn(),
                startTurnStream: vi.fn(),
                readTurnStream: vi.fn(),
                cancelTurnStream: vi.fn(),
                commit: vi.fn(),
                stop: vi.fn(),
            }),
            enqueuePendingContextUpdate: vi.fn(),
        });

        expect(handle.backend).toBe('daemon');
        expect(handle.rpcSessionId).toBe('s1');
        expect(handle.agentBackendId).toBe('codex');
        expect(start).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionId: 's1',
                agentId: 'codex',
                profileId: 'cached-profile',
                chatModelId: getAgentCore('codex').model.defaultMode,
                commitModelId: getAgentCore('codex').model.defaultMode,
            }),
        );
    });
});
