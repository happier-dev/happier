import type { AppPaneScopeLayoutState } from '@/components/appShell/panes/hooks/useAppPaneScopeLayout';
import { SESSION_BOARD_MIN_ITEM_WIDTH_PX } from '@/components/sessions/board/sessionBoardGridLayout';
import { DEFAULT_MAIN_MIN_PX } from '@/components/ui/panels/paneBreakpoints';

import type {
    SessionCompanionEdge,
    SessionCompanionPreferenceV1,
} from '../state/sessionCompanionPreference';

/**
 * Where this viewer's Companion may appear right now.
 *
 * The pane system owns pane geometry and this resolver consumes its resolved
 * layout; it never re-derives pane breakpoints from window width and never
 * becomes another pane. When a dedicated inset cannot be reserved safely the
 * answer is the header control — V1 has no floating-over-transcript mode and no
 * "unused transcript space" heuristic.
 */
export type SessionCompanionPlacement =
    | Readonly<{ kind: 'hidden' }>
    | Readonly<{ kind: 'mobile_control' }>
    | Readonly<{
        kind: 'collapsed_control';
        edge: SessionCompanionEdge;
        /** Lets the one header control distinguish Expand from Open full. */
        reason: 'preference' | 'geometry' | 'unmeasured';
    }>
    | Readonly<{
        /**
         * A non-interactive, accessibility-hidden pass through the real card
         * composition. It occupies no row space and can never be an executable
         * Board host; the Host publishes its actual constrained card bounds into
         * the existing exact-identity measurement owner, then resolves again.
         */
        kind: 'measuring_rail';
        edge: SessionCompanionEdge;
        widthPx: number;
        heightPx: number;
    }>
    | Readonly<{ kind: 'reserved_rail'; edge: SessionCompanionEdge; widthPx: number }>;

export type SessionCompanionPlacementInput = Readonly<{
    preference: SessionCompanionPreferenceV1;
    /** `null` while no pane scope has measured yet: geometry is unproven. */
    paneLayout: AppPaneScopeLayoutState | null;
    /** Measured Session host box, excluding chrome the host already reserves. */
    hostHeightPx: number;
    /** Keyboard, composer and Cockpit bottom chrome already reported by their owners. */
    bottomObstructionPx: number;
    mainVisible: boolean;
    /** An accessibility-modal pane overlay owns focus; nothing may sit behind it. */
    accessibilityModalPaneActive: boolean;
    /** Effective text scale, so a larger card can force the collapsed control. */
    fontScale: number;
    /** Required outer rail bounds derived from card layout. `null` means fit is unproven. */
    cardBounds: Readonly<{ widthPx: number; heightPx: number }> | null;
    /** The Session's side panel is open on its Companion tab: the Companion is already on screen there. */
    presentedInSidePanel?: boolean;
}>;

const HIDDEN: SessionCompanionPlacement = Object.freeze({ kind: 'hidden' });
const MOBILE_CONTROL: SessionCompanionPlacement = Object.freeze({ kind: 'mobile_control' });

export const SESSION_COMPANION_RAIL_GUTTER_PX = 16;
/**
 * The rail body owns 12px of content padding on each horizontal edge. Card
 * layout events therefore report 24px less than the outer rail constraint the
 * placement resolver consumes. Keep that conversion here with the placement
 * contract so cold and visible measurement use the same unit.
 */
export const SESSION_COMPANION_CONTENT_HORIZONTAL_PADDING_PX = 12;

export function resolveSessionCompanionOuterRailWidthPx(cardWidthPx: number): number {
    return cardWidthPx + (SESSION_COMPANION_CONTENT_HORIZONTAL_PADDING_PX * 2);
}

function collapsedControl(
    edge: SessionCompanionEdge,
    reason: 'preference' | 'geometry' | 'unmeasured',
): SessionCompanionPlacement {
    return Object.freeze({ kind: 'collapsed_control', edge, reason });
}

function isFinitePositive(value: number): boolean {
    return Number.isFinite(value) && value > 0;
}

/**
 * Persistence and code keep the logical edge; only rendering resolves it to a
 * physical side. Menus localize "Left"/"Right" from the same result.
 */
