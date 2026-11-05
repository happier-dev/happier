import {
    DEFAULT_DETAILS_MIN_PX,
    DEFAULT_MAIN_MIN_PX,
    DEFAULT_RIGHT_MIN_PX,
    DEFAULT_RIGHT_PREFERRED_PX,
    DEFAULT_EDITOR_MIN_PX,
    DEFAULT_SESSION_MIN_PX,
    DEFAULT_SESSION_WIDTH_PX,
    type PaneArrangement,
} from '@/components/ui/panels/paneBreakpoints';

/**
 * The two side columns are one primitive in two configurations:
 * - `right`, the sidebar whose content the action rail picks. Widening it stops at the width that
 *   keeps the main content at its minimum.
 * - `details`, the wider pane. Widening it past that width turns it into an overlay over the main
 *   content instead of squeezing it (`overlayWhenWiderThanBudget`).
 * The threshold is always the main content's minimum width, never a separate number.
 */
export const PANE_SIZING_DEFAULTS = {
    mainMinPx: DEFAULT_MAIN_MIN_PX,
    mainMinThreePanePx: 320,
    session: { minPx: DEFAULT_SESSION_MIN_PX, defaultPx: DEFAULT_SESSION_WIDTH_PX },
    right: {
        minPx: DEFAULT_RIGHT_MIN_PX,
        /** Stored pixels are a preference; window changes only clamp their rendered size. */
        defaultPx: DEFAULT_RIGHT_PREFERRED_PX,
        // No global cap: the effective max is derived from the container width minus the main min width
        // (and any other docked pane). This enables user-resizable panes to scale naturally on wide screens.
        maxPx: Number.POSITIVE_INFINITY,
        overlayWhenWiderThanBudget: false,
    },
    details: {
        minPx: DEFAULT_DETAILS_MIN_PX,
        // No global cap: see `right.maxPx`.
        maxPx: Number.POSITIVE_INFINITY,
        overlayWhenWiderThanBudget: true,
    },
    bottom: {
        minPx: 220,
        // No global cap: the effective max is derived from container height minus the main min height.
        maxPx: Number.POSITIVE_INFINITY,
    },
} as const;

/**
 * The details column's width. A person's dragged width always wins. Until they drag, a destination whose detail is the
 * reading surface (an item opened beside its list) asks for its own width, within what keeps main at its minimum; a
 * stored width that is already over that budget keeps the existing overlay decision.
 */
