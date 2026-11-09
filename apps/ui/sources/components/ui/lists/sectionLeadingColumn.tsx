import * as React from 'react';

/**
 * The leading column of a page section, decided once per section.
 *
 * A page section's rows share one leading column: when any row carries a leading icon or mark, every
 * row in that section reserves the column, so all titles in the section start on one line. A section
 * with no icon rows reserves nothing. Rows report whether they have a leading element; the section
 * (`ItemGroup` under page presentation) owns the answer. Outside a page section there is no provider
 * and each row keeps only its own leading element.
 */
type SectionLeadingColumn = Readonly<{
    reserves: () => boolean;
    register: () => () => void;
    subscribe: (listener: () => void) => () => void;
}>;

const SectionLeadingColumnContext = React.createContext<SectionLeadingColumn | null>(null);

/**
 * The section's registry. Registration only counts rows; listeners hear only when the section's answer
 * (any leading row or none) flips, so adding or removing a row never re-renders the section or its rows
 * unless the leading column itself appears or goes away.
 */
function createSectionLeadingColumn(): SectionLeadingColumn {
    let leadingRows = 0;
    const listeners = new Set<() => void>();
    const setLeadingRows = (next: number) => {
        const changed = (leadingRows > 0) !== (next > 0);
        leadingRows = next;
        if (changed) for (const listener of listeners) listener();
    };
    return {
        reserves: () => leadingRows > 0,
        register: () => {
            setLeadingRows(leadingRows + 1);
            let registered = true;
            return () => {
                if (!registered) return;
                registered = false;
                setLeadingRows(leadingRows - 1);
            };
        },
        subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
}

export function SectionLeadingColumnProvider(props: Readonly<{ children: React.ReactNode }>) {
    const [section] = React.useState(createSectionLeadingColumn);
    return <SectionLeadingColumnContext.Provider value={section}>{props.children}</SectionLeadingColumnContext.Provider>;
}

// Rows register before paint, so a section never draws its titles in one place and then moves them.
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? React.useEffect : React.useLayoutEffect;

const subscribeNowhere = () => () => {};
const reservesNothing = () => false;
const reservesOwnColumn = () => true;

/**
 * Registers this row's leading element with its section and returns whether the section reserves the
 * leading column (true for every row of a section in which any row has one). A row with its own leading
 * element reserves from its first render; only rows without one follow the section's answer.
 */
export function useSectionLeadingColumn(hasLeading: boolean): boolean {
    const section = React.useContext(SectionLeadingColumnContext);
    useIsomorphicLayoutEffect(() => {
        if (!hasLeading || !section) return undefined;
        return section.register();
    }, [hasLeading, section]);
    const follows = section !== null && !hasLeading;
    const reserves = !section ? reservesNothing : hasLeading ? reservesOwnColumn : section.reserves;
    return React.useSyncExternalStore(follows ? section.subscribe : subscribeNowhere, reserves, reserves);
}

/** Whether this row sits inside a section (`ItemGroup`), so a row-shaped notice knows it already has its sheet. */
export function useIsInsideItemSection(): boolean {
    return React.useContext(SectionLeadingColumnContext) !== null;
}
