import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiUpdateContainer } from '@/sync/api/types/apiTypes';
import type { Session } from '@/sync/domains/state/storageTypes';
import { storage } from '@/sync/domains/state/storage';
import {
    markSessionSurfaceVisible,
    resetSessionSurfaceVisibilityForTests,
} from '@/sync/domains/session/sessionSurfaceVisibility';
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

function buildNewMessageUpdate(params: {
    sessionId: string;
    messageId: string;
    messageSeq: number;
    attentionImpact?: {
        affectsUnread: boolean;
        affectsMeaningfulActivity: boolean;
    };
}): ApiUpdateContainer {
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
                ...(params.attentionImpact ? { attentionImpact: params.attentionImpact } : {}),
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

function buildPlainAuthSwitchUpdate(params: { sessionId: string; messageId: string; messageSeq: number }): ApiUpdateContainer {
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
                content: {
                    t: 'plain',
                    v: {
                        role: 'agent',
                        content: {
                            type: 'event',
                            id: 'event-account-switch',
                            data: {
                                type: 'connected-service-account-switch',
                                serviceId: 'openai-codex',
                                groupId: 'happier',
                                fromProfileId: 'profile-a',
                                toProfileId: 'profile-b',
                                reason: 'usage_limit',
                                mode: 'hot_apply',
                            },
                        },
                    },
                },
            },
        },
    } as ApiUpdateContainer;
}

