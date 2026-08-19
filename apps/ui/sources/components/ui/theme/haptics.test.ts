import { describe, expect, it, vi, beforeEach } from 'vitest';

const selectionAsync = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const impactAsync = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const notificationAsync = vi.hoisted(() => vi.fn(() => Promise.resolve()));

// `expo-haptics` is a genuine platform boundary (native haptic engine); everything
// beneath it in this module stays real.
vi.mock('expo-haptics', () => ({
    selectionAsync,
    impactAsync,
    notificationAsync,
    ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
    NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
}));

import { hapticsError, hapticsLight, hapticsSelection } from './haptics';
import {
    hapticsError as webHapticsError,
    hapticsLight as webHapticsLight,
    hapticsSelection as webHapticsSelection,
} from './haptics.web';

beforeEach(() => {
    selectionAsync.mockClear();
    impactAsync.mockClear();
    notificationAsync.mockClear();
});

describe('haptics (native)', () => {
    it('routes a selection tick to the platform selection API', () => {
        hapticsSelection();

        expect(selectionAsync).toHaveBeenCalledTimes(1);
    });

    it('does not emit an impact or notification for a selection tick', () => {
        // A picker ticks once per index change while scrubbing. Reusing the
        // impact-class `hapticsLight` at that frequency reads as a stutter, so the
        // selection helper must be its own feedback class, not an alias.
        hapticsSelection();

        expect(impactAsync).not.toHaveBeenCalled();
        expect(notificationAsync).not.toHaveBeenCalled();
    });

    it('keeps the existing light impact contract', () => {
        hapticsLight();

        expect(impactAsync).toHaveBeenCalledTimes(1);
        expect(impactAsync).toHaveBeenCalledWith('light');
        expect(selectionAsync).not.toHaveBeenCalled();
    });

    it('keeps the existing error notification contract', () => {
        hapticsError();

        expect(notificationAsync).toHaveBeenCalledTimes(1);
        expect(notificationAsync).toHaveBeenCalledWith('error');
        expect(selectionAsync).not.toHaveBeenCalled();
    });
});

describe('haptics (web twin)', () => {
    it('exposes the same surface as no-ops that never reach a native API', () => {
        expect(() => webHapticsSelection()).not.toThrow();
        expect(() => webHapticsLight()).not.toThrow();
        expect(() => webHapticsError()).not.toThrow();

        expect(selectionAsync).not.toHaveBeenCalled();
        expect(impactAsync).not.toHaveBeenCalled();
        expect(notificationAsync).not.toHaveBeenCalled();
    });
});
