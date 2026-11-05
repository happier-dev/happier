import { getPendingSetupIntent, setPendingSetupIntent } from '@/sync/domains/pending/pendingSetupIntent';

export function setOnboardingWizardAwaitingAuthResumeIntent(relayUrl: string | null): void {
    if (getPendingSetupIntent()?.branch === 'askHappier') return;
    setPendingSetupIntent({
        branch: 'thisComputer',
        phase: 'awaiting_auth',
        relayUrl,
    });
}

export function resolveWizardAuthReturnToRoute(): '/' {
    return '/';
}
