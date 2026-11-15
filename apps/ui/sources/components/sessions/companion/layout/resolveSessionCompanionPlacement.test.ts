import { describe, expect, it } from 'vitest';

import type { AppPaneScopeLayoutState } from '@/components/appShell/panes/hooks/useAppPaneScopeLayout';
import { DEFAULT_MAIN_MIN_PX } from '@/components/ui/panels/paneBreakpoints';
import { SESSION_BOARD_MIN_ITEM_WIDTH_PX } from '@/components/sessions/board/sessionBoardGridLayout';

import type { SessionCompanionPreferenceV1 } from '../state/sessionCompanionPreference';
import {
    resolveSessionCompanionPhysicalSide,
    resolveSessionCompanionOuterRailWidthPx,
    resolveSessionCompanionPlacement,
    SESSION_COMPANION_RAIL_GUTTER_PX,
    type SessionCompanionPlacementInput,
} from './resolveSessionCompanionPlacement';

const shown: SessionCompanionPreferenceV1 = {
    v: 1,
    visible: true,
    collapsed: false,
    edge: 'trailing',
    density: 'compact',
    items: [{ kind: 'builtin', id: 'session_summary' }],
};

function paneLayout(overrides: Partial<AppPaneScopeLayoutState> = {}): AppPaneScopeLayoutState {
    return {
        arrangement: 'session', mainHidden: false, mainDrawerOpen: false, effectiveDetailsOpen: false, detailsAvailable: true,
        containerWidthPx: 1440,
        containerHeightPx: 900,
        mainRegionHeightPx: 900,
        mainRegionWidthPx: 1000,
        multiPaneEnabled: true,
        deviceType: 'tablet',
        layout: { main: 'docked', kind: 'single', right: 'hidden', details: 'hidden' },
        bottomPresentation: 'docked',
        ...overrides,
    };
}

function placement(overrides: Partial<SessionCompanionPlacementInput> = {}) {
    return resolveSessionCompanionPlacement({
        preference: shown,
        paneLayout: paneLayout(),
        hostHeightPx: 800,
        bottomObstructionPx: 0,
        mainVisible: true,
        accessibilityModalPaneActive: false,
        fontScale: 1,
        cardBounds: { widthPx: 280, heightPx: 168 },
        ...overrides,
    });
}

