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
const sessionExecutionRunGet = vi.fn(async (_sessionId: string, _params?: any) => ({
    ok: false as const,
    error: 'Execution run not found',
    errorCode: 'execution_run_not_found',
}));
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
        state.sessions.s1.metadataLayoutVersion = 0;
        delete state.sessions.s1.ownerMetadataView;
        state.sessions.s1.metadata = {
            flavor: 'claude',
            profileId: 'raw-profile',
            agentRuntimeCapabilitiesV1: {
                localControl: { supported: true },
            },
        };
        state.sessionListRenderables.s1.metadataLayoutVersion = 0;
        delete state.sessionListRenderables.s1.ownerMetadataView;
        state.sessionListRenderables.s1.metadata = {
            flavor: 'codex',
            profileId: 'cached-profile',
            agentRuntimeCapabilitiesV1: {
                localControl: { supported: true },
            },
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
            setDeferredTargetSessionContext: vi.fn(),
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

    it.each<[string, () => void]>([
        ['visible session metadata', () => {
            state.sessions.s1.metadataLayoutVersion = 1;
            state.sessions.s1.ownerMetadataView = null;
            state.sessionListRenderables.s1.metadataLayoutVersion = 1;
            state.sessionListRenderables.s1.ownerMetadataView = null;
        }],
        ['cached session metadata', () => {
            state.sessions.s1.metadata = null;
            state.sessionListRenderables.s1.metadataLayoutVersion = 1;
            state.sessionListRenderables.s1.ownerMetadataView = null;
        }],
    ])('fails closed without RPC when the %s Agent is unreadable', async (_case, arrange) => {
        arrange();
        const getDaemonVoiceAgentClient = vi.fn(() => ({
            start,
            sendTurn: vi.fn(),
            welcome: vi.fn(),
            startTurnStream: vi.fn(),
            readTurnStream: vi.fn(),
            cancelTurnStream: vi.fn(),
            commit: vi.fn(),
            stop: vi.fn(),
        }));
        const { initializeVoiceAgentHandle } = await import('./initializeVoiceAgentHandle');

        await expect(initializeVoiceAgentHandle({
            sessionId: 's1',
            getDaemonVoiceAgentClient,
            setDeferredTargetSessionContext: vi.fn(),
        })).rejects.toMatchObject({
            message: 'voice_agent_selection_unavailable',
            code: 'VOICE_AGENT_SELECTION_UNAVAILABLE',
        });

        expect(ensureVoiceAgentInstallablesBackground).not.toHaveBeenCalled();
        expect(getDaemonVoiceAgentClient).not.toHaveBeenCalled();
        expect(start).not.toHaveBeenCalled();
    });

    it('routes migrated OpenAI-compatible Chat through the daemon with exact Provider selections', async () => {
        const { initializeVoiceAgentHandle } = await import('./initializeVoiceAgentHandle');
        const originalAgent = state.settings.voice.providers.local_conversation.config.agent;
        state.settings.voice.providers.local_conversation.config.agent = {
            ...originalAgent,
            agentSource: 'agent',
            agentId: 'opencode',
            providerChat: {
                status: 'configured',
                chat: {
                    agentTargetKey: 'agent:happier.agent.opencode/opencode',
                    providerConnectionId: 'voice-openai-compatible-chat',
                    modelId: 'chat-model',
                },
                commit: {
                    agentTargetKey: 'agent:happier.agent.opencode/opencode',
                    providerConnectionId: 'voice-openai-compatible-chat',
                    modelId: 'commit-model',
                },
                configuration: { temperature: 0.73 },
            },
        };

        try {
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
                setDeferredTargetSessionContext: vi.fn(),
            });

            expect(handle.backend).toBe('daemon');
            expect(start).toHaveBeenCalledWith(expect.objectContaining({
                agentSource: 'agent',
                agentId: 'opencode',
                chatModelId: 'chat-model',
                commitModelId: 'commit-model',
                chatModelSelection: expect.objectContaining({ providerConnectionId: 'voice-openai-compatible-chat' }),
                commitModelSelection: expect.objectContaining({ providerConnectionId: 'voice-openai-compatible-chat' }),
                sessionConfigOptionOverrides: {
                    v: 1,
                    updatedAt: 0,
                    overrides: { temperature: { updatedAt: 0, value: 0.73 } },
                },
            }));
        } finally {
            state.settings.voice.providers.local_conversation.config.agent = originalAgent;
        }
    });

    it('routes the released OpenAI-compatible settings through migration and daemon startup', async () => {
        const { settingsParse } = await import('@/sync/domains/settings/settings');
        const { initializeVoiceAgentHandle } = await import('./initializeVoiceAgentHandle');
        const originalSettings = state.settings;
        const legacySecret = {
            id: 'voice:openai_compat:chat_api_key',
            name: 'Voice: openai_compat',
            kind: 'apiKey' as const,
            encryptedValue: { _isSecretValue: true as const, value: 'sk-existing' },
            createdAt: 0,
            updatedAt: 0,
        };
        state.settings = settingsParse({
            secrets: [legacySecret],
            voice: {
                providerId: 'local_conversation',
                adapters: {
                    local_conversation: {
                        conversationMode: 'agent',
                        agent: {
                            backend: 'openai_compat',
                            agentSource: 'agent',
                            agentId: 'opencode',
                            permissionPolicy: 'read_only',
                            openaiCompat: {
                                chatBaseUrl: 'http://127.0.0.1:11434/v1',
                                chatApiKey: legacySecret.encryptedValue,
                                chatModel: 'qwen-chat',
                                commitModel: 'qwen-commit',
                                temperature: 0.25,
                            },
                        },
                    },
                },
            },
        });

        try {
            await initializeVoiceAgentHandle({
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
                setDeferredTargetSessionContext: vi.fn(),
            });

            expect(start).toHaveBeenCalledWith(expect.objectContaining({
                agentSource: 'agent',
                agentId: 'opencode',
                chatModelId: 'qwen-chat',
                commitModelId: 'qwen-commit',
                chatModelSelection: expect.objectContaining({
                    providerConnectionId: 'voice-openai-compatible-chat',
                }),
                commitModelSelection: expect.objectContaining({
                    providerConnectionId: 'voice-openai-compatible-chat',
                }),
            }));
        } finally {
            state.settings = originalSettings;
        }
    });

    it.each([
        ['different', 'backend:codex'],
        ['malformed', 'not-a-target-key'],
    ])('fails closed when the configured commit target is %s', async (_case, commitTargetKey) => {
        const { initializeVoiceAgentHandle } = await import('./initializeVoiceAgentHandle');
        const originalAgent = state.settings.voice.providers.local_conversation.config.agent;
        state.settings.voice.providers.local_conversation.config.agent = {
            ...originalAgent,
            agentSource: 'agent',
            agentId: 'opencode',
            providerChat: {
                status: 'configured',
                chat: {
                    agentTargetKey: 'agent:happier.agent.opencode/opencode',
                    providerConnectionId: 'voice-openai-compatible-chat',
                    modelId: 'chat-model',
                },
                commit: {
                    agentTargetKey: commitTargetKey,
                    providerConnectionId: 'voice-openai-compatible-chat',
                    modelId: 'commit-model',
                },
                configuration: {},
            },
        };

        try {
            await expect(initializeVoiceAgentHandle({
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
                setDeferredTargetSessionContext: vi.fn(),
            })).rejects.toMatchObject({ code: 'VOICE_AGENT_PROVIDER_SELECTION_MISMATCH' });
            expect(start).not.toHaveBeenCalled();
        } finally {
            state.settings.voice.providers.local_conversation.config.agent = originalAgent;
        }
    });
});
