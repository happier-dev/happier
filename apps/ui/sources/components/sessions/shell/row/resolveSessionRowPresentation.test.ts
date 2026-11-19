import { describe, expect, it } from 'vitest';

import { resolveSessionRowPresentation } from './resolveSessionRowPresentation';

describe('resolveSessionRowPresentation', () => {
    it('keeps the canonical failed status and simultaneous request together', () => {
        const status = { state: 'failed', bucket: 'needs_you', tone: 'danger', word: 'Failed', attentionType: 'approval' } as const;
        const requestRef = { kind: 'permission', serverId: 'home-a', sessionId: 'failure', requestId: 'approval-1', turnId: 'turn-1' } as const;
        const row = resolveSessionRowPresentation({ status, requestRef });
        expect(row.status).toBe(status);
        expect(row.requestRef).toBe(requestRef);
        expect(row.accessibilityStatusText).toBe(status.word);
        expect(row.titleTone).toBe('emphasized');
    });

    it('does not turn quiet admitted questions into emphasized requests', () => {
        const status = { state: 'action_required', bucket: 'needs_you', tone: 'neutral', word: 'Manager handling this', attentionType: 'decision' } as const;
        const row = resolveSessionRowPresentation({ status });
        expect(row.status).toBe(status);
        expect(row.titleTone).toBe('normal');
        expect(row.accessibilityStatusText).toBe(status.word);
    });

    it('retains the owner words for unavailable, stopped, usage-limited and viewer news states', () => {
        for (const state of ['unknown', 'locked', 'stopped', 'usage_limited', 'finished_unseen', 'mentioned', 'unread']) {
            const status = { state, bucket: 'idle', tone: 'neutral', word: `owner:${state}`, attentionType: null } as const;
            const row = resolveSessionRowPresentation({ status });
            expect(row.status).toBe(status);
            expect(row.statusText).toBe(status.word);
            expect(row.accessibilityStatusText).toBe(status.word);
        }
    });

    it('quiets the title of an idle row', () => {
        const status = { state: 'waiting', bucket: 'idle', tone: 'neutral', word: 'Idle', attentionType: null } as const;
        expect(resolveSessionRowPresentation({ status }).titleTone).toBe('quiet');
    });
});
