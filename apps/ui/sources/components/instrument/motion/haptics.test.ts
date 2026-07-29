import { beforeEach, describe, expect, it, vi } from 'vitest';

const { selectionAsync, impactAsync } = vi.hoisted(() => ({
    selectionAsync: vi.fn(() => Promise.resolve()),
    impactAsync: vi.fn(() => Promise.resolve()),
}));

vi.mock('expo-haptics', () => ({
    selectionAsync,
    impactAsync,
    ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
    NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
}));

import { instrumentSelectionTick, instrumentThresholdImpact } from './haptics';

describe('instrument haptics gating', () => {
    beforeEach(() => {
        selectionAsync.mockClear();
        impactAsync.mockClear();
    });

    it('does not fire when disabled', () => {
        instrumentSelectionTick(false);
        instrumentThresholdImpact(false);
        expect(selectionAsync).not.toHaveBeenCalled();
        expect(impactAsync).not.toHaveBeenCalled();
    });

    it('fires a selection tick when enabled (native)', () => {
        instrumentSelectionTick(true);
        expect(selectionAsync).toHaveBeenCalledTimes(1);
        expect(impactAsync).not.toHaveBeenCalled();
    });

    it('fires a medium impact for threshold crossings when enabled', () => {
        instrumentThresholdImpact(true);
        expect(impactAsync).toHaveBeenCalledTimes(1);
        expect(impactAsync).toHaveBeenCalledWith('medium');
    });

    it('swallows rejected haptic promises without throwing', () => {
        selectionAsync.mockImplementationOnce(() => Promise.reject(new Error('no haptics')));
        expect(() => instrumentSelectionTick(true)).not.toThrow();
    });
});
