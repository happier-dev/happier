import { describe, expect, it } from 'vitest';

import {
    resolveVoiceOrbRestingBottomInset,
    resolveVoicePresenceGeometry,
    resolveVoicePresenceReleaseTarget,
    resolveVoicePresenceBottomReservation,
} from '@/components/voice/presence/voicePresenceGeometry';

// Composer controls measured at y=790 above a 62-point bottom chrome in a 950-point viewport.
const BOTTOM_CHROME_HEIGHT = 62;
const COMPOSER_CHROME_HEIGHT = 950 - BOTTOM_CHROME_HEIGHT - 790;

describe('voice presence geometry', () => {
    it('snaps an Island to top/bottom and left/centre/right using the projected release', () => {
        const bounds = { minX: 16, maxX: 514, minY: 72, maxY: 630 };
        expect(resolveVoicePresenceReleaseTarget({ projected: { x: 250, y: 110 }, bounds, anchors: 'island' }))
            .toEqual({ x: 265, y: 72 });
        expect(resolveVoicePresenceReleaseTarget({ projected: { x: 490, y: 580 }, bounds, anchors: 'island' }))
            .toEqual({ x: 514, y: 630 });
        expect(resolveVoicePresenceReleaseTarget({ projected: { x: -90, y: -20 }, bounds, anchors: 'island' }))
            .toEqual({ x: 16, y: 72 });
        expect(resolveVoicePresenceReleaseTarget({ projected: { x: 250, y: 110 }, bounds }))
            .toEqual({ x: 16, y: 110 });
    });

    it('reserves the measured bottom Island band for the composer, withdrawing it at the top anchor', () => {
        const facts = { hostHeight: 844, point: { x: 16, y: 664 }, containerHeight: 70, bottomChromeInset: 98, dockedBottom: true };
        expect(resolveVoicePresenceBottomReservation(facts)).toBe(82);
        expect(resolveVoicePresenceBottomReservation({ ...facts, containerHeight: 94, point: { x: 16, y: 640 } })).toBe(106);
        expect(resolveVoicePresenceBottomReservation({ ...facts, dockedBottom: false, point: { x: 16, y: 56 } })).toBe(0);
    });
    it('keeps a measured wide presence inside its host and above bottom exclusions', () => {
        const geometry = resolveVoicePresenceGeometry({
            hostWidth: 390,
            hostHeight: 844,
            restingBottomInset: 140,
            containerWidth: 260,
            containerHeight: 64,
        });
        expect(geometry.restingPoint.x + 260).toBeLessThanOrEqual(390 - 14);
        expect(geometry.restingPoint.y + 64).toBeLessThanOrEqual(844 - 140);
        expect(geometry.dragBounds.minX).toBeLessThanOrEqual(geometry.dragBounds.maxX);
        expect(geometry.dragBounds.minY).toBeLessThanOrEqual(geometry.dragBounds.maxY);
    });

    it('reserves nothing for a composer that is not on screen', () => {
        // A list route has a tab bar and no composer; the orb must not float in dead space there.
        expect(resolveVoiceOrbRestingBottomInset({
            safeAreaBottom: 34,
            bottomChromeHeight: BOTTOM_CHROME_HEIGHT,
            composerChromeHeight: 0,
            keyboardHeight: 0,
            petOffset: 0,
        })).toBe(34 + BOTTOM_CHROME_HEIGHT + 12);
    });

    it('stacks the composer on top of the pet, never instead of it', () => {
        const withPet = resolveVoiceOrbRestingBottomInset({
            safeAreaBottom: 0,
            bottomChromeHeight: BOTTOM_CHROME_HEIGHT,
            composerChromeHeight: COMPOSER_CHROME_HEIGHT,
            keyboardHeight: 0,
            petOffset: 80,
        });
        const withoutPet = resolveVoiceOrbRestingBottomInset({
            safeAreaBottom: 0,
            bottomChromeHeight: BOTTOM_CHROME_HEIGHT,
            composerChromeHeight: COMPOSER_CHROME_HEIGHT,
            keyboardHeight: 0,
            petOffset: 0,
        });

        expect(withPet - withoutPet).toBe(80);
    });

    /**
     * The case a previous pass left open: the tab bar publishes `0` while the keyboard is up, so an
     * inset built only from the published chrome collapses and the orb lands on the keyboard —
     * covering the composer's Send, and covering End Voice in the sheet below it.
     */
    it('clears the keyboard once the bottom chrome collapses under it', () => {
        const typing = resolveVoiceOrbRestingBottomInset({
            safeAreaBottom: 34,
            // The mobile chrome host hides the bar while the keyboard is open.
            bottomChromeHeight: 0,
            composerChromeHeight: COMPOSER_CHROME_HEIGHT,
            keyboardHeight: 291,
            petOffset: 0,
        });

        expect(typing).toBe(34 + 291 + COMPOSER_CHROME_HEIGHT + 12);
        expect(typing).toBeGreaterThan(291);
    });

    it('does not stack the keyboard on a tab bar the keyboard has already replaced', () => {
        // Both published at once during the transition: the taller band wins, they never sum.
        expect(resolveVoiceOrbRestingBottomInset({
            safeAreaBottom: 0,
            bottomChromeHeight: BOTTOM_CHROME_HEIGHT,
            composerChromeHeight: 0,
            keyboardHeight: 291,
            petOffset: 0,
        })).toBe(291 + 12);
    });
});
