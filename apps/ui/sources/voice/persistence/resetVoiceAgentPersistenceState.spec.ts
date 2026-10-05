import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';

const patchSessionMetadataWithRetry = vi.fn();
const applySettings = vi.fn();
const stateRef = {
    current: {
        settings: {
            voice: {
                providers: {
                    local_conversation: { schemaVersion: 1, config: {
                        agent: {
                            transcript: {
                                persistenceMode: 'ephemeral',
                                epoch: 1,
                            },
                        },
                    } },
                },
            },
        },
        settingsScope: { serverId: 'server-a', accountId: 'account-a' },
        sessions: {} as Record<string, any>,
        sessionListRowsByServerId: {},
        ordinarySessionListMembershipByServerId: {},
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

vi.mock('@/sync/sync', () => ({
    sync: {
        patchSessionMetadataWithRetry: (sessionId: string, updater: (metadata: any) => any) =>
            patchSessionMetadataWithRetry(sessionId, updater),
    },
}));

vi.mock('@/sync/runtime/getSyncSingleton', () => ({
    getSyncSingleton: () => ({ applySettings }),
}));

function createVoiceConversationSession(params: Readonly<{
    id: string;
    updatedAt: number;
    controlSessionId?: string;
    runId: string;
}>): any {
    const metadata: Record<string, unknown> = {
        systemSessionV1: {
            v: 1,
            key: 'voice_conversation',
            hidden: true,
        },
        voiceAgentRunV1: {
            v: 1,
            runId: params.runId,
            backendId: 'claude',
            resumeHandle: null,
            updatedAtMs: params.updatedAt,
        },
    };
    if (params.controlSessionId) {
        metadata.voiceConversationBindingV1 = {
            v: 1,
            adapterId: 'local_conversation',
            controlSessionId: params.controlSessionId,
            transcriptMode: 'native_session',
            targetSessionId: null,
            updatedAt: params.updatedAt,
        };
    }

    return {
        id: params.id,
        serverId: getActiveServerSnapshot().serverId,
        updatedAt: params.updatedAt,
        metadata,
    };
}

describe('resetVoiceAgentPersistenceState', () => {
    beforeEach(() => {
        vi.resetModules();
        patchSessionMetadataWithRetry.mockReset();
        applySettings.mockReset();
        stateRef.current = {
            settings: {
                voice: {
                    providers: {
                        local_conversation: { schemaVersion: 1, config: {
                            agent: {
                                transcript: {
                                    persistenceMode: 'ephemeral',
                                    epoch: 1,
                                },
                            },
                        } },
                    },
                },
            },
            settingsScope: { serverId: 'server-a', accountId: 'account-a' },
            sessions: {
                sys_bound: createVoiceConversationSession({
                    id: 'sys_bound',
                    updatedAt: 10,
                    controlSessionId: '__voice_agent__',
                    runId: 'run_bound',
                }),
                sys_newer: createVoiceConversationSession({
                    id: 'sys_newer',
                    updatedAt: 20,
                    runId: 'run_newer',
                }),
            },
            sessionListRowsByServerId: {},
            ordinarySessionListMembershipByServerId: {},
            sessionListIndexByServerId: {},
            concurrentSessionListCacheByServerId: {},
        };
        patchSessionMetadataWithRetry.mockImplementation(async (sessionId: string, updater: (metadata: any) => any) => {
            const current = stateRef.current;
            const nextMetadata = updater(current.sessions[sessionId]?.metadata ?? {});
            stateRef.current = {
                ...current,
                sessions: {
                    ...current.sessions,
                    [sessionId]: {
                        ...current.sessions[sessionId],
                        metadata: nextMetadata,
                    },
                },
            };
        });
    });

    it('clears run metadata from the canonically bound global voice conversation when newer hidden sessions exist', async () => {
        const stop = vi.fn(async () => {});
        const { resetVoiceAgentPersistenceState } = await import('./resetVoiceAgentPersistenceState');

        await resetVoiceAgentPersistenceState({ stop });

        expect(stop).toHaveBeenCalledTimes(1);
        expect(patchSessionMetadataWithRetry).toHaveBeenCalledWith('sys_bound', expect.any(Function));
        expect(stateRef.current.sessions.sys_bound.metadata).not.toHaveProperty('voiceAgentRunV1');
        expect(stateRef.current.sessions.sys_newer.metadata.voiceAgentRunV1).toMatchObject({
            runId: 'run_newer',
        });
    });

    it('falls back to the newest hidden voice conversation when no canonical binding exists', async () => {
        stateRef.current.sessions.sys_bound = createVoiceConversationSession({
            id: 'sys_bound',
            updatedAt: 10,
            runId: 'run_bound',
        });

        const stop = vi.fn(async () => {});
        const { resetVoiceAgentPersistenceState } = await import('./resetVoiceAgentPersistenceState');

        await resetVoiceAgentPersistenceState({ stop });

        expect(patchSessionMetadataWithRetry).toHaveBeenCalledWith('sys_newer', expect.any(Function));
        expect(stateRef.current.sessions.sys_newer.metadata).not.toHaveProperty('voiceAgentRunV1');
        expect(stateRef.current.sessions.sys_bound.metadata.voiceAgentRunV1).toMatchObject({
            runId: 'run_bound',
        });
    });

    it('keeps transcript invalidation bound to the Account scope captured before stopping', async () => {
        stateRef.current.settings.voice.providers.local_conversation.config.agent.transcript.persistenceMode = 'persistent';
        const stop = vi.fn(async () => {
            // Publish the next persisted snapshot immutably, as the real storage owner does.
            stateRef.current = { ...stateRef.current,
                settingsScope: { serverId: 'server-b', accountId: 'account-b' },
                sessions: {
                    sys_bound: createVoiceConversationSession({ id: 'sys_bound', updatedAt: 30,
                        controlSessionId: '__voice_agent__', runId: 'account-b-run' }),
                },
            };
        });
        const { resetVoiceAgentPersistenceState } = await import('./resetVoiceAgentPersistenceState');

        await resetVoiceAgentPersistenceState({ stop });

        expect(applySettings).toHaveBeenCalledWith(expect.any(Object), {
            expectedSettingsScope: { serverId: 'server-a', accountId: 'account-a' },
            source: 'ui',
        });
        expect(stateRef.current.sessions.sys_bound.metadata.voiceAgentRunV1).toMatchObject({ runId: 'account-b-run' });
        expect(patchSessionMetadataWithRetry).not.toHaveBeenCalled();
    });

    it('does not depend on the legacy voice activity compatibility controller', async () => {
        const source = await readFile(new URL('./resetVoiceAgentPersistenceState.ts', import.meta.url), 'utf8');

        expect(source).not.toContain('voiceActivityController');
    });
});
