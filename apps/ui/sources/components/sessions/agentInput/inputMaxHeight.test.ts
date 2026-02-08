import { describe, expect, it } from 'vitest';
import { computeAgentInputDefaultMaxHeight, computeNewSessionInputMaxHeight } from './inputMaxHeight';

describe('inputMaxHeight', () => {
    it('reduces default max height when keyboard is open (native)', () => {
        const closed = computeAgentInputDefaultMaxHeight({ platform: 'ios', screenHeight: 800, keyboardHeight: 0 });
        const open = computeAgentInputDefaultMaxHeight({ platform: 'ios', screenHeight: 800, keyboardHeight: 300 });
        expect(open).toBeLessThan(closed);
    });

    it('reduces default max height when keyboard is open (web)', () => {
        const closed = computeAgentInputDefaultMaxHeight({ platform: 'web', screenHeight: 900, keyboardHeight: 0 });
        const open = computeAgentInputDefaultMaxHeight({ platform: 'web', screenHeight: 900, keyboardHeight: 400 });
        expect(open).toBeLessThan(closed);
    });

    it('allocates less space to the input when enhanced wizard is enabled', () => {
        const simple = computeNewSessionInputMaxHeight({ useEnhancedSessionWizard: false, screenHeight: 900, keyboardHeight: 0 });
        const wizard = computeNewSessionInputMaxHeight({ useEnhancedSessionWizard: true, screenHeight: 900, keyboardHeight: 0 });
        expect(wizard).toBeLessThan(simple);
    });

    it('caps /new input more aggressively when keyboard is open (simple)', () => {
        const closed = computeNewSessionInputMaxHeight({ useEnhancedSessionWizard: false, screenHeight: 900, keyboardHeight: 0 });
        const open = computeNewSessionInputMaxHeight({ useEnhancedSessionWizard: false, screenHeight: 900, keyboardHeight: 400 });
        expect(open).toBeLessThan(closed);
        expect(open).toBeLessThanOrEqual(360);
    });

    it('keeps /new wizard input cap when keyboard is open', () => {
        const open = computeNewSessionInputMaxHeight({ useEnhancedSessionWizard: true, screenHeight: 900, keyboardHeight: 400 });
        expect(open).toBeLessThanOrEqual(240);
    });

    it.each([
        { platform: 'ios', screenHeight: 1, keyboardHeight: 0, expected: 120 },
        { platform: 'web', screenHeight: 1, keyboardHeight: 0, expected: 200 },
        { platform: 'ios', screenHeight: 9_999, keyboardHeight: 0, expected: 360 },
        { platform: 'web', screenHeight: 9_999, keyboardHeight: 0, expected: 900 },
        { platform: 'web', screenHeight: 600, keyboardHeight: -300, expected: 675 },
    ])(
        'clamps default max height for platform=$platform screen=$screenHeight keyboard=$keyboardHeight',
        ({ platform, screenHeight, keyboardHeight, expected }) => {
            expect(computeAgentInputDefaultMaxHeight({ platform, screenHeight, keyboardHeight })).toBe(expected);
        },
    );

    it.each([
        { useEnhancedSessionWizard: false, screenHeight: Number.NaN, keyboardHeight: 10, expected: 120 },
        { useEnhancedSessionWizard: false, screenHeight: 10_000, keyboardHeight: 0, expected: 900 },
        { useEnhancedSessionWizard: false, screenHeight: 10_000, keyboardHeight: 3_000, expected: 360 },
        { useEnhancedSessionWizard: true, screenHeight: 10_000, keyboardHeight: 0, expected: 240 },
        { useEnhancedSessionWizard: true, screenHeight: Number.POSITIVE_INFINITY, keyboardHeight: Number.NaN, expected: 120 },
    ])(
        'clamps /new input max height for wizard=$useEnhancedSessionWizard screen=$screenHeight keyboard=$keyboardHeight',
        ({ useEnhancedSessionWizard, screenHeight, keyboardHeight, expected }) => {
            expect(computeNewSessionInputMaxHeight({ useEnhancedSessionWizard, screenHeight, keyboardHeight })).toBe(expected);
        },
    );
});
