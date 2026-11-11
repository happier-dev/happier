import type { ScrimBandAxes } from '@/components/ui/overlays/createBackdropLayerStyle';
import { SCRIM_RAMP_UNDERLAP } from '@/components/ui/overlays/progressiveScrimFalloff';

/**
 * The band's ramp: how far it dissolves upward from where it is seated, on every width (0.2's phone recipe). The
 * band holds the docked stack's own measured content, so its height follows that content, never a fixed tall
 * run over the page above. Taller than the shared `OVERLAY_SCRIM_RAMP_HEIGHT`: the composer floats over a busy,
 * scrolling list rather than one quiet surface, yet stays far short of veiling it.
 */
export const DOCKED_BAND_RAMP_HEIGHT = 128;

/**
 * Where the frost around the docked new-session composer is seated, one rule for phone and desktop
 * (owner 2026-11-11, item 20). A phone seats it on the card edge (`cardTop`, the card's offset under the
 * dock's status row), as 0.2 did. A desktop seats it on the top of the whole docked stack (the "New session"
 * header line, and a bot-template header only when one is present), so the header stands in the band's held
 * tier and the band dissolves upward from there over the same short ramp, and sideways within its column.
 */
export function resolveDockedBandGeometry(input: Readonly<{
    phone: boolean;
    cardTop: number;
    /**
     * Desktop: the clearance the page leaves between the docked stack's top and what stands above it (a Session
     * composer). The dissolve fits inside it, so the page above stays unblurred unless the stack overlaps it.
     */
    clearanceAbove?: number;
}>): Readonly<{
    seatTop: number;
    rampHeight: number;
    axes: ScrimBandAxes;
}> {
    if (input.phone) return { seatTop: input.cardTop, rampHeight: DOCKED_BAND_RAMP_HEIGHT, axes: 'top' };
    const clearance = input.clearanceAbove;
    const rampHeight = clearance === undefined || !Number.isFinite(clearance)
        ? DOCKED_BAND_RAMP_HEIGHT
        : Math.min(DOCKED_BAND_RAMP_HEIGHT, Math.max(0, clearance) + SCRIM_RAMP_UNDERLAP);
    return { seatTop: 0, rampHeight, axes: 'centre' };
}
