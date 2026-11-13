import * as React from 'react';
import { View } from 'react-native';
import { HappierBodyEdgeContext, HappierPageSectionContext } from '@happier-dev/plugin-ui/presentation';

import type { PageColumn } from '@/components/ui/layout/contentWidthMode';
import { PANE_TEXT_INSET_PX } from '@/components/ui/layout/headerBand';
import { ITEM_ROW_PADDING_HORIZONTAL } from '@/components/ui/lists/itemDensityMetrics';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';

/**
 * How grouped list content is presented.
 *
 * - `grouped`: the compact inset-grouped look (sentence-case header, description under the card). It stays the
 *   look of menus, pickers, sheets and every list that is not a full configuration page.
 * - `page`: the configuration-page anatomy (sentence-case section heading with its description above
 *   the rows, a hairline sheet with row dividers, paper background). A full-page `ItemList` defaults to it
 *   and every `ItemGroup`/`Item` below it follows.
 *
 * Floating surfaces (menus, popovers) reset to `grouped` so a menu opened from a page never inherits
 * page anatomy — see `FloatingOverlay`.
 */
export type ListPresentation = 'grouped' | 'page';

const ListPresentationContext = React.createContext<ListPresentation>('grouped');
type PageListInsets = 'standard' | 'contained';
const PageListInsetsContext = React.createContext<PageListInsets>('standard');
const PageNoticeActiveContext = React.createContext(false);
/**
 * The scope's rows sit directly on a floating surface (a popover, menu or its phone sheet). Grouped
 * sections there take the menu anatomy instead of drawing a card inside the floating card.
 */
const FloatingListSurfaceContext = React.createContext(false);

/** True inside a floating surface's own list scope (see `ListPresentationProvider` `floating`). */
export function useFloatingListSurface(): boolean {
    return React.useContext(FloatingListSurfaceContext);
}

/**
 * A side pane's body (the right sidebar of a Session, a Project, a Discussion or the app): its text keeps
 * the pane's one edge, `PANE_TEXT_INSET_PX`, the inset its header title uses. Set once by each host under
 * its `RightSidebarPaneHeader`.
 */
const SidePaneBodyContext = React.createContext(false);

export function SidePaneBodyProvider(props: Readonly<{
    /** `false` inside a card drawn on the pane: its rows keep the card's own inset, the card stands on the edge. */
    active?: boolean;
    children: React.ReactNode;
}>) {
    return <SidePaneBodyContext.Provider value={props.active !== false}>{props.children}</SidePaneBodyContext.Provider>;
}

/**
 * Whether content here starts on a side pane's text edge: its section labels, its rows' leading marks and its
 * flat page sections. A floating surface opened from the pane (React context crosses portals) keeps its own.
 */
export function useSidePaneTextEdge(): boolean {
    const sidePane = React.useContext(SidePaneBodyContext);
    const floating = React.useContext(FloatingListSurfaceContext);
    return sidePane && !floating;
}

/**
 * Whether a list row here stands on a widget body's edge (`HappierBodyEdgeContext`, set by the widget frame): its
 * glyph lines up with the frame's mark and its meta with the frame's edge, so the row draws no inset of its own.
 * A floating surface opened from the body starts outside it again (see `ListPresentationProvider` `floating`).
 */
export function useWidgetBodyRowEdge(): boolean {
    return React.useContext(HappierBodyEdgeContext);
}

/**
 * The inset pane content (a rail's toolbar, rows and labels drawn outside `Item`) starts its text at: the side
 * pane's text edge there, else the compact row inset such content shares with compact rows.
 */
export function usePaneContentInsetPx(): number {
    return useSidePaneTextEdge() ? PANE_TEXT_INSET_PX : ITEM_ROW_PADDING_HORIZONTAL.compact;
}

/**
 * Set by a grouped section laid out as a menu section on a floating surface: its rows take the menu row
 * role (`Item` `rowRole="menu"`) unless they choose another.
 */
export const MenuSectionRowsContext = React.createContext(false);

/**
 * Rows of a section with no drawn sheet (`ItemGroup surface="none"`): nothing clips them, so their fills are
 * square and their keyboard ring stands outside the row with a gap, as on every other control.
 */
export const BareSectionRowsContext = React.createContext(false);

/** Only repeated states explained by the current page notice defer to this fact. */
export function usePageNoticeActive(): boolean {
    return React.useContext(PageNoticeActiveContext);
}

