import * as React from 'react';
import { useRegisterSessionPaneDriver } from '@/components/sessions/panes/useRegisterSessionPaneDriver';
import { AppPaneScopeHost } from './AppPaneScopeHost';

/** Reuses the Session's real adapters without mounting its transcript or sibling panes. */
export function SelectedPaneDestinationHost(props: Readonly<{
    scopeId: string;
    tabKey: string;
    sessionId: string;
    serverId?: string | null;
}>) {
    useRegisterSessionPaneDriver(props.sessionId, props.serverId, undefined, undefined, { scopeId: props.scopeId });
    return <AppPaneScopeHost scopeId={props.scopeId} main={null} selectedPaneTabKey={props.tabKey} />;
}
