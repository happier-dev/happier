import { beforeEach, describe, expect, it, vi } from 'vitest';

import { installVoiceAgentCommonModuleMocks } from '@/voice/agent/voiceAgentTestHelpers';

import {
    readVoiceAgentActionEffectId,
    type VoiceAgentClient,
    type VoiceAgentHandle,
    type VoiceAgentTurnStreamEvent,
} from '@/voice/agent/types';

const patchSessionMetadataWithRetry = vi.hoisted(() => vi.fn(async (sessionId: string, updater: (metadata: any) => any) => {
    const session = stateRef.current.sessions[sessionId];
    if (!session) return;
    session.metadata = updater(session.metadata ?? {});
}));

const stateRef = vi.hoisted(() => ({
    current: {} as any,
}));

const storageListeners = new Set<() => void>();

installVoiceAgentCommonModuleMocks({
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            storage: {
                getState: () => stateRef.current,
                subscribe: (listener: () => void) => {
                    storageListeners.add(listener);
                    return () => storageListeners.delete(listener);
                },
            } as any,
        });
    },
});

vi.mock('@/sync/sync', () => ({
    sync: {
        patchSessionMetadataWithRetry: (sessionId: string, updater: (metadata: any) => any) =>
            patchSessionMetadataWithRetry(sessionId, updater),
    },
}));

function createState(): any {
    return {
        settings: {
            voice: {
                providerId: 'local_conversation',
                providers: {
                    local_conversation: { schemaVersion: 1, config: {
                        streaming: {
                            enabled: true,
                            turnReadPollIntervalMs: 50,
                            turnReadMaxEvents: 7,
                            turnStreamTimeoutMs: 1200,
                        },
                        agent: {
                            backend: 'daemon',
                            resumabilityMode: 'provider_resume',
                            transcript: {
                                persistenceMode: 'persistent',
                                epoch: 0,
                            },
                        },
                        networkTimeoutMs: 15_000,
                    } },
                },
            },
        },
        sessions: {
            sys_voice: {
                id: 'sys_voice',
                updatedAt: 10,
                metadata: {
                    systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
                    agentRuntimeFacetsV1: {
                        v: 1,
                        transcriptSource: {
                            supported: true,
                            followLeaseSupported: true,
                        },
                    },
                    voiceConversationBindingV1: {
                        v: 1,
                        adapterId: 'local_conversation',
                        controlSessionId: '__voice_agent__',
                        transcriptMode: 'native_session',
                        targetSessionId: 's1',
                        updatedAt: 111,
                    },
                    voiceAgentRunV1: {
                        v: 1,
                        runId: 'run_1',
                        backendId: 'claude',
                        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
                        resumeHandle: null,
                        streamId: null,
                        transcriptContractVersion: 2,
                        updatedAtMs: 222,
                    },
                },
            },
            stale_rpc: {
                id: 'stale_rpc',
                updatedAt: 5,
                metadata: {
                    systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
                },
            },
            s1: {
                id: 's1',
                updatedAt: 1,
                metadata: { flavor: 'claude' },
            },
        },
        sessionMessages: {},
        sessionListRenderables: {},
        sessionListIndexByServerId: {},
        concurrentSessionListCacheByServerId: {},
    };
}

function createHandle(client: VoiceAgentClient): VoiceAgentHandle {
    return {
        client,
        voiceAgentId: 'run_1',
        backend: 'daemon',
        rpcSessionId: 'stale_rpc',
        agentBackendId: 'claude',
    };
}

