import * as React from 'react';
import { View } from 'react-native';
import { Modal } from '@/modal';

import { AppPaneContext, useAppPaneContext, type AppPaneContextSubscription } from '../AppPaneContext';
import { PaneRegionProvider } from '../paneRegion';
import { parseSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { SessionDetailsPanel } from '@/components/sessions/panes/SessionDetailsPanelHost';
import { usePathname } from '@/components/appShell/workspace/destinationRoute';
import { StyleSheet } from 'react-native-unistyles';
import { SelectionListBackChip } from '@/components/ui/selectionList/SelectionListBackChip';

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

const stepStyles = StyleSheet.create((theme) => ({
    back: { flexDirection: 'row', paddingHorizontal: theme.space.s12, paddingTop: theme.space.s8, paddingBottom: theme.space.s4 },
    body: { flex: 1, minHeight: 0 },
}));

/**
 * The Start as the next step of the list it was chosen from, inside the same popover or sheet (a phone has no
 * Details beside the page). It places the scope's same Details renderer as the Start sheet does; Back returns
 * to the list and, like closing that sheet, closes the unstarted Start (its tab stays for the next choice).
 */
export function DetailsStartStep(props: Readonly<{ scopeId: string; backLabel: string; height: number; onBack: () => void }>) {
    const dispatch = useAppPaneContext(value => value.dispatch);
    const { scopeId } = props;
    React.useEffect(() => () => dispatch({ type: 'closeDetails', scopeId }), [dispatch, scopeId]);
    return <View testID="details-start-step" style={{ height: props.height }}>
        <View style={stepStyles.back}>
            <SelectionListBackChip testID="details-start-step.back" label={props.backLabel} onPress={props.onBack} />
        </View>
        <View style={stepStyles.body}>
            <PhoneDetailsStartContext.Provider value={true}><DetailsStartBody scopeId={scopeId} /></PhoneDetailsStartContext.Provider>
        </View>
    </View>;
}

/** The one sheet placement for a phone pane and a transcript host without pane columns. */
export function presentDetailsStartSheet(props: Omit<React.ComponentProps<typeof PhoneDetailsStartSheet>, 'onClose'>, onClose: () => void): string {
    return Modal.show({ component: PhoneDetailsStartSheet, props,
        onRequestClose: onClose, onHostUnmount: onClose, closeOnBackdrop: true,
        chrome: { kind: 'card', header: 'none', scrollHost: 'body', bodyScroll: 'none',
            dimensions: { size: 'lg' }, phonePresentation: 'sheet' },
    });
}
