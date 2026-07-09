import { describe, expect, it } from 'vitest';
import type { TranscriptViewportLifecycleEffect } from './lifecycle';
import { resolveContentGrowthLiveTailCommandApplyEffect } from './contentGrowthLiveTailCommand';

describe('content-growth live-tail command selector', () => {
    it('returns null when no lifecycle effect requests a live-tail command', () => {
        expect(resolveContentGrowthLiveTailCommandApplyEffect({
            effects: [],
            sessionId: 'session-a',
        })).toBeNull();
    });

    it('ignores live-tail commands for another session', () => {
        const effects: readonly TranscriptViewportLifecycleEffect[] = [
            {
                command: {
                    reason: 'content-size-change',
                    type: 'scroll-to-live-tail',
                },
                sessionId: 'session-b',
                type: 'command',
            },
        ];

        expect(resolveContentGrowthLiveTailCommandApplyEffect({
            effects,
            sessionId: 'session-a',
        })).toBeNull();
    });

    it('ignores non-command effects for the same session', () => {
        const effects: readonly TranscriptViewportLifecycleEffect[] = [
            {
                distanceFromLiveTailPx: 0,
                isPinned: true,
                sessionId: 'session-a',
                source: 'mode-following',
                type: 'viewport-change',
            },
        ];

        expect(resolveContentGrowthLiveTailCommandApplyEffect({
            effects,
            sessionId: 'session-a',
        })).toBeNull();
    });

    it('returns the first current-session live-tail command and preserves its reason', () => {
        const effects: readonly TranscriptViewportLifecycleEffect[] = [
            {
                command: {
                    reason: 'content-size-change',
                    type: 'scroll-to-live-tail',
                },
                sessionId: 'session-a',
                type: 'command',
            },
            {
                command: {
                    reason: 'layout-change',
                    type: 'scroll-to-live-tail',
                },
                sessionId: 'session-a',
                type: 'command',
            },
        ];

        expect(resolveContentGrowthLiveTailCommandApplyEffect({
            effects,
            sessionId: 'session-a',
        })).toEqual({
            reason: 'content-size-change',
            sessionId: 'session-a',
            type: 'apply-content-growth-live-tail-command',
        });
    });
});
