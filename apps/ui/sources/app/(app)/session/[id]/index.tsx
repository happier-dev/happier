import * as React from 'react';
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
import { SessionDestinationBody } from '@/components/sessions/shell/SessionDestinationBody';
import { PhoneRetainedSessionViews, useSessionRouteRetainedAddress } from '@/components/sessions/shell/PhoneRetainedSessionViews';

const SESSION_ROUTE_BODY = <WorkspaceRouteEntry Body={SessionDestinationBody} />;

export default function SessionRouteEntry() {
    const retainedAddress = useSessionRouteRetainedAddress();
    return retainedAddress ? <PhoneRetainedSessionViews address={retainedAddress} body={SESSION_ROUTE_BODY} /> : SESSION_ROUTE_BODY;
}
