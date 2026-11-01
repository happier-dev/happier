import * as React from 'react';
import { HappierBodyEdgeContext, HappierPageSectionContext } from '@happier-dev/plugin-ui/presentation';

import type { PageColumn } from '@/components/ui/layout/contentWidthMode';

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

/** Whether a list row here stands on a widget body's edge. Floating surfaces reset this context. */
export function useWidgetBodyRowEdge(): boolean {
    return React.useContext(HappierBodyEdgeContext);
}

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
                    {props.floating === true ? (
                        // A floating surface opened from a widget body is off that body's edge: its rows keep their own inset.
                        <HappierBodyEdgeContext.Provider value={false}>
                            <ListPresentationContext.Provider value={props.value}>{props.children}</ListPresentationContext.Provider>
                        </HappierBodyEdgeContext.Provider>
                    ) : <ListPresentationContext.Provider value={props.value}>{props.children}</ListPresentationContext.Provider>}
                </PageNoticeActiveContext.Provider>
            </PageListInsetsContext.Provider>
        </HappierPageSectionContext.Provider>
    );
}

export function useListPresentation(): ListPresentation {
    return React.useContext(ListPresentationContext);
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
