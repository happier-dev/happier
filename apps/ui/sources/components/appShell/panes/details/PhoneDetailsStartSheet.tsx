import * as React from 'react';
import { View } from 'react-native';
import { Modal } from '@/modal';

import { AppPaneContext, useAppPaneContext, type AppPaneContextSubscription } from '../AppPaneContext';
import { PaneRegionProvider } from '../paneRegion';

/** A placement of the scope's existing renderer, including any in-place result replacement. */
export const PhoneDetailsStartContext = React.createContext<Readonly<{ onClose: () => void }> | null>(null);

function DetailsStartBody(props: Readonly<{ scopeId: string }>) {
    const { adapter } = useAppPaneContext(value => ({
        adapter: value.getDriver(props.scopeId)?.detailsPaneBuiltinAdapter,
        version: value.driverRegistryVersion,
    }));
    const destinationId = adapter?.defaultDestinationId ?? adapter?.destinationIds[0];
    return <PaneRegionProvider region="details">
        <View style={{ flex: 1, minHeight: 0 }}>
            {adapter && destinationId ? adapter.render({ scopeId: props.scopeId, destinationId }) : null}
        </View>
    </PaneRegionProvider>;
}

export function PhoneDetailsStartSheet(props: Readonly<{
    scopeId: string;
    subscription?: AppPaneContextSubscription;
    content?: React.ReactNode;
    onClose: () => void;
}>) {
    const presentation = React.useMemo(() => ({ onClose: props.onClose }), [props.onClose]);
    return <PhoneDetailsStartContext.Provider value={presentation}>
        {props.subscription ? <AppPaneContext.Provider value={props.subscription}>
            <DetailsStartBody scopeId={props.scopeId} />
        </AppPaneContext.Provider> : <PaneRegionProvider region="details">{props.content}</PaneRegionProvider>}
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
