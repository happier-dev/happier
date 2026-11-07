import * as React from 'react';

import { UnboundSessionHomeScopeCard } from '@/components/sessions/access/UnboundSessionHomeScopeCard';
import { useServerProfilesGeneration } from '@/hooks/server/useServerProfilesGeneration';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';

/**
 * A route that names a Home this device has not saved is refused with the Home refusal, never shown as a failed
 * read or redirected away: nothing there can be read, and the URL must survive. The one decision for both the
 * signed-out root (`RootLayoutRedirectGate`) and signed-in scoped routes (managed Machines).
 */
export function KnownHomeGate(props: Readonly<{ serverId: string; testIDPrefix: string; children: React.ReactNode }>) {
    useServerProfilesGeneration();
    if (!getServerProfileById(props.serverId)) {
        return <UnboundSessionHomeScopeCard resolution={{ kind: 'unknown_home' }} serverId={props.serverId} testIDPrefix={props.testIDPrefix} />;
    }
    return <>{props.children}</>;
}
