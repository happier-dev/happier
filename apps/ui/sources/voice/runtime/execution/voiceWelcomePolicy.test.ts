import { beforeEach, describe, expect, it, vi } from 'vitest';

import { installVoiceAgentCommonModuleMocks } from '@/voice/agent/voiceAgentTestHelpers';

import type { VoiceAgentClient, VoiceAgentHandle } from '@/voice/agent/types';

const stateRef = vi.hoisted(() => ({
    current: {} as any,
}));

const shouldFailPersistRef = vi.hoisted(() => ({
    current: false,
}));

installVoiceAgentCommonModuleMocks({
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            storage: {
                getState: () => stateRef.current,
            } as any,
        });
    },
});

vi.mock('@/voice/agent/voiceAgentRunState', () => ({
    persistVoiceAgentWelcomedEpoch: async (metadataSessionId: string | null, welcomedEpoch: number) => {
        if (!metadataSessionId) return;
        if (shouldFailPersistRef.current) {
            throw new Error('persist_failed');
        }
        const session = stateRef.current.sessions[metadataSessionId];
        if (!session) return;
        session.metadata = {
            ...(session.metadata ?? {}),
            voiceAgentRunV1: {
                ...(session.metadata?.voiceAgentRunV1 ?? {}),
                welcomedEpoch,
            },
        };
    },
    resolveVoiceRunMetadataSessionId: (_managedSessionId: string, _backend: 'daemon', conversationSessionId?: string | null) =>
        conversationSessionId ?? 'sys_voice',
}));

vi.mock('@/voice/persistence/voiceAgentRunMetadata', () => ({
    readVoiceAgentRunMetadataFromSession: ({ sessionId }: { sessionId: string }) =>
        stateRef.current.sessions[sessionId]?.metadata?.voiceAgentRunV1 ?? null,
}));

vi.mock('@/voice/binding/voiceConversationBindingPersistence', () => ({
    readPersistedVoiceConversationRuntimeState: ({ managedSessionId }: { managedSessionId: string }) => {
        if (managedSessionId !== '__voice_agent__') return null;
        return {
            metadataSessionId: 'sys_voice',
        };
    },
}));

function createState(): any {
    return {
        settings: {
            voice: {
                providerId: 'local_conversation',
                welcome: {
                    enabled: true,
                    mode: 'immediate',
                    templateId: null,
                },
                providers: {
                    local_conversation: { schemaVersion: 1, config: {
                        agent: {
                            backend: 'daemon',
                            transcript: {
                                persistenceMode: 'persistent',
                                epoch: 1,
                            },
                        },
                    } },
                },
            },
        },
        sessions: {
            sys_voice: {
                id: 'sys_voice',
                metadata: {
                    voiceAgentRunV1: {
                        v: 1,
                        runId: 'run_1',
                        backendId: 'claude',
                        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
                        resumeHandle: null,
                        transcriptContractVersion: 2,
                        updatedAtMs: 1,
                    },
                },
            },
        },
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
        rpcSessionId: 'sys_voice',
        agentBackendId: 'claude',
    };
}

describe('createVoiceWelcomePolicy', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        shouldFailPersistRef.current = false;
        stateRef.current = createState();
    });

    it('retries immediate welcome when welcomedEpoch was not persisted', async () => {
        shouldFailPersistRef.current = true;

        const welcome = vi.fn(async () => ({ assistantText: 'Welcome!' }));
        const client: VoiceAgentClient = {
            start: vi.fn(async () => ({ voiceAgentId: 'run_1' })),
            sendTurn: vi.fn(async () => ({ assistantText: '', actions: [] })),
            welcome,
            startTurnStream: vi.fn(),
            readTurnStream: vi.fn(),
            cancelTurnStream: vi.fn(),
            commit: vi.fn(async () => ({ commitText: '' })),
            stop: vi.fn(async () => ({ ok: true as const })),
        };

        const { createVoiceWelcomePolicy } = await import('./voiceWelcomePolicy');
        const welcomePolicy = createVoiceWelcomePolicy({
            getVoiceAgentHandle: async () => createHandle(client),
            resetCachedHandle: () => undefined,
        });

        await expect(welcomePolicy.ensureRunningAndMaybeWelcome('__voice_agent__')).resolves.toBe('Welcome!');
        await expect(welcomePolicy.ensureRunningAndMaybeWelcome('__voice_agent__')).resolves.toBe('Welcome!');

        expect(welcome).toHaveBeenCalledTimes(2);
        expect(stateRef.current.sessions.sys_voice.metadata.voiceAgentRunV1.welcomedEpoch).toBeUndefined();
    });

    it('suppresses duplicate welcome once welcomedEpoch is persisted', async () => {
        const welcome = vi.fn(async () => ({ assistantText: 'Welcome!' }));
        const client: VoiceAgentClient = {
            start: vi.fn(async () => ({ voiceAgentId: 'run_1' })),
            sendTurn: vi.fn(async () => ({ assistantText: '', actions: [] })),
            welcome,
            startTurnStream: vi.fn(),
            readTurnStream: vi.fn(),
            cancelTurnStream: vi.fn(),
            commit: vi.fn(async () => ({ commitText: '' })),
            stop: vi.fn(async () => ({ ok: true as const })),
        };

        const { createVoiceWelcomePolicy } = await import('./voiceWelcomePolicy');
        const welcomePolicy = createVoiceWelcomePolicy({
            getVoiceAgentHandle: async () => createHandle(client),
            resetCachedHandle: () => undefined,
        });

        await expect(welcomePolicy.ensureRunningAndMaybeWelcome('__voice_agent__')).resolves.toBe('Welcome!');
        await expect(welcomePolicy.ensureRunningAndMaybeWelcome('__voice_agent__')).resolves.toBeNull();

        expect(welcome).toHaveBeenCalledTimes(1);
        expect(stateRef.current.sessions.sys_voice.metadata.voiceAgentRunV1).toMatchObject({
            welcomedEpoch: 1,
        });
    });
});
