import * as React from 'react';
import { HappierPageSectionContext } from '@happier-dev/plugin-ui/presentation';

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
    /** A contained column already owns its outer padding; sections add no second page inset. */
    pageInsets?: PageListInsets;
    /** The page owns the cause and recovery; sections may omit repeats of that cause. */
    pageNoticeActive?: boolean;
    children: React.ReactNode;
}>) {
    return (
        <HappierPageSectionContext.Provider value={null}>
            <PageListInsetsContext.Provider value={props.pageInsets ?? 'standard'}>
                <PageNoticeActiveContext.Provider value={props.value === 'page' && props.pageNoticeActive === true}>
                    <ListPresentationContext.Provider value={props.value}>{props.children}</ListPresentationContext.Provider>
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
export type PageColumnPreferencePolicy = 'respect' | 'ignore';

type PageColumnPresentation = Readonly<{
    column: PageColumn;
    preferencePolicy: PageColumnPreferencePolicy;
}>;

const PageColumnContext = React.createContext<PageColumnPresentation>({ column: 'reading', preferencePolicy: 'respect' });

export function PageColumnProvider(props: Readonly<{
    value: PageColumn;
    /** Opt out for this page only; nested lists inherit the policy unless they explicitly change it. */
    preferencePolicy?: PageColumnPreferencePolicy;
    children: React.ReactNode;
}>) {
    const inherited = React.useContext(PageColumnContext);
    const preferencePolicy = props.preferencePolicy ?? inherited.preferencePolicy;
    const value = React.useMemo(() => ({ column: props.value, preferencePolicy }), [props.value, preferencePolicy]);
    return <PageColumnContext.Provider value={value}>{props.children}</PageColumnContext.Provider>;
}

export function usePageColumn(): PageColumn {
    return React.useContext(PageColumnContext).column;
}

export function usePageColumnPreferencePolicy(): PageColumnPreferencePolicy {
    return React.useContext(PageColumnContext).preferencePolicy;
}
