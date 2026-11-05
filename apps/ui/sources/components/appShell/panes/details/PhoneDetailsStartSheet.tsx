import * as React from 'react';
import { View } from 'react-native';
import { Modal } from '@/modal';

import { AppPaneContext, useAppPaneContext, type AppPaneContextSubscription } from '../AppPaneContext';
import { PaneRegionProvider } from '../paneRegion';
import { parseSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { SessionDetailsPanel } from '@/components/sessions/panes/SessionDetailsPanelHost';
import { usePathname } from '@/components/appShell/workspace/destinationRoute';

/** A placement of the scope's existing renderer, including any in-place result replacement. */
export const PhoneDetailsStartContext = React.createContext<true | null>(null);

function DetailsStartBody(props: Readonly<{ scopeId: string }>) {
    const { adapter } = useAppPaneContext(value => ({
        adapter: value.getDriver(props.scopeId)?.detailsPaneBuiltinAdapter,
        version: value.driverRegistryVersion,
    }));
    const destinationId = adapter?.defaultDestinationId ?? adapter?.destinationIds[0];
    const address = parseSessionPaneScopeId(props.scopeId)?.address;
    return <PaneRegionProvider region="details">
        <View style={{ flex: 1, minHeight: 0 }}>
            {adapter && destinationId ? adapter.render({ scopeId: props.scopeId, destinationId })
                : address ? <SessionDetailsPanel sessionId={address.sessionId} routeServerId={address.serverId} scopeId={props.scopeId} /> : null}
        </View>
    </PaneRegionProvider>;
}

export function PhoneDetailsStartSheet(props: Readonly<{
    scopeId: string;
    subscription: AppPaneContextSubscription;
    onClose: () => void;
}>) {
    const pathname = usePathname();
    const openedPathname = React.useRef(pathname);
    React.useEffect(() => {
        if (pathname !== openedPathname.current) props.onClose();
    }, [pathname, props.onClose]);
    return <PhoneDetailsStartContext.Provider value={true}>
        <AppPaneContext.Provider value={props.subscription}>
            <DetailsStartBody scopeId={props.scopeId} />
        </AppPaneContext.Provider>
    </PhoneDetailsStartContext.Provider>;
}

/** The one sheet placement for a phone pane and a transcript host without pane columns. */
export function presentDetailsStartSheet(props: Omit<React.ComponentProps<typeof PhoneDetailsStartSheet>, 'onClose'>, onClose: () => void): string {
    return Modal.show({ component: PhoneDetailsStartSheet, props,
        onRequestClose: onClose, onHostUnmount: onClose, closeOnBackdrop: true,
        chrome: { kind: 'card', header: 'none', scrollHost: 'body', bodyScroll: 'none',
            dimensions: { size: 'lg' }, phonePresentation: 'sheet' },
    });
}
