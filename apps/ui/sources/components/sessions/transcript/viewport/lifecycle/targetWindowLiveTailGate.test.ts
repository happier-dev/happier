import { describe, expect, it } from 'vitest';

import {
    resolveTargetWindowLiveTailGate,
    shouldResetTargetWindowForViewportTransition,
} from './targetWindowLiveTailGate';

describe('target window live-tail gate', () => {
    it('blocks automatic live-tail follow while a target window is active', () => {
        expect(resolveTargetWindowLiveTailGate({
            targetWindowActive: true,
            explicitLiveTailCommand: false,
        })).toEqual({
            targetWindowActive: true,
            allowAutomaticLiveTailFollow: false,
        });
    });

    it('allows explicit jump-to-bottom to leave target-window mode through the viewport-change seam', () => {
        expect(resolveTargetWindowLiveTailGate({
            targetWindowActive: true,
            explicitLiveTailCommand: true,
        })).toEqual({
            targetWindowActive: true,
            allowAutomaticLiveTailFollow: true,
        });
        expect(shouldResetTargetWindowForViewportTransition({
            previousSessionId: 'session-1',
            nextSessionId: 'session-1',
            previousRouteKey: 'chain-a',
            nextRouteKey: 'chain-a',
            explicitLiveTailIntent: true,
        })).toBe(true);
    });

    it('resets target-window lifecycle facts across session and route/chain transitions', () => {
        expect(shouldResetTargetWindowForViewportTransition({
            previousSessionId: 'session-1',
            nextSessionId: 'session-2',
            previousRouteKey: 'chain-a',
            nextRouteKey: 'chain-a',
            explicitLiveTailIntent: false,
        })).toBe(true);
        expect(shouldResetTargetWindowForViewportTransition({
            previousSessionId: 'session-1',
            nextSessionId: 'session-1',
            previousRouteKey: 'chain-a',
            nextRouteKey: 'chain-b',
            explicitLiveTailIntent: false,
        })).toBe(true);
    });
});
