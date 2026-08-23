import { resolveAvailablePanelHeight } from '@/components/sessions/keyboardAvoidance/composerKeyboardGeometry';

/*
 * §2.1 / §2.7 — Horizon's vessel geometry.
 *
 * Extracted from the presentation because the failure mode is silent: a vessel
 * whose minimum is too small does not throw, does not fail a render assertion and
 * does not look wrong at default scale — it clips the recovery action or End Voice
 * off the bottom under a short viewport, a long translation, Dynamic Type or 200%
 * web text, and `overflow: hidden` hides the evidence.
 *
 *   status block = 19 (label) + 1 + 16 (caption) = 36
 *   actions row  = 8 (gap) + 20 (meter bars)     = 28
 */

/** Symmetric inner padding. Design requirement, not a round number (§2.1). */
const PAD = 12;
/**
 * The vessel border counts twice.
 *
 * The height is a border-box height, so `PAD * 2 + content` leaves the content
 * area 2px short and the status row eats it out of the BOTTOM padding — measured
 * live as 12px above the label against 10px below the caption. Anything that
 * changes `borderWidth` must change this with it.
 */
const BORDER = 1;
/** Expanded target height at default theme and default text size. */
const EXPANDED = 286;
/** The transcript must have somewhere to live before it is worth expanding. */
const MIN_TRANSCRIPT = 64;
/**
 * What the host keeps around the vessel: the sidebar's own header/footer chrome.
 * A reserve, not a measurement — the vessel is docked, never full-viewport, and
 * this only decides when the clamp starts biting on a short window.
 */
const HOST_CHROME_RESERVE = 220;

/** Default-scale height of the status block. A floor for the measured value. */
export const VOICE_HORIZON_STATUS_ROW_HEIGHT = 36;
/**
 * Default-scale height of the contextual-actions block, measured from the top of
 * its 8pt gap. A floor for the measured value **while that block renders**, so the
 * first frame is not visibly short before layout reports the real height.
 */
export const VOICE_HORIZON_ACTIONS_BLOCK_HEIGHT = 28;

export type VoiceHorizonHeightsInput = Readonly<{
    /** Measured height of the status + transport row. */
    statusRowHeight: number;
    /**
     * Measured height of everything below the transcript — diagnostics, the
     * meter, the recovery action and the contextual controls — including the gap
     * above it. Zero when none of it renders.
     */
    actionsBlockHeight: number;
    /** Whether the transcript is on screen and therefore owed room. */
    conversational: boolean;
    viewportHeight: number;
    safeAreaBottom: number;
    /**
     * Session-scaffold ceiling after keyboard, composer, header and safe-area
     * reservations. Undefined outside that canonical keyboard owner.
     */
    availablePanelHeight?: number;
}>;

export type VoiceHorizonHeights = Readonly<{
    /**
     * The height below which content is lost. §2.7: *"Never truncate recovery
     * controls, permission actions, or End Voice. If something must be cut, it is
     * never the way out."*
     */
    minimumHeight: number;
    /** Where the entrance animation is heading. */
    desiredHeight: number;
    /** The per-frame ceiling the animation is clamped to. */
    availableHeight: number;
}>;

function normalizeMeasuredHeight(value: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
    return value;
}

export function resolveVoiceHorizonHeights(input: VoiceHorizonHeightsInput): VoiceHorizonHeights {
    const statusRowHeight = Math.max(
        VOICE_HORIZON_STATUS_ROW_HEIGHT,
        normalizeMeasuredHeight(input.statusRowHeight),
    );
    const actionsBlockHeight = normalizeMeasuredHeight(input.actionsBlockHeight);

    /*
     * The way out is part of the floor, not a decoration on top of it.
     *
     * Recovery, cancel-turn, open-conversation and teleport all live in the
     * actions block — and when a hard error withholds the transport, so does the
     * only remaining route off this surface. A minimum computed from the status
     * row alone let the clamp cut every one of them off on a short viewport, and
     * budgeting a fixed 28pt meter row was no better: a recovery button is a 44pt
     * (48 on Android) target, so the block is nearly twice the budget the moment
     * an error is recoverable. Measured, not assumed (§2.7).
     */
    const minimumHeight = PAD * 2 + BORDER * 2 + statusRowHeight + actionsBlockHeight;
    const desiredHeight = input.conversational
        ? Math.max(EXPANDED, minimumHeight + MIN_TRANSCRIPT)
        : minimumHeight;

    /*
     * The clamp **caps** the animation, it does not replace it: the entrance still
     * runs its full `VOICE_MOTION.spatial` curve and simply stops growing when it
     * reaches the space it has. Writing the clamped value into the timing target
     * instead would short-circuit the transition the §3.1 fidelity gate protects.
     */
    const reservedAvailableHeight = resolveAvailablePanelHeight({
        viewportHeight: input.viewportHeight,
        safeAreaBottom: input.safeAreaBottom,
        reservedHeight: HOST_CHROME_RESERVE,
        minHeight: minimumHeight,
    });

    /*
     * The host-chrome reserve is a preference, not an inviolable subtraction.
     *
     * On a short window `viewport - safeArea - reserve` can land *below* the
     * vessel's own minimum — a 320pt window leaves 66pt against a 114pt floor —
     * and `resolveAvailablePanelHeight` cannot honour a minimum larger than the
     * region it was handed, so it returns the smaller number and the recovery
     * action is clipped away by `overflow: hidden`. §2.7 is explicit about which
     * side gives way: *"If something must be cut, it is never the way out."* So
     * the vessel borrows from the reserve, and only from the reserve — never past
     * the real viewport and safe area, which are physical.
     */
    const unreservedRegion = Math.max(
        0,
        input.viewportHeight - Math.max(0, input.safeAreaBottom),
    );
    const viewportAvailableHeight = Math.max(
        reservedAvailableHeight,
        Math.min(minimumHeight, unreservedRegion),
    );
    /*
     * The scaffold's panel ceiling is subject to the same rule as the host-chrome
     * reserve above, and for the same reason.
     *
     * `availablePanelHeight` is what the session scaffold has left after the
     * header, the composer and keyboard avoidance — reservations for other
     * chrome, not the physical region. Applied as a bare `Math.min` it clamped
     * the vessel *below its own minimum* under keyboard + 200% text (a 96pt
     * status row and a 60pt actions block put the floor at 182pt against a
     * ~150pt panel), and `overflow: hidden` then cut End Voice and Retry off the
     * bottom — the one thing §2.7 says is never cut. The transcript is the child
     * that gives way (it is `flex: 1`; the status row and actions block are
     * not), so honouring the floor squeezes the feed to nothing rather than
     * clipping the way out. Physical viewport and safe area still bound it.
     */
    const availablePanelHeight = normalizeMeasuredHeight(input.availablePanelHeight ?? 0);
    const panelClampedHeight = availablePanelHeight > 0
        ? Math.min(viewportAvailableHeight, availablePanelHeight)
        : viewportAvailableHeight;
    const availableHeight = Math.max(
        panelClampedHeight,
        Math.min(minimumHeight, unreservedRegion),
    );

    return { minimumHeight, desiredHeight, availableHeight };
}
