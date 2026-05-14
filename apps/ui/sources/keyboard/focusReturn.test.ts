import { describe, expect, it, vi } from 'vitest';

import { restoreFocusToBestTarget } from './focusReturn';

describe('focus return helpers', () => {
    it('restores focus to the trigger when it is still connected', () => {
        const triggerFocus = vi.fn();
        const fallbackFocus = vi.fn();

        expect(restoreFocusToBestTarget(
            { current: { focus: triggerFocus, isConnected: true } },
            { current: { focus: fallbackFocus, isConnected: true } },
        )).toBe(true);

        expect(triggerFocus).toHaveBeenCalledTimes(1);
        expect(fallbackFocus).not.toHaveBeenCalled();
    });

    it('falls back to the owning focus zone when the trigger is disconnected', () => {
        const triggerFocus = vi.fn();
        const fallbackFocus = vi.fn();

        expect(restoreFocusToBestTarget(
            { current: { focus: triggerFocus, isConnected: false } },
            { current: { focus: fallbackFocus, isConnected: true } },
        )).toBe(true);

        expect(triggerFocus).not.toHaveBeenCalled();
        expect(fallbackFocus).toHaveBeenCalledTimes(1);
    });
});
