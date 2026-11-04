import { describe, expect, it } from 'vitest';

import { resolveSessionRowPresentation } from './resolveSessionRowPresentation';

describe('resolveSessionRowPresentation', () => {
    it('keeps an admitted work headline visible when its Session is otherwise quiet', () => {
        const status = { state: 'waiting', bucket: 'idle', tone: 'neutral', word: '', attentionType: null } as const;
        const row = resolveSessionRowPresentation({ status, density: 'default', requestedSecondaryLineMode: 'status',
            hasPathSubtitle: true, hasWorkHeadline: true });
        expect(row.secondaryLine).toBe('status');
        expect(row.status).toBe(status);
        expect(resolveSessionRowPresentation({ status, density: 'minimal', requestedSecondaryLineMode: 'status',
            hasPathSubtitle: true, hasWorkHeadline: true }).secondaryLine).toBe('none');
        expect(resolveSessionRowPresentation({ status, density: 'default', requestedSecondaryLineMode: 'path',
            hasPathSubtitle: true, hasWorkHeadline: true }).secondaryLine).toBe('path');
    });
    it('keeps offline status spoken when the roster already shows its age', () => {
        const status = { state: 'disconnected', bucket: 'offline', tone: 'neutral', word: 'Offline', attentionType: null } as const;
        const row = resolveSessionRowPresentation({ status, quietWhenOffline: true, density: 'compact', requestedSecondaryLineMode: 'status', hasPathSubtitle: false });
        expect(row.secondaryLine).toBe('none');
        expect(row.status).toBe(status);
        expect(row.accessibilityStatusText).toBe(status.word);
    });
    it('keeps the canonical failed status and simultaneous request together in a minimal row', () => {
        const status = { state: 'failed', bucket: 'needs_you', tone: 'danger', word: 'Failed', attentionType: 'approval' } as const;
        const requestRef = { kind: 'permission', serverId: 'home-a', sessionId: 'failure', requestId: 'approval-1', turnId: 'turn-1' } as const;
        const row = resolveSessionRowPresentation({ status, requestRef, density: 'minimal', requestedSecondaryLineMode: 'path', hasPathSubtitle: true });
        expect(row.status).toBe(status);
        expect(row.requestRef).toBe(requestRef);
        expect(row.secondaryLine).toBe('none');
        expect(row.accessibilityStatusText).toBe(status.word);
        expect(row.titleTone).toBe('emphasized');
    });

    it('does not turn quiet admitted questions into emphasized requests', () => {
        const status = { state: 'action_required', bucket: 'needs_you', tone: 'neutral', word: 'Manager handling this', attentionType: 'decision' } as const;
        const row = resolveSessionRowPresentation({ status, density: 'default', requestedSecondaryLineMode: 'path', hasPathSubtitle: true });
        expect(row.status).toBe(status);
        expect(row.titleTone).toBe('normal');
        expect(row.accessibilityStatusText).toBe(status.word);
    });

    it('retains the owner words for unavailable, stopped, usage-limited and viewer news states', () => {
        for (const state of ['unknown', 'locked', 'stopped', 'usage_limited', 'finished_unseen', 'mentioned', 'unread']) {
            const status = { state, bucket: 'idle', tone: 'neutral', word: `owner:${state}`, attentionType: null } as const;
            const row = resolveSessionRowPresentation({ status, density: 'compact', requestedSecondaryLineMode: 'status', hasPathSubtitle: false });
            expect(row.status).toBe(status);
            expect(row.statusText).toBe(status.word);
            expect(row.accessibilityStatusText).toBe(status.word);
        }
    });

    it('reserves the requested path for a quiet row and never changes status on density changes', () => {
        const status = { state: 'waiting', bucket: 'idle', tone: 'neutral', word: 'Idle', attentionType: null } as const;
        const row = resolveSessionRowPresentation({ status, density: 'default', requestedSecondaryLineMode: 'path', hasPathSubtitle: true });
        expect(row.secondaryLine).toBe('path');
        expect(row.titleTone).toBe('quiet');
        expect(resolveSessionRowPresentation({ status, density: 'minimal', requestedSecondaryLineMode: 'status', hasPathSubtitle: false }).status).toBe(status);
    });
});
