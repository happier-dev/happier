import { describe, expect, it } from 'vitest';
import { resolvePaneLayout } from './paneBreakpoints';

describe('resolvePaneLayout', () => {
    it('never docks an item opened over its page, so the page keeps its width at every size', () => {
        const input = { deviceType: 'tablet' as const, multiPaneEnabled: true, detailsOpen: true, detailsOverPage: true,
            detailsPreferredPx: 750, rightPreferredPx: 380 };
        expect(resolvePaneLayout({ ...input, containerWidthPx: 1440, rightOpen: false }))
            .toMatchObject({ kind: 'overlayStack', main: 'docked', right: 'hidden', details: 'overlay' });
        // The side column beside the page stays; only the page is covered.
        expect(resolvePaneLayout({ ...input, containerWidthPx: 1440, rightOpen: true }))
            .toMatchObject({ kind: 'twoPane', main: 'docked', right: 'docked', details: 'overlay' });
        expect(resolvePaneLayout({ ...input, containerWidthPx: 600, rightOpen: true }))
            .toMatchObject({ kind: 'overlayStack', right: 'hidden', details: 'overlay' });
    });
    it('keeps the editor permanent and folds side then session in editor-first', () => {
        const input = { arrangement: 'editor' as const, deviceType: 'tablet' as const, multiPaneEnabled: true,
            rightOpen: true, detailsOpen: false, rightPreferredPx: 340, sessionWidthPx: 440 };
        expect(resolvePaneLayout({ ...input, containerWidthPx: 1280 })).toMatchObject({ main: 'docked', right: 'docked', details: 'docked' });
        expect(resolvePaneLayout({ ...input, containerWidthPx: 1100 })).toMatchObject({ main: 'docked', right: 'overlay', details: 'docked' });
        expect(resolvePaneLayout({ ...input, containerWidthPx: 834, detailsOpenedFrom: 'side' })).toMatchObject({ main: 'overlay', right: 'overlay', details: 'docked' });
    });
    it('returns single when multi-pane is disabled', () => {
        expect(resolvePaneLayout({
            containerWidthPx: 1400,
            deviceType: 'tablet',
            multiPaneEnabled: false,
            rightOpen: true,
            detailsOpen: true,
        })).toEqual({ main: 'docked', kind: 'single', right: 'hidden', details: 'hidden' });
    });

    it('returns single on phone regardless of width', () => {
        expect(resolvePaneLayout({
            containerWidthPx: 1400,
            deviceType: 'phone',
            multiPaneEnabled: true,
            rightOpen: true,
            detailsOpen: true,
        })).toEqual({ main: 'docked', kind: 'single', right: 'hidden', details: 'hidden' });
    });

    it('docks right when main+right fit, even on narrower widths', () => {
        expect(resolvePaneLayout({
            containerWidthPx: 880,
            deviceType: 'tablet',
            multiPaneEnabled: true,
            rightOpen: true,
            detailsOpen: false,
        })).toEqual({ main: 'docked', kind: 'twoPane', right: 'docked', details: 'hidden' });
    });

    it('docks right when the preferred right width cannot fit with main (clamped later by sizing)', () => {
        expect(resolvePaneLayout({
            containerWidthPx: 880,
            deviceType: 'tablet',
            multiPaneEnabled: true,
            rightOpen: true,
            detailsOpen: false,
            rightPreferredPx: 560,
        })).toEqual({ main: 'docked', kind: 'twoPane', right: 'docked', details: 'hidden' });
    });

    it('uses overlay for right when preferred cannot fit and the caller explicitly prefers overlay', () => {
        expect(resolvePaneLayout({
            containerWidthPx: 880,
            deviceType: 'tablet',
            multiPaneEnabled: true,
            rightOpen: true,
            detailsOpen: false,
            rightPreferredPx: 560,
            rightPreferOverlayWhenPreferredDoesNotFit: true,
        })).toEqual({ main: 'docked', kind: 'overlayStack', right: 'overlay', details: 'hidden' });
    });

    it('uses overlay when main+right cannot fit', () => {
        expect(resolvePaneLayout({
            containerWidthPx: 640,
            deviceType: 'tablet',
            multiPaneEnabled: true,
            rightOpen: true,
            detailsOpen: false,
        })).toEqual({ main: 'docked', kind: 'overlayStack', right: 'overlay', details: 'hidden' });
    });

    it('docks right and overlays details when both are open but three panes do not fit', () => {
        expect(resolvePaneLayout({
            containerWidthPx: 950,
            deviceType: 'tablet',
            multiPaneEnabled: true,
            rightOpen: true,
            detailsOpen: true,
        })).toEqual({ main: 'docked', kind: 'twoPane', right: 'docked', details: 'overlay' });
    });

    it('docks details in twoPane when only details is open and it fits', () => {
        expect(resolvePaneLayout({
            containerWidthPx: 980,
            deviceType: 'tablet',
            multiPaneEnabled: true,
            rightOpen: false,
            detailsOpen: true,
    })).toEqual({ main: 'docked', kind: 'twoPane', right: 'hidden', details: 'docked' });
    });

    it('docks details when the preferred details width cannot fit with main (clamped later by sizing)', () => {
        expect(resolvePaneLayout({
            containerWidthPx: 880,
            deviceType: 'tablet',
            multiPaneEnabled: true,
            rightOpen: false,
            detailsOpen: true,
            detailsPreferredPx: 700,
        })).toEqual({ main: 'docked', kind: 'twoPane', right: 'hidden', details: 'docked' });
    });

    it('uses overlay for details when preferred cannot fit and the caller explicitly prefers overlay', () => {
        expect(resolvePaneLayout({
            containerWidthPx: 880,
            deviceType: 'tablet',
            multiPaneEnabled: true,
            rightOpen: false,
            detailsOpen: true,
            detailsPreferredPx: 700,
            detailsPreferOverlayWhenPreferredDoesNotFit: true,
        })).toEqual({ main: 'docked', kind: 'overlayStack', right: 'hidden', details: 'overlay' });
    });

    it('uses threePane when both panes are open and fit', () => {
        expect(resolvePaneLayout({
            containerWidthPx: 1020,
            deviceType: 'tablet',
            multiPaneEnabled: true,
            rightOpen: true,
            detailsOpen: true,
        })).toEqual({ main: 'docked', kind: 'threePane', right: 'docked', details: 'docked' });
    });

    it('prefers overlay details when three-pane mins fit but preferred widths do not', () => {
        expect(resolvePaneLayout({
            containerWidthPx: 1100,
            deviceType: 'tablet',
            multiPaneEnabled: true,
            rightOpen: true,
            detailsOpen: true,
            rightPreferredPx: 560,
            detailsPreferredPx: 700,
        })).toEqual({ main: 'docked', kind: 'twoPane', right: 'docked', details: 'overlay' });
    });

    it('falls back to docked right + overlay details when three panes do not fit but two do', () => {
        expect(resolvePaneLayout({
            containerWidthPx: 1300,
            deviceType: 'tablet',
            multiPaneEnabled: true,
            rightOpen: true,
            detailsOpen: true,
            mainMinPx: 800,
        })).toEqual({ main: 'docked', kind: 'twoPane', right: 'docked', details: 'overlay' });
    });

    it('falls back to overlayStack when even main+right does not fit', () => {
        expect(resolvePaneLayout({
            containerWidthPx: 1300,
            deviceType: 'tablet',
            multiPaneEnabled: true,
            rightOpen: true,
            detailsOpen: true,
            mainMinPx: 1100,
        })).toEqual({ main: 'docked', kind: 'overlayStack', right: 'hidden', details: 'overlay' });
    });

    it('docks all three panes at their minimums when no preferred width fits but the minimums do', () => {
        expect(resolvePaneLayout({
            containerWidthPx: 1000,
            deviceType: 'tablet',
            multiPaneEnabled: true,
            rightOpen: true,
            detailsOpen: true,
            rightPreferredPx: 600,
            detailsPreferredPx: 600,
        })).toEqual({ main: 'docked', kind: 'threePane', right: 'docked', details: 'docked' });
    });

    it('allows threePane with a relaxed main minimum when both panes are open', () => {
        expect(resolvePaneLayout({
            containerWidthPx: 960,
            deviceType: 'tablet',
            multiPaneEnabled: true,
            rightOpen: true,
            detailsOpen: true,
            mainMinPxThreePane: 320,
        })).toEqual({ main: 'docked', kind: 'threePane', right: 'docked', details: 'docked' });
    });

    describe('Details never covers what it was opened from (details lab 2, Q1)', () => {
        const wideEnoughForTwoNotThree = {
            containerWidthPx: 1200,
            deviceType: 'tablet' as const,
            multiPaneEnabled: true,
            rightOpen: true,
            detailsOpen: true,
            rightPreferredPx: 360,
            detailsPreferredPx: 600,
        };

        it('folds the sidebar to its rail and docks Details when opened from the transcript', () => {
            expect(resolvePaneLayout({ ...wideEnoughForTwoNotThree, detailsOpenedFrom: 'main' }))
                .toEqual({ main: 'docked', kind: 'twoPane', right: 'hidden', details: 'docked' });
        });

        it('keeps the sidebar list and draws Details as a drawer when opened from that list', () => {
            expect(resolvePaneLayout({ ...wideEnoughForTwoNotThree, detailsOpenedFrom: 'side', rightPreferredPx: 900 }))
                .toEqual({ main: 'docked', kind: 'twoPane', right: 'docked', details: 'overlay' });
        });

        it('docks all three when they fit, whichever region opened Details', () => {
            for (const detailsOpenedFrom of ['main', 'side'] as const) {
                expect(resolvePaneLayout({ ...wideEnoughForTwoNotThree, containerWidthPx: 1800, detailsOpenedFrom }))
                    .toEqual({ main: 'docked', kind: 'threePane', right: 'docked', details: 'docked' });
            }
        });
    });
});

