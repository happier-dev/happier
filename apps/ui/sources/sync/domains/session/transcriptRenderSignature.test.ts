import { describe, expect, it } from 'vitest';

import { buildTranscriptRenderSignature } from './transcriptRenderSignature';

function createSession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: 'session-1',
        seq: 4,
        active: true,
        thinking: false,
        accessLevel: 'owner',
        canApprovePermissions: true,
        presence: 'online',
        metadata: {
            path: '/repo',
            summary: { text: 'summary', updatedAt: 1 },
        },
        updatedAt: 10,
        activeAt: 10,
        thinkingAt: 10,
        latestTurnStatus: 'in_progress',
        latestTurnStatusObservedAt: 10,
        meaningfulActivityAt: 10,
        latestReadyEventAt: 10,
        latestUsage: { inputTokens: 1, outputTokens: 2 },
        pendingVersion: 1,
        pendingCount: 1,
        agentStateVersion: 1,
        pendingPermissionRequestCount: 0,
        pendingUserActionRequestCount: 0,
        lastRuntimeIssue: null,
        ...overrides,
    };
}

describe('buildTranscriptRenderSignature', () => {
    it('includes the session sequence cursor because transcript row hydration can change without another prop identity bump', () => {
        const before = createSession({ seq: 4 });
        const after = createSession({ seq: 5 });

        expect(buildTranscriptRenderSignature(after)).not.toBe(buildTranscriptRenderSignature(before));
    });

    it('ignores session-list freshness fields that do not affect transcript rendering', () => {
        const before = createSession();
        const after = createSession({
            updatedAt: 20,
            activeAt: 21,
            thinkingAt: 22,
            latestTurnStatusObservedAt: 23,
            meaningfulActivityAt: 24,
            latestReadyEventAt: 25,
            latestUsage: { inputTokens: 3, outputTokens: 4 },
            pendingVersion: 2,
            pendingCount: 2,
            agentStateVersion: 2,
            pendingPermissionRequestCount: 1,
            pendingUserActionRequestCount: 1,
            lastRuntimeIssue: { code: 'transient' },
        });

        expect(buildTranscriptRenderSignature(after)).toBe(buildTranscriptRenderSignature(before));
    });

    it('treats unknown future session fields as render-relevant by default', () => {
        const before = createSession();
        const after = createSession({ transcriptFutureRenderingMode: 'compact' });

        expect(buildTranscriptRenderSignature(after)).not.toBe(buildTranscriptRenderSignature(before));
    });

    it('uses metadata stability rules instead of raw metadata freshness timestamps', () => {
        const before = createSession();
        const after = createSession({
            metadata: {
                path: '/repo',
                summary: { text: 'summary', updatedAt: 99 },
            },
        });

        expect(buildTranscriptRenderSignature(after)).toBe(buildTranscriptRenderSignature(before));
    });
});
