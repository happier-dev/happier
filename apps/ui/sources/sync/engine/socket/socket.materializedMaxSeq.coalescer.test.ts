import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiUpdateContainer } from '@/sync/api/types/apiTypes';
import type { Session } from '@/sync/domains/state/storageTypes';
import { storage } from '@/sync/domains/state/storage';
import { handleUpdateContainer } from './socket';

const initialStorageState = storage.getState();

function buildSession(sessionId: string): Session {
    return {
        id: sessionId,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: null,
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
    };
}

function buildNewMessageUpdate(params: { sessionId: string; messageId: string; messageSeq: number }): ApiUpdateContainer {
    return {
        id: `u_${params.messageId}`,
        seq: 100 + params.messageSeq,
        createdAt: 1_000 + params.messageSeq,
        body: {
            t: 'new-message',
            sid: params.sessionId,
            message: {
                id: params.messageId,
                seq: params.messageSeq,
                localId: null,
                createdAt: 1_000 + params.messageSeq,
                updatedAt: 1_000 + params.messageSeq,
                content: { t: 'encrypted', c: 'x' },
            },
        },
    } as ApiUpdateContainer;
}

describe('socket new-message + coalescer: materialized max seq', () => {
    beforeEach(() => {
        storage.setState(initialStorageState, true);
    });

    it('marks materializedMaxSeq only when the coalesced batch is applied (and avoids false gap detection while queued)', async () => {
        vi.useFakeTimers();
        try {
            storage.setState((prev) => ({
                ...prev,
                sessions: { ...prev.sessions, s1: buildSession('s1') },
                settings: {
                    ...prev.settings,
                    transcriptStreamingCoalesceEnabled: true,
                    transcriptStreamingCoalesceWindowMs: 50,
                    transcriptStreamingCoalesceMaxBatchSize: 1_000,
                },
            }));

            const applyMessages = vi.fn();
            const applySessions = vi.fn();
            const onMessageGapDetected = vi.fn();

            let materializedMaxSeq = 1;
            const markSessionMaterializedMaxSeq = vi.fn((sessionId: string, seq: number) => {
                if (sessionId === 's1') {
                    materializedMaxSeq = Math.max(materializedMaxSeq, Math.trunc(seq));
                }
            });

            const baseParams: Omit<Parameters<typeof handleUpdateContainer>[0], 'updateData'> = {
                encryption: {
                    getSessionEncryption: () => ({
                        decryptMessage: async (msg: any) => ({
                            id: msg.id,
                            localId: null,
                            createdAt: 1_000,
                            content: { role: 'user', content: { type: 'text', text: 'hi' } },
                        }),
                    }),
                    getMachineEncryption: () => null,
                    removeSessionEncryption: () => {},
                    decryptEncryptionKey: async () => null as Uint8Array | null,
                    initializeMachines: async () => {},
                } as any,
                artifactDataKeys: new Map<string, Uint8Array>(),
                applySessions,
                fetchSessions: vi.fn(),
                applyMessages,
                onSessionVisible: vi.fn(),
                isSessionMessagesLoaded: vi.fn(() => true),
                getSessionMaterializedMaxSeq: vi.fn(() => materializedMaxSeq),
                markSessionMaterializedMaxSeq,
                onMessageGapDetected,
                assumeUsers: vi.fn(async () => {}),
                applyTodoSocketUpdates: vi.fn(async () => {}),
                invalidateMachines: vi.fn(),
                invalidateSessions: vi.fn(),
                invalidateArtifacts: vi.fn(),
                invalidateFriends: vi.fn(),
                invalidateFriendRequests: vi.fn(),
                invalidateFeed: vi.fn(),
                invalidateAutomations: vi.fn(),
                invalidateTodos: vi.fn(),
                log: { log: vi.fn() },
            };

            await handleUpdateContainer({ ...baseParams, updateData: buildNewMessageUpdate({ sessionId: 's1', messageId: 'm2', messageSeq: 2 }) });
            await handleUpdateContainer({ ...baseParams, updateData: buildNewMessageUpdate({ sessionId: 's1', messageId: 'm3', messageSeq: 3 }) });

            expect(applyMessages).not.toHaveBeenCalled();
            expect(markSessionMaterializedMaxSeq).not.toHaveBeenCalled();
            expect(onMessageGapDetected).not.toHaveBeenCalled();

            await vi.runAllTimersAsync();

            expect(applyMessages).toHaveBeenCalledTimes(1);
            expect(markSessionMaterializedMaxSeq).toHaveBeenCalledWith('s1', 3);

            const applyOrder = applyMessages.mock.invocationCallOrder[0] ?? 0;
            const markOrder = markSessionMaterializedMaxSeq.mock.invocationCallOrder[0] ?? 0;
            expect(applyOrder).toBeGreaterThan(0);
            expect(markOrder).toBeGreaterThan(0);
            expect(markOrder).toBeGreaterThan(applyOrder);
        } finally {
            vi.useRealTimers();
        }
    });
});
