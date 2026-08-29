import { describe, expect, it } from 'vitest';

import {
    createTranscriptViewportLifecycle,
    type TranscriptViewportLifecycleEffect,
} from './lifecycle';

function effectTypes(effects: readonly TranscriptViewportLifecycleEffect[]): string[] {
    return effects.map((effect) => effect.type);
}

describe('transcript viewport lifecycle', () => {
    it('preempts both entry restore and explicit jump for web user takeover', () => {
        const lifecycle = createTranscriptViewportLifecycle();
        lifecycle.dispatch({
            sessionId: 'session-a',
            shouldFollowLiveTail: true,
            type: 'session-entry',
        });

        const transition = lifecycle.dispatch({
            sessionId: 'session-a',
            type: 'web-user-scroll-takeover',
        });

        expect(effectTypes(transition.effects)).toEqual([
            'web-user-scroll-preempt-entry-restore',
            'web-user-scroll-preempt-explicit-jump',
        ]);
    });

    it('initializes a following session entry at the live tail and emits entry reset effects', () => {
        const lifecycle = createTranscriptViewportLifecycle();

        const transition = lifecycle.dispatch({
            platform: 'native',
            sessionId: 'session-a',
            shouldFollowLiveTail: true,
            type: 'session-entry',
        });

        expect(transition.state).toMatchObject({
            fingerDown: false,
            followMode: 'following',
            gesturePhase: 'settled',
            sessionId: 'session-a',
        });
        expect(transition.effects).toEqual(expect.arrayContaining([
            {
                distanceFromLiveTailPx: 0,
                isPinned: true,
                sessionId: 'session-a',
                shouldRestoreViewport: false,
                type: 'session-entry-viewport',
            },
            {
                sessionId: 'session-a',
                shouldArmConfirmation: true,
                type: 'session-entry-native-entry-settle-confirmation-reset',
            },
            {
                openEntryTransaction: true,
                sessionId: 'session-a',
                type: 'session-entry-command-controller-reset',
            },
            {
                sessionId: 'session-a',
                type: 'session-entry-measurement-reset',
            },
        ]));
    });

    it('initializes a restored session entry away from the live tail', () => {
        const lifecycle = createTranscriptViewportLifecycle();

        const transition = lifecycle.dispatch({
            entryDistanceFromLiveTailPx: 320.8,
            platform: 'web',
            sessionId: 'session-a',
            shouldFollowLiveTail: false,
            type: 'session-entry',
        });

        expect(transition.state).toMatchObject({
            fingerDown: false,
            followMode: 'released',
            gesturePhase: 'settled',
            sessionId: 'session-a',
        });
        expect(transition.effects).toEqual(expect.arrayContaining([
            {
                distanceFromLiveTailPx: 320,
                isPinned: false,
                sessionId: 'session-a',
                shouldRestoreViewport: true,
                type: 'session-entry-viewport',
            },
            {
                openEntryTransaction: true,
                sessionId: 'session-a',
                type: 'session-entry-command-controller-reset',
            },
        ]));
    });

    it('tracks drag start, drag end, and momentum settle phases', () => {
        const lifecycle = createTranscriptViewportLifecycle();
        lifecycle.dispatch({
            sessionId: 'session-a',
            shouldFollowLiveTail: true,
            type: 'session-entry',
        });

        const dragStart = lifecycle.dispatch({
            sessionId: 'session-a',
            type: 'gesture-start',
        });

        expect(dragStart.state).toMatchObject({
            fingerDown: true,
            followMode: 'escaping',
            gesturePhase: 'dragging',
        });
        expect(dragStart.effects).toEqual(expect.arrayContaining([
            {
                active: true,
                sessionId: 'session-a',
                type: 'native-drag-active-mirror',
            },
            {
                sessionId: 'session-a',
                type: 'native-bottom-follow-rearm-reset',
            },
        ]));

        const dragEnd = lifecycle.dispatch({
            distanceFromLiveTailPx: 240,
            pinThresholdPx: 72,
            sessionId: 'session-a',
            type: 'gesture-end',
        });

        expect(dragEnd.state).toMatchObject({
            fingerDown: false,
            followMode: 'released',
            gesturePhase: 'momentum',
        });

        const settled = lifecycle.dispatch({
            distanceFromLiveTailPx: 240,
            pinThresholdPx: 72,
            sessionId: 'session-a',
            type: 'momentum-settle',
        });

        expect(settled.state).toMatchObject({
            fingerDown: false,
            followMode: 'released',
            gesturePhase: 'settled',
        });
    });

    it('keeps repeated gesture-start events idempotent and preserves the original pre-gesture mode', () => {
        const lifecycle = createTranscriptViewportLifecycle();
        lifecycle.dispatch({
            sessionId: 'session-a',
            shouldFollowLiveTail: true,
            type: 'session-entry',
        });
        lifecycle.dispatch({
            sessionId: 'session-a',
            type: 'gesture-start',
        });
        lifecycle.dispatch({
            sessionId: 'session-a',
            type: 'gesture-start',
        });

        const dragEnd = lifecycle.dispatch({
            distanceFromLiveTailPx: 0,
            pinThresholdPx: 72,
            sessionId: 'session-a',
            type: 'gesture-end',
        });

        expect(dragEnd.state).toMatchObject({
            followMode: 'following',
            gesturePhase: 'momentum',
        });
        expect(effectTypes(dragEnd.effects)).not.toContain('viewport-change');
        expect(effectTypes(dragEnd.effects)).not.toContain('drain-deferred-newer');
        expect(dragEnd.effects).toContainEqual({
            distanceFromLiveTailPx: 0,
            sessionId: 'session-a',
            type: 'native-bottom-follow-rearm',
        });
    });

    it('emits viewport-change and deferred-newer drain effects atomically when a released reader returns to the live tail', () => {
        const lifecycle = createTranscriptViewportLifecycle();
        lifecycle.dispatch({
            sessionId: 'session-a',
            shouldFollowLiveTail: false,
            type: 'session-entry',
        });

        const transition = lifecycle.dispatch({
            distanceFromLiveTailPx: 24,
            movement: 'toward-live-tail',
            pinThresholdPx: 72,
            sessionId: 'session-a',
            trustedUserMovement: true,
            type: 'facts-observed',
        });

        expect(transition.state).toMatchObject({
            followMode: 'following',
            gesturePhase: 'settled',
        });
        expect(transition.effects).toEqual([
            {
                distanceFromLiveTailPx: 24,
                isPinned: true,
                sessionId: 'session-a',
                source: 'mode-following',
                type: 'viewport-change',
            },
            {
                distanceFromLiveTailPx: 24,
                isPinned: true,
                sessionId: 'session-a',
                type: 'drain-deferred-newer',
            },
        ]);
    });
});
