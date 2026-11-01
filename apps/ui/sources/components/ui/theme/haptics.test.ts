import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Platform } from 'react-native';

const selectionAsync = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const impactAsync = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const notificationAsync = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const performAndroidHapticsAsync = vi.hoisted(() => vi.fn(() => Promise.resolve()));

// `expo-haptics` is a genuine platform boundary (native haptic engine); everything
// beneath it in this module stays real.
vi.mock('expo-haptics', () => ({
    selectionAsync,
    impactAsync,
    notificationAsync,
    performAndroidHapticsAsync,
    AndroidHaptics: { Drag_Start: 'drag-start', Segment_Tick: 'segment-tick', Context_Click: 'context-click', Long_Press: 'long-press', Confirm: 'confirm', Reject: 'reject' },
    ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
    NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
}));

import { hapticsDragStart, hapticsError, hapticsLight, hapticsSelection } from './haptics';
import {
    hapticsError as webHapticsError,
    hapticsLight as webHapticsLight,
    hapticsSelection as webHapticsSelection,
    hapticsDragStart as webHapticsDragStart,
} from './haptics.web';

beforeEach(() => {
    Reflect.set(Platform, 'OS', 'ios');
    selectionAsync.mockClear();
    impactAsync.mockClear();
    notificationAsync.mockClear();
    performAndroidHapticsAsync.mockClear();
});

describe('haptics (native)', () => {
    it('acknowledges a native drag pickup with a light impact', async () => {
        await hapticsDragStart();
        expect(impactAsync).toHaveBeenCalledWith('light');
    });

    it('uses Android system gesture feedback for pickup, selection, release, and refusal', async () => {
        Reflect.set(Platform, 'OS', 'android');
        await hapticsDragStart();
        await hapticsSelection();
        await hapticsLight();
        await hapticsError();
        expect(performAndroidHapticsAsync.mock.calls).toEqual([
            ['drag-start'], ['segment-tick'], ['context-click'], ['reject'],
        ]);
        expect(impactAsync).not.toHaveBeenCalled();
        expect(notificationAsync).not.toHaveBeenCalled();
    });

    it('contains device failures and reports them without rejecting the interaction', async () => {
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
        impactAsync.mockRejectedValueOnce(new Error('native failure'));
        try {
            await expect(hapticsLight()).resolves.toBeUndefined();
            expect(warning).toHaveBeenCalled();
        } finally {
            warning.mockRestore();
        }
    });

    it('honors the live device preference for all haptic effects', async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        getStorage().getState().applyLocalSettings({ hapticsEnabled: false });
        try {
            await hapticsDragStart();
            await hapticsSelection();
            await hapticsLight();
            await hapticsError();
            expect(impactAsync).not.toHaveBeenCalled();
            expect(notificationAsync).not.toHaveBeenCalled();
            expect(selectionAsync).not.toHaveBeenCalled();
            expect(performAndroidHapticsAsync).not.toHaveBeenCalled();
            getStorage().getState().applyLocalSettings({ hapticsEnabled: true });
            await hapticsSelection();
            expect(selectionAsync).toHaveBeenCalledTimes(1);
        } finally {
            getStorage().getState().applyLocalSettings({ hapticsEnabled: true });
        }
    });
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
        expect(() => webHapticsDragStart()).not.toThrow();

        expect(selectionAsync).not.toHaveBeenCalled();
        expect(impactAsync).not.toHaveBeenCalled();
        expect(notificationAsync).not.toHaveBeenCalled();
    });
});
