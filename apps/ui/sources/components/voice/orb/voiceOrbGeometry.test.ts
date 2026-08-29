import { describe, expect, it } from 'vitest';

import {
    VOICE_ORB_DOCK_HEADROOM,
    VOICE_ORB_DOCK_INSET,
    VOICE_ORB_HIT_TARGET,
    VOICE_ORB_INTERACTION_INSET,
    VOICE_ORB_MIN_TOP,
    VOICE_ORB_SHEET_HEIGHT,
    VOICE_ORB_SIZE,
    resolveVoiceOrbHitRect,
    resolveVoiceOrbInteractionGeometry,
    resolveVoiceOrbRestingBottomInset,
    resolveVoiceOrbRestingCorner,
    resolveVoiceOrbSheetLayout,
    type VoiceOrbRect,
} from './voiceOrbGeometry';

/**
 * Measured live at 440×950 in a session, not derived: the orb body rendered 34×34 at (392, 808),
 * `session-composer-send` 32×32 at (374, 838) and `agent-input-dictation` 24×24 at (384, 790).
 * `document.elementFromPoint(399, 840)` returned the orb, not Send.
 */
const VIEWPORT = { width: 440, height: 950 } as const;
const SEND_RECT: VoiceOrbRect = { x: 374, y: 838, width: 32, height: 32 };
const DICTATION_RECT: VoiceOrbRect = { x: 384, y: 790, width: 24, height: 24 };
/** The bottom chrome measured in that same frame (the only band the orb used to subtract). */
const BOTTOM_CHROME_HEIGHT = 62;
/**
 * The composer band, taken from the controls themselves rather than invented: its bottom edge meets
 * the top of the bottom chrome, and its top edge is no lower than the highest control in it. This is
 * the *smallest* band consistent with the measurement, so the assertions below stay strict.
 */
const COMPOSER_CHROME_HEIGHT =
    VIEWPORT.height - BOTTOM_CHROME_HEIGHT - Math.min(SEND_RECT.y, DICTATION_RECT.y);

function rectsIntersect(a: VoiceOrbRect, b: VoiceOrbRect): boolean {
    return a.x < b.x + b.width
        && b.x < a.x + a.width
        && a.y < b.y + b.height
        && b.y < a.y + a.height;
}

function rectContainsPoint(rect: VoiceOrbRect, point: Readonly<{ x: number; y: number }>): boolean {
    return point.x >= rect.x
        && point.x <= rect.x + rect.width
        && point.y >= rect.y
        && point.y <= rect.y + rect.height;
}

function hitRectWith(composerChromeHeight: number): VoiceOrbRect {
    return resolveVoiceOrbHitRect({
        hostWidth: VIEWPORT.width,
        hostHeight: VIEWPORT.height,
        restingBottomInset: resolveVoiceOrbRestingBottomInset({
            safeAreaBottom: 0,
            bottomChromeHeight: BOTTOM_CHROME_HEIGHT,
            composerChromeHeight,
            keyboardHeight: 0,
            petOffset: 0,
        }),
    });
}

/**
 * §6.4 — the orb must clear the composer, and the *hit* rect is what has to clear it. §2.6 makes the
 * target deliberately larger than the body, so the only correct fix is moving the orb, not shrinking
 * what the user can press.
 */
