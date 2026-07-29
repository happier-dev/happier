import { getPendingSetupIntent, setPendingSetupIntent } from '@/sync/domains/pending/pendingSetupIntent';

export function setOnboardingWizardPreAuthResumeIntent(relayUrl: string | null): void {
    setPendingSetupIntent({
        branch: 'thisComputer',
        phase: 'pre_auth',
        relayUrl,
    });
}

export function setOnboardingWizardAwaitingAuthResumeIntent(relayUrl: string | null): void {
    setPendingSetupIntent({
        branch: 'thisComputer',
        phase: 'awaiting_auth',
        relayUrl,
    });
}

export function shouldResumeSetupWizardAfterAuth(): boolean {
    return getPendingSetupIntent()?.phase === 'awaiting_auth';
}

export function resolveWizardAuthReturnToRoute(): string {
    return '/';
}
