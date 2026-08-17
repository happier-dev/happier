import { describe, expect, it } from 'vitest';

import {
    resolveVoiceHorizonHeights,
    VOICE_HORIZON_ACTIONS_BLOCK_HEIGHT,
    VOICE_HORIZON_STATUS_ROW_HEIGHT,
} from './resolveVoiceHorizonHeights';

/**
 * §2.7 — *"Never truncate recovery controls, permission actions, or End Voice. If
 * something must be cut, it is never the way out."*
 *
 * These are height assertions because the failure is invisible everywhere else:
 * the vessel clips with `overflow: hidden`, so a recovery button pushed past the
 * bottom edge still renders, still passes every `findByTestId`, and simply cannot
 * be seen or reached. The only thing that discriminates a correct minimum from a
 * status-row-only minimum is the arithmetic.
 */

/** A tall window: the clamp is not the binding constraint. */
const ROOMY = { viewportHeight: 900, safeAreaBottom: 0 } as const;

describe('Horizon vessel minimum height', () => {
    it('reserves room for the contextual-actions block, not just the status row', () => {
        const withoutActions = resolveVoiceHorizonHeights({
            ...ROOMY,
            statusRowHeight: VOICE_HORIZON_STATUS_ROW_HEIGHT,
            actionsBlockHeight: 0,
            conversational: false,
        });
        const withRecovery = resolveVoiceHorizonHeights({
            ...ROOMY,
            statusRowHeight: VOICE_HORIZON_STATUS_ROW_HEIGHT,
            // A recovery button is a 44pt target plus its 8pt gap — far taller
            // than the 28pt meter row the shipped geometry budgeted for.
            actionsBlockHeight: 52,
            conversational: false,
        });

        expect(withRecovery.minimumHeight - withoutActions.minimumHeight).toBe(52);
        expect(withRecovery.minimumHeight).toBeLessThanOrEqual(withRecovery.desiredHeight);
    });

    it('counts the border on both edges so symmetric padding survives', () => {
        const heights = resolveVoiceHorizonHeights({
            ...ROOMY,
            statusRowHeight: VOICE_HORIZON_STATUS_ROW_HEIGHT,
            actionsBlockHeight: VOICE_HORIZON_ACTIONS_BLOCK_HEIGHT,
            conversational: false,
        });

        // 12 padding + 1 border, twice, around 36 + 28 of content.
        expect(heights.minimumHeight).toBe(2 * 12 + 2 * 1 + 36 + 28);
        expect(heights.desiredHeight).toBe(heights.minimumHeight);
    });

    it('keeps the way out reachable when the viewport is too short for the vessel', () => {
        // A short window with the host's own chrome already reserved: 320 - 34 - 220
        // leaves 66pt against a 114pt floor. The reserve is what gives way — the
        // recovery action is not (§2.7).
        const heights = resolveVoiceHorizonHeights({
            viewportHeight: 320,
            safeAreaBottom: 34,
            statusRowHeight: VOICE_HORIZON_STATUS_ROW_HEIGHT,
            actionsBlockHeight: 52,
            conversational: true,
        });

        expect(heights.minimumHeight).toBe(2 * 12 + 2 * 1 + 36 + 52);
        expect(heights.availableHeight).toBeGreaterThanOrEqual(heights.minimumHeight);
        // The transcript is what gives way next, not the controls.
        expect(heights.availableHeight).toBeLessThan(heights.desiredHeight);
    });

    it('never borrows past the real viewport and safe area', () => {
        // The reserve is negotiable; the physical window is not. A vessel taller
        // than the device would push its own controls off-screen instead.
        const heights = resolveVoiceHorizonHeights({
            viewportHeight: 90,
            safeAreaBottom: 34,
            statusRowHeight: 200,
            actionsBlockHeight: 120,
            conversational: false,
        });

        expect(heights.availableHeight).toBe(90 - 34);
    });

    it('treats the composer scaffold available height as the physical ceiling', () => {
        const heights = resolveVoiceHorizonHeights({
            ...ROOMY,
            statusRowHeight: VOICE_HORIZON_STATUS_ROW_HEIGHT,
            actionsBlockHeight: VOICE_HORIZON_ACTIONS_BLOCK_HEIGHT,
            conversational: true,
            availablePanelHeight: 156,
        });

        // The keyboard-aware scaffold has already subtracted the composer, keyboard,
        // header and safe-area bands. Horizon must not borrow through that boundary.
        expect(heights.availableHeight).toBe(156);
        expect(heights.availableHeight).toBeLessThan(heights.desiredHeight);
    });

    it('grows with a long translation or 200% text instead of clipping the controls', () => {
        // A wrapped status label plus a wrapped target caption at 200% web text:
        // the row reports far more than its 36pt default-scale height.
        const scaled = resolveVoiceHorizonHeights({
            ...ROOMY,
            statusRowHeight: 96,
            actionsBlockHeight: 60,
            conversational: false,
        });
        const defaultScale = resolveVoiceHorizonHeights({
            ...ROOMY,
            statusRowHeight: VOICE_HORIZON_STATUS_ROW_HEIGHT,
            actionsBlockHeight: 60,
            conversational: false,
        });

        expect(scaled.minimumHeight - defaultScale.minimumHeight).toBe(96 - VOICE_HORIZON_STATUS_ROW_HEIGHT);
        expect(scaled.availableHeight).toBeGreaterThanOrEqual(scaled.minimumHeight);
    });

    it('treats the default-scale status height as a floor, never a ceiling', () => {
        const unmeasured = resolveVoiceHorizonHeights({
            ...ROOMY,
            statusRowHeight: 0,
            actionsBlockHeight: 0,
            conversational: false,
        });
        const shorterThanDefault = resolveVoiceHorizonHeights({
            ...ROOMY,
            statusRowHeight: 12,
            actionsBlockHeight: 0,
            conversational: false,
        });

        expect(unmeasured.minimumHeight).toBe(shorterThanDefault.minimumHeight);
    });

    it('gives the transcript its own room only once the controls are paid for', () => {
        // Tall enough that the 286pt default-scale target is no longer the binding
        // number — the transcript's 64pt is added ON TOP of the real floor rather
        // than being carved out of it.
        const conversational = resolveVoiceHorizonHeights({
            ...ROOMY,
            statusRowHeight: 200,
            actionsBlockHeight: 60,
            conversational: true,
        });

        expect(conversational.desiredHeight).toBe(conversational.minimumHeight + 64);
        expect(conversational.desiredHeight).toBeGreaterThan(286);
    });
});
