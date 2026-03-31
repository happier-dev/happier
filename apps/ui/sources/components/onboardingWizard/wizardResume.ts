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

export type PostAuthSetupRouteInputs = Readonly<{
    isDesktopShell: boolean;
    onlineMachineCount: number | null;
    currentMachineIsConfiguredAndHealthy: boolean;
    hasRelayDrift: boolean;
}>;

export function resolvePostAuthSetupRoute(params: PostAuthSetupRouteInputs): '/' | '/setup' {
    if (!params.isDesktopShell) {
        return (params.onlineMachineCount ?? 0) >= 1 ? '/' : '/setup';
    }

    if (!params.currentMachineIsConfiguredAndHealthy) {
        return '/setup';
    }

    return params.hasRelayDrift ? '/setup' : '/';
}

export function resolveWizardAuthReturnToRoute(): string {
    return '/';
}
