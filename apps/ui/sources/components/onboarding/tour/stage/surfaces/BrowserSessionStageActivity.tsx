import * as React from 'react';

import { DEMO_BROWSER_CONTEXT_SESSION_ID } from '@/demoMode/world/featureSessions';
import { storage } from '@/sync/domains/state/storage';

import { useSpotlightTargetScopeActive } from '../useSpotlightTarget';

export function BrowserSessionStageActivity(): null {
    const active = useSpotlightTargetScopeActive();
    React.useEffect(() => {
        if (!active) return;
        const session = storage.getState().sessions[DEMO_BROWSER_CONTEXT_SESSION_ID];
        if (!session) return;
        const previous = { active: session.active, thinking: session.thinking };
        // This demo presentation does not produce a newer daemon observation.
        // Keeping its clock lets normal lifecycle ordering admit the restoration.
        storage.getState().applySessions([{ ...session, active: true, thinking: false }]);
        return () => {
            const current = storage.getState().sessions[DEMO_BROWSER_CONTEXT_SESSION_ID];
            if (current) storage.getState().applySessions([{ ...current, ...previous }]);
        };
    }, [active]);
    return null;
}
