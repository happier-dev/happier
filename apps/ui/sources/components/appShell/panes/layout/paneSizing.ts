export const PANE_SIZING_DEFAULTS = {
    mainMinPx: 420,
    mainMinThreePanePx: 320,
    right: {
        minPx: 260,
        // No global cap: the effective max is derived from the container width minus the main min width
        // (and any other docked pane). This enables user-resizable panes to scale naturally on wide screens.
        maxPx: Number.POSITIVE_INFINITY,
    },
    details: {
        minPx: 320,
        // No global cap: see `right.maxPx`.
        maxPx: Number.POSITIVE_INFINITY,
    },
    bottom: {
        minPx: 220,
        // No global cap: the effective max is derived from container height minus the main min height.
        maxPx: Number.POSITIVE_INFINITY,
    },
} as const;

export function resolveScaledPaneWidthPx(input: Readonly<{
    preferredWidthPx: number;
    basisContainerWidthPx: number;
    containerWidthPx: number;
    minPx: number;
    maxPx: number;
}>): number {
    const clamp = (value: number) => Math.min(input.maxPx, Math.max(input.minPx, value));
    const basis = input.basisContainerWidthPx;
    if (!Number.isFinite(basis) || basis <= 0) return clamp(input.preferredWidthPx);
    const ratio = input.containerWidthPx / basis;
    if (!Number.isFinite(ratio) || ratio <= 0) return clamp(input.preferredWidthPx);
    return clamp(input.preferredWidthPx * ratio);
}

export function resolveScaledPaneWidthPxUncapped(input: Readonly<{
    preferredWidthPx: number;
    basisContainerWidthPx: number;
    containerWidthPx: number;
    minPx: number;
}>): number {
    const clampMin = (value: number) => Math.max(input.minPx, value);
    const basis = input.basisContainerWidthPx;
    const prefer = input.preferredWidthPx;
    if (!Number.isFinite(prefer)) return input.minPx;
    if (!Number.isFinite(basis) || basis <= 0) return clampMin(prefer);
    const ratio = input.containerWidthPx / basis;
    if (!Number.isFinite(ratio) || ratio <= 0) return clampMin(prefer);
    return clampMin(prefer * ratio);
}

export function resolveScaledPaneHeightPx(input: Readonly<{
    preferredHeightPx: number;
    basisContainerHeightPx: number;
    containerHeightPx: number;
    minPx: number;
    maxPx: number;
}>): number {
    const clamp = (value: number) => Math.min(input.maxPx, Math.max(input.minPx, value));
    const basis = input.basisContainerHeightPx;
    if (!Number.isFinite(basis) || basis <= 0) return clamp(input.preferredHeightPx);
    const ratio = input.containerHeightPx / basis;
    if (!Number.isFinite(ratio) || ratio <= 0) return clamp(input.preferredHeightPx);
    return clamp(input.preferredHeightPx * ratio);
}

export function resolveScaledPaneHeightPxUncapped(input: Readonly<{
    preferredHeightPx: number;
    basisContainerHeightPx: number;
    containerHeightPx: number;
    minPx: number;
}>): number {
    const clampMin = (value: number) => Math.max(input.minPx, value);
    const basis = input.basisContainerHeightPx;
    const prefer = input.preferredHeightPx;
    if (!Number.isFinite(prefer)) return input.minPx;
    if (!Number.isFinite(basis) || basis <= 0) return clampMin(prefer);
    const ratio = input.containerHeightPx / basis;
    if (!Number.isFinite(ratio) || ratio <= 0) return clampMin(prefer);
    return clampMin(prefer * ratio);
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
    rightWidthPx: number;
    detailsWidthPx: number;
    rightMaxWidthPx: number;
    detailsMaxWidthPx: number;
}>;

export function resolveDockedPaneSizing(input: DockedPaneSizingInput): DockedPaneSizingResult {
    const width = input.containerWidthPx;
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
