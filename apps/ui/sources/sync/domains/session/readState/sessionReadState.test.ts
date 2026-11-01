import { beforeEach, describe, expect, it } from 'vitest';

import { deriveSessionReadState, resolveSessionReadStateAction } from './sessionReadState';
import type { StorageState } from '@/sync/store/types';
import type { Message } from '@/sync/domains/messages/messageTypes';
import { buildTranscriptRenderableAggregate } from '@/sync/domains/messages/transcriptRenderableAggregate';

const storageState = {
    sessionMessages: {},
} as unknown as StorageState;

beforeEach(async () => {
    (storageState as { sessionMessages: Record<string, unknown> }).sessionMessages = {};
    (storageState as { sessionListRenderables: Record<string, unknown> }).sessionListRenderables = {};
    const { registerStorageStateReader } = await import('@/sync/domains/state/storageStateReaderBridge');
    registerStorageStateReader(() => storageState);
});

describe('sessionReadState', () => {
    it('reads the maintained unread watermark without visiting historical messages', () => {
        let historicalVisits = 0;
        const messages = Array.from({ length: 400 }, (_, index): Message => ({
            id: `history-${index}`,
            seq: index + 1,
            localId: null,
            kind: 'agent-text',
            text: 'done',
            createdAt: index + 1,
            get transcriptObservationProvenance() {
                historicalVisits += 1;
                return undefined;
            },
        }));
        const renderableAggregate = buildTranscriptRenderableAggregate({ messages, completedRequests: null });
        (storageState as { sessionMessages: Record<string, unknown> }).sessionMessages = {
            s_aggregate: {
                isLoaded: true,
                messageIdsOldestFirst: messages.map((message) => message.id),
                messagesById: Object.fromEntries(messages.map((message) => [message.id, message])),
                renderableAggregate,
            },
        };
        historicalVisits = 0;

        expect(deriveSessionReadState({
            id: 's_aggregate',
            seq: 400,
            lastViewedSessionSeq: 400,
            latestTurnStatus: 'completed',
            metadata: null,
        })).toBe('read');
        expect(historicalVisits).toBe(0);
    });

    it('derives empty state when a session has no committed activity', () => {
        expect(deriveSessionReadState({ seq: 0, lastViewedSessionSeq: null, metadata: null })).toBe('empty');
        expect(resolveSessionReadStateAction({ seq: 0, lastViewedSessionSeq: null, metadata: null })).toEqual({
            kind: 'none',
            visible: false,
        });
    });

    it('ignores non-terminal raw session seq when deriving read-state actions', () => {
        const session = {
            id: 's_raw',
            seq: 3,
            lastViewedSessionSeq: 2,
            latestTurnStatus: 'in_progress' as const,
            metadata: null,
        };

        expect(deriveSessionReadState(session)).toBe('empty');
        expect(resolveSessionReadStateAction(session)).toEqual({
            kind: 'none',
            visible: false,
        });
    });

    it('derives unread state from a committed stored message and offers mark-read', () => {
        (storageState as { sessionMessages: Record<string, unknown> }).sessionMessages = {
            s_message: {
                isLoaded: true,
                messageIdsOldestFirst: ['m3'],
                messagesById: {
                    m3: {
                        id: 'm3',
                        seq: 3,
                        localId: null,
                        kind: 'agent-text',
                        text: 'done',
                        createdAt: 100,
                    },
                },
            },
        };
        const session = {
            id: 's_message',
            seq: 9,
            lastViewedSessionSeq: 2,
            latestTurnStatus: 'in_progress' as const,
            metadata: null,
        };

        expect(deriveSessionReadState(session)).toBe('unread');
        expect(resolveSessionReadStateAction(session)).toEqual({
            kind: 'mark-read',
            visible: true,
            targetState: 'read',
        });
    });

    it('ignores trailing maintenance events when deriving manual read-state actions', () => {
        (storageState as { sessionMessages: Record<string, unknown> }).sessionMessages = {
            s_maintenance: {
                isLoaded: true,
                messageIdsOldestFirst: ['m-visible', 'm-switch'],
                messagesById: {
                    'm-visible': {
                        id: 'm-visible',
                        seq: 945,
                        localId: null,
                        kind: 'agent-text',
                        text: 'done',
                        createdAt: 100,
                    },
                    'm-switch': {
                        id: 'm-switch',
                        seq: 946,
                        kind: 'agent-event',
                        createdAt: 101,
                        event: {
                            type: 'connected-service-account-switch',
                            serviceId: 'openai-codex',
                            groupId: 'codex-main',
                            fromProfileId: 'profile-a',
                            toProfileId: 'profile-b',
                            reason: 'usage_limit',
                            mode: 'hot_apply',
                        },
                    },
                },
            },
        };
        const session = {
            id: 's_maintenance',
            seq: 946,
            lastViewedSessionSeq: 945,
            latestMessageSeq: 946,
            latestTurnStatus: 'in_progress' as const,
            metadata: null,
        };

        expect(deriveSessionReadState(session)).toBe('read');
        expect(resolveSessionReadStateAction(session)).toEqual({
            kind: 'mark-unread',
            visible: true,
            targetState: 'unread',
        });
    });

    it('does not let a partial stored transcript suppress terminal session activity', () => {
        (storageState as { sessionMessages: Record<string, unknown> }).sessionMessages = {
            s_partial: {
                isLoaded: false,
                messageIdsOldestFirst: ['m110'],
                messagesById: {
                    m110: {
                        id: 'm110',
                        seq: 110,
                        localId: null,
                        kind: 'agent-text',
                        text: 'older visible message',
                        createdAt: 100,
                    },
                },
            },
        };
        const session = {
            id: 's_partial',
            seq: 742,
            lastViewedSessionSeq: 741,
            latestReadyEventSeq: 110,
            latestTurnStatus: 'completed' as const,
            metadata: null,
        };

        expect(deriveSessionReadState(session)).toBe('unread');
        expect(resolveSessionReadStateAction(session)).toEqual({
            kind: 'mark-read',
            visible: true,
            targetState: 'read',
        });
    });

    it('preserves loaded-empty transcript fallback rules', () => {
        const session = {
            id: 's_empty',
            seq: 9,
            latestMessageSeq: 8,
            lastViewedSessionSeq: 7,
            latestTurnStatus: 'in_progress' as const,
            metadata: null,
        };
        expect(deriveSessionReadState(session)).toBe('unread');
        (storageState as { sessionMessages: Record<string, unknown> }).sessionMessages = {
            s_empty: { isLoaded: true, messageIdsOldestFirst: [], messagesById: {} },
        };
        expect(deriveSessionReadState(session)).toBe('empty');
        expect(deriveSessionReadState({ ...session, latestTurnStatus: 'completed' })).toBe('unread');
    });

    it('derives unread state from a ready event and offers mark-read', () => {
        const session = {
            seq: 3,
            lastViewedSessionSeq: 2,
            latestReadyEventSeq: 3,
            latestTurnStatus: 'in_progress' as const,
            metadata: null,
        };

        expect(deriveSessionReadState(session)).toBe('unread');
        expect(resolveSessionReadStateAction(session)).toEqual({
            kind: 'mark-read',
            visible: true,
            targetState: 'read',
        });
    });

    it('derives read state from a current cursor and offers mark-unread', () => {
        const session = {
            seq: 3,
            lastViewedSessionSeq: 3,
            latestTurnStatus: 'completed' as const,
            metadata: null,
        };

        expect(deriveSessionReadState(session)).toBe('read');
        expect(resolveSessionReadStateAction(session)).toEqual({
            kind: 'mark-unread',
            visible: true,
            targetState: 'unread',
        });
    });

    it('uses renderable unread state when committed transcript details are not available', () => {
        const session = {
            id: 's_renderable',
            seq: 7,
            lastViewedSessionSeq: 7,
            latestTurnStatus: 'in_progress' as const,
            metadata: null,
            hasUnreadMessages: true,
        };

        expect(deriveSessionReadState(session)).toBe('unread');
        expect(resolveSessionReadStateAction(session)).toEqual({
            kind: 'mark-read',
            visible: true,
            targetState: 'read',
        });
    });

    it('uses registered row renderable unread state for full sessions without committed transcript details', () => {
        (storageState as { sessionListRenderables: Record<string, unknown> }).sessionListRenderables = {
            s_renderable_cache: {
                id: 's_renderable_cache',
                seq: 7,
                lastViewedSessionSeq: 7,
                hasUnreadMessages: true,
            },
        };
        const session = {
            id: 's_renderable_cache',
            seq: 7,
            lastViewedSessionSeq: 7,
            latestTurnStatus: 'in_progress' as const,
            metadata: null,
        };

        expect(deriveSessionReadState(session)).toBe('unread');
        expect(resolveSessionReadStateAction(session)).toEqual({
            kind: 'mark-read',
            visible: true,
            targetState: 'read',
        });
    });

    it('uses registered row renderable unread state over a stale full-session read cursor', () => {
        (storageState as { sessionListRenderables: Record<string, unknown> }).sessionListRenderables = {
            s_stale_full_session: {
                id: 's_stale_full_session',
                seq: 7,
                lastViewedSessionSeq: 6,
                hasUnreadMessages: true,
            },
        };
        const session = {
            id: 's_stale_full_session',
            seq: 7,
            lastViewedSessionSeq: 7,
            latestReadyEventSeq: 7,
            latestTurnStatus: 'in_progress' as const,
            metadata: null,
        };

        expect(deriveSessionReadState(session)).toBe('unread');
        expect(resolveSessionReadStateAction(session)).toEqual({
            kind: 'mark-read',
            visible: true,
            targetState: 'read',
        });
    });

    it('falls back to legacy readStateV1 when the top-level cursor is missing', () => {
        const session = {
            seq: 3,
            lastViewedSessionSeq: null,
            latestTurnStatus: 'completed' as const,
            metadata: {
                path: '/repo',
                host: 'localhost',
                readStateV1: { v: 1 as const, sessionSeq: 3, pendingActivityAt: 0, updatedAt: 1 },
            },
        };

        expect(deriveSessionReadState(session)).toBe('read');
        expect(resolveSessionReadStateAction(session)).toEqual({
            kind: 'mark-unread',
            visible: true,
            targetState: 'unread',
        });
    });

    it('hides manual read-state actions for view-only shared sessions', () => {
        const session = {
            seq: 3,
            lastViewedSessionSeq: 2,
            latestTurnStatus: 'completed' as const,
            metadata: null,
            accessLevel: 'view' as const,
        };

        expect(deriveSessionReadState(session)).toBe('unread');
        expect(resolveSessionReadStateAction(session)).toEqual({
            kind: 'none',
            visible: false,
        });
    });
});
