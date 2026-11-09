import { afterEach, describe, expect, it, vi } from 'vitest';

import { standardCleanup } from '@/dev/testkit';
import { clearPendingSetupIntent, getPendingSetupIntent, setPendingSetupIntent } from '@/sync/domains/pending/pendingSetupIntent';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';

import { resolveWizardAuthReturnToRoute, setOnboardingWizardAwaitingAuthResumeIntent } from './wizardResume';

const RELAY_URL = 'https://relay.example.test';

async function activateRelay(): Promise<void> {
    await upsertAndActivateServer({
        serverUrl: RELAY_URL,
        source: 'manual',
        scope: 'device',
        replaceEquivalentStoredUrl: true,
    });
}

describe('wizardResume', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        clearPendingSetupIntent();
        standardCleanup();
    });

    it('returns sign-in to the explicitly selected Home', () => {
        vi.stubGlobal('document', {});
        vi.stubGlobal('window', { location: { href: 'https://app.example.test/?server=https%3A%2F%2Fselected.example.test' } });
        expect(resolveWizardAuthReturnToRoute()).toBe('/?server=https%3A%2F%2Fselected.example.test');
    });

    it('persists onboarding resume phases through the canonical pending setup intent', async () => {
        await activateRelay();

        setOnboardingWizardAwaitingAuthResumeIntent(`${RELAY_URL}/`);
        expect(getPendingSetupIntent()).toMatchObject({ branch: 'thisComputer', phase: 'awaiting_auth' });
    });

    it('never replaces a pending Ask Happier continuation with a wizard resume', async () => {
        await activateRelay();
        setPendingSetupIntent({ branch: 'askHappier', phase: 'awaiting_auth', relayUrl: RELAY_URL });

        setOnboardingWizardAwaitingAuthResumeIntent(RELAY_URL);

        expect(getPendingSetupIntent()).toMatchObject({ branch: 'askHappier', phase: 'awaiting_auth' });
    });
});
