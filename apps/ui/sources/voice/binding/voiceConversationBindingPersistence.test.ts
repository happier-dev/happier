import { beforeEach, describe, expect, it, vi } from 'vitest';

const stateRef = {
    current: {
        sessions: {
            sys_voice: {
                id: 'sys_voice',
                updatedAt: 10,
                metadata: {
                    systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
                    agentRuntimeDescriptorV1: {
                        v: 1,
                        providerId: 'claude',
                        provider: {
                            backendMode: 'native',
                        },
                    },
                    agentRuntimeCapabilitiesV1: {
                        executionRun: {
                            supported: true,
                        },
                    },
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
                        streamId: 'stream_1',
                        transcriptContractVersion: 2,
                        updatedAtMs: 222,
                    },
                },
            },
            s1: {
                id: 's1',
                updatedAt: 5,
                metadata: {
                    flavor: 'claude',
                },
            },
        },
        sessionListRenderables: {},
        sessionListIndexByServerId: {},
        concurrentSessionListCacheByServerId: {},
    } as any,
};

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        storage: {
            getState: () => stateRef.current,
        } as any,
    });
});

describe('voiceConversationBindingPersistence', () => {
    beforeEach(() => {
        vi.resetModules();
        stateRef.current = {
            sessions: {
                sys_voice: {
                    id: 'sys_voice',
                    updatedAt: 10,
                    metadata: {
                        systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
                        agentRuntimeDescriptorV1: {
                            v: 1,
                            providerId: 'claude',
                            provider: {
                                backendMode: 'native',
                            },
                        },
                        agentRuntimeCapabilitiesV1: {
                            executionRun: {
                                supported: true,
                            },
                        },
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
                            streamId: 'stream_1',
                            transcriptContractVersion: 2,
                            updatedAtMs: 222,
                        },
                    },
                },
                s1: {
                    id: 's1',
                    updatedAt: 5,
                    metadata: { flavor: 'claude' },
                },
            },
            sessionListRenderables: {},
            sessionListIndexByServerId: {},
            concurrentSessionListCacheByServerId: {},
        } as any;
    });

    it('falls back to the session-scoped metadata session for non-global managed runs', async () => {
        stateRef.current.sessions.s1.metadata.voiceAgentRunV1 = {
            v: 1,
            runId: 'run_session',
            backendId: 'claude',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            resumeHandle: null,
            streamId: null,
            transcriptContractVersion: 2,
            updatedAtMs: 333,
        };

        const { readPersistedVoiceConversationRuntimeState } = await import('./voiceConversationBindingPersistence');

        expect(
            readPersistedVoiceConversationRuntimeState({
                managedSessionId: 's1',
            }),
        ).toMatchObject({
            metadataSessionId: 's1',
            runMetadata: expect.objectContaining({
                runId: 'run_session',
                transcriptContractVersion: 2,
            }),
            runtimePublication: {
                descriptor: null,
                capabilities: null,
                facets: null,
            },
        });
    });

    it('reads generic runtime publication state without going through the daemon handoff DTO', async () => {
        const { readPersistedVoiceConversationRuntimePublication } = await import('./voiceConversationBindingPersistence');

        expect(
            readPersistedVoiceConversationRuntimePublication({
                managedSessionId: '__voice_agent__',
            }),
        ).toEqual({
            descriptor: expect.objectContaining({ providerId: 'claude' }),
            capabilities: expect.objectContaining({
                executionRun: expect.objectContaining({ supported: true }),
            }),
            facets: expect.objectContaining({
                transcriptSource: expect.objectContaining({
                    supported: true,
                    followLeaseSupported: true,
                }),
            }),
        });
    });

    it('reads canonical persisted runtime state without going through the daemon handoff DTO', async () => {
        const { readPersistedVoiceConversationRuntimeState } = await import('./voiceConversationBindingPersistence');

        expect(
            readPersistedVoiceConversationRuntimeState({
                managedSessionId: '__voice_agent__',
            }),
        ).toMatchObject({
            metadataSessionId: 'sys_voice',
            runMetadata: expect.objectContaining({
                runId: 'run_1',
                backendId: 'claude',
                transcriptContractVersion: 2,
            }),
            runtimePublication: {
                descriptor: expect.objectContaining({ providerId: 'claude' }),
                capabilities: expect.objectContaining({
                    executionRun: expect.objectContaining({
                        supported: true,
                    }),
                }),
                facets: expect.objectContaining({
                    transcriptSource: expect.objectContaining({
                        supported: true,
                        followLeaseSupported: true,
                    }),
                }),
            },
        });
    });
});
