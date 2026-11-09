import * as React from 'react';

import { useServerAuthStatusByServerId } from '@/components/settings/server/hooks/useServerAuthStatusByServerId';
import { useServerProfilesGeneration } from '@/hooks/server/useServerProfilesGeneration';
import { canHostPersonalHomeHere } from '@/sync/domains/server/setup/setupSurfacePolicy';
import {
    isServerProfilePersonalHomeBootstrapCompleted,
    listServerProfiles,
    resolveServerProfileScopeId,
    type ServerProfile,
} from '@/sync/domains/server/serverProfiles';
import { homesJourneyAcknowledgementsState, useHomesJourneyAcknowledgements } from '@/sync/domains/state/onboardingUiState';

import {
    resolveAlreadyUseHappierOffer,
    resolveHomesReconcileOffer,
    type HomesReconcileOffer,
    type JourneyHome,
} from './homesJourneyModel';

type JourneyHomes = Readonly<{
    profiles: readonly ServerProfile[];
    homes: readonly JourneyHome[];
}>;

/** This device's saved Homes as the journeys read them: when saved, confirmed sign-in, and which is its own. */
function useJourneyHomes(): JourneyHomes {
    const generation = useServerProfilesGeneration();
    const profiles = React.useMemo(() => listServerProfiles(), [generation]);
    const authStatus = useServerAuthStatusByServerId(profiles);
    const homes = React.useMemo(() => profiles.map((profile): JourneyHome => {
        const id = resolveServerProfileScopeId(profile);
        return {
            id,
            createdAt: profile.createdAt,
            signedIn: authStatus[id] === 'signedIn',
            personalHomeOnThisDevice: isServerProfilePersonalHomeBootstrapCompleted(profile),
        };
    }), [authStatus, profiles]);
    return { profiles, homes };
}

/** Whether Get set up shows "Already use Happier?" on this device. */
export function useAlreadyUseHappierOffer(): boolean {
    const { homes } = useJourneyHomes();
    return resolveAlreadyUseHappierOffer({ canHostPersonalHome: canHostPersonalHomeHere(), homes });
}

export type HomesReconcileState = Readonly<{
    offer: HomesReconcileOffer | null;
    profiles: readonly ServerProfile[];
    /** Records the person's choice for every Home the offer is about (Keep both / Use …). */
    settle: () => void;
}>;

/** The reconcile offer (J2) and the one way to settle it. */
export function useHomesReconcileState(): HomesReconcileState {
    const { homes, profiles } = useJourneyHomes();
    const acknowledged = useHomesJourneyAcknowledgements();
    const offer = React.useMemo(
        () => resolveHomesReconcileOffer({ homes, acknowledgedHomeIds: acknowledged }),
        [acknowledged, homes],
    );
    const settle = React.useCallback(() => {
        if (!offer) return;
        homesJourneyAcknowledgementsState.set('acknowledged', [...new Set([...acknowledged, ...offer.foundHomeIds])]);
    }, [acknowledged, offer]);
    return { offer, profiles, settle };
}
