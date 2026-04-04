import { describe, expect, it } from 'vitest';
import { PANE_SIZING_DEFAULTS, resolveDockedPaneSizing, resolveScaledPaneWidthPx } from './paneSizing';

describe('resolveDockedPaneSizing', () => {
    it('shrinks right/details widths to preserve mainMinPx when both panes are docked', () => {
        const containerWidthPx = 1440;
        const result = resolveDockedPaneSizing({
            containerWidthPx,
            mainMinPx: PANE_SIZING_DEFAULTS.mainMinPx,
            rightMinPx: PANE_SIZING_DEFAULTS.right.minPx,
            detailsMinPx: PANE_SIZING_DEFAULTS.details.minPx,
            rightWidthPx: 432,
            detailsWidthPx: 624,
            rightGlobalMinPx: PANE_SIZING_DEFAULTS.right.minPx,
            rightGlobalMaxPx: PANE_SIZING_DEFAULTS.right.maxPx,
            detailsGlobalMinPx: PANE_SIZING_DEFAULTS.details.minPx,
            detailsGlobalMaxPx: PANE_SIZING_DEFAULTS.details.maxPx,
            rightDocked: true,
            detailsDocked: true,
        });

        const budget = containerWidthPx - PANE_SIZING_DEFAULTS.mainMinPx;
        expect(result.rightWidthPx + result.detailsWidthPx).toBeLessThanOrEqual(budget);
        expect(result.rightWidthPx).toBeGreaterThanOrEqual(PANE_SIZING_DEFAULTS.right.minPx);
        expect(result.detailsWidthPx).toBeGreaterThanOrEqual(PANE_SIZING_DEFAULTS.details.minPx);
        // Max widths should reflect the remaining budget after reserving `mainMinPx`, not an arbitrary global cap.
        expect(result.rightMaxWidthPx).toBeLessThanOrEqual(budget);
        expect(result.detailsMaxWidthPx).toBeLessThanOrEqual(budget);
    });
});

describe('resolveScaledPaneWidthPx', () => {
    it('can keep a matching default width fixed across viewport changes', () => {
        expect(
            resolveScaledPaneWidthPx({
                preferredWidthPx: 230,
                basisContainerWidthPx: 1200,
                containerWidthPx: 1600,
                minPx: 220,
                maxPx: 420,
                skipScalingWhenPreferredWidthPxMatches: 230,
            })
        ).toBe(230);
    });

    it('continues scaling widths that do not match the fixed default marker', () => {
        expect(
            resolveScaledPaneWidthPx({
                preferredWidthPx: 260,
                basisContainerWidthPx: 1200,
                containerWidthPx: 1600,
                minPx: 220,
                maxPx: 420,
                skipScalingWhenPreferredWidthPxMatches: 230,
            })
        ).toBeCloseTo(346.6666666666667);
    });
});
