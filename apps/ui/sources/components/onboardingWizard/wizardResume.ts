import { getPendingSetupIntent, setPendingSetupIntent } from '@/sync/domains/pending/pendingSetupIntent';
import { isTauriDesktop } from '@/utils/platform/tauri';

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
    return isTauriDesktop() && getPendingSetupIntent()?.phase === 'awaiting_auth';
}

export function resolveWizardAuthReturnToRoute(): string {
    return shouldResumeSetupWizardAfterAuth() ? '/setup' : '/';
}