export function resolveDetailsDockPreferredPx(input: Readonly<{
    storedPx: number;
    storedDefaultPx: number;
    destinationPreferredPx: number | undefined;
    budgetMaxPx: number;
}>): number {
    if (input.destinationPreferredPx === undefined || input.storedPx !== input.storedDefaultPx) return input.storedPx;
    return Math.max(input.storedPx, Math.min(input.destinationPreferredPx, input.budgetMaxPx));
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function reduceDownToMin(value: number, min: number, amount: number): { next: number; used: number } {
    const reducible = Math.max(0, value - min);
    const used = Math.min(reducible, amount);
    return { next: value - used, used };
}

export type DockedPaneSizingInput = Readonly<{
    arrangement?: PaneArrangement;
    sessionWidthPx?: number;
    mainDocked?: boolean;
    containerWidthPx: number;
    mainMinPx: number;
    rightMinPx: number;
    detailsMinPx: number;
    rightWidthPx: number;
    detailsWidthPx: number;
    rightGlobalMinPx: number;
    rightGlobalMaxPx: number;
    detailsGlobalMinPx: number;
    detailsGlobalMaxPx: number;
    rightDocked: boolean;
    detailsDocked: boolean;
}>;

export type DockedPaneSizingResult = Readonly<{
    mainWidthPx?: number;
    mainMaxWidthPx?: number;
    rightWidthPx: number;
    detailsWidthPx: number;
    rightMaxWidthPx: number;
    detailsMaxWidthPx: number;
}>;

export function resolveDockedPaneSizing(input: DockedPaneSizingInput): DockedPaneSizingResult {
    const width = input.containerWidthPx;
    if (input.arrangement === 'editor' && Number.isFinite(width) && width > 0) {
        const session = PANE_SIZING_DEFAULTS.session;
        const sessionPreferredPx = Math.max(session.minPx, input.sessionWidthPx ?? session.defaultPx);
        const rightWidthPx = input.rightDocked ? clamp(input.rightWidthPx, input.rightMinPx,
            Math.max(input.rightMinPx, width - DEFAULT_EDITOR_MIN_PX - (input.mainDocked ? sessionPreferredPx : 0))) : 0;
        const mainMaxWidthPx = Math.max(session.minPx, width - DEFAULT_EDITOR_MIN_PX - rightWidthPx);
        const mainWidthPx = input.mainDocked ? clamp(sessionPreferredPx, session.minPx, mainMaxWidthPx) : 0;
        const detailsWidthPx = Math.max(0, width - mainWidthPx - rightWidthPx);
        return { mainWidthPx, mainMaxWidthPx, rightWidthPx, detailsWidthPx,
            rightMaxWidthPx: Math.max(input.rightMinPx, width - DEFAULT_EDITOR_MIN_PX - mainWidthPx),
            detailsMaxWidthPx: detailsWidthPx };
    }
    if (!Number.isFinite(width) || width <= 0) {
        return {
            rightWidthPx: clamp(input.rightWidthPx, input.rightGlobalMinPx, input.rightGlobalMaxPx),
            detailsWidthPx: clamp(input.detailsWidthPx, input.detailsGlobalMinPx, input.detailsGlobalMaxPx),
            rightMaxWidthPx: input.rightGlobalMaxPx,
            detailsMaxWidthPx: input.detailsGlobalMaxPx,
        };
    }

    let rightWidthPx = clamp(input.rightWidthPx, input.rightGlobalMinPx, input.rightGlobalMaxPx);
    let detailsWidthPx = clamp(input.detailsWidthPx, input.detailsGlobalMinPx, input.detailsGlobalMaxPx);

    const mainMinPx = input.mainMinPx;
    const rightMinPx = input.rightMinPx;
    const detailsMinPx = input.detailsMinPx;

    if (input.rightDocked && input.detailsDocked) {
        const budget = width - mainMinPx;
        const minSum = rightMinPx + detailsMinPx;
        if (budget <= minSum) {
            rightWidthPx = rightMinPx;
            detailsWidthPx = detailsMinPx;
        } else {
            rightWidthPx = clamp(rightWidthPx, rightMinPx, input.rightGlobalMaxPx);
            detailsWidthPx = clamp(detailsWidthPx, detailsMinPx, input.detailsGlobalMaxPx);

            const sum = rightWidthPx + detailsWidthPx;
            if (sum > budget) {
                let over = sum - budget;
                const rightSlack = Math.max(0, rightWidthPx - rightMinPx);
                const detailsSlack = Math.max(0, detailsWidthPx - detailsMinPx);
                const totalSlack = rightSlack + detailsSlack;
                if (totalSlack <= 0) {
                    rightWidthPx = rightMinPx;
                    detailsWidthPx = detailsMinPx;
                } else {
                    const rightShare = (over * rightSlack) / totalSlack;
                    const r1 = reduceDownToMin(rightWidthPx, rightMinPx, rightShare);
                    rightWidthPx = r1.next;
                    over -= r1.used;

                    const d1 = reduceDownToMin(detailsWidthPx, detailsMinPx, over);
                    detailsWidthPx = d1.next;
                    over -= d1.used;

                    if (over > 0) {
                        const r2 = reduceDownToMin(rightWidthPx, rightMinPx, over);
                        rightWidthPx = r2.next;
                        over -= r2.used;
                    }
                }
            }
        }

        const rightMaxWidthPx = clamp(width - mainMinPx - detailsWidthPx, rightMinPx, input.rightGlobalMaxPx);
        const detailsMaxWidthPx = clamp(width - mainMinPx - rightWidthPx, detailsMinPx, input.detailsGlobalMaxPx);
        return { rightWidthPx, detailsWidthPx, rightMaxWidthPx, detailsMaxWidthPx };
    }

    if (input.rightDocked) {
        const rightMaxWidthPx = clamp(width - mainMinPx, rightMinPx, input.rightGlobalMaxPx);
        rightWidthPx = clamp(rightWidthPx, rightMinPx, rightMaxWidthPx);
        return { rightWidthPx, detailsWidthPx, rightMaxWidthPx, detailsMaxWidthPx: input.detailsGlobalMaxPx };
    }

    if (input.detailsDocked) {
        const detailsMaxWidthPx = clamp(width - mainMinPx, detailsMinPx, input.detailsGlobalMaxPx);
        detailsWidthPx = clamp(detailsWidthPx, detailsMinPx, detailsMaxWidthPx);
        return { rightWidthPx, detailsWidthPx, rightMaxWidthPx: input.rightGlobalMaxPx, detailsMaxWidthPx };
    }

    return {
        rightWidthPx,
        detailsWidthPx,
        rightMaxWidthPx: input.rightGlobalMaxPx,
        detailsMaxWidthPx: input.detailsGlobalMaxPx,
    };
}