export function resolveSessionCompanionPhysicalSide(
    edge: SessionCompanionEdge,
    direction: 'ltr' | 'rtl',
): 'left' | 'right' {
    const leadingIsLeft = direction !== 'rtl';
    if (edge === 'leading') return leadingIsLeft ? 'left' : 'right';
    return leadingIsLeft ? 'right' : 'left';
}

export function resolveSessionCompanionPlacement(
    input: SessionCompanionPlacementInput,
): SessionCompanionPlacement {
    const { preference, paneLayout } = input;
    if (!preference.visible) return HIDDEN;
    // One Companion on screen: while the side panel presents it, the main region draws no second copy.
    if (input.presentedInSidePanel === true) return HIDDEN;

    // A pane overlay owns z-order and the focus boundary, and a hidden main region
    // must not keep an inert card mounted behind the active surface.
    if (!input.mainVisible || input.accessibilityModalPaneActive) return HIDDEN;

    // Unproven geometry resolves to the header control rather than guessing a
    // width and covering transcript rows.
    if (!paneLayout) return collapsedControl(preference.edge, 'geometry');
    if (paneLayout.deviceType === 'phone' || !paneLayout.multiPaneEnabled) return MOBILE_CONTROL;
    // Geometry must win over the saved collapse state. Otherwise a constrained
    // window with `collapsed: true` would make the header's first press merely
    // flip a preference while still showing no content. The header needs one
    // truthful answer: expand in place only when a rail really fits; otherwise
    // open the existing full surface immediately.
    if (paneLayout.layout.right === 'overlay' || paneLayout.layout.details === 'overlay') return HIDDEN;

    const usableHeightPx = input.hostHeightPx - Math.max(0, input.bottomObstructionPx);
    if (!isFinitePositive(usableHeightPx)) return collapsedControl(preference.edge, 'geometry');

    const mainRegionWidthPx = paneLayout.mainRegionWidthPx;
    if (!isFinitePositive(mainRegionWidthPx)) return collapsedControl(preference.edge, 'geometry');

    // What is left inside main once Chat keeps its canonical minimum and the gutter.
    const budgetPx = mainRegionWidthPx - DEFAULT_MAIN_MIN_PX - SESSION_COMPANION_RAIL_GUTTER_PX;

    // Text scale remains a required measured-host fact. The actual scaled size is
    // represented by cardBounds; an invalid scale means those bounds cannot be
    // trusted for the current accessibility layout.
    if (!isFinitePositive(input.fontScale)) return collapsedControl(preference.edge, 'geometry');

    const cardBounds = input.cardBounds;
    const readableOuterRailWidthPx = resolveSessionCompanionOuterRailWidthPx(
        SESSION_BOARD_MIN_ITEM_WIDTH_PX,
    );
    if (!cardBounds) {
        // Cold measurement must use a real constraint rather than a persisted or
        // guessed card size. Companion embeds the same card shells as Board, so
        // Board's canonical readable-item floor is the narrowest truthful rail
        // candidate. If even that cannot coexist with Chat, there is nothing to
        // measure: the existing full destination remains the truthful fallback.
        if (budgetPx < readableOuterRailWidthPx) {
            return collapsedControl(preference.edge, 'geometry');
        }
        return Object.freeze({
            kind: 'measuring_rail',
            edge: preference.edge,
            widthPx: readableOuterRailWidthPx,
            heightPx: usableHeightPx,
        });
    }
    if (
        !isFinitePositive(cardBounds.widthPx)
        || !isFinitePositive(cardBounds.heightPx)
    ) return collapsedControl(preference.edge, 'geometry');
    if (usableHeightPx < cardBounds.heightPx) return collapsedControl(preference.edge, 'geometry');
    // A newly added compact row may measure narrower than the readable card
    // constraint. That measurement must not ratchet the containing rail down.
    const widthPx = Math.max(readableOuterRailWidthPx, cardBounds.widthPx);
    if (budgetPx < widthPx) return collapsedControl(preference.edge, 'geometry');

    if (preference.collapsed) return collapsedControl(preference.edge, 'preference');

    return Object.freeze({
        kind: 'reserved_rail',
        edge: preference.edge,
        widthPx,
    });
}
