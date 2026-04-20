import * as React from 'react';

import type { ResolvedPaneLayout } from '@/components/ui/panels/paneBreakpoints';

export type AppPaneScopeLayoutState = Readonly<{
    containerWidthPx: number;
    containerHeightPx: number;
    mainRegionWidthPx: number;
    multiPaneEnabled: boolean;
    deviceType: 'phone' | 'tablet';
    layout: ResolvedPaneLayout;
}>;

const AppPaneScopeLayoutContext = React.createContext<AppPaneScopeLayoutState | null>(null);

export function AppPaneScopeLayoutProvider(
    props: Readonly<{
        value: AppPaneScopeLayoutState;
        children: React.ReactNode;
    }>,
) {
    return (
        <AppPaneScopeLayoutContext.Provider value={props.value}>
            {props.children}
        </AppPaneScopeLayoutContext.Provider>
    );
}

export function useOptionalAppPaneScopeLayout(): AppPaneScopeLayoutState | null {
    return React.useContext(AppPaneScopeLayoutContext);
}