/**
 * Starts a list presentation scope. The scope also starts outside any page sheet: a menu, popover or
 * picker opened from a sheet row (React context crosses portals) draws its own rows, never the sheet's
 * row inset and hairlines.
 */
export function ListPresentationProvider(props: Readonly<{
    value: ListPresentation;
    /** A contained column or widget body already owns its outer padding; sections add no second inset. */
    pageInsets?: PageListInsets;
    /** The page owns the cause and recovery; sections may omit repeats of that cause. */
    pageNoticeActive?: boolean;
    /** The scope is a floating surface's (`FloatingOverlay`); a nested scope starts outside it again. */
    floating?: boolean;
    children: React.ReactNode;
}>) {
    return (
        <HappierPageSectionContext.Provider value={null}>
            <PageListInsetsContext.Provider value={props.pageInsets ?? 'standard'}>
                <PageNoticeActiveContext.Provider value={props.value === 'page' && props.pageNoticeActive === true}>
                    <FloatingListSurfaceContext.Provider value={props.floating === true}>
                        {props.floating === true ? (
                            // A floating surface opened from a widget body is off that body's edge: its rows keep their own inset.
                            <HappierBodyEdgeContext.Provider value={false}>
                                <ListPresentationContext.Provider value={props.value}>{props.children}</ListPresentationContext.Provider>
                            </HappierBodyEdgeContext.Provider>
                        ) : <ListPresentationContext.Provider value={props.value}>{props.children}</ListPresentationContext.Provider>}
                    </FloatingListSurfaceContext.Provider>
                </PageNoticeActiveContext.Provider>
            </PageListInsetsContext.Provider>
        </HappierPageSectionContext.Provider>
    );
}

export function useListPresentation(): ListPresentation {
    return React.useContext(ListPresentationContext);
}

/**
 * Whether content drawn outside `Item` (a state line, a work row) stands among a bare page section's rows
 * (`ItemGroup surface="none"`, page presentation): no sheet and no sheet row inset, so it starts on the rows'
 * own text edge (`PAGE_LIST_METRICS.rowPaddingHorizontalPx`) rather than a collection column's inset.
 */
export function useBareSectionRowEdge(): boolean {
    const bare = React.useContext(BareSectionRowsContext);
    const presentation = useListPresentation();
    return bare && presentation === 'page';
}

const BARE_SECTION_LINE_STYLE = { paddingHorizontal: PAGE_LIST_METRICS.rowPaddingHorizontalPx } as const;

/**
 * The one edge of a state line (`SurfaceStateCard` or `EmptyState` at line size) among a bare page section's rows:
 * the rows' own text edge, with the line's glyph standing on it, rather than a collection list's inset. Elsewhere,
 * or when `enabled` is false (a line that fills its container, or one with menu or catalog density), it renders
 * its child unchanged.
 */
export function BareSectionLineEdge(props: Readonly<{ children: React.ReactNode; enabled?: boolean }>): React.ReactElement {
    const bare = useBareSectionRowEdge();
    if (!bare || props.enabled === false) return <>{props.children}</>;
    return <View style={BARE_SECTION_LINE_STYLE}><HappierBodyEdgeContext.Provider value>{props.children}</HappierBodyEdgeContext.Provider></View>;
}

export function usePageListInsets(): PageListInsets {
    return React.useContext(PageListInsetsContext);
}

/**
 * A configuration page's column (`reading` unless the page's `ItemList` declares `wide`). Everything in
 * the page that sizes itself to the content column (`useLayoutMaxWidth`) follows it, so the header,
 * sections, bars and footers keep one edge.
 */
const PageColumnContext = React.createContext<PageColumn>('reading');

/**
 * A contained surface (a card modal's body) is its page lists' column: a page list inside it takes the
 * container's width and text edge instead of the page reading column (R-APP-7). Lists keep the scope
 * across their own presentation scopes; a fullscreen modal does not start one.
 */
const ContainedPageScopeContext = React.createContext(false);

export function ContainedPageScopeProvider(props: Readonly<{ contained?: boolean; children: React.ReactNode }>) {
    return <ContainedPageScopeContext.Provider value={props.contained !== false}>{props.children}</ContainedPageScopeContext.Provider>;
}

export function useContainedPageScope(): boolean {
    return React.useContext(ContainedPageScopeContext);
}

export function PageColumnProvider(props: Readonly<{ value: PageColumn; children: React.ReactNode }>) {
    return <PageColumnContext.Provider value={props.value}>{props.children}</PageColumnContext.Provider>;
}

export function usePageColumn(): PageColumn {
    return React.useContext(PageColumnContext);
}
