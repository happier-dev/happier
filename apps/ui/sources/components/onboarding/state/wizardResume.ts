import { createContext } from 'react';

import { resolveWebServerEntrySignInRoute } from '@/sync/domains/server/url/bootstrapActiveServerFromWebLocation';
import { getPendingSetupIntent, setPendingSetupIntent } from '@/sync/domains/pending/pendingSetupIntent';

export function setOnboardingWizardAwaitingAuthResumeIntent(relayUrl: string | null): void {
    if (getPendingSetupIntent()?.branch === 'askHappier') return;
    setPendingSetupIntent({
        branch: 'thisComputer',
        phase: 'awaiting_auth',
        relayUrl,
    });
}

// The root redirect owns the admitted entry. The wizard forwards that same
// navigation through its existing auth handoffs, including external methods.
export const WizardAuthReturnRouteContext = createContext<Readonly<{
    returnTo: string;
    abandon: () => void;
}> | null>(null);

export function resolveWizardAuthReturnToRoute(entry?: string | null): string {
    return entry ?? resolveWebServerEntrySignInRoute();
}
