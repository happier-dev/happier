import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiUpdateContainer } from '@/sync/api/types/apiTypes';
import type { Session } from '@/sync/domains/state/storageTypes';
import { storage } from '@/sync/domains/state/storage';
import { clearActiveViewingSessionId, setActiveViewingSessionId } from '@/sync/domains/session/activeViewingSession';
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

function buildPlainNewMessageUpdate(params: { sessionId: string; messageId: string; messageSeq: number; text: string }): ApiUpdateContainer {
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
                content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: params.text } } },
            },
        },
    } as ApiUpdateContainer;
}

describe('socket new-message + coalescer: materialized max seq', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        storage.setState(initialStorageState, true);
        clearActiveViewingSessionId('s1');
        clearActiveViewingSessionId('s-offscreen');
    });

    afterEach(() => {
        clearActiveViewingSessionId('s1');
        clearActiveViewingSessionId('s-offscreen');
        vi.useRealTimers();
    });

    it('marks materializedMaxSeq for the active session leading batch immediately and waits for queued trailing batches', async () => {
        setActiveViewingSessionId('s1', 1);
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
            } as unknown as Parameters<typeof handleUpdateContainer>[0]['encryption'],
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

        expect(applyMessages).toHaveBeenCalledTimes(1);
        expect(markSessionMaterializedMaxSeq).toHaveBeenCalledWith('s1', 2);
        expect(onMessageGapDetected).not.toHaveBeenCalled();

        await vi.runAllTimersAsync();

        expect(applyMessages).toHaveBeenCalledTimes(2);
        expect(markSessionMaterializedMaxSeq).toHaveBeenCalledWith('s1', 3);

        const firstApplyOrder = applyMessages.mock.invocationCallOrder[0] ?? 0;
        const firstMarkOrder = markSessionMaterializedMaxSeq.mock.invocationCallOrder[0] ?? 0;
        const secondApplyOrder = applyMessages.mock.invocationCallOrder[1] ?? 0;
        const secondMarkOrder = markSessionMaterializedMaxSeq.mock.invocationCallOrder[1] ?? 0;
        expect(firstApplyOrder).toBeGreaterThan(0);
        expect(firstMarkOrder).toBeGreaterThan(firstApplyOrder);
        expect(secondApplyOrder).toBeGreaterThan(firstMarkOrder);
        expect(secondMarkOrder).toBeGreaterThan(secondApplyOrder);
    });

    it('defers the first off-screen new-message apply until the coalescing window flushes', async () => {
        storage.setState((prev) => ({
            ...prev,
            sessions: {
                ...prev.sessions,
                's-offscreen': { ...buildSession('s-offscreen'), encryptionMode: 'plain' },
            },
            settings: {
                ...prev.settings,
                transcriptStreamingCoalesceEnabled: true,
                transcriptStreamingCoalesceWindowMs: 50,
                transcriptStreamingCoalesceMaxBatchSize: 1_000,
            },
        }));

        const applyMessages = vi.fn();
        const markSessionMaterializedMaxSeq = vi.fn();
        const baseParams: Omit<Parameters<typeof handleUpdateContainer>[0], 'updateData'> = {
            encryption: {
                getSessionEncryption: () => null,
                getMachineEncryption: () => null,
                removeSessionEncryption: () => {},
                decryptEncryptionKey: async () => null as Uint8Array | null,
                initializeMachines: async () => {},
            } as any,
            artifactDataKeys: new Map<string, Uint8Array>(),
            applySessions: vi.fn(),
            fetchSessions: vi.fn(),
            applyMessages,
            onSessionVisible: vi.fn(),
            isSessionMessagesLoaded: vi.fn(() => true),
            getSessionMaterializedMaxSeq: vi.fn(() => 1),
            markSessionMaterializedMaxSeq,
            onMessageGapDetected: vi.fn(),
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

        await handleUpdateContainer({
            ...baseParams,
            updateData: buildPlainNewMessageUpdate({
                sessionId: 's-offscreen',
                messageId: 'm2',
                messageSeq: 2,
                text: 'off-screen',
            }),
        });

        expect(applyMessages).not.toHaveBeenCalled();
        expect(markSessionMaterializedMaxSeq).not.toHaveBeenCalled();

        await vi.runAllTimersAsync();

        expect(applyMessages).toHaveBeenCalledTimes(1);
        expect(markSessionMaterializedMaxSeq).toHaveBeenCalledWith('s-offscreen', 2);
    });

    it('drops queued off-screen new-message applies when the session is deleted', async () => {
        storage.setState((prev) => ({
            ...prev,
            sessions: {
                ...prev.sessions,
                's-offscreen': { ...buildSession('s-offscreen'), encryptionMode: 'plain' },
            },
            settings: {
                ...prev.settings,
                transcriptStreamingCoalesceEnabled: true,
                transcriptStreamingCoalesceWindowMs: 50,
                transcriptStreamingCoalesceMaxBatchSize: 1_000,
            },
        }));

        const applyMessages = vi.fn();
        const baseParams: Omit<Parameters<typeof handleUpdateContainer>[0], 'updateData'> = {
            encryption: {
                getSessionEncryption: () => null,
                getMachineEncryption: () => null,
                removeSessionEncryption: () => {},
                decryptEncryptionKey: async () => null as Uint8Array | null,
                initializeMachines: async () => {},
            } as any,
            artifactDataKeys: new Map<string, Uint8Array>(),
            applySessions: vi.fn(),
            fetchSessions: vi.fn(),
            applyMessages,
            onSessionVisible: vi.fn(),
            isSessionMessagesLoaded: vi.fn(() => true),
            getSessionMaterializedMaxSeq: vi.fn(() => 1),
            markSessionMaterializedMaxSeq: vi.fn(),
            onMessageGapDetected: vi.fn(),
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

        await handleUpdateContainer({
            ...baseParams,
            updateData: buildPlainNewMessageUpdate({
                sessionId: 's-offscreen',
                messageId: 'm2',
                messageSeq: 2,
                text: 'queued before delete',
            }),
        });

        expect(applyMessages).not.toHaveBeenCalled();

        await handleUpdateContainer({
            ...baseParams,
            updateData: {
                id: 'u_delete',
                seq: 200,
                createdAt: 2_000,
                body: {
                    t: 'delete-session',
                    sid: 's-offscreen',
                },
            } as ApiUpdateContainer,
        });

        await vi.runAllTimersAsync();

        expect(applyMessages).not.toHaveBeenCalled();
    });

    it('drops queued new-message work when the socket generation guard becomes stale', async () => {
        setActiveViewingSessionId('s1', 1);
        storage.setState((prev) => ({
            ...prev,
            sessions: {
                ...prev.sessions,
                s1: { ...buildSession('s1'), encryptionMode: 'plain' },
            },
            settings: {
                ...prev.settings,
                transcriptStreamingCoalesceEnabled: true,
                transcriptStreamingCoalesceWindowMs: 50,
                transcriptStreamingCoalesceMaxBatchSize: 1_000,
            },
        }));

        let shouldContinue = true;
        const applyMessages = vi.fn();
        const baseParams: Omit<Parameters<typeof handleUpdateContainer>[0], 'updateData'> = {
            encryption: {
                getSessionEncryption: () => null,
                getMachineEncryption: () => null,
                removeSessionEncryption: () => {},
                decryptEncryptionKey: async () => null as Uint8Array | null,
                initializeMachines: async () => {},
            } as any,
            artifactDataKeys: new Map<string, Uint8Array>(),
            applySessions: vi.fn(),
            fetchSessions: vi.fn(),
            applyMessages,
            onSessionVisible: vi.fn(),
            isSessionMessagesLoaded: vi.fn(() => true),
            getSessionMaterializedMaxSeq: vi.fn(() => 1),
            markSessionMaterializedMaxSeq: vi.fn(),
            onMessageGapDetected: vi.fn(),
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
            shouldContinue: () => shouldContinue,
            log: { log: vi.fn() },
        };

        await handleUpdateContainer({
            ...baseParams,
            updateData: buildPlainNewMessageUpdate({ sessionId: 's1', messageId: 'm2', messageSeq: 2, text: 'leading' }),
        });
        await handleUpdateContainer({
            ...baseParams,
            updateData: buildPlainNewMessageUpdate({ sessionId: 's1', messageId: 'm3', messageSeq: 3, text: 'queued' }),
        });

        expect(applyMessages).toHaveBeenCalledTimes(1);

        shouldContinue = false;
        await vi.runAllTimersAsync();

        expect(applyMessages).toHaveBeenCalledTimes(1);
    });

    it('does not let a queued new-message overwrite a newer immediate message-updated payload', async () => {
        setActiveViewingSessionId('s1', 1);
        storage.setState((prev) => ({
            ...prev,
            sessions: {
                ...prev.sessions,
                s1: { ...buildSession('s1'), encryptionMode: 'plain' },
            },
            settings: {
                ...prev.settings,
                transcriptStreamingCoalesceEnabled: true,
                transcriptStreamingCoalesceWindowMs: 50,
                transcriptStreamingCoalesceMaxBatchSize: 1_000,
            },
        }));

        const appliedTexts = new Map<string, string>();
        const applyMessages = vi.fn((_sessionId: string, messages: Array<{ id: string; content: { type: 'text'; text: string } }>) => {
            for (const message of messages) {
                appliedTexts.set(message.id, message.content.text);
            }
        });
        let materializedMaxSeq = 1;
        const markSessionMaterializedMaxSeq = vi.fn((sessionId: string, seq: number) => {
            if (sessionId === 's1') {
                materializedMaxSeq = Math.max(materializedMaxSeq, Math.trunc(seq));
            }
        });

        const baseParams: Omit<Parameters<typeof handleUpdateContainer>[0], 'updateData'> = {
            encryption: {
                getSessionEncryption: () => null,
                getMachineEncryption: () => null,
                removeSessionEncryption: () => {},
                decryptEncryptionKey: async () => null as Uint8Array | null,
                initializeMachines: async () => {},
            } as any,
            artifactDataKeys: new Map<string, Uint8Array>(),
            applySessions: vi.fn(),
            fetchSessions: vi.fn(),
            applyMessages: applyMessages as any,
            onSessionVisible: vi.fn(),
            isSessionMessagesLoaded: vi.fn(() => true),
            getSessionMaterializedMaxSeq: vi.fn(() => materializedMaxSeq),
            markSessionMaterializedMaxSeq,
            onMessageGapDetected: vi.fn(),
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

        await handleUpdateContainer({
            ...baseParams,
            updateData: {
                id: 'u_leading',
                seq: 101,
                createdAt: 1_001,
                body: {
                    t: 'new-message',
                    sid: 's1',
                    message: {
                        id: 'm1',
                        seq: 2,
                        localId: null,
                        createdAt: 1_001,
                        updatedAt: 1_001,
                        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'leading text' } } },
                    },
                },
            } as ApiUpdateContainer,
        });
        expect(appliedTexts.get('m1')).toBe('leading text');
        expect(applyMessages).toHaveBeenCalledTimes(1);

        await handleUpdateContainer({
            ...baseParams,
            updateData: {
                id: 'u_new',
                seq: 102,
                createdAt: 1_002,
                body: {
                    t: 'new-message',
                    sid: 's1',
                    message: {
                        id: 'm2',
                        seq: 3,
                        localId: null,
                        createdAt: 1_002,
                        updatedAt: 1_002,
                        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'stale text' } } },
                    },
                },
            } as ApiUpdateContainer,
        });

        expect(applyMessages).toHaveBeenCalledTimes(1);

        await handleUpdateContainer({
            ...baseParams,
            updateData: {
                id: 'u_updated',
                seq: 103,
                createdAt: 1_003,
                body: {
                    t: 'message-updated',
                    sid: 's1',
                    message: {
                        id: 'm2',
                        seq: 3,
                        localId: null,
                        sidechainId: null,
                        createdAt: 1_002,
                        updatedAt: 1_003,
                        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'fresh text' } } },
                    },
                },
            } as ApiUpdateContainer,
        });

        expect(appliedTexts.get('m2')).toBe('fresh text');

        await vi.runAllTimersAsync();

        expect(appliedTexts.get('m2')).toBe('fresh text');
    });
});