describe('resolveSessionCompanionPlacement', () => {
    it('uses the existing collapsed placement inside a fixed editor-first session column', () => {
        expect(placement({ paneLayout: paneLayout({ arrangement: 'editor', mainRegionWidthPx: 440,
            layout: { main: 'docked', kind: 'twoPane', right: 'hidden', details: 'docked' } }),
        })).toEqual({ kind: 'collapsed_control', edge: 'trailing', reason: 'geometry' });
    });
    it('keeps the readable rail floor after a smaller card is measured and still requires enough Chat space', () => {
        const widthPx = resolveSessionCompanionOuterRailWidthPx(SESSION_BOARD_MIN_ITEM_WIDTH_PX);
        expect(placement({ cardBounds: { widthPx: 110, heightPx: 168 } }))
            .toEqual({ kind: 'reserved_rail', edge: 'trailing', widthPx });
        expect(placement({ cardBounds: { widthPx: 110, heightPx: 168 },
            paneLayout: paneLayout({ mainRegionWidthPx: DEFAULT_MAIN_MIN_PX + SESSION_COMPANION_RAIL_GUTTER_PX + widthPx - 1 }),
        })).toEqual({ kind: 'collapsed_control', edge: 'trailing', reason: 'geometry' });
    });

    it('reserves a rail when the main region fits the card plus the canonical Chat minimum', () => {
        expect(placement()).toEqual({ kind: 'reserved_rail', edge: 'trailing', widthPx: 280 });
    });

    it('honours the stored logical edge rather than a physical side', () => {
        expect(placement({ preference: { ...shown, edge: 'leading' } }))
            .toEqual({ kind: 'reserved_rail', edge: 'leading', widthPx: 280 });
        expect(resolveSessionCompanionPhysicalSide('leading', 'ltr')).toBe('left');
        expect(resolveSessionCompanionPhysicalSide('leading', 'rtl')).toBe('right');
        expect(resolveSessionCompanionPhysicalSide('trailing', 'rtl')).toBe('left');
    });

    it('uses the measured card width instead of a density-specific static cap', () => {
        const comfortable = placement({
            preference: { ...shown, density: 'comfortable' },
            cardBounds: { widthPx: 356, heightPx: 184 },
        });

        expect(comfortable).toEqual({ kind: 'reserved_rail', edge: 'trailing', widthPx: 356 });
    });

    it('collapses instead of squeezing Chat when the main region is too narrow', () => {
        expect(placement({ paneLayout: paneLayout({ mainRegionWidthPx: 600 }) }))
            .toEqual({ kind: 'collapsed_control', edge: 'trailing', reason: 'geometry' });
    });

    it('collapses when the measured large-text card grows past the budget', () => {
        expect(placement({ fontScale: 1, paneLayout: paneLayout({ mainRegionWidthPx: 740 }) }))
            .toEqual({ kind: 'reserved_rail', edge: 'trailing', widthPx: 280 });
        expect(placement({
            fontScale: 2,
            paneLayout: paneLayout({ mainRegionWidthPx: 740 }),
            cardBounds: { widthPx: 480, heightPx: 260 },
        }))
            .toEqual({ kind: 'collapsed_control', edge: 'trailing', reason: 'geometry' });
    });

    it('uses the mobile control on a phone and never a persistent card', () => {
        expect(placement({ paneLayout: paneLayout({ deviceType: 'phone' }) }))
            .toEqual({ kind: 'mobile_control' });
        expect(placement({ paneLayout: paneLayout({ multiPaneEnabled: false }) }))
            .toEqual({ kind: 'mobile_control' });
    });

    it('hides while an overlaid pane owns z-order and focus', () => {
        expect(placement({ paneLayout: paneLayout({ layout: { kind: 'overlayStack', main: 'docked', right: 'overlay', details: 'hidden' } }) }))
            .toEqual({ kind: 'hidden' });
        expect(placement({ paneLayout: paneLayout({ layout: { kind: 'overlayStack', main: 'docked', right: 'hidden', details: 'overlay' } }) }))
            .toEqual({ kind: 'hidden' });
    });

    it('draws no rail while the docked side panel already presents the Companion', () => {
        const docked = paneLayout({ layout: { main: 'docked', kind: 'twoPane', right: 'docked', details: 'hidden' } });
        expect(placement({ paneLayout: docked }).kind).toBe('reserved_rail');
        expect(placement({ paneLayout: docked, presentedInSidePanel: true })).toEqual({ kind: 'hidden' });
    });
    it('keeps a rail beside a docked pane', () => {
        expect(placement({
            paneLayout: paneLayout({
                mainRegionWidthPx: 900,
                layout: { kind: 'twoPane', main: 'docked', right: 'docked', details: 'hidden' },
            }),
        })).toEqual({ kind: 'reserved_rail', edge: 'trailing', widthPx: 280 });
    });

    it('hides when main is not visible or an accessibility-modal overlay is active', () => {
        expect(placement({ mainVisible: false })).toEqual({ kind: 'hidden' });
        expect(placement({ accessibilityModalPaneActive: true })).toEqual({ kind: 'hidden' });
    });

    it('never mounts a card for a hidden preference', () => {
        expect(placement({ preference: { ...shown, visible: false } })).toEqual({ kind: 'hidden' });
        expect(placement({
            preference: { ...shown, visible: false },
            paneLayout: paneLayout({ deviceType: 'phone' }),
        })).toEqual({ kind: 'hidden' });
    });

    it('shows the collapsed control for a collapsed preference', () => {
        expect(placement({ preference: { ...shown, collapsed: true, edge: 'leading' } }))
            .toEqual({ kind: 'collapsed_control', edge: 'leading', reason: 'preference' });
    });

    it('collapses rather than letting keyboard or bottom chrome overlap the card', () => {
        expect(placement({ hostHeightPx: 400, bottomObstructionPx: 300 }))
            .toEqual({ kind: 'collapsed_control', edge: 'trailing', reason: 'geometry' });
    });

    it('collapses when pane geometry has not been measured yet', () => {
        expect(placement({ paneLayout: null })).toEqual({ kind: 'collapsed_control', edge: 'trailing', reason: 'geometry' });
        expect(placement({ paneLayout: paneLayout({ mainRegionWidthPx: Number.NaN }) }))
            .toEqual({ kind: 'collapsed_control', edge: 'trailing', reason: 'geometry' });
    });

    it('requests an inert rail-constrained measurement when wide geometry is proven but card bounds are cold', () => {
        expect(placement({ cardBounds: null }))
            .toEqual({ kind: 'measuring_rail', edge: 'trailing', widthPx: 264, heightPx: 800 });
        expect(placement({ cardBounds: { widthPx: Number.NaN, heightPx: 168 } }))
            .toEqual({ kind: 'collapsed_control', edge: 'trailing', reason: 'geometry' });
    });

    it('does not request a cold measurement when the canonical readable rail cannot fit', () => {
        expect(placement({
            paneLayout: paneLayout({ mainRegionWidthPx: 600 }),
            cardBounds: null,
        })).toEqual({ kind: 'collapsed_control', edge: 'trailing', reason: 'geometry' });
    });

    it('admits the cold readable outer rail at its exact width threshold and rejects one pixel less', () => {
        const exactWidthPx = DEFAULT_MAIN_MIN_PX + SESSION_COMPANION_RAIL_GUTTER_PX + 264;

        expect(placement({
            paneLayout: paneLayout({ mainRegionWidthPx: exactWidthPx }),
            cardBounds: null,
        })).toEqual({ kind: 'measuring_rail', edge: 'trailing', widthPx: 264, heightPx: 800 });
        expect(placement({
            paneLayout: paneLayout({ mainRegionWidthPx: exactWidthPx - 1 }),
            cardBounds: null,
        })).toEqual({ kind: 'collapsed_control', edge: 'trailing', reason: 'geometry' });
    });

    it('collapses when effective text scale cannot be proven', () => {
        expect(placement({ fontScale: Number.NaN }))
            .toEqual({ kind: 'collapsed_control', edge: 'trailing', reason: 'geometry' });
        expect(placement({ fontScale: 0 }))
            .toEqual({ kind: 'collapsed_control', edge: 'trailing', reason: 'geometry' });
    });
});
