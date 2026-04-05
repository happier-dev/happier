import * as React from 'react';

import type { DetailsTabState } from '@/components/appShell/panes/model/appPaneReducer';

function buildProjectDetailsSignature(input: Readonly<{
    isOpen?: boolean;
    tabs?: ReadonlyArray<DetailsTabState>;
}> | null | undefined): string {
    const openMarker = input?.isOpen === true ? 'open' : 'closed';
    const tabKeys = (input?.tabs ?? []).map((tab) => tab.key).join('|');
    return `${openMarker}:${tabKeys}`;
}

export function useProjectOverviewMode(params: Readonly<{
    showWorktrees?: boolean;
    onSetShowWorktrees?: (nextValue: boolean) => void;
    detailsState?: Readonly<{
        isOpen?: boolean;
        tabs?: ReadonlyArray<DetailsTabState>;
    }> | null;
}>): Readonly<{
    forceOverviewMode: boolean;
}> {
    const detailsSignature = React.useMemo(
        () => buildProjectDetailsSignature(params.detailsState),
        [params.detailsState],
    );
    const overviewEntryDetailsSignatureRef = React.useRef<string | null>(null);
    const [overviewExitRequested, setOverviewExitRequested] = React.useState(false);

    React.useEffect(() => {
        if (params.showWorktrees !== true) {
            overviewEntryDetailsSignatureRef.current = null;
            setOverviewExitRequested(false);
            return;
        }
        if (overviewEntryDetailsSignatureRef.current == null) {
            overviewEntryDetailsSignatureRef.current = detailsSignature;
            setOverviewExitRequested(false);
        }
    }, [detailsSignature, params.showWorktrees]);

    React.useEffect(() => {
        if (params.showWorktrees !== true) return;
        const baselineSignature = overviewEntryDetailsSignatureRef.current;
        if (baselineSignature == null) return;
        if (baselineSignature === detailsSignature) return;
        setOverviewExitRequested(true);
        params.onSetShowWorktrees?.(false);
    }, [detailsSignature, params.onSetShowWorktrees, params.showWorktrees]);

    return {
        forceOverviewMode: params.showWorktrees === true && !overviewExitRequested,
    };
}
