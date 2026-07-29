import { afterEach, describe, expect, it, vi } from 'vitest';

const setPendingSetupIntentMock = vi.hoisted(() => vi.fn());
const getPendingSetupIntentMock = vi.hoisted(() => vi.fn());
const isTauriDesktopMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/domains/pending/pendingSetupIntent', () => ({
    setPendingSetupIntent: (value: unknown) => setPendingSetupIntentMock(value),
    getPendingSetupIntent: () => getPendingSetupIntentMock(),
    clearPendingSetupIntent: vi.fn(),
}));

vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => isTauriDesktopMock(),
}));

describe('wizardResume', () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    it('routes back to the setup wizard only for awaiting-auth desktop resumes', async () => {
        const { resolveWizardAuthReturnToRoute } = await import('./wizardResume');

        isTauriDesktopMock.mockReturnValue(true);
        getPendingSetupIntentMock.mockReturnValue({ branch: 'thisComputer', phase: 'awaiting_auth', relayUrl: 'https://relay.example.test' });
        expect(resolveWizardAuthReturnToRoute()).toBe('/');

        getPendingSetupIntentMock.mockReturnValue({ branch: 'thisComputer', phase: 'pre_auth', relayUrl: 'https://relay.example.test' });
        expect(resolveWizardAuthReturnToRoute()).toBe('/');

        isTauriDesktopMock.mockReturnValue(false);
        getPendingSetupIntentMock.mockReturnValue({ branch: 'thisComputer', phase: 'awaiting_auth', relayUrl: 'https://relay.example.test' });
        expect(resolveWizardAuthReturnToRoute()).toBe('/');
    });

    it('persists onboarding resume phases through the canonical pending setup intent', async () => {
        const {
            setOnboardingWizardPreAuthResumeIntent,
            setOnboardingWizardAwaitingAuthResumeIntent,
        } = await import('./wizardResume');

        setOnboardingWizardPreAuthResumeIntent('https://relay.example.test/');
        expect(setPendingSetupIntentMock).toHaveBeenCalledWith({
            branch: 'thisComputer',
            phase: 'pre_auth',
            relayUrl: 'https://relay.example.test/',
        });

        setOnboardingWizardAwaitingAuthResumeIntent('https://relay.example.test/');
        expect(setPendingSetupIntentMock).toHaveBeenCalledWith({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay.example.test/',
        });
    });
});
