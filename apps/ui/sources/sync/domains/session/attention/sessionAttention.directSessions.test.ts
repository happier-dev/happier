import { describe, expect, it } from 'vitest';

import { deriveSessionAttentionFlags } from './sessionAttention';

describe('sessionAttention (direct sessions)', () => {
    it('treats linked direct sessions with a newer observed token as unread', () => {
        const flags = deriveSessionAttentionFlags({
            id: 's1',
            seq: 0,
            createdAt: 0,
            updatedAt: 0,
            active: false,
            activeAt: 0,
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
                directSessionV1: {
                    v: 1,
                    providerId: 'codex',
                    machineId: 'machine-1',
                    remoteSessionId: 'remote-1',
                    source: { kind: 'codexHome', home: 'user' },
                },
                directSessionAttentionV1: {
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
                directSessionV1: {
                    v: 1,
                    providerId: 'codex',
                    machineId: 'machine-1',
                    remoteSessionId: 'remote-1',
                    source: { kind: 'codexHome', home: 'user' },
                },
                directSessionAttentionV1: {
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
                directSessionV1: {
                    v: 1,
                    providerId: 'codex',
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
                directSessionV1: {
                    v: 1,
                    providerId: 'codex',
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
});