describe('voice orb resting geometry', () => {
    it('reproduces the measured resting corner from the chrome that produced it', () => {
        // Guards the fixture itself: if this stops matching the live frame, the numbers below are
        // no longer evidence about the shipped orb.
        const corner = resolveVoiceOrbRestingCorner({
            hostWidth: VIEWPORT.width,
            hostHeight: VIEWPORT.height,
            restingBottomInset: resolveVoiceOrbRestingBottomInset({
                safeAreaBottom: 0,
                bottomChromeHeight: BOTTOM_CHROME_HEIGHT,
                composerChromeHeight: 0,
                keyboardHeight: 0,
                petOffset: 0,
            }),
        });

        expect(corner).toEqual({ x: 392, y: 808 });
    });

    it('keeps the orb out of the composer send and dictation targets', () => {
        const hitRect = hitRectWith(COMPOSER_CHROME_HEIGHT);

        expect(rectsIntersect(hitRect, SEND_RECT)).toBe(false);
        expect(rectsIntersect(hitRect, DICTATION_RECT)).toBe(false);
    });

    it('leaves the two measured collision points to the composer', () => {
        const hitRect = hitRectWith(COMPOSER_CHROME_HEIGHT);

        // The exact points that resolved to `voice.orb.body` instead of Send and the dictation mic.
        expect(rectContainsPoint(hitRect, { x: 399, y: 840 })).toBe(false);
        expect(rectContainsPoint(hitRect, { x: 400, y: 811 })).toBe(false);
    });

    it('clears the composer by moving the orb, never by shrinking its target', () => {
        const hitRect = hitRectWith(COMPOSER_CHROME_HEIGHT);

        expect(hitRect.width).toBe(VOICE_ORB_HIT_TARGET);
        expect(hitRect.height).toBe(VOICE_ORB_HIT_TARGET);
        expect(hitRect.width).toBeGreaterThan(VOICE_ORB_SIZE);
    });

    it('centres the 34-point planet in the physical target without moving its rest or dock geometry', () => {
        const restingCorner = resolveVoiceOrbRestingCorner({
            hostWidth: VIEWPORT.width,
            hostHeight: VIEWPORT.height,
            restingBottomInset: 100,
        });
        const geometry = resolveVoiceOrbInteractionGeometry({
            hostWidth: VIEWPORT.width,
            hostHeight: VIEWPORT.height,
            restingBottomInset: 100,
            sheetHeight: VOICE_ORB_SHEET_HEIGHT,
        });

        expect({
            x: geometry.restingPoint.x + VOICE_ORB_INTERACTION_INSET,
            y: geometry.restingPoint.y + VOICE_ORB_INTERACTION_INSET,
        }).toEqual(restingCorner);
        expect({
            x: geometry.dockedPoint.x + VOICE_ORB_INTERACTION_INSET,
            y: geometry.dockedPoint.y + VOICE_ORB_INTERACTION_INSET,
        }).toEqual({
            x: (VIEWPORT.width - VOICE_ORB_SIZE) / 2,
            y: VIEWPORT.height - VOICE_ORB_SHEET_HEIGHT + VOICE_ORB_DOCK_INSET,
        });
        expect(geometry.dragBounds.minY + VOICE_ORB_INTERACTION_INSET).toBe(VOICE_ORB_MIN_TOP);
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

/**
 * §2.7 — `236` is a default-scale target dimension. Frozen as a literal height it cuts whatever
 * overflows, and what overflows first in a bottom-anchored sheet is the bar at the bottom: End
 * Voice and the recovery actions. The rule is `min(desired, available)`, and the caption is the
 * only thing allowed to give way.
 */
describe('voice orb sheet layout', () => {
    const defaultScale = {
        // Measured from the rendered sheet at default text size: status line + caption block.
        captionHeight: 36,
        // `VoiceTransport`'s 34pt control plus the bar's 12pt padding and hairline.
        barHeight: 60,
        bottomPadding: 46,
    } as const;

    it('keeps the reference height at default scale in a tall viewport', () => {
        const layout = resolveVoiceOrbSheetLayout({
            availableHeight: 900,
            content: defaultScale,
        });

        expect(layout.height).toBe(VOICE_ORB_SHEET_HEIGHT);
        expect(layout.scrolls).toBe(false);
    });

    it('grows past the reference height when a long locale or Dynamic Type needs more', () => {
        const layout = resolveVoiceOrbSheetLayout({
            availableHeight: 900,
            // 200% text: the status wraps to two lines and the caption to two more.
            content: { ...defaultScale, captionHeight: 168 },
        });

        expect(layout.height).toBeGreaterThan(VOICE_ORB_SHEET_HEIGHT);
        expect(layout.height).toBe(VOICE_ORB_DOCK_HEADROOM + 60 + 46 + 168);
        // It grew instead of scrolling, because the room was there.
        expect(layout.scrolls).toBe(false);
        // And the growth is not undone by a sub-pixel ceiling that clips the last line.
        expect(layout.captionMaxHeight).toBeGreaterThanOrEqual(168);
    });

    it('clamps to the available space and scrolls the caption instead of cutting the bar', () => {
        const layout = resolveVoiceOrbSheetLayout({
            // A short viewport with the keyboard up leaves very little.
            availableHeight: 260,
            content: { ...defaultScale, captionHeight: 168 },
        });

        expect(layout.height).toBe(260);
        expect(layout.scrolls).toBe(true);
        // Decorative dock clearance gives way before readable content. The bar
        // and its padding remain pinned, and only then does the caption shrink.
        expect(layout.captionMaxHeight).toBe(260 - 60 - 46);
        expect(layout.captionMaxHeight).toBeLessThan(168);
    });

    it('never asks the caption to render into negative space', () => {
        const layout = resolveVoiceOrbSheetLayout({
            availableHeight: 80,
            content: { ...defaultScale, captionHeight: 168 },
        });

        expect(layout.captionMaxHeight).toBe(0);
        expect(layout.scrolls).toBe(true);
        expect(layout.height).toBe(80);
        expect(layout.height).toBeLessThanOrEqual(80);
    });

    it('falls back to the desired height before the host has measured itself', () => {
        const layout = resolveVoiceOrbSheetLayout({
            availableHeight: 0,
            content: { captionHeight: 0, barHeight: 0, bottomPadding: 0 },
        });

        expect(layout.height).toBe(VOICE_ORB_SHEET_HEIGHT);
        // The natural caption cannot report its height if the first frame gives
        // its ScrollView a zero-height ceiling.
        expect(layout.captionMaxHeight).toBeGreaterThan(0);
        expect(layout.scrolls).toBe(false);
    });
});
