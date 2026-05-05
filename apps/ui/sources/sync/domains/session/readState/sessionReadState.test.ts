import { describe, expect, it } from 'vitest';

import { deriveSessionReadState, resolveSessionReadStateAction } from './sessionReadState';

describe('sessionReadState', () => {
    it('derives empty state when a session has no committed activity or direct-session progress', () => {
        expect(deriveSessionReadState({ seq: 0, lastViewedSessionSeq: null, metadata: null })).toBe('empty');
        expect(resolveSessionReadStateAction({ seq: 0, lastViewedSessionSeq: null, metadata: null })).toEqual({
            kind: 'none',
            visible: false,
        });
    });

    it('derives unread state from a missing cursor and offers mark-read', () => {
        const session = { seq: 3, lastViewedSessionSeq: null, metadata: null };

        expect(deriveSessionReadState(session)).toBe('unread');
        expect(resolveSessionReadStateAction(session)).toEqual({
            kind: 'mark-read',
            visible: true,
            targetState: 'read',
        });
    });

    it('derives read state from a current cursor and offers mark-unread', () => {
        const session = { seq: 3, lastViewedSessionSeq: 3, metadata: null };

        expect(deriveSessionReadState(session)).toBe('read');
        expect(resolveSessionReadStateAction(session)).toEqual({
            kind: 'mark-unread',
            visible: true,
            targetState: 'unread',
        });
    });

    it('falls back to legacy readStateV1 when the top-level cursor is missing', () => {
        const session = {
            seq: 3,
            lastViewedSessionSeq: null,
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
                directSessionV1: {
                    v: 1,
                    providerId: 'codex',
                    machineId: 'machine-1',
                    remoteSessionId: 'remote-1',
                    source: { kind: 'codexHome', home: 'user' },
                },
                directSessionAttentionV1: {
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
