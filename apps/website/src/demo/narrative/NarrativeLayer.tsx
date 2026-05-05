import { motion } from 'framer-motion';
import type { ReactNode } from 'react';
import type { DeviceFocus, ScenarioBeat } from '../timeline/scenarioTypes';

/**
 * Caption for the active beat — positioned next to the hero device.
 *
 * Caption swap timing matches the device-frame spring (~0.45s) so the caption
 * doesn't lag the visual beat change. We don't use AnimatePresence — instead
 * we let `key={beatId}` remount the motion element. The old node unmounts
 * instantly while the new node fades in; the visual effect reads as "the
 * caption changes WITH the scene", not 200ms after.
 */

export type CaptionSlot =
    | 'above-narrow' // hero is short device (terminal/desktop) — caption sits just above its top edge
    | 'above-wide' // dual focus / triptych — caption spans top, centered
    | 'side-top'; // hero is phone — caption hugs top-left

export type HeroKind = 'terminal' | 'phone' | 'desktop' | 'dual' | 'triptych';

export function heroKindForFocus(focus: DeviceFocus): HeroKind {
    if (focus === 'terminal') return 'terminal';
    if (focus === 'phone') return 'phone';
    if (focus === 'desktop') return 'desktop';
    if (focus === 'all' || focus === 'both') return 'triptych';
    return 'dual';
}

export function captionSlotForHero(hero: HeroKind): CaptionSlot {
    if (hero === 'phone') return 'side-top';
    if (hero === 'terminal' || hero === 'desktop') return 'above-narrow';
    return 'above-wide';
}

// Kept for compatibility while we shake out the new shape.
export type NarrativeVariant = 'captions';
export const DEFAULT_NARRATIVE_VARIANT: NarrativeVariant = 'captions';

type NarrativeLayerProps = {
    activeBeat: ScenarioBeat;
    /** Which device is the hero of this beat — drives caption placement. */
    hero: HeroKind;
    /** Optional override; defaults to slot derived from hero. */
    slot?: CaptionSlot;
    /** Optional variant flag — accepted for API symmetry, ignored. */
    variant?: NarrativeVariant;
};

/**
 * Per-hero vertical offset (in px) for the `above-narrow` slot. Different
 * devices have different heights, so the gap between caption bottom and
 * device top varies; these offsets are tuned to give each device the same
 * visual breathing room.
 *
 * Stage min-height is 660. Devices are vertically centered:
 *   - terminal partner frame (~260px effective height at 0.86 scale):
 *     top edge lands higher than the desktop's window chrome
 *   - desktop short (340px): top edge sits lower and needs less lift
 *   - phone (600px):          top edge at   ~30px (uses different slot anyway)
 *
 * Caption text height is roughly 50px; the terminal caption needs a slightly
 * higher anchor so the first terminal beat reads above the macOS chrome on
 * wide desktop renders.
 */
const ABOVE_TOP_PX: Record<HeroKind, number> = {
    terminal: 20,
    desktop: 32, // 32 + 50 caption = 82,  desktop top 160 → gap 78
    dual: 24,
    triptych: 24,
    phone: 64, // unused (phone uses side-top), kept for completeness
};

/**
 * Renders the caption for the current beat.
 *
 * Motion timing:
 *   - No AnimatePresence — the motion element re-mounts via `key` when the
 *     beat advances, so the new caption appears immediately rather than
 *     waiting for an exit animation.
 *   - Enter: opacity 0→1, y 6→0, blur 4px→0, 320 ms cubic-bezier(0.2,0,0,1)
 */
export function NarrativeLayer({ activeBeat, hero, slot }: NarrativeLayerProps): ReactNode {
    const caption = activeBeat.label;
    if (!caption) return null;

    const resolvedSlot = slot ?? captionSlotForHero(hero);

    const captionEl = (
        <motion.p
            key={`${activeBeat.id}-caption`}
            initial={{ opacity: 0, y: 6, filter: 'blur(4px)' }}
            animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            transition={{
                opacity: { duration: 0.32, ease: [0.2, 0, 0, 1] },
                y: { duration: 0.32, ease: [0.2, 0, 0, 1] },
                filter: { duration: 0.32, ease: [0.2, 0, 0, 1] },
            }}
            className="font-display text-[26px] font-semibold leading-[1.15] sm:text-[30px]"
            style={{
                color: 'var(--fg-primary)',
                letterSpacing: '-0.02em',
                textWrap: 'balance',
            }}
        >
            {caption}
        </motion.p>
    );

    if (resolvedSlot === 'side-top') {
        return (
            <div
                className="pointer-events-none absolute left-4 top-12 z-30 w-[320px] max-w-[34%] sm:left-12 sm:top-16"
                aria-live="polite"
            >
                {captionEl}
            </div>
        );
    }

    if (resolvedSlot === 'above-narrow') {
        return (
            <div
                className="pointer-events-none absolute inset-x-0 z-30 mx-auto flex max-w-[760px] flex-col items-center px-6"
                style={{ top: ABOVE_TOP_PX[hero] }}
                aria-live="polite"
            >
                <div className="text-center">{captionEl}</div>
            </div>
        );
    }

    // 'above-wide' — dual focus / triptych: caption spans the stage top.
    return (
        <div
            className="pointer-events-none absolute inset-x-0 top-6 z-30 mx-auto flex max-w-[820px] flex-col items-center px-6"
            aria-live="polite"
        >
            <div className="text-center">{captionEl}</div>
        </div>
    );
}
