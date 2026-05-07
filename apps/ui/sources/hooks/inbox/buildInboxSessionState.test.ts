import { describe, expect, it } from 'vitest';

import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { Session } from '@/sync/domains/state/storageTypes';

import { buildInboxSessionState } from './buildInboxSessionState';

function makeUnreadRenderable(overrides: Partial<SessionListRenderableSession> = {}): SessionListRenderableSession {
    return {
        id: 'session-1',
        seq: 4,
        createdAt: 1,
        updatedAt: 10,
        active: true,
        activeAt: 1,
        metadataVersion: 0,
        agentStateVersion: 0,
        metadata: null,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        hasUnreadMessages: true,
        ...overrides,
    };
}

function makeSession(overrides: Partial<Session> = {}): Session {
    return {
        id: 'session-1',
        seq: 4,
        createdAt: 1,
        updatedAt: 10,
        active: true,
        activeAt: 1,
        archivedAt: null,
        pendingVersion: 0,
        pendingCount: 0,
        lastViewedSessionSeq: 1,
        metadataVersion: 0,
        agentStateVersion: 0,
        metadata: null,
        agentState: null,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        ...overrides,
    } as Session;
}

describe('buildInboxSessionState', () => {
    it('deduplicates unread session rows by canonical session id', () => {
        const firstSession = makeUnreadRenderable({ id: 'session-1', updatedAt: 20 });
        const duplicateSession = makeUnreadRenderable({ id: 'session-1', updatedAt: 10 });

        const state = buildInboxSessionState({
            sessions: [],
            sessionRows: [firstSession, duplicateSession],
        });

        expect(state.unreadSessions).toEqual([firstSession]);
    });

    it('uses canonical unread state when a stale renderable says the hydrated session is read', () => {
        const canonicalSession = makeSession({ id: 'session-1', seq: 4, lastViewedSessionSeq: 1 });
        const staleRenderable = makeUnreadRenderable({
            id: 'session-1',
            seq: 4,
            lastViewedSessionSeq: 4,
            hasUnreadMessages: false,
        });

        const state = buildInboxSessionState({
            sessions: [canonicalSession],
            sessionRows: [staleRenderable],
        });

        expect(state.unreadSessions).toEqual([canonicalSession]);
    });

    it('uses canonical read state when a stale renderable says the hydrated session is unread', () => {
        const canonicalSession = makeSession({ id: 'session-1', seq: 4, lastViewedSessionSeq: 4 });
        const staleRenderable = makeUnreadRenderable({
            id: 'session-1',
            seq: 4,
            lastViewedSessionSeq: 1,
            hasUnreadMessages: true,
        });

        const state = buildInboxSessionState({
            sessions: [canonicalSession],
            sessionRows: [staleRenderable],
        });

        expect(state.unreadSessions).toEqual([]);
    });

    it('excludes undecryptable session rows from unread attention', () => {
        const unavailableRenderable = makeUnreadRenderable({
            id: 'session-unknown',
            metadata: null,
            metadataUnavailable: true,
            hasUnreadMessages: true,
        });

        const state = buildInboxSessionState({
            sessions: [],
            sessionRows: [unavailableRenderable],
        });

        expect(state.unreadSessions).toEqual([]);
    });

    it('excludes hidden system sessions from inbox attention', () => {
        const hiddenSession = makeSession({
            id: 'voice-carrier',
            pendingCount: 1,
            metadata: {
                path: '/tmp/voice-carrier',
                host: 'test-host',
                systemSessionV1: { v: 1, key: 'voice_carrier', hidden: true },
            },
            agentState: {
                controlledByUser: null,
                requests: {
                    request_1: {
                        tool: 'Voice',
                        kind: 'user_action',
                        arguments: {},
                        createdAt: 10,
                    },
                },
            },
        });
        const hiddenRenderable = makeUnreadRenderable({
            id: 'voice-carrier',
            metadata: {
                path: '/tmp/voice-carrier',
                hiddenSystemSession: true,
            },
            hasUnreadMessages: true,
        });

        const state = buildInboxSessionState({
            sessions: [hiddenSession],
            sessionRows: [hiddenRenderable],
        });

        expect(state.sessionsNeedingAttention).toEqual([]);
        expect(state.unreadSessions).toEqual([]);
    });
});
