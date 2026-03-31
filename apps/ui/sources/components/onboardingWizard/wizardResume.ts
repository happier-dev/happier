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
    // Post-auth should always return the user to the app home (`/`) and continue
    // any remaining setup as a wizard overlay, not by routing into settings-like
    // control panel screens.
    //
    // Web vs desktop differences (skip rules, drift repair prompts, etc) are
    // handled by the overlay visibility logic, not by changing routes here.
    void params;
    return '/';
}

export function resolveWizardAuthReturnToRoute(): string {
    return '/';
}
