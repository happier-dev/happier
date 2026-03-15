import { describe, expect, it } from 'vitest';
import { resolvePaneLayout } from './paneBreakpoints';

describe('resolvePaneLayout', () => {
    it('returns single when multi-pane is disabled', () => {
        expect(resolvePaneLayout({
            containerWidthPx: 1400,
            deviceType: 'tablet',
            multiPaneEnabled: false,
            rightOpen: true,
            detailsOpen: true,
        })).toEqual({ kind: 'single', right: 'hidden', details: 'hidden' });
    });

    it('returns single on phone regardless of width', () => {
        expect(resolvePaneLayout({
            containerWidthPx: 1400,
            deviceType: 'phone',
            multiPaneEnabled: true,
            rightOpen: true,
            detailsOpen: true,
        })).toEqual({ kind: 'single', right: 'hidden', details: 'hidden' });
    });

    it('docks right when main+right fit, even on narrower widths', () => {
        expect(resolvePaneLayout({
            containerWidthPx: 880,
            deviceType: 'tablet',
            multiPaneEnabled: true,
            rightOpen: true,
            detailsOpen: false,
        })).toEqual({ kind: 'twoPane', right: 'docked', details: 'hidden' });
    });

    it('docks right when the preferred right width cannot fit with main (clamped later by sizing)', () => {
        expect(resolvePaneLayout({
            containerWidthPx: 880,
            deviceType: 'tablet',
            multiPaneEnabled: true,
            rightOpen: true,
            detailsOpen: false,
            rightPreferredPx: 560,
        })).toEqual({ kind: 'twoPane', right: 'docked', details: 'hidden' });
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
        })).toEqual({ kind: 'overlayStack', right: 'overlay', details: 'hidden' });
    });

    it('uses overlay when main+right cannot fit', () => {
        expect(resolvePaneLayout({
            containerWidthPx: 640,
            deviceType: 'tablet',
            multiPaneEnabled: true,
            rightOpen: true,
            detailsOpen: false,
        })).toEqual({ kind: 'overlayStack', right: 'overlay', details: 'hidden' });
    });

    it('docks right and overlays details when both are open but three panes do not fit', () => {
        expect(resolvePaneLayout({
            containerWidthPx: 950,
            deviceType: 'tablet',
            multiPaneEnabled: true,
            rightOpen: true,
            detailsOpen: true,
        })).toEqual({ kind: 'twoPane', right: 'docked', details: 'overlay' });
    });

    it('docks right and overlays details when both are open and still do not fit three panes', () => {
        expect(resolvePaneLayout({
            containerWidthPx: 980,
            deviceType: 'tablet',
            multiPaneEnabled: true,
            rightOpen: true,
            detailsOpen: true,
        })).toEqual({ kind: 'twoPane', right: 'docked', details: 'overlay' });
    });

    it('docks right in twoPane when only right is open', () => {
        expect(resolvePaneLayout({
            containerWidthPx: 920,
            deviceType: 'tablet',
            multiPaneEnabled: true,
            rightOpen: true,
            detailsOpen: false,
        })).toEqual({ kind: 'twoPane', right: 'docked', details: 'hidden' });
    });

    it('docks details in twoPane when only details is open and it fits', () => {
        expect(resolvePaneLayout({
            containerWidthPx: 980,
            deviceType: 'tablet',
            multiPaneEnabled: true,
            rightOpen: false,
            detailsOpen: true,
    })).toEqual({ kind: 'twoPane', right: 'hidden', details: 'docked' });
    });

    it('docks details when the preferred details width cannot fit with main (clamped later by sizing)', () => {
        expect(resolvePaneLayout({
            containerWidthPx: 880,
            deviceType: 'tablet',
            multiPaneEnabled: true,
            rightOpen: false,
            detailsOpen: true,
            detailsPreferredPx: 700,
        })).toEqual({ kind: 'twoPane', right: 'hidden', details: 'docked' });
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
        })).toEqual({ kind: 'overlayStack', right: 'hidden', details: 'overlay' });
    });

    it('uses threePane when both panes are open and fit', () => {
        expect(resolvePaneLayout({
            containerWidthPx: 1020,
            deviceType: 'tablet',
            multiPaneEnabled: true,
            rightOpen: true,
            detailsOpen: true,
        })).toEqual({ kind: 'threePane', right: 'docked', details: 'docked' });
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
        })).toEqual({ kind: 'twoPane', right: 'docked', details: 'overlay' });
    });

    it('falls back to docked right + overlay details when three panes do not fit but two do', () => {
        expect(resolvePaneLayout({
            containerWidthPx: 1300,
            deviceType: 'tablet',
            multiPaneEnabled: true,
            rightOpen: true,
            detailsOpen: true,
            mainMinPx: 800,
        })).toEqual({ kind: 'twoPane', right: 'docked', details: 'overlay' });
    });

    it('falls back to overlayStack when even main+right does not fit', () => {
        expect(resolvePaneLayout({
            containerWidthPx: 1300,
            deviceType: 'tablet',
            multiPaneEnabled: true,
            rightOpen: true,
            detailsOpen: true,
            mainMinPx: 1100,
        })).toEqual({ kind: 'overlayStack', right: 'hidden', details: 'overlay' });
    });

    it('avoids overlayStack when preferred three-pane widths do not fit but mins do', () => {
        expect(resolvePaneLayout({
            containerWidthPx: 980,
            deviceType: 'tablet',
            multiPaneEnabled: true,
            rightOpen: true,
            detailsOpen: true,
            rightPreferredPx: 560,
            detailsPreferredPx: 700,
        })).toEqual({ kind: 'twoPane', right: 'docked', details: 'overlay' });
    });

    it('allows threePane with a relaxed main minimum when both panes are open', () => {
        expect(resolvePaneLayout({
            containerWidthPx: 960,
            deviceType: 'tablet',
            multiPaneEnabled: true,
            rightOpen: true,
            detailsOpen: true,
            mainMinPxThreePane: 320,
        })).toEqual({ kind: 'threePane', right: 'docked', details: 'docked' });
    });
});
