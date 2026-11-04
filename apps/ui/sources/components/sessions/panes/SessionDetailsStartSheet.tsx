import * as React from 'react';
import { Modal } from '@/modal';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { AppPaneContext } from '@/components/appShell/panes/AppPaneContext';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { presentDetailsStartSheet } from '@/components/appShell/panes/details/PhoneDetailsStartSheet';
import type { DetailsTab } from '@/components/appShell/panes/model/appPaneReducer';
import { SessionDetailsPanel } from './SessionDetailsPanelHost';

type Input = Readonly<{
    scopeId: string;
    address: Readonly<{ sessionId: string; serverId: string }>;
    tab: DetailsTab;
    onClose: () => void;
}>;

/** A no-pane transcript borrows the same Session Details renderer for this sheet's mounted lifetime. */
export function presentSessionDetailsStartSheet(input: Input): void {
    let modalId = '';
    const close = () => {
        if (!modalId) return;
        const id = modalId;
        modalId = '';
        input.onClose();
        Modal.hide(id);
    };
    modalId = presentDetailsStartSheet({ scopeId: input.scopeId, content: (
        <AppPaneProvider presentedPaneTab={{ scopeId: input.scopeId, tabKey: input.tab.key }}>
            <SessionStartContent {...input} onClose={close} />
        </AppPaneProvider>
    ) }, close);
}

function SessionStartContent(props: Input) {
    const subscription = React.useContext(AppPaneContext)!;
    const { openDetailsTab } = useAppPaneScope(props.scopeId);
    const { scopeId, tab, onClose } = props;
    React.useEffect(() => {
        openDetailsTab(tab, { intent: 'pinned', present: false });
        const unsubscribe = subscription.subscribe(() => {
            if (!subscription.getSnapshot().state.scopes[scopeId]?.details.isOpen) onClose();
        });
        return () => {
            unsubscribe();
            subscription.getSnapshot().dispatch({ type: 'closeDetails', scopeId });
        };
    }, [onClose, openDetailsTab, scopeId, subscription, tab]);
    return <SessionDetailsPanel sessionId={props.address.sessionId} routeServerId={props.address.serverId} scopeId={scopeId} />;
}
