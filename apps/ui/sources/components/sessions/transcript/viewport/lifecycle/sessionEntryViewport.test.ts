import { describe, expect, it } from 'vitest';

import type { TranscriptViewportLifecycleEffect } from './lifecycle';
import { resolveSessionEntryViewportApplyEffects } from './sessionEntryViewport';

const sessionEntryViewportEffect = (
    overrides: Partial<Extract<TranscriptViewportLifecycleEffect, { type: 'session-entry-viewport' }>> = {},
): Extract<TranscriptViewportLifecycleEffect, { type: 'session-entry-viewport' }> => ({
    distanceFromLiveTailPx: 0,
    isPinned: true,
    sessionId: 'session-a',
    shouldRestoreViewport: false,
    type: 'session-entry-viewport',
    ...overrides,
});

describe('session-entry viewport apply effects', () => {
    it('returns no apply effects when none match the current session', () => {
        expect(resolveSessionEntryViewportApplyEffects({
            effects: [],
            sessionId: 'session-a',
        })).toEqual([]);

        expect(resolveSessionEntryViewportApplyEffects({
            effects: [
                sessionEntryViewportEffect({ sessionId: 'session-b' }),
                {
                    distanceFromLiveTailPx: 0,
                    isPinned: true,
                    sessionId: 'session-a',
                    source: 'explicit-return',
                    type: 'viewport-change',
                },
                {
                    sessionId: 'session-a',
                    type: 'session-entry-measurement-reset',
                },
            ],
            sessionId: 'session-a',
        })).toEqual([]);
    });

    it('maps pinned follow-bottom entry to a typed apply effect', () => {
        expect(resolveSessionEntryViewportApplyEffects({
            effects: [sessionEntryViewportEffect()],
            sessionId: 'session-a',
        })).toEqual([
            {
                distanceFromLiveTailPx: 0,
                isPinned: true,
                jumpButtonDistanceFromLiveTailPx: 0,
                sessionId: 'session-a',
                shouldEmitViewportChange: true,
                shouldRestoreViewport: false,
                shouldUseEntryAnchor: false,
                type: 'apply-session-entry-viewport',
            },
        ]);
    });

    it('preserves finite restored entry distance and emits with entry anchor', () => {
        expect(resolveSessionEntryViewportApplyEffects({
            effects: [
                sessionEntryViewportEffect({
                    distanceFromLiveTailPx: 320,
                    isPinned: false,
                    shouldRestoreViewport: true,
                }),
            ],
            sessionId: 'session-a',
        })).toEqual([
            {
                distanceFromLiveTailPx: 320,
                isPinned: false,
                jumpButtonDistanceFromLiveTailPx: 320,
                sessionId: 'session-a',
                shouldEmitViewportChange: true,
                shouldRestoreViewport: true,
                shouldUseEntryAnchor: true,
                type: 'apply-session-entry-viewport',
            },
        ]);
    });

    it('preserves unknown restored distance without fabricating a persisted bottom viewport', () => {
        expect(resolveSessionEntryViewportApplyEffects({
            effects: [
                sessionEntryViewportEffect({
                    distanceFromLiveTailPx: null,
                    isPinned: false,
                    shouldRestoreViewport: true,
                }),
            ],
            sessionId: 'session-a',
        })).toEqual([
            {
                distanceFromLiveTailPx: null,
                isPinned: false,
                jumpButtonDistanceFromLiveTailPx: 0,
                sessionId: 'session-a',
                shouldEmitViewportChange: false,
                shouldRestoreViewport: true,
                shouldUseEntryAnchor: true,
                type: 'apply-session-entry-viewport',
            },
        ]);
    });

    it('ignores unrelated lifecycle effects while preserving matching order and multiplicity', () => {
        expect(resolveSessionEntryViewportApplyEffects({
            effects: [
                {
                    distanceFromLiveTailPx: 0,
                    isPinned: true,
                    sessionId: 'session-a',
                    type: 'drain-deferred-newer',
                },
                sessionEntryViewportEffect({ distanceFromLiveTailPx: 2, isPinned: false, shouldRestoreViewport: true }),
                {
                    reason: 'jump-to-bottom',
                    sessionId: 'session-a',
                    type: 'explicit-jump-preempt-entry-restore',
                },
                {
                    sessionId: 'session-a',
                    type: 'follow-bottom-intent-preempt-entry-restore',
                },
                sessionEntryViewportEffect({ distanceFromLiveTailPx: 0, isPinned: true }),
            ],
            sessionId: 'session-a',
        })).toEqual([
            {
                distanceFromLiveTailPx: 2,
                isPinned: false,
                jumpButtonDistanceFromLiveTailPx: 2,
                sessionId: 'session-a',
                shouldEmitViewportChange: true,
                shouldRestoreViewport: true,
                shouldUseEntryAnchor: true,
                type: 'apply-session-entry-viewport',
            },
            {
                distanceFromLiveTailPx: 0,
                isPinned: true,
                jumpButtonDistanceFromLiveTailPx: 0,
                sessionId: 'session-a',
                shouldEmitViewportChange: true,
                shouldRestoreViewport: false,
                shouldUseEntryAnchor: false,
                type: 'apply-session-entry-viewport',
            },
        ]);
    });
});
