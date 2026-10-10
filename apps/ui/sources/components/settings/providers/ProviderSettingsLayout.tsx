import * as React from 'react';
import { useGlobalSearchParams } from '@/components/appShell/workspace/destinationRoute';
import { useIsFocused } from '@/components/appShell/workspace/destinationRoute';

import { SettingsCollectionLayout } from '@/components/settings/shell/SettingsCollectionLayout';

import { ProviderConnectionsSettingsScreen, PROVIDERS_COLLECTION_ROUTE } from './ProviderConnectionsSettingsScreen';

/** Rail width at normal text scale: a provider mark, a name and one status line. */
const PROVIDER_RAIL_WIDTH_PX = 272;
/** The narrowest detail that still fits a field select beside its label. */
const PROVIDER_DETAIL_MIN_WIDTH_PX = 480;

function resolveProvidersChildRoute(pathname: string): string {
    if (pathname === PROVIDERS_COLLECTION_ROUTE) return 'index';
    if (pathname === `${PROVIDERS_COLLECTION_ROUTE}/new`) return 'new';
    return pathname.endsWith('/models') ? '[connectionId]/models' : '[connectionId]';
}

const ProviderCollectionPaneClaimContext = React.createContext<((claimed: boolean) => void) | null>(null);

/**
 * The collection's landing says it shows a whole-page state (the invitation to add a first
 * provider, or what must happen first), so the page owns the pane: no rail column beside it to
 * repeat the state or to clip it. Released when the landing leaves or lands on a provider.
 */
export function useClaimProviderCollectionPane(claimed: boolean): void {
    const claim = React.useContext(ProviderCollectionPaneClaimContext);
    React.useEffect(() => {
        if (!claim) return;
        claim(claimed);
        return () => claim(false);
    }, [claim, claimed]);
}

/**
 * Providers as a collection beside the selected connection. Wide: the provider rail beside the
 * detail stack. Narrow: the detail stack alone, whose index page lists the providers and pushes
 * their detail; an open editor keeps its draft across the change.
 */
export const ProviderSettingsLayout = React.memo(function ProviderSettingsLayout() {
    return (
        <ProviderCollectionPane>
            {(landingOwnsPane) => (
                <SettingsCollectionLayout
                    navigator="providers"
                    rootPathname={PROVIDERS_COLLECTION_ROUTE}
                    resolveChildRoute={resolveProvidersChildRoute}
                    rail={landingOwnsPane ? null : <ProviderCollectionRail />}
                    railWidthPx={PROVIDER_RAIL_WIDTH_PX}
                    detailMinWidthPx={PROVIDER_DETAIL_MIN_WIDTH_PX}
                    testID="settings-providers"
                />
            )}
        </ProviderCollectionPane>
    );
});

/** Holds whether the landing has claimed the whole pane, for the layout around it. */
export function ProviderCollectionPane(props: Readonly<{
    children: (landingOwnsPane: boolean) => React.ReactNode;
}>) {
    const [landingOwnsPane, setLandingOwnsPane] = React.useState(false);
    return (
        <ProviderCollectionPaneClaimContext.Provider value={setLandingOwnsPane}>
            {props.children(landingOwnsPane)}
        </ProviderCollectionPaneClaimContext.Provider>
    );
}

/** The rail beside a provider's detail; it reads while the Providers navigator is focused. */
const ProviderCollectionRail = React.memo(function ProviderCollectionRail() {
    const focused = useIsFocused();
    const params = useGlobalSearchParams<{ connectionId?: string | string[] }>();
    const connectionId = Array.isArray(params.connectionId) ? params.connectionId[0] : params.connectionId;
    return (
        <ProviderConnectionsSettingsScreen
            variant="rail"
            active={focused}
            selectedConnectionId={connectionId ?? null}
        />
    );
});
