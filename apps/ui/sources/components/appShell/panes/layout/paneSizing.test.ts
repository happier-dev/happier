import { describe, expect, it } from 'vitest';
import { resolvePaneLayout } from '@/components/ui/panels/paneBreakpoints';
import { PANE_SIZING_DEFAULTS, resolveDetailsDockPreferredPx, resolveDockedPaneSizing, resolveRightDockPreferredPx } from './paneSizing';

describe('resolveRightDockPreferredPx', () => {
    const base = { storedDefaultPx: 380, mainReadingWidthPx: 850 };
    it('gives an undragged side pane the canvas the reading column leaves empty on a wide window', () => {
        // 2560 less the sidebar and rail: the transcript keeps its reading width, the pane takes the rest.
        expect(resolveRightDockPreferredPx({ ...base, storedPx: 380, containerWidthPx: 2196 })).toBe(1346);
    });
    it('keeps the default where the window has no spare canvas', () => {
        expect(resolveRightDockPreferredPx({ ...base, storedPx: 380, containerWidthPx: 1096 })).toBe(380);
    });
    // DESIGN-ACCEPT-1116-D (X-routed P2): with Browser in Details and Local services beside it, the side pane took
    // all the canvas beyond the transcript's reading width as if Details were closed, so three docked columns never
    // fit and Details covered the transcript even at 2560 (lab FB1: from 1920 Details docks beside it, no scrim).
    it('leaves an open Details its column before the side pane takes the spare canvas', () => {
        const container = 2196;
        const rightPx = resolveRightDockPreferredPx({ ...base, storedPx: 380, containerWidthPx: container, besidePx: 600 });
        expect(rightPx).toBe(746);
        expect(resolvePaneLayout({
            arrangement: 'session', containerWidthPx: container, deviceType: 'tablet', multiPaneEnabled: true,
            rightOpen: true, detailsOpen: true, mainMinPx: PANE_SIZING_DEFAULTS.mainMinPx,
            mainMinPxThreePane: PANE_SIZING_DEFAULTS.mainMinThreePanePx,
            rightMinPx: PANE_SIZING_DEFAULTS.right.minPx, detailsMinPx: PANE_SIZING_DEFAULTS.details.minPx,
            rightPreferredPx: rightPx, detailsPreferredPx: 600,
        })).toMatchObject({ right: 'docked', details: 'docked' });
        // Where Details cannot dock anyway, the side pane keeps its default width.
        expect(resolveRightDockPreferredPx({ ...base, storedPx: 380, containerWidthPx: 1096, besidePx: 600 })).toBe(380);
    });
    it('keeps a dragged width and a full-width reading preference', () => {
        expect(resolveRightDockPreferredPx({ ...base, storedPx: 420, containerWidthPx: 2196 })).toBe(420);
        expect(resolveRightDockPreferredPx({ storedDefaultPx: 380, mainReadingWidthPx: Number.POSITIVE_INFINITY,
            storedPx: 380, containerWidthPx: 2196 })).toBe(380);
    });
});

describe('resolveDetailsDockPreferredPx', () => {
    const base = { storedDefaultPx: 600, destinationPreferredPx: 750 };
    it('gives an undragged detail its destination width while main keeps its minimum', () => {
        expect(resolveDetailsDockPreferredPx({ ...base, storedPx: 600, budgetMaxPx: 956 })).toBe(750);
        expect(resolveDetailsDockPreferredPx({ ...base, storedPx: 600, budgetMaxPx: 680 })).toBe(680);
    });
    it('lets a destination that reads narrower than the default take its width until the person drags', () => {
        const narrow = { storedDefaultPx: 600, destinationPreferredPx: 440, budgetMaxPx: 956 };
        expect(resolveDetailsDockPreferredPx({ ...narrow, storedPx: 600 })).toBe(440);
        expect(resolveDetailsDockPreferredPx({ ...narrow, storedPx: 700 })).toBe(700);
    });
    it('keeps a dragged width, a destination with no preference, and the overlay decision of a narrow window', () => {
        expect(resolveDetailsDockPreferredPx({ ...base, storedPx: 520, budgetMaxPx: 956 })).toBe(520);
        expect(resolveDetailsDockPreferredPx({ storedDefaultPx: 600, destinationPreferredPx: undefined, storedPx: 600, budgetMaxPx: 956 })).toBe(600);
        expect(resolveDetailsDockPreferredPx({ ...base, storedPx: 600, budgetMaxPx: 500 })).toBe(600);
    });
});

describe('resolveDockedPaneSizing', () => {
    it('clamps the side pane before shrinking the stored session preference', () => {
        expect(resolveDockedPaneSizing({ arrangement: 'editor', containerWidthPx: 1180, mainMinPx: 480,
            rightMinPx: 260, detailsMinPx: 480, rightWidthPx: 340, detailsWidthPx: 520, sessionWidthPx: 440,
            mainDocked: true, rightGlobalMinPx: 260, rightGlobalMaxPx: Infinity, detailsGlobalMinPx: 480,
            detailsGlobalMaxPx: Infinity, rightDocked: true, detailsDocked: true,
        })).toMatchObject({ mainWidthPx: 440, rightWidthPx: 260, detailsWidthPx: 480 });
    });
    it('reserves stored session and side widths while the editor takes the remainder', () => {
        const result = resolveDockedPaneSizing({
            arrangement: 'editor', containerWidthPx: 1440, mainMinPx: 480, rightMinPx: 260, detailsMinPx: 480,
            rightWidthPx: 340, detailsWidthPx: 520, sessionWidthPx: 440, mainDocked: true,
            rightGlobalMinPx: 260, rightGlobalMaxPx: Infinity, detailsGlobalMinPx: 480,
            detailsGlobalMaxPx: Infinity, rightDocked: true, detailsDocked: true,
        });
        expect(result).toMatchObject({ mainWidthPx: 440, rightWidthPx: 340, detailsWidthPx: 660, mainMaxWidthPx: 620 });
    });
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