describe('createVoiceTurnStreaming', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        stateRef.current = createState();
        storageListeners.clear();
    });

    it('passes resume=true when the resolved metadata session exposes transcriptSource even if the rpc session is stale', async () => {
        const startTurnStream = vi.fn(async () => ({ streamId: 'stream_1' }));
        const events: VoiceAgentTurnStreamEvent[] = [{ t: 'done', assistantText: 'assistant reply', actions: [] }];
        const readTurnStreamResponse: Awaited<ReturnType<VoiceAgentClient['readTurnStream']>> = {
            streamId: 'stream_1',
            events,
            nextCursor: 1,
            done: true,
        };
        const client: VoiceAgentClient = {
            start: vi.fn(async () => ({ voiceAgentId: 'run_1' })),
            sendTurn: vi.fn(async () => ({ assistantText: 'unused', actions: [] })),
            welcome: vi.fn(async () => ({ assistantText: 'unused' })),
            startTurnStream,
            readTurnStream: vi.fn(async (_params: Parameters<VoiceAgentClient['readTurnStream']>[0]) => readTurnStreamResponse),
            cancelTurnStream: vi.fn(async (_params: Parameters<VoiceAgentClient['cancelTurnStream']>[0]) => ({ ok: true as const })),
            commit: vi.fn(async () => ({ commitText: 'unused' })),
            stop: vi.fn(async (_params: Parameters<VoiceAgentClient['stop']>[0]) => ({ ok: true as const })),
        };

        const { createVoiceTurnStreaming } = await import('./voiceTurnStreaming');
        const turnStreaming = createVoiceTurnStreaming({
            getVoiceAgentHandle: async () => createHandle(client),
            interruptActiveTurn: () => undefined,
            resetCachedHandle: () => undefined,
            runSerializedTurn: async (_sessionId, task) => await task(),
            stop: async () => undefined,
            voiceAgentPendingContextBySessionId: new Map(),
            voiceAgentTurnAbortControllerBySessionId: new Map(),
        });

        await turnStreaming.sendTurn('__voice_agent__', 'hello');

        expect(startTurnStream).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'stale_rpc',
            resume: true,
        }));
    });

    it('preserves process-local effect identity while normalizing the streamed turn response', async () => {
        const events: VoiceAgentTurnStreamEvent[] = [
            {
                t: 'voice_output',
                output: {
                    v: 1,
                    kind: 'side_effect',
                    turnId: 'stream_effect',
                    seq: 0,
                    effectId: 'effect-normalized',
                    action: { t: 'sendSessionMessage', args: { message: 'Do it' } },
                },
            },
            {
                t: 'voice_output',
                output: {
                    v: 1,
                    kind: 'turn_final',
                    turnId: 'stream_effect',
                    seq: 1,
                    text: 'Working on it.',
                },
            },
        ];
        const client: VoiceAgentClient = {
            start: vi.fn(async () => ({ voiceAgentId: 'run_1' })),
            sendTurn: vi.fn(async () => ({ assistantText: 'unused', actions: [] })),
            welcome: vi.fn(async () => ({ assistantText: 'unused' })),
            startTurnStream: vi.fn(async () => ({ streamId: 'stream_effect' })),
            readTurnStream: vi.fn(async () => ({
                streamId: 'stream_effect', events, nextCursor: 2, done: true,
            })),
            cancelTurnStream: vi.fn(async () => ({ ok: true as const })),
            commit: vi.fn(async () => ({ commitText: 'unused' })),
            stop: vi.fn(async () => ({ ok: true as const })),
        };

        const { createVoiceTurnStreaming } = await import('./voiceTurnStreaming');
        const turnStreaming = createVoiceTurnStreaming({
            getVoiceAgentHandle: async () => createHandle(client),
            interruptActiveTurn: () => undefined,
            resetCachedHandle: () => undefined,
            runSerializedTurn: async (_sessionId, task) => await task(),
            stop: async () => undefined,
            voiceAgentPendingContextBySessionId: new Map(),
            voiceAgentTurnAbortControllerBySessionId: new Map(),
        });

        const result = await turnStreaming.sendTurn('__voice_agent__', 'hello');

        expect(result.actions).toEqual([{ t: 'sendSessionMessage', args: { message: 'Do it' } }]);
        expect(readVoiceAgentActionEffectId(result.actions[0])).toBe('effect-normalized');
    });

    it('uses the non-eager client turn when speech streaming is disabled', async () => {
        stateRef.current.settings.voice.providers.local_conversation.config.streaming.enabled = false;
        const sendTurn = vi.fn(async () => ({
            assistantText: 'legacy reply',
            actions: [{ t: 'sendSessionMessage' as const, args: { message: 'Legacy action' } }],
        }));
        const startTurnStream = vi.fn(async () => ({ streamId: 'stream_1' }));
        const client: VoiceAgentClient = {
            start: vi.fn(async () => ({ voiceAgentId: 'run_1' })),
            sendTurn,
            welcome: vi.fn(async () => ({ assistantText: 'unused' })),
            startTurnStream,
            readTurnStream: vi.fn(async () => ({ streamId: 'stream_1', events: [], nextCursor: 0, done: true })),
            cancelTurnStream: vi.fn(async () => ({ ok: true as const })),
            commit: vi.fn(async () => ({ commitText: 'unused' })),
            stop: vi.fn(async () => ({ ok: true as const })),
        };

        const { createVoiceTurnStreaming } = await import('./voiceTurnStreaming');
        const turnStreaming = createVoiceTurnStreaming({
            getVoiceAgentHandle: async () => createHandle(client),
            interruptActiveTurn: () => undefined,
            resetCachedHandle: () => undefined,
            runSerializedTurn: async (_sessionId, task) => await task(),
            stop: async () => undefined,
            voiceAgentPendingContextBySessionId: new Map(),
            voiceAgentTurnAbortControllerBySessionId: new Map(),
        });

        const result = await turnStreaming.sendTurn('__voice_agent__', 'hello');
        expect(result).toEqual({
            assistantText: 'legacy reply',
            actions: [{ t: 'sendSessionMessage', args: { message: 'Legacy action' } }],
        });
        expect(readVoiceAgentActionEffectId(result.actions[0])).toBeNull();
        expect(sendTurn).toHaveBeenCalledTimes(1);
        expect(startTurnStream).not.toHaveBeenCalled();
    });
});