function buildPlainMessageUpdatedUpdate(params: { sessionId: string; messageId: string; messageSeq: number; text: string }): ApiUpdateContainer {
    return {
        id: `u_${params.messageId}`,
        seq: 100 + params.messageSeq,
        createdAt: 1_000 + params.messageSeq,
        body: {
            t: 'message-updated',
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

function buildUpdateSessionUpdate(params: {
    id: string;
    seq: number;
    createdAt: number;
    body: Record<string, unknown>;
}): ApiUpdateContainer {
    return {
        id: `u_update_${params.seq}`,
        seq: params.seq,
        createdAt: params.createdAt,
        body: {
            t: 'update-session',
            id: params.id,
            ...params.body,
        },
    } as ApiUpdateContainer;
}

describe('socket new-message + coalescer: materialized max seq', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        storage.setState(initialStorageState, true);
        resetSessionSurfaceVisibilityForTests();
    });

    afterEach(() => {
        resetSessionSurfaceVisibilityForTests();
        vi.useRealTimers();
    });

    it('marks materializedMaxSeq for the active session leading batch immediately and waits for queued trailing batches', async () => {
        markSessionSurfaceVisible('s1');
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
            artifactDataKeys: new Map(),
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

    it('defers the first off-screen new-message session projection until the coalescing window flushes', async () => {
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

        const applySessions = vi.fn();
        const applyMessages = vi.fn();
        const markSessionMaterializedMaxSeq = vi.fn();
        const markSessionTranscriptDeferred = vi.fn();
        const baseParams: Omit<Parameters<typeof handleUpdateContainer>[0], 'updateData'> = {
            encryption: {
                getSessionEncryption: () => null,
                getMachineEncryption: () => null,
                removeSessionEncryption: () => {},
                decryptEncryptionKey: async () => null as Uint8Array | null,
                initializeMachines: async () => {},
            } as unknown as Parameters<typeof handleUpdateContainer>[0]['encryption'],
            artifactDataKeys: new Map(),
            applySessions,
            fetchSessions: vi.fn(),
            applyMessages,
            onSessionVisible: vi.fn(),
            isSessionMessagesLoaded: vi.fn(() => true),
            getSessionMaterializedMaxSeq: vi.fn(() => 1),
            markSessionMaterializedMaxSeq,
            markSessionTranscriptDeferred,
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
        expect(applySessions).not.toHaveBeenCalled();
        expect(markSessionMaterializedMaxSeq).not.toHaveBeenCalled();
        expect(markSessionTranscriptDeferred).toHaveBeenCalledWith('s-offscreen', expect.objectContaining({
            updateType: 'new-message',
            seq: 2,
        }));

        await vi.runAllTimersAsync();

        expect(applyMessages).not.toHaveBeenCalled();
        expect(markSessionMaterializedMaxSeq).not.toHaveBeenCalled();
        expect(applySessions).toHaveBeenCalledTimes(1);
        expect(applySessions).toHaveBeenCalledWith([
            expect.objectContaining({
                id: 's-offscreen',
                seq: 2,
                updatedAt: 1_002,
                meaningfulActivityAt: 1_002,
            }),
        ]);
    });

    it('uses cache-only renderable projections for hidden hydrated sessions', async () => {
        storage.setState((prev) => ({
            ...prev,
            sessions: {
                ...prev.sessions,
                's-hidden-projection': {
                    ...buildSession('s-hidden-projection'),
                    encryptionMode: 'plain',
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: 900,
                    meaningfulActivityAt: 1,
                },
            },
            settings: {
                ...prev.settings,
                transcriptStreamingCoalesceEnabled: true,
                transcriptStreamingCoalesceWindowMs: 50,
                transcriptStreamingCoalesceMaxBatchSize: 1_000,
            },
        }));
        storage.setState((prev) => ({
            ...prev,
            sessionListRenderables: {
                ...prev.sessionListRenderables,
                's-hidden-projection': {
                    id: 's-hidden-projection',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    active: false,
                    activeAt: 1,
                    archivedAt: null,
                    lastViewedSessionSeq: 1,
                    metadataVersion: 1,
                    agentStateVersion: 0,
                    metadata: { path: '/tmp', host: 'localhost' },
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: 900,
                    hasUnreadMessages: false,
                    thinking: false,
                    thinkingAt: 0,
                    presence: 1,
                },
            },
        }));

        const applySessions = vi.fn();
        const applyMessages = vi.fn();
        const markSessionTranscriptDeferred = vi.fn();
        const baseParams: Omit<Parameters<typeof handleUpdateContainer>[0], 'updateData'> = {
            encryption: {
                getSessionEncryption: () => null,
                getMachineEncryption: () => null,
                removeSessionEncryption: () => {},
                decryptEncryptionKey: async () => null as Uint8Array | null,
                initializeMachines: async () => {},
            } as unknown as Parameters<typeof handleUpdateContainer>[0]['encryption'],
            artifactDataKeys: new Map(),
            applySessions,
            fetchSessions: vi.fn(),
            applyMessages,
            onSessionVisible: vi.fn(),
            isSessionMessagesLoaded: vi.fn(() => true),
            getSessionMaterializedMaxSeq: vi.fn(() => 1),
            markSessionMaterializedMaxSeq: vi.fn(),
            markSessionTranscriptDeferred,
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
                sessionId: 's-hidden-projection',
                messageId: 'm2',
                messageSeq: 2,
                text: 'hidden projection-only',
            }),
        });

        expect(applyMessages).not.toHaveBeenCalled();
        expect(applySessions).not.toHaveBeenCalled();
        expect(markSessionTranscriptDeferred).toHaveBeenCalledWith('s-hidden-projection', expect.objectContaining({
            updateType: 'new-message',
            seq: 2,
        }));

        expect(storage.getState().sessionListRenderables['s-hidden-projection']).toEqual(
            expect.objectContaining({ seq: 2, updatedAt: 1_002, hasUnreadMessages: true }),
        );

        await vi.runAllTimersAsync();

        expect(applySessions).not.toHaveBeenCalled();
    });

    it('uses cache-only renderable projections for hidden hydrated message-updated updates', async () => {
        storage.setState((prev) => ({
            ...prev,
            sessions: {
                ...prev.sessions,
                's-hidden-updated': {
                    ...buildSession('s-hidden-updated'),
                    encryptionMode: 'plain',
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: 900,
                    meaningfulActivityAt: 1,
                },
            },
            settings: {
                ...prev.settings,
                transcriptStreamingCoalesceEnabled: true,
                transcriptStreamingCoalesceWindowMs: 50,
                transcriptStreamingCoalesceMaxBatchSize: 1_000,
            },
        }));
        storage.setState((prev) => ({
            ...prev,
            sessionListRenderables: {
                ...prev.sessionListRenderables,
                's-hidden-updated': {
                    id: 's-hidden-updated',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    active: false,
                    activeAt: 1,
                    archivedAt: null,
                    lastViewedSessionSeq: 1,
                    metadataVersion: 1,
                    agentStateVersion: 0,
                    metadata: { path: '/tmp', host: 'localhost' },
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: 900,
                    hasUnreadMessages: false,
                    thinking: false,
                    thinkingAt: 0,
                    presence: 1,
                },
            },
        }));

        const applySessions = vi.fn();
        const applyMessages = vi.fn();
        const markSessionTranscriptStale = vi.fn();
        const baseParams: Omit<Parameters<typeof handleUpdateContainer>[0], 'updateData'> = {
            encryption: {
                getSessionEncryption: () => null,
                getMachineEncryption: () => null,
                removeSessionEncryption: () => {},
                decryptEncryptionKey: async () => null as Uint8Array | null,
                initializeMachines: async () => {},
            } as unknown as Parameters<typeof handleUpdateContainer>[0]['encryption'],
            artifactDataKeys: new Map(),
            applySessions,
            fetchSessions: vi.fn(),
            applyMessages,
            onSessionVisible: vi.fn(),
            isSessionMessagesLoaded: vi.fn(() => true),
            getSessionMaterializedMaxSeq: vi.fn(() => 1),
            markSessionMaterializedMaxSeq: vi.fn(),
            markSessionTranscriptStale,
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
            updateData: buildPlainMessageUpdatedUpdate({
                sessionId: 's-hidden-updated',
                messageId: 'm2',
                messageSeq: 2,
                text: 'hidden projection-only edit',
            }),
        });

        expect(applyMessages).not.toHaveBeenCalled();
        expect(applySessions).not.toHaveBeenCalled();
        expect(markSessionTranscriptStale).toHaveBeenCalledWith('s-hidden-updated', expect.objectContaining({
            updateType: 'message-updated',
            seq: 2,
            messageId: 'm2',
        }));

        expect(storage.getState().sessionListRenderables['s-hidden-updated']).toEqual(
            expect.objectContaining({ seq: 2, updatedAt: 1_002, hasUnreadMessages: true }),
        );

        await vi.runAllTimersAsync();

        expect(applySessions).not.toHaveBeenCalled();
    });

    it('marks cache-only hidden renderables unread when a projected durable message advances past the read cursor', async () => {
        storage.setState((prev) => ({
            ...prev,
            sessions: {},
            sessionListRenderables: {
                ...prev.sessionListRenderables,
                's-offscreen': {
                    id: 's-offscreen',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    active: true,
                    activeAt: 1,
                    metadataVersion: 0,
                    agentStateVersion: 0,
                    metadata: null,
                    thinking: false,
                    thinkingAt: 0,
                    presence: 'online',
                    lastViewedSessionSeq: 1,
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: 1,
                    hasUnreadMessages: false,
                },
            },
            settings: {
                ...prev.settings,
                transcriptStreamingCoalesceEnabled: false,
            },
        }));

        const baseParams: Omit<Parameters<typeof handleUpdateContainer>[0], 'updateData'> = {
            encryption: {
                getSessionEncryption: () => null,
                getMachineEncryption: () => null,
                removeSessionEncryption: () => {},
                decryptEncryptionKey: async () => null as Uint8Array | null,
                initializeMachines: async () => {},
            } as any,
            artifactDataKeys: new Map(),
            applySessions: vi.fn((sessions: Parameters<typeof handleUpdateContainer>[0]['applySessions'] extends (arg: infer T) => void ? T : never) => {
                storage.getState().applySessions(sessions as Session[]);
            }),
            fetchSessions: vi.fn(),
            applyMessages: vi.fn(),
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
            markSessionTranscriptDeferred: vi.fn(),
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

        expect(storage.getState().sessionListRenderables['s-offscreen']?.hasUnreadMessages).toBe(true);
    });

    it('does not mark cache-only renderables unread or meaningful when a hidden durable new-message is auth maintenance', async () => {
        storage.setState((prev) => ({
            ...prev,
            sessions: {},
            sessionListRenderables: {
                ...prev.sessionListRenderables,
                's-cache-auth-maintenance': {
                    id: 's-cache-auth-maintenance',
                    seq: 10,
                    createdAt: 1,
                    updatedAt: 900,
                    meaningfulActivityAt: 800,
                    active: false,
                    activeAt: 1,
                    archivedAt: null,
                    lastViewedSessionSeq: 10,
                    metadataVersion: 1,
                    agentStateVersion: 0,
                    metadata: { path: '/tmp', host: 'localhost' },
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: 900,
                    hasUnreadMessages: false,
                    thinking: false,
                    thinkingAt: 0,
                    presence: 1,
                },
            },
            settings: {
                ...prev.settings,
                transcriptStreamingCoalesceEnabled: true,
                transcriptStreamingCoalesceWindowMs: 50,
                transcriptStreamingCoalesceMaxBatchSize: 1_000,
            },
        }));

        const applyMessages = vi.fn();
        const fetchSessions = vi.fn();
        const baseParams: Omit<Parameters<typeof handleUpdateContainer>[0], 'updateData'> = {
            encryption: {
                getSessionEncryption: () => null,
                getMachineEncryption: () => null,
                removeSessionEncryption: () => {},
                decryptEncryptionKey: async () => null as Uint8Array | null,
                initializeMachines: async () => {},
            } as unknown as Parameters<typeof handleUpdateContainer>[0]['encryption'],
            artifactDataKeys: new Map(),
            applySessions: vi.fn(),
            fetchSessions,
            applyMessages,
            onSessionVisible: vi.fn(),
            isSessionMessagesLoaded: vi.fn(() => true),
            getSessionMaterializedMaxSeq: vi.fn(() => 10),
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
            markSessionTranscriptDeferred: vi.fn(),
            log: { log: vi.fn() },
        };

        await handleUpdateContainer({
            ...baseParams,
            updateData: buildPlainAuthSwitchUpdate({
                sessionId: 's-cache-auth-maintenance',
                messageId: 'm-auth-switch',
                messageSeq: 11,
            }),
        });

        expect(fetchSessions).not.toHaveBeenCalled();
        expect(applyMessages).not.toHaveBeenCalled();
        expect(storage.getState().sessionListRenderables['s-cache-auth-maintenance']).toEqual(
            expect.objectContaining({
                seq: 10,
                updatedAt: 900,
                meaningfulActivityAt: 800,
                hasUnreadMessages: false,
            }),
        );

        await vi.runAllTimersAsync();

        expect(storage.getState().sessionListRenderables['s-cache-auth-maintenance']).toEqual(
            expect.objectContaining({
                seq: 11,
                updatedAt: 1_011,
                meaningfulActivityAt: 800,
                hasUnreadMessages: false,
            }),
        );
    });

    it('hydrates instead of projecting unread state for encrypted cache-only durable messages with unknown attention impact', async () => {
        storage.setState((prev) => ({
            ...prev,
            sessions: {},
            sessionListRenderables: {
                ...prev.sessionListRenderables,
                's-cache-encrypted': {
                    id: 's-cache-encrypted',
                    seq: 10,
                    createdAt: 1,
                    updatedAt: 900,
                    meaningfulActivityAt: 800,
                    active: false,
                    activeAt: 1,
                    archivedAt: null,
                    lastViewedSessionSeq: 10,
                    metadataVersion: 1,
                    agentStateVersion: 0,
                    metadata: { path: '/tmp', host: 'localhost' },
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: 900,
                    hasUnreadMessages: false,
                    thinking: false,
                    thinkingAt: 0,
                    presence: 1,
                },
            },
            settings: {
                ...prev.settings,
                transcriptStreamingCoalesceEnabled: true,
                transcriptStreamingCoalesceWindowMs: 50,
                transcriptStreamingCoalesceMaxBatchSize: 1_000,
            },
        }));

        const fetchSessions = vi.fn();
        const hydrateSessionById = vi.fn();
        const baseParams: Omit<Parameters<typeof handleUpdateContainer>[0], 'updateData'> = {
            encryption: {
                getSessionEncryption: () => null,
                getMachineEncryption: () => null,
                removeSessionEncryption: () => {},
                decryptEncryptionKey: async () => null as Uint8Array | null,
                initializeMachines: async () => {},
            } as unknown as Parameters<typeof handleUpdateContainer>[0]['encryption'],
            artifactDataKeys: new Map(),
            applySessions: vi.fn(),
            fetchSessions,
            hydrateSessionById,
            applyMessages: vi.fn(),
            onSessionVisible: vi.fn(),
            isSessionMessagesLoaded: vi.fn(() => true),
            getSessionMaterializedMaxSeq: vi.fn(() => 10),
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
            markSessionTranscriptDeferred: vi.fn(),
            log: { log: vi.fn() },
        };

        await handleUpdateContainer({
            ...baseParams,
            updateData: buildNewMessageUpdate({
                sessionId: 's-cache-encrypted',
                messageId: 'm-encrypted',
                messageSeq: 11,
            }),
        });

        expect(fetchSessions).not.toHaveBeenCalled();
        expect(hydrateSessionById).toHaveBeenCalledWith('s-cache-encrypted', 'socket-update-attention-unknown');
        expect(storage.getState().sessionListRenderables['s-cache-encrypted']).toEqual(
            expect.objectContaining({
                seq: 10,
                updatedAt: 900,
                meaningfulActivityAt: 800,
                hasUnreadMessages: false,
            }),
        );

        await vi.runAllTimersAsync();

        expect(storage.getState().sessionListRenderables['s-cache-encrypted']).toEqual(
            expect.objectContaining({
                seq: 10,
                updatedAt: 900,
                meaningfulActivityAt: 800,
                hasUnreadMessages: false,
            }),
        );
    });

    it('projects encrypted cache-only durable maintenance messages when the server supplies trusted non-unread attention impact', async () => {
        storage.setState((prev) => ({
            ...prev,
            sessions: {},
            sessionListRenderables: {
                ...prev.sessionListRenderables,
                's-cache-encrypted-maintenance-trusted': {
                    id: 's-cache-encrypted-maintenance-trusted',
                    seq: 10,
                    createdAt: 1,
                    updatedAt: 900,
                    meaningfulActivityAt: 800,
                    active: false,
                    activeAt: 1,
                    archivedAt: null,
                    lastViewedSessionSeq: 10,
                    metadataVersion: 1,
                    agentStateVersion: 0,
                    metadata: { path: '/tmp', host: 'localhost' },
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: 900,
                    hasUnreadMessages: false,
                    thinking: false,
                    thinkingAt: 0,
                    presence: 1,
                },
            },
            settings: {
                ...prev.settings,
                transcriptStreamingCoalesceEnabled: true,
                transcriptStreamingCoalesceWindowMs: 50,
                transcriptStreamingCoalesceMaxBatchSize: 1_000,
            },
        }));

        const fetchSessions = vi.fn();
        const applyMessages = vi.fn();
        const baseParams: Omit<Parameters<typeof handleUpdateContainer>[0], 'updateData'> = {
            encryption: {
                getSessionEncryption: () => null,
                getMachineEncryption: () => null,
                removeSessionEncryption: () => {},
                decryptEncryptionKey: async () => null as Uint8Array | null,
                initializeMachines: async () => {},
            } as unknown as Parameters<typeof handleUpdateContainer>[0]['encryption'],
            artifactDataKeys: new Map(),
            applySessions: vi.fn(),
            fetchSessions,
            applyMessages,
            onSessionVisible: vi.fn(),
            isSessionMessagesLoaded: vi.fn(() => true),
            getSessionMaterializedMaxSeq: vi.fn(() => 10),
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
            markSessionTranscriptDeferred: vi.fn(),
            log: { log: vi.fn() },
        };

        await handleUpdateContainer({
            ...baseParams,
            updateData: buildNewMessageUpdate({
                sessionId: 's-cache-encrypted-maintenance-trusted',
                messageId: 'm-encrypted-maintenance-trusted',
                messageSeq: 11,
                attentionImpact: {
                    affectsUnread: false,
                    affectsMeaningfulActivity: false,
                },
            }),
        });

        expect(fetchSessions).not.toHaveBeenCalled();
        expect(applyMessages).not.toHaveBeenCalled();

        await vi.runAllTimersAsync();

        expect(storage.getState().sessionListRenderables['s-cache-encrypted-maintenance-trusted']).toEqual(
            expect.objectContaining({
                seq: 11,
                updatedAt: 1_011,
                meaningfulActivityAt: 800,
                hasUnreadMessages: false,
            }),
        );
    });

    it('coalesces trailing cache-only renderable projections without delaying the first unread projection', async () => {
        storage.getState().replaceSessionListRenderables([
            {
                id: 's-cache-coalesced',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: false,
                activeAt: 1,
                archivedAt: null,
                lastViewedSessionSeq: 1,
                metadataVersion: 1,
                agentStateVersion: 0,
                metadata: { path: '/tmp', host: 'localhost' },
                latestTurnStatus: 'in_progress',
                latestTurnStatusObservedAt: 900,
                hasUnreadMessages: false,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            },
        ]);

        const fetchSessions = vi.fn();
        const baseParams: Omit<Parameters<typeof handleUpdateContainer>[0], 'updateData'> = {
            encryption: {
                getSessionEncryption: () => null,
                getMachineEncryption: () => null,
                removeSessionEncryption: () => {},
                decryptEncryptionKey: async () => null as Uint8Array | null,
                initializeMachines: async () => {},
            } as unknown as Parameters<typeof handleUpdateContainer>[0]['encryption'],
            artifactDataKeys: new Map(),
            applySessions: vi.fn(),
            fetchSessions,
            applyMessages: vi.fn(),
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
                sessionId: 's-cache-coalesced',
                messageId: 'm2',
                messageSeq: 2,
                text: 'first hidden durable update',
            }),
        });

        expect(storage.getState().sessionListRenderables['s-cache-coalesced']).toEqual(
            expect.objectContaining({ seq: 2, hasUnreadMessages: true }),
        );

        await handleUpdateContainer({
            ...baseParams,
            updateData: buildPlainNewMessageUpdate({
                sessionId: 's-cache-coalesced',
                messageId: 'm3',
                messageSeq: 3,
                text: 'trailing hidden durable update',
            }),
        });

        expect(fetchSessions).not.toHaveBeenCalled();
        expect(storage.getState().sessionListRenderables['s-cache-coalesced']).toEqual(
            expect.objectContaining({ seq: 2, updatedAt: 1_002 }),
        );

        await vi.runAllTimersAsync();

        expect(storage.getState().sessionListRenderables['s-cache-coalesced']).toEqual(
            expect.objectContaining({ seq: 3, updatedAt: 1_003, hasUnreadMessages: true }),
        );
    });

    it('defers cache-only renderable projections while the unread state is already visible', async () => {
        storage.getState().replaceSessionListRenderables([
            {
                id: 's-cache-already-unread',
                seq: 2,
                createdAt: 1,
                updatedAt: 1_002,
                active: false,
                activeAt: 1,
                archivedAt: null,
                lastViewedSessionSeq: 1,
                metadataVersion: 1,
                agentStateVersion: 0,
                metadata: { path: '/tmp', host: 'localhost' },
                latestTurnStatus: 'in_progress',
                latestTurnStatusObservedAt: 900,
                hasUnreadMessages: true,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            },
        ]);

        const baseParams: Omit<Parameters<typeof handleUpdateContainer>[0], 'updateData'> = {
            encryption: {
                getSessionEncryption: () => null,
                getMachineEncryption: () => null,
                removeSessionEncryption: () => {},
                decryptEncryptionKey: async () => null as Uint8Array | null,
                initializeMachines: async () => {},
            } as unknown as Parameters<typeof handleUpdateContainer>[0]['encryption'],
            artifactDataKeys: new Map(),
            applySessions: vi.fn(),
            fetchSessions: vi.fn(),
            applyMessages: vi.fn(),
            onSessionVisible: vi.fn(),
            isSessionMessagesLoaded: vi.fn(() => true),
            getSessionMaterializedMaxSeq: vi.fn(() => 2),
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
                sessionId: 's-cache-already-unread',
                messageId: 'm3',
                messageSeq: 3,
                text: 'trailing unread update',
            }),
        });

        expect(storage.getState().sessionListRenderables['s-cache-already-unread']).toEqual(
            expect.objectContaining({ seq: 2, updatedAt: 1_002, hasUnreadMessages: true }),
        );

        await vi.runAllTimersAsync();

        expect(storage.getState().sessionListRenderables['s-cache-already-unread']).toEqual(
            expect.objectContaining({ seq: 3, updatedAt: 1_003, hasUnreadMessages: true }),
        );
    });

    it('keeps a same-timestamp higher-seq urgent cache-only projection after flushing a queued non-urgent patch', async () => {
        storage.getState().replaceSessionListRenderables([
            {
                id: 's-cache-same-timestamp',
                seq: 10,
                createdAt: 1,
                updatedAt: 1_000,
                active: false,
                activeAt: 1,
                archivedAt: null,
                lastViewedSessionSeq: 10,
                metadataVersion: 1,
                agentStateVersion: 0,
                metadata: { path: '/tmp', host: 'localhost' },
                latestTurnStatus: null,
                latestTurnStatusObservedAt: null,
                hasUnreadMessages: false,
                hasPendingPermissionRequests: false,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            },
        ]);

        const baseParams: Omit<Parameters<typeof handleUpdateContainer>[0], 'updateData'> = {
            encryption: {
                getSessionEncryption: () => null,
                getMachineEncryption: () => null,
                removeSessionEncryption: () => {},
                decryptEncryptionKey: async () => null as Uint8Array | null,
                initializeMachines: async () => {},
            } as unknown as Parameters<typeof handleUpdateContainer>[0]['encryption'],
            artifactDataKeys: new Map(),
            applySessions: vi.fn(),
            fetchSessions: vi.fn(),
            applyMessages: vi.fn(),
            onSessionVisible: vi.fn(),
            isSessionMessagesLoaded: vi.fn(() => true),
            getSessionMaterializedMaxSeq: vi.fn(() => 10),
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
            updateData: buildUpdateSessionUpdate({
                id: 's-cache-same-timestamp',
                seq: 20,
                createdAt: 2_000,
                body: {
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: 2_000,
                },
            }),
        });

        expect(storage.getState().sessionListRenderables['s-cache-same-timestamp']).toEqual(
            expect.objectContaining({ seq: 10, latestTurnStatus: null, hasPendingPermissionRequests: false }),
        );

        await handleUpdateContainer({
            ...baseParams,
            updateData: buildUpdateSessionUpdate({
                id: 's-cache-same-timestamp',
                seq: 21,
                createdAt: 2_000,
                body: {
                    pendingPermissionRequestCount: 1,
                    pendingRequestObservedAt: 2_000,
                },
            }),
        });

        expect(storage.getState().sessionListRenderables['s-cache-same-timestamp']).toEqual(
            expect.objectContaining({
                updatedAt: 2_000,
                latestTurnStatus: 'in_progress',
                hasPendingPermissionRequests: true,
                pendingRequestObservedAt: 2_000,
            }),
        );
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
            artifactDataKeys: new Map(),
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
        markSessionSurfaceVisible('s1');
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
            artifactDataKeys: new Map(),
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
        markSessionSurfaceVisible('s1');
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
        const sessionReceivedMessages = new Map<string, Map<string, number>>();
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
            artifactDataKeys: new Map(),
            applySessions: vi.fn(),
            fetchSessions: vi.fn(),
            applyMessages: applyMessages as any,
            sessionReceivedMessages,
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
        // Admission to the existing new-message queue is not transcript apply,
        // and therefore cannot publish page/socket currentness.
        expect(sessionReceivedMessages.get('s1')?.get('m2')).toBeUndefined();

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
        expect(sessionReceivedMessages.get('s1')?.get('m2')).toBe(1_003);

        await vi.runAllTimersAsync();

        expect(appliedTexts.get('m2')).toBe('fresh text');
        expect(sessionReceivedMessages.get('s1')?.get('m2')).toBe(1_003);
    });
});
