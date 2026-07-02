import { beforeEach, describe, expect, it, vi } from 'vitest';

import { deriveSessionReadState, resolveSessionReadStateAction } from './sessionReadState';

const storageState = vi.hoisted(() => ({
    sessionMessages: {} as Record<string, unknown>,
}));
const readStorageState = () => storageState as any;

beforeEach(async () => {
    storageState.sessionMessages = {};
    const { registerStorageStateReader } = await import('@/sync/domains/state/storageStateReaderBridge');
    registerStorageStateReader(readStorageState);
});

describe('sessionReadState', () => {
    it('derives empty state when a session has no committed activity or direct-session progress', () => {
        expect(deriveSessionReadState({ seq: 0, lastViewedSessionSeq: null, metadata: null })).toBe('empty');
        expect(resolveSessionReadStateAction({ seq: 0, lastViewedSessionSeq: null, metadata: null })).toEqual({
            kind: 'none',
            visible: false,
        });
    });

    it('derives empty state from non-terminal raw seq without readable activity', () => {
        const session = { seq: 3, lastViewedSessionSeq: null, latestTurnStatus: 'in_progress' as const, metadata: null };

        expect(deriveSessionReadState(session)).toBe('empty');
        expect(resolveSessionReadStateAction(session)).toEqual({
            kind: 'none',
            visible: false,
        });
    });

    it('derives unread state from terminal seq and offers mark-read', () => {
        const session = { seq: 3, lastViewedSessionSeq: null, latestTurnStatus: 'completed' as const, metadata: null };

        expect(deriveSessionReadState(session)).toBe('unread');
        expect(resolveSessionReadStateAction(session)).toEqual({
            kind: 'mark-read',
            visible: true,
            targetState: 'read',
        });
    });

    it('derives read state from a current cursor and offers mark-unread', () => {
        const session = { seq: 3, lastViewedSessionSeq: 3, latestTurnStatus: 'completed' as const, metadata: null };

        expect(deriveSessionReadState(session)).toBe('read');
        expect(resolveSessionReadStateAction(session)).toEqual({
            kind: 'mark-unread',
            visible: true,
            targetState: 'unread',
        });
    });

    it('derives unread state from ready seq without using raw non-terminal seq', () => {
        const session = {
            seq: 10,
            lastViewedSessionSeq: 4,
            latestTurnStatus: 'in_progress' as const,
            latestReadyEventSeq: 5,
            metadata: null,
        };

        expect(deriveSessionReadState(session)).toBe('unread');
        expect(resolveSessionReadStateAction(session)).toEqual({
            kind: 'mark-read',
            visible: true,
            targetState: 'read',
        });
    });

    it('derives unread state from committed readable messages for non-terminal sessions', () => {
        storageState.sessionMessages = {
            s1: {
                isLoaded: true,
                messageIdsOldestFirst: ['m1'],
                messagesById: {
                    m1: {
                        id: 'm1',
                        kind: 'agent-text',
                        seq: 5,
                        localId: null,
                        createdAt: 1,
                        text: 'visible',
                    },
                },
            },
        };
        const session = {
            id: 's1',
            seq: 6,
            lastViewedSessionSeq: 4,
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

    it('uses direct-session attention before cursor state', () => {
        const session = {
            seq: 0,
            lastViewedSessionSeq: 0,
            metadata: {
                externalSessionV1: {
                    v: 1,
                    providerId: 'codex',
                    machineId: 'machine-1',
                    remoteSessionId: 'remote-1',
                    source: { kind: 'codexHome', home: 'user' },
                },
                externalSessionAttentionV1: {
                    v: 1,
                    observedProgressToken: '2:message',
                    viewedProgressToken: '1:message',
                },
            },
        };

        expect(deriveSessionReadState(session)).toBe('unread');
        expect(resolveSessionReadStateAction(session)).toEqual({
            kind: 'mark-read',
            visible: true,
            targetState: 'read',
        });
    });
});
