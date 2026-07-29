import { describe, expect, it } from 'vitest';

import { deriveSessionAttentionFlags, hasSessionAttention } from './sessionAttention';

describe('sessionAttention (direct sessions)', () => {
    it('treats failed primary runtime issues as session attention', () => {
        expect(hasSessionAttention({
            id: 's1',
            seq: 0,
            createdAt: 0,
            updatedAt: 0,
            active: true,
            activeAt: 0,
            metadata: {},
            agentState: null,
            pendingCount: 0,
            latestTurnStatus: 'failed',
            lastRuntimeIssue: {
                v: 1,
                scope: 'primary_session',
                status: 'failed',
                source: 'agent_status_error',
                code: 'agent_status_error',
                occurredAt: 1,
            },
        } as any)).toBe(true);
    });

    it('treats linked direct sessions with a newer observed token as unread', () => {
        const flags = deriveSessionAttentionFlags({
            id: 's1',
            seq: 0,
            createdAt: 0,
            updatedAt: 0,
            active: false,
            activeAt: 0,
            metadata: {
                externalSessionV1: {
                    v: 1,
                    agentId: 'codex',
                    machineId: 'machine-1',
                    remoteSessionId: 'remote-1',
                    source: { kind: 'codexHome', home: 'user' },
                },
                externalSessionAttentionV1: {
                    v: 1,
                    observedProgressToken: 'marker-2',
                    viewedProgressToken: 'marker-1',
                },
            },
            agentState: null,
            pendingCount: 0,
        } as any);

        expect(flags.hasUnread).toBe(true);
    });

    it('treats linked direct sessions with only an observed token as unread', () => {
        const flags = deriveSessionAttentionFlags({
            id: 's1',
            seq: 0,
            createdAt: 0,
            updatedAt: 0,
            active: false,
            activeAt: 0,
            metadata: {
                externalSessionV1: {
                    v: 1,
                    agentId: 'codex',
                    machineId: 'machine-1',
                    remoteSessionId: 'remote-1',
                    source: { kind: 'codexHome', home: 'user' },
                },
                externalSessionAttentionV1: {
                    v: 1,
                    observedProgressToken: 'marker-1',
                },
            },
            agentState: null,
            pendingCount: 0,
        } as any);

        expect(flags.hasUnread).toBe(true);
    });

    it('treats linked direct sessions with matching observed and viewed timestamps as read', () => {
        const flags = deriveSessionAttentionFlags({
            id: 's1',
            seq: 0,
            createdAt: 0,
            updatedAt: 0,
            active: false,
            activeAt: 0,
            metadata: {
                externalSessionV1: {
                    v: 1,
                    agentId: 'codex',
                    machineId: 'machine-1',
                    remoteSessionId: 'remote-1',
                    source: { kind: 'codexHome', home: 'user' },
                },
                externalSessionAttentionV1: {
                    v: 1,
                    observedAtMs: 100,
                    viewedAtMs: 100,
                },
            },
            agentState: null,
            pendingCount: 0,
        } as any);

        expect(flags.hasUnread).toBe(false);
    });

    it('ignores direct-session follow policy when deriving unread state for linked direct sessions', () => {
        const flags = deriveSessionAttentionFlags({
            id: 's1',
            seq: 0,
            lastViewedSessionSeq: 0,
            createdAt: 0,
            updatedAt: 0,
            active: false,
            activeAt: 0,
            metadata: {
                externalSessionV1: {
                    v: 1,
                    agentId: 'codex',
                    machineId: 'machine-1',
                    remoteSessionId: 'remote-1',
                    source: { kind: 'codexHome', home: 'user' },
                    followPolicyV1: {
                        v: 1,
                        policy: 'background_follow',
                    },
                },
            },
            agentState: null,
            pendingCount: 0,
        } as any);

        expect(flags.hasUnread).toBe(false);
    });

    it('falls back to committed transcript seq when direct-session markers are absent', () => {
        const flags = deriveSessionAttentionFlags({
            id: 's1',
            seq: 3,
            createdAt: 0,
            updatedAt: 0,
            active: false,
            activeAt: 0,
            metadata: {
                externalSessionV1: {
                    v: 1,
                    agentId: 'codex',
                    machineId: 'machine-1',
                    remoteSessionId: 'remote-1',
                    source: { kind: 'codexHome', home: 'user' },
                },
            },
            agentState: null,
            pendingCount: 0,
            lastViewedSessionSeq: 1,
        } as any);

        expect(flags.hasUnread).toBe(true);
    });

    it('does not treat normal non-terminal raw session seq as unread activity', () => {
        const flags = deriveSessionAttentionFlags({
            id: 's1',
            seq: 3,
            createdAt: 0,
            updatedAt: 0,
            active: true,
            activeAt: 0,
            metadata: null,
            agentState: null,
            pendingCount: 0,
            latestTurnStatus: 'in_progress',
            lastViewedSessionSeq: 2,
        } as any);

        expect(flags.hasUnread).toBe(false);
        expect(hasSessionAttention({
            id: 's1',
            seq: 3,
            createdAt: 0,
            updatedAt: 0,
            active: true,
            activeAt: 0,
            metadata: null,
            agentState: null,
            pendingCount: 0,
            latestTurnStatus: 'in_progress',
            lastViewedSessionSeq: 2,
        } as any)).toBe(false);
    });

    it('treats terminal normal session seq as readable attention', () => {
        const flags = deriveSessionAttentionFlags({
            id: 's1',
            seq: 3,
            createdAt: 0,
            updatedAt: 0,
            active: false,
            activeAt: 0,
            metadata: null,
            agentState: null,
            pendingCount: 0,
            latestTurnStatus: 'completed',
            lastViewedSessionSeq: 2,
        } as any);

        expect(flags.hasUnread).toBe(true);
    });
});
