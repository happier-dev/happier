import * as React from 'react';
import { HappierPageSectionContext } from '@happier-dev/plugin-ui/presentation';

import type { PageColumn } from '@/components/ui/layout/contentWidthMode';

/**
 * How grouped list content is presented.
 *
 * - `grouped`: the compact inset-grouped look (uppercase header, footer under the card). It stays the
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

/**
 * Starts a list presentation scope. The scope also starts outside any page sheet: a menu, popover or
 * picker opened from a sheet row (React context crosses portals) draws its own rows, never the sheet's
 * row inset and hairlines.
 */
export function ListPresentationProvider(props: Readonly<{
    value: ListPresentation;
    /** A contained column already owns its outer padding; sections add no second page inset. */
    pageInsets?: PageListInsets;
    children: React.ReactNode;
}>) {
    return (
        <HappierPageSectionContext.Provider value={null}>
            <PageListInsetsContext.Provider value={props.pageInsets ?? 'standard'}>
                <ListPresentationContext.Provider value={props.value}>{props.children}</ListPresentationContext.Provider>
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

export const PageColumnProvider = PageColumnContext.Provider;

export function usePageColumn(): PageColumn {
    return React.useContext(PageColumnContext);
}
