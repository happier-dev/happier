import { describe, expect, it } from 'vitest';
import {
    computeAgentInputDefaultMaxHeight,
    computeExistingSessionComposerPanelMaxHeight,
    computeExistingSessionComposerInputMaxHeight,
    computeMeasuredPanelInputMaxHeight,
    computeAgentInputKeyboardOpenPanelMaxHeight,
    computeAgentInputKeyboardOpenVariableSectionMaxHeight,
    computeNewSessionComposerPanelMaxHeight,
    computeNewSessionInputMaxHeight,
} from './inputMaxHeight';

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

    it('reserves composer chrome before sizing the /new input', () => {
        const withoutReservedChrome = computeNewSessionInputMaxHeight({
            useEnhancedSessionWizard: false,
            screenHeight: 720,
            keyboardHeight: 280,
        });
        const withReservedChrome = computeNewSessionInputMaxHeight({
            useEnhancedSessionWizard: false,
            screenHeight: 720,
            keyboardHeight: 280,
            reservedHeight: 132,
        });
        expect(withReservedChrome).toBeLessThan(withoutReservedChrome);
        expect(withReservedChrome).toBe(231);
    });

    it('keeps existing-session composer panels bounded by the available host height', () => {
        expect(computeExistingSessionComposerPanelMaxHeight({
            availablePanelHeight: 900,
            viewportHeight: 800,
        })).toBe(900);
    });

    it('does not shrink existing-session composer panels that are already below the input viewport cap', () => {
        expect(computeExistingSessionComposerPanelMaxHeight({
            availablePanelHeight: 300,
            viewportHeight: 800,
        })).toBe(300);
    });

    it('caps existing-session text input viewports so transcript content remains visible', () => {
        expect(computeExistingSessionComposerInputMaxHeight({
            availablePanelHeight: 900,
            viewportHeight: 800,
        })).toBe(200);
    });

    it('caps collapsed existing-session text input viewports more tightly while keyboard is open', () => {
        expect(computeExistingSessionComposerInputMaxHeight({
            availablePanelHeight: 900,
            keyboardHeight: 320,
            viewportHeight: 800,
        })).toBe(120);
    });

    it('scales existing-session text input viewports below fixed pixel caps for compact viewports', () => {
        expect(computeExistingSessionComposerInputMaxHeight({
            availablePanelHeight: 900,
            viewportHeight: 240,
        })).toBe(60);
    });

    it('does not grow existing-session text input viewports past the available host height', () => {
        expect(computeExistingSessionComposerInputMaxHeight({
            availablePanelHeight: 120,
            viewportHeight: 800,
        })).toBe(120);
    });

    it('uses the viewport cap before existing-session host panel height is measured', () => {
        expect(computeExistingSessionComposerInputMaxHeight({
            availablePanelHeight: null,
            viewportHeight: 576,
        })).toBe(144);
    });

    it('allows existing-session text input viewports to expand on demand', () => {
        expect(computeExistingSessionComposerInputMaxHeight({
            availablePanelHeight: 900,
            viewportHeight: 800,
            expanded: true,
        })).toBe(520);
    });

    it('does not shrink existing-session composer panels on very small viewports', () => {
        expect(computeExistingSessionComposerPanelMaxHeight({
            availablePanelHeight: 900,
            viewportHeight: 240,
        })).toBe(900);
    });

    it('caps new-session wizard composer panels to a percentage of the viewport height', () => {
        expect(computeNewSessionComposerPanelMaxHeight({
            mode: 'wizard',
            availablePanelHeight: 900,
            viewportHeight: 800,
        })).toBe(320);
    });

    it('lets simple new-session composer panels use the measured modal height', () => {
        expect(computeNewSessionComposerPanelMaxHeight({
            mode: 'simple',
            availablePanelHeight: 420,
            viewportHeight: 800,
        })).toBe(420);
    });

    it('keeps the caller input max height as a hard cap when layout metrics are available', () => {
        expect(computeMeasuredPanelInputMaxHeight({
            panelMaxHeight: 480,
            panelHeight: 220,
            inputContainerHeight: 60,
            fallbackMaxHeight: 200,
        })).toBe(200);
    });

    it('derives measured input caps without depending on the live input viewport height', () => {
        expect(computeMeasuredPanelInputMaxHeight({
            panelMaxHeight: 480,
            panelHeight: 220,
            inputContainerHeight: 60,
            fallbackMaxHeight: 360,
            fallbackMaxHeightMode: 'seed',
        })).toBe(320);
    });

    it('uses the explicit fixed chrome floor when a capped panel hides attachment and footer chrome', () => {
        expect(computeMeasuredPanelInputMaxHeight({
            panelMaxHeight: 300,
            panelHeight: 300,
            inputContainerHeight: 260,
            inputContainerChromeHeight: 8,
            minimumFixedChromeHeight: 164,
            fallbackMaxHeight: 360,
            fallbackMaxHeightMode: 'seed',
        })).toBe(128);
    });

    it('falls back to the heuristic max height when panel layout metrics are incomplete', () => {
        expect(computeMeasuredPanelInputMaxHeight({
            panelMaxHeight: 480,
            panelHeight: null,
            inputContainerHeight: 60,
            fallbackMaxHeight: 200,
        })).toBe(200);
    });

    it('does not clamp measured input height above the measured panel maximum', () => {
        expect(computeMeasuredPanelInputMaxHeight({
            panelMaxHeight: 80,
            panelHeight: 220,
            inputContainerHeight: 60,
            fallbackMaxHeight: 200,
        })).toBeLessThanOrEqual(80);
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
        { useEnhancedSessionWizard: false, screenHeight: 844, keyboardHeight: 336, reservedHeight: 600, expected: 120 },
        { useEnhancedSessionWizard: true, screenHeight: 10_000, keyboardHeight: 0, expected: 240 },
        { useEnhancedSessionWizard: true, screenHeight: Number.POSITIVE_INFINITY, keyboardHeight: Number.NaN, expected: 120 },
    ])(
        'clamps /new input max height for wizard=$useEnhancedSessionWizard screen=$screenHeight keyboard=$keyboardHeight',
        ({ useEnhancedSessionWizard, screenHeight, keyboardHeight, expected, ...rest }) => {
            expect(computeNewSessionInputMaxHeight({ useEnhancedSessionWizard, screenHeight, keyboardHeight, ...rest })).toBe(expected);
        },
    );

    it('caps the overall native composer panel when the keyboard is open', () => {
        expect(computeAgentInputKeyboardOpenPanelMaxHeight({ screenHeight: 900, keyboardHeight: 320 })).toBe(564);
    });

    it('does not clamp the native keyboard-open panel above the visible region', () => {
        const panelMaxHeight = computeAgentInputKeyboardOpenPanelMaxHeight({
            screenHeight: 420,
            keyboardHeight: 300,
        });

        expect(panelMaxHeight).toBeLessThanOrEqual(104);
    });

    it('does not cap the overall native composer panel when the keyboard is closed', () => {
        expect(computeAgentInputKeyboardOpenPanelMaxHeight({ screenHeight: 900, keyboardHeight: 0 })).toBeUndefined();
    });

    it('reserves footer height from the variable composer section budget', () => {
        expect(computeAgentInputKeyboardOpenVariableSectionMaxHeight({
            panelMaxHeight: 564,
            footerHeight: 72,
        })).toBe(492);
    });

    it('caps the variable section at the remaining height when the footer is very tall', () => {
        expect(computeAgentInputKeyboardOpenVariableSectionMaxHeight({
            panelMaxHeight: 220,
            footerHeight: 200,
        })).toBe(20);
    });

    it('does not clamp the variable section above the remaining panel height', () => {
        expect(computeAgentInputKeyboardOpenVariableSectionMaxHeight({
            panelMaxHeight: 80,
            footerHeight: 24,
        })).toBeLessThanOrEqual(56);
    });
});
