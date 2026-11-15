import * as React from 'react';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { SessionGettingStartedDecisionKind } from '@/components/sessions/guidance/gettingStartedModel';

/** A reach failure cannot turn this Account's committed hub back into first-use guidance. */
export function useHomeHubGuidanceKind(kind: SessionGettingStartedDecisionKind, homeUnavailable: boolean, machineSetupOpen = false): SessionGettingStartedDecisionKind {
    const lifetime = captureActiveServerAccountScopeLifetime();
    const hydratedHub = React.useRef<typeof lifetime>(null);
    React.useEffect(() => {
        if (kind === 'select_session' || kind === 'create_session') hydratedHub.current = lifetime;
    }, [lifetime, kind]);
    // Registration precedes daemon readiness. The setup already owns that arrival and its next step;
    // offline guidance can take Home again after the person closes the open machine flow.
    if (kind === 'start_daemon' && machineSetupOpen) return 'connect_machine';
    return homeUnavailable && lifetime?.isCurrent() && hydratedHub.current === lifetime ? 'select_session' : kind;
}
