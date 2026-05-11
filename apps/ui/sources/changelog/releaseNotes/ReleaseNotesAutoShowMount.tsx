import * as React from 'react';

import { useAuth } from '@/auth/context/AuthContext';
import { useOptionalModal } from '@/modal';
import { useOnboardingShowcaseState } from '@/onboarding/showcase';
import { getPendingSetupIntent } from '@/sync/domains/pending/pendingSetupIntent';

import { isReleaseNotesStoryCardsEnabled } from './featureGate';
import { runReleaseNotesMigrationSeeding } from './migration';
import { revalidateRemoteManifest } from './remoteManifest';
import { useReleaseNotesLauncher } from './useReleaseNotesLauncher';

function hasActiveSetupIntent(): boolean {
    const intent = getPendingSetupIntent();
    return Boolean(intent && intent.phase !== 'dismissed');
}

/**
 * Headless mount that runs once per cold launch:
 *   1. Seed release-notes seen-state migration so existing users do not get
 *      retroactive notes.
 *   2. Best-effort revalidate the remote manifest from `happier-assets`.
 *   3. Auto-show the release-notes story modal if the launch policy allows.
 *
 * Auto-show gates (per plan §1.3 #11):
 *   - User is authenticated (no auth/setup redirect pending).
 *   - There is a current release with curated cards.
 *   - That release has not been seen yet.
 *
 * Place once near other runtime mounts in `(app)/_layout.tsx`.
 */
export function ReleaseNotesAutoShowMount(): null {
    const { credentials } = useAuth();
    const onboardingShowcase = useOnboardingShowcaseState();
    const launcher = useReleaseNotesLauncher();
    const modal = useOptionalModal();
    const setupIntentActive = hasActiveSetupIntent();
    const modalStackActive = (modal?.state.modals.length ?? 0) > 0;
    const releaseNotesEnabled = isReleaseNotesStoryCardsEnabled();
    const ranRef = React.useRef(false);

    React.useEffect(() => {
        if (ranRef.current) return;
        if (!releaseNotesEnabled) return;
        if (!credentials) return; // wait for auth/setup to resolve.
        if (setupIntentActive) return;
        if (modalStackActive) return;
        if (onboardingShowcase.hasUnread) return;
        ranRef.current = true;

        // 1) Seed migration baseline before evaluating launch policy.
        try {
            runReleaseNotesMigrationSeeding();
        } catch {
            // migration is best-effort; never block UI on it.
        }

        // 2) Best-effort revalidation; failure is non-fatal.
        void revalidateRemoteManifest().catch(() => undefined);

        // 3) Schedule auto-show after a tick so the route is settled.
        const timer = setTimeout(() => {
            try {
                launcher.open();
            } catch {
                // ignore — fall back to user tapping the update tag.
            }
        }, 800);

        return () => clearTimeout(timer);
    }, [
        credentials,
        launcher,
        modalStackActive,
        onboardingShowcase.hasUnread,
        releaseNotesEnabled,
        setupIntentActive,
    ]);

    return null;
}
