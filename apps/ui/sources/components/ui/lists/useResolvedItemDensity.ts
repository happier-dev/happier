import * as React from 'react';

import { resolvePageRowMetrics, type PageRowDensity, type PageRowMetrics, type PageRowShape } from '@/components/ui/lists/pageRowMetrics';
import { useLocalSetting } from '@/sync/store/settingsReadHooks';

export type ResolvedItemDensity = 'comfortable' | 'cozy' | 'compact' | 'tight';

/**
 * The density a section asks for its rows (`ItemGroup density`): row height follows content, so a long
 * index-style list of single-line rows is compact while rows that carry a description keep their room.
 */
const SectionItemDensityContext = React.createContext<ResolvedItemDensity | undefined>(undefined);

export const SectionItemDensityProvider = SectionItemDensityContext.Provider;

/**
 * What a page section's rows are (`ItemGroup rows`): settings, label first, or `facts` about one thing (a Store
 * listing's Includes, Licence), whose labels step back so each value leads (`resolvePageRowMetrics` `role`).
 */
const SectionRowRoleContext = React.createContext<'rows' | 'facts'>('rows');

export const SectionRowRoleProvider = SectionRowRoleContext.Provider;

export function useSectionRowRole(): 'rows' | 'facts' {
    return React.useContext(SectionRowRoleContext);
}

/**
 * A surface that fixes its page rows' density whatever the preference: a page hosted as a side-pane
 * inspector (Session Info, lab csinfo I2) draws `inspector` rows. Menus and popovers opened from it
 * keep their own row role; grouped rows read it as `compact`.
 */
const PageRowDensityContext = React.createContext<PageRowDensity | null>(null);

export function PageRowDensityProvider(props: Readonly<{ value: PageRowDensity; children?: React.ReactNode }>) {
    return React.createElement(PageRowDensityContext.Provider, { value: props.value }, props.children);
}

/** The density the surrounding surface fixes for its page rows, if any. */
export function usePageRowDensityOverride(): PageRowDensity | null {
    return React.useContext(PageRowDensityContext);
}

/** A row's own density, else its section's, else the user's list-density preference. */
export function useResolvedItemDensity(explicitDensity?: ResolvedItemDensity): ResolvedItemDensity {
    return useItemDensityInputs(explicitDensity).resolved;
}

/**
 * The resolved density together with what it came from. A configuration-page row is drawn at the
 * user's preference whatever a section asks, and reads a section's `compact` as "a long single-line
 * list" (see `resolvePageRowDensityInput`), so it needs the preference and the request separately.
 */
export function useItemDensityInputs(explicitDensity?: ResolvedItemDensity): Readonly<{
    resolved: ResolvedItemDensity;
    preferred: PageRowDensity;
    /** The row or its section asked for a density; the preference did not decide it. */
    requested: boolean;
}> {
    const setting = useLocalSetting('uiItemDensity');
    const surfaceDensity = React.useContext(PageRowDensityContext);
    const sectionDensity = React.useContext(SectionItemDensityContext);
    const requestedDensity = explicitDensity ?? sectionDensity;
    const preferred = surfaceDensity ?? setting;
    return {
        resolved: requestedDensity ?? (preferred === 'inspector' ? 'compact' : preferred),
        preferred,
        requested: requestedDensity !== undefined,
    };
}

/** A configuration-page row's metrics at the user's density, for content that stands in for rows. */
export function usePageRowMetrics(shape: PageRowShape = 'standard'): PageRowMetrics {
    const setting = useLocalSetting('uiItemDensity');
    const preferred = React.useContext(PageRowDensityContext) ?? setting;
    return resolvePageRowMetrics({ density: preferred, shape });
}
