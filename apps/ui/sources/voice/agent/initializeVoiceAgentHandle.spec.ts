import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAgentModelConfig } from '@happier-dev/agents';
import { installVoiceAgentCommonModuleMocks } from './voiceAgentTestHelpers';
import { storage } from '@/sync/domains/state/storage';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { ExecutionRunPublicStateSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import type { SessionExecutionRunGetResult, SessionExecutionRunListResult } from '@/sync/ops/sessionExecutionRuns';
import { V2SessionRecordSchema, type V2SessionByIdResponse } from '@happier-dev/protocol/sessions/control/contract';
import { SessionMetadataTuplePatchV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { readVoiceSessionOwnerMetadataFromState } from '@/voice/shared/readVoiceSessionOwnerMetadata';

const start = vi.fn(async (_params: any) => ({ voiceAgentId: 'voice-agent-1' }));
const ensureVoiceAgentInstallablesBackground = vi.fn(async (_args: unknown) => {});
const assertDaemonVoiceAgentRuntimeSupported = vi.fn(async () => {});
const resolveVoiceAgentInitialContexts = vi.fn((_sessionId: string, _options?: Readonly<{
    targetSessionId?: string | null;
    targetSessionAddress?: Readonly<{ serverId: string; sessionId: string }> | null;
}>) => ({
    bootstrapInitialContext: 'bootstrap-context',
    deferredTargetSessionContext: '',
}));
const sessionExecutionRunList = vi.fn(async (_sessionId: string, _params?: any): Promise<SessionExecutionRunListResult> => ({ runs: [] }));
const sessionExecutionRunGet = vi.fn(async (_sessionId: string, _params?: any): Promise<SessionExecutionRunGetResult> => ({
    ok: false as const,
    error: 'Execution run not found',
    errorCode: 'execution_run_not_found',
}));
const sessionExecutionRunStop = vi.fn(async (_sessionId: string, _params?: any) => ({ ok: true }));
let state: any = {
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
    sessionListRowsByServerId: {
        'server-a': {
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
    },
    ordinarySessionListMembershipByServerId: { 'server-a': ['s1'] },
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

installVoiceAgentCommonModuleMocks();

installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();

vi.mock('@/voice/agent/assertDaemonVoiceAgentRuntimeSupported', () => ({
    assertDaemonVoiceAgentRuntimeSupported: () => assertDaemonVoiceAgentRuntimeSupported(),
}));

vi.mock('@/voice/agent/ensureVoiceAgentInstallablesBackground', () => ({
    ensureVoiceAgentInstallablesBackground: (args: unknown) => ensureVoiceAgentInstallablesBackground(args),
}));

vi.mock('@/voice/agent/resolveVoiceAgentInitialContexts', () => ({
    resolveVoiceAgentInitialContexts: (sessionId: string, options?: Readonly<{
        targetSessionId?: string | null;
        targetSessionAddress?: Readonly<{ serverId: string; sessionId: string }> | null;
    }>) =>
        resolveVoiceAgentInitialContexts(sessionId, options),
}));

vi.mock('@/sync/ops/sessionExecutionRuns', () => ({
    sessionExecutionRunGet: (sessionId: string, params?: any) => sessionExecutionRunGet(sessionId, params),
    sessionExecutionRunList: (sessionId: string, params?: any) => sessionExecutionRunList(sessionId, params),
    sessionExecutionRunStop: (sessionId: string, params?: any) => sessionExecutionRunStop(sessionId, params),
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
    let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>>;
    let serveRetainedSession = false;
    beforeAll(loadSyncSingletonForTests, 60_000);
    afterEach(async () => {
        await connection?.dispose();
        vi.restoreAllMocks();
    });
    beforeEach(async () => {
        serveRetainedSession = false;
        const previousServerId = state.profileScope?.serverId ?? 'server-a';
        let wireSession: V2SessionByIdResponse['session'] | undefined;
        connection = await restoreServerAccountForTest({
            serverUrl: 'https://voice-initialize.example.test',
            // Session HTTP is a genuine boundary. Retained-run adoption writes
            // its pointer through the real metadata tuple owner, not a stub.
            request: async (url, init) => {
                const path = new URL(String(url)).pathname;
                const respond = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
                if (path.endsWith('/messages')) return respond({ messages: [], hasMore: false });
                if (path === '/v1/account/encryption/currentness') return respond({ mode: 'plain', version: 0,
                    signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0 });
                if (serveRetainedSession && path === '/v2/sessions/s1') {
                    wireSession ??= V2SessionRecordSchema.parse({ id: 's1', seq: 0, createdAt: 1, updatedAt: 1,
                        active: true, activeAt: Date.now(), encryptionMode: 'plain', dataEncryptionKey: null,
                        metadataLayoutVersion: 0, metadataVersion: 0,
                        metadata: JSON.stringify(readVoiceSessionOwnerMetadataFromState(storage.getState(),
                            { serverId: connection.home.id, sessionId: 's1' })),
                        agentState: null, agentStateVersion: 0 });
                    if (init?.method === 'PATCH') {
                        if (typeof init.body !== 'string') throw new Error('Expected Session tuple JSON');
                        const patch = SessionMetadataTuplePatchV1Schema.parse(JSON.parse(init.body));
                        if (patch.mode === 'owner_migration') {
                            expect(patch.source.metadata.version).toBe(wireSession.metadataVersion);
                            wireSession = { ...wireSession, metadataLayoutVersion: 1,
                                metadata: patch.target.sharedMetadata.ciphertext, ownerMetadata: patch.target.ownerMetadata,
                                agentState: patch.target.agentState.ciphertext,
                                metadataVersion: wireSession.metadataVersion + 1, agentStateVersion: (wireSession.agentStateVersion ?? 0) + 1 };
                        } else if (patch.mode === 'owner') {
                            expect(patch.sharedMetadata.expectedVersion).toBe(wireSession.metadataVersion);
                            wireSession = { ...wireSession, metadata: patch.sharedMetadata.ciphertext,
                                ownerMetadata: patch.ownerMetadata, agentState: patch.agentState.ciphertext,
                                metadataVersion: wireSession.metadataVersion + 1, agentStateVersion: (wireSession.agentStateVersion ?? 0) + 1 };
                        } else throw new Error('Expected owner Session tuple mutation');
                        return respond({ success: true, metadataLayoutVersion: 1,
                            sharedMetadata: { version: wireSession.metadataVersion }, agentState: { version: wireSession.agentStateVersion } });
                    }
                    return respond({ session: wireSession });
                }
                return new Response('{}', { status: 404 });
            },
        });
        const { home } = connection;
        storage.setState({
            ...state,
            profileScope: { serverId: home.id, accountId: 'account-a' },
            sessionListRowsByServerId: { [home.id]: state.sessionListRowsByServerId[previousServerId] },
            ordinarySessionListMembershipByServerId: { [home.id]: ['s1'] },
            sessionListIndexByServerId: { [home.id]: [{ type: 'session', sessionId: 's1', serverId: home.id, serverName: 'Voice' }] },
        });
        state = storage.getState();
        state.sessions.s1.active = true;
        state.sessions.s1.presence = 'online';
        state.sessions.s1.encryptionMode = 'plain';
        start.mockClear();
        ensureVoiceAgentInstallablesBackground.mockClear();
        assertDaemonVoiceAgentRuntimeSupported.mockClear();
        resolveVoiceAgentInitialContexts.mockClear();
        sessionExecutionRunList.mockClear();
        sessionExecutionRunGet.mockClear();
        sessionExecutionRunStop.mockClear();
        state.sessions.s1.metadataLayoutVersion = 0;
        delete state.sessions.s1.ownerMetadataView;
        state.sessions.s1.metadata = {
            flavor: 'claude',
            profileId: 'raw-profile',
            agentRuntimeCapabilitiesV1: {
                localControl: { supported: true },
            },
        };
        state.sessionListRowsByServerId[home.id].s1.metadataLayoutVersion = 0;
        state.sessionListRowsByServerId[home.id].s1.active = true;
        state.sessionListRowsByServerId[home.id].s1.presence = 'online';
        delete state.sessionListRowsByServerId[home.id].s1.ownerMetadataView;
        state.sessionListRowsByServerId[home.id].s1.metadata = {
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
                chatModelId: getAgentModelConfig('codex')?.defaultMode,
                commitModelId: getAgentModelConfig('codex')?.defaultMode,
            }),
        );
    });

    it('admits the exact Session default greeting into the run policy before the daemon starts', async () => {
        const previousSettings = state.settings;
        state.settings = {
            ...previousSettings,
            voice: { ...previousSettings.voice, assistantLanguage: 'en',
                welcome: { enabled: true, mode: 'immediate', templateId: null } },
        };
        storage.setState({ settings: state.settings });
        const { readSessionDisplayTitle } = await import('@/utils/sessions/sessionDisplayTitle');
        const targetName = readSessionDisplayTitle({ serverId: connection.home.id, sessionId: 's1' });
        expect(targetName).toBeTruthy();
        try {
            const { initializeVoiceAgentHandle } = await import('./initializeVoiceAgentHandle');
            const handle = await initializeVoiceAgentHandle({
                sessionId: 's1',
                getDaemonVoiceAgentClient: () => ({
                    start, sendTurn: vi.fn(), welcome: vi.fn(), startTurnStream: vi.fn(),
                    readTurnStream: vi.fn(), cancelTurnStream: vi.fn(), commit: vi.fn(), stop: vi.fn(),
                }),
                setDeferredTargetSessionContext: vi.fn(),
            });
            expect(handle.voicePolicy?.welcome?.text).toContain(targetName);
            expect(start.mock.calls[0]?.[0].voicePolicy?.welcome?.text).toContain(targetName);
        } finally {
            storage.setState({ settings: previousSettings });
            state = storage.getState();
        }
    });

    it('retires a started run when its admitted target binding changes during the daemon await', async () => {
        const { voiceSessionBindingStore } = await import('@/voice/binding/voiceConversationBindingStore');
        voiceSessionBindingStore.getState().bind({ adapterId: 'local_conversation', controlSessionId: 's1',
            conversationSessionId: 's1', conversationSessionAddress: { serverId: connection.home.id, sessionId: 's1' },
            lifetime: 'runtime_attempt', transcriptMode: 'synthetic',
            targetSessionAddress: { serverId: connection.home.id, sessionId: 's1' }, updatedAt: 1 });
        const stop = vi.fn(async () => {});
        start.mockImplementationOnce(async () => {
            voiceSessionBindingStore.getState().unbind('s1');
            return { voiceAgentId: 'voice-agent-1' };
        });
        try {
            const { initializeVoiceAgentHandle } = await import('./initializeVoiceAgentHandle');
            await expect(initializeVoiceAgentHandle({ sessionId: 's1',
                getDaemonVoiceAgentClient: () => ({ start, sendTurn: vi.fn(), welcome: vi.fn(), startTurnStream: vi.fn(),
                    readTurnStream: vi.fn(), cancelTurnStream: vi.fn(), commit: vi.fn(), stop }),
                setDeferredTargetSessionContext: vi.fn() })).rejects.toThrow('voice_agent_binding_changed');
            expect(stop).toHaveBeenCalledWith({ sessionId: 's1', voiceAgentId: 'voice-agent-1' });
        } finally {
            voiceSessionBindingStore.getState().unbind('s1');
            start.mockReset().mockResolvedValue({ voiceAgentId: 'voice-agent-1' });
        }
    });

    it('reconnects with retained greeting bytes without re-reading an unavailable current selection', async () => {
        serveRetainedSession = true;
        const previousSettings = state.settings;
        storage.setState({ settings: { ...previousSettings,
            voice: { ...previousSettings.voice, assistantLanguage: 'en',
                welcome: { enabled: true, mode: 'immediate', templateId: 'deleted-after-admission' } },
        } });
        const voicePolicy = { assistantLanguage: 'fr', welcome: { enabled: true, mode: 'on_first_turn', text: '  Retained.\n ' } };
        const retainedAdmission = ExecutionRunPublicStateSchema.safeParse({ runId: 'voice-agent-1', callId: 'call', sidechainId: 'sidechain',
            intent: 'voice_agent', backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, permissionMode: 'read-only',
            retentionPolicy: 'ephemeral', runClass: 'long_lived', ioMode: 'streaming', status: 'running', startedAtMs: 1,
            voicePolicy });
        // The daemon's canonical retained wire reader must admit the selected literal before a reconnect can consume it.
        expect(retainedAdmission.success).toBe(true);
        if (!retainedAdmission.success) throw retainedAdmission.error;
        const run = retainedAdmission.data;
        sessionExecutionRunList.mockResolvedValueOnce({ runs: [run] });
        sessionExecutionRunGet.mockResolvedValueOnce({ run }).mockResolvedValueOnce({ run });
        try {
            const { initializeVoiceAgentHandle } = await import('./initializeVoiceAgentHandle');
            const handle = await initializeVoiceAgentHandle({ sessionId: 's1',
                getDaemonVoiceAgentClient: () => ({ start, sendTurn: vi.fn(), welcome: vi.fn(), startTurnStream: vi.fn(),
                    readTurnStream: vi.fn(), cancelTurnStream: vi.fn(), commit: vi.fn(), stop: vi.fn() }),
                setDeferredTargetSessionContext: vi.fn() });
            expect(handle.voicePolicy).toEqual(voicePolicy);
            expect(start.mock.calls[0]?.[0].voicePolicy).toEqual(voicePolicy);
        } finally {
            sessionExecutionRunList.mockReset().mockResolvedValue({ runs: [] });
            sessionExecutionRunGet.mockReset().mockResolvedValue({ ok: false, error: 'Execution run not found', errorCode: 'execution_run_not_found' });
            storage.setState({ settings: previousSettings });
            state = storage.getState();
        }
    });

    it.each([true, false])('keeps hidden history separate from the bound/global persona (bound=%s)', async bound => {
        const { voiceSessionBindingStore } = await import('@/voice/binding/voiceConversationBindingStore');
        const { VOICE_AGENT_GLOBAL_SESSION_ID } = await import('@/voice/agent/voiceAgentGlobalSessionId');
        const previousSettings = state.settings;
        const history = 'hidden-welcome-history';
        const targetAddress = { serverId: connection.home.id, sessionId: 's1' };
        storage.setState({ sessions: { ...storage.getState().sessions,
            [history]: { ...state.sessions.s1, id: history, serverId: connection.home.id,
                metadata: { ...state.sessions.s1.metadata, profileId: 'history-is-not-a-persona' } },
        }, settings: { ...previousSettings, voice: { ...previousSettings.voice, assistantLanguage: 'en',
            welcome: { enabled: true, mode: 'immediate', templateId: null } } } });
        voiceSessionBindingStore.getState().bind({ adapterId: 'local_conversation', controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
            conversationSessionId: history, conversationSessionAddress: { serverId: connection.home.id, sessionId: history },
            lifetime: 'runtime_attempt', transcriptMode: 'synthetic', targetSessionAddress: bound ? targetAddress : null, updatedAt: 1 });
        try {
            const { initializeVoiceAgentHandle } = await import('./initializeVoiceAgentHandle');
            await initializeVoiceAgentHandle({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
                getDaemonVoiceAgentClient: () => ({ start, sendTurn: vi.fn(), welcome: vi.fn(), startTurnStream: vi.fn(),
                    readTurnStream: vi.fn(), cancelTurnStream: vi.fn(), commit: vi.fn(), stop: vi.fn() }),
                setDeferredTargetSessionContext: vi.fn() });
            expect(start.mock.calls[0]?.[0].sessionId).toBe(history);
            expect(start.mock.calls[0]?.[0].profileId).toBe(bound ? 'cached-profile' : null);
            const { resolveVoiceWelcomeText } = await import('./voiceWelcomeText');
            if (!bound) expect(start.mock.calls[0]?.[0].voicePolicy?.welcome?.text).toBe(resolveVoiceWelcomeText('en'));
        } finally {
            voiceSessionBindingStore.getState().unbind(history);
            const sessions = { ...storage.getState().sessions };
            delete sessions[history];
            storage.setState({ sessions, settings: previousSettings });
            state = storage.getState();
        }
    });

    it('uses hydrated layout-1 owner facts with the current list-selected session model', async () => {
        const { initializeVoiceAgentHandle } = await import('./initializeVoiceAgentHandle');
        state = storage.getState();
        const previousSettings = state.settings;
        const previousSession = state.sessions.s1;
        const rows = state.sessionListRowsByServerId[state.profileScope.serverId];
        const previousRow = rows.s1;
        try {
            state.settings = {
                ...previousSettings,
                voice: {
                    ...previousSettings.voice,
                    providers: {
                        ...previousSettings.voice.providers,
                        local_conversation: { schemaVersion: 1, config: {
                            ...previousSettings.voice.providers.local_conversation.config,
                            agent: {
                                ...previousSettings.voice.providers.local_conversation.config.agent,
                                agentSource: 'agent', agentId: 'claude',
                                chatModelSource: 'session', commitModelSource: 'session',
                            },
                        } },
                    },
                },
            };
            state.sessions.s1 = {
                ...previousSession, metadataLayoutVersion: 1, modelMode: 'stale-session-model',
                metadata: { summaryText: 'Shared presentation' },
                ownerMetadataView: previousSession.metadata,
            };
            rows.s1 = {
                ...previousRow, metadataLayoutVersion: 1, modelMode: 'current-session-model',
                metadata: { summaryText: 'Current shared presentation' }, ownerMetadataView: null,
            };
            // Publish fixture replacement through the real store: Sync may have
            // replaced its root while the asynchronous module import settled.
            storage.setState({
                settings: state.settings,
                sessions: state.sessions,
                sessionListRowsByServerId: state.sessionListRowsByServerId,
            });
            await initializeVoiceAgentHandle({
                sessionId: 's1',
                getDaemonVoiceAgentClient: () => ({
                    start, sendTurn: vi.fn(), welcome: vi.fn(), startTurnStream: vi.fn(),
                    readTurnStream: vi.fn(), cancelTurnStream: vi.fn(), commit: vi.fn(), stop: vi.fn(),
                }),
                setDeferredTargetSessionContext: vi.fn(),
            });
            expect(start).toHaveBeenCalledWith(expect.objectContaining({
                agentId: 'claude', profileId: 'raw-profile',
            }));
            expect(start.mock.calls.at(-1)?.[0].chatModelId).toBeUndefined();
            expect(start.mock.calls.at(-1)?.[0].commitModelId).toBeUndefined();
        } finally {
            state.settings = previousSettings;
            state.sessions.s1 = previousSession;
            rows.s1 = previousRow;
            storage.setState({
                settings: previousSettings,
                sessions: state.sessions,
                sessionListRowsByServerId: state.sessionListRowsByServerId,
            });
            state = storage.getState();
        }
    });

    it.each<[string, () => void]>([
        ['visible session metadata', () => {
            state.sessions.s1.metadataLayoutVersion = 1;
            state.sessions.s1.ownerMetadataView = null;
            state.sessionListRowsByServerId[state.profileScope.serverId].s1.metadataLayoutVersion = 1;
            state.sessionListRowsByServerId[state.profileScope.serverId].s1.ownerMetadataView = null;
        }],
        ['cached session metadata', () => {
            state.sessions.s1.metadata = null;
            state.sessionListRowsByServerId[state.profileScope.serverId].s1.metadataLayoutVersion = 1;
            state.sessionListRowsByServerId[state.profileScope.serverId].s1.ownerMetadataView = null;
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
            }));
            expect(start.mock.calls[0]?.[0]).not.toHaveProperty('sessionConfigOptionOverrides');
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
        ['different', 'agent:happier.agent.codex/codex'],
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
