import * as React from 'react';
import { resolveProjectPageCatalogState, type ProjectPageCatalogState } from '../detail/projectPageCatalog';

/** Scope input changes resolve once; viewport and placement projections never enter this owner. */
export function useProjectNavigationCatalog(input: Parameters<typeof resolveProjectPageCatalogState>[0]) {
    const previous = React.useRef<ProjectPageCatalogState | undefined>(undefined);
    return React.useMemo(() => {
        const state = resolveProjectPageCatalogState({ ...input, baseline: input.baseline ?? previous.current });
        previous.current = state;
        return state;
    }, [input.target, input.placements, input.policyContext, input.localize, input.sidebar, input.activePage]);
}
