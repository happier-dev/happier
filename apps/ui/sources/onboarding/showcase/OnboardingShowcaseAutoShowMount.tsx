import * as React from 'react';
import { useCurrentRouteSegments } from '@/components/appShell/workspace/currentRouteLocation';

import { useAuth } from '@/auth/context/AuthContext';
import { isWelcomeRoute } from '@/auth/routing/authRouting';
import { getCurrentReleaseId } from '@/changelog/releaseNotes/manifestRuntime';
import { setLastSeenReleaseId } from '@/changelog/releaseNotes/storage';
import { OnboardingShowcaseStorySurface } from '@/components/onboarding/showcase';
import { Modal, useModal } from '@/modal';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { getPendingTerminalConnect } from '@/sync/domains/pending/pendingTerminalConnect';
import { usePendingSetupIntent } from '@/components/onboarding/state/usePendingSetupIntent';

import { isShowcaseAwaitingSignIn, isShowcaseHomeLandingPending, markShowcaseAwaitingSignIn, subscribeShowcaseHomeLanding } from './storage';
import { useOnboardingShowcaseState } from './useOnboardingShowcaseState';

function markCurrentReleaseNotesSeen(): void {
    const releaseId = getCurrentReleaseId();
    if (releaseId) setLastSeenReleaseId(releaseId);
}

/**
 * Shows the evergreen tour once, right after the first sign-in or account creation on this device: the
 * device was seen signed out with the tour unread (kept across a reload, so an OAuth return or a refresh
 * between sign-in and Home still gets it), then signs in. The signed-out doorway stays clear: welcome-1115 draws it with no sheet
 * (LABPARITY-ACCEPT-D-1118). An app that opens already signed in is an existing user, silently seeded as
 * seen. After sign-in the tour waits for Home and for any open modal, never covering a task the person
 * came to do (a Team invitation, a terminal connect link).
 */
export function OnboardingShowcaseAutoShowMount(): null {
    const auth = useAuth();
    const showcase = useOnboardingShowcaseState();
    const modal = useModal();
    const modalStackActive = modal.state.modals.length > 0;
    const welcomeActive = isWelcomeRoute(useCurrentRouteSegments());
    const landingPending = React.useSyncExternalStore(subscribeShowcaseHomeLanding, isShowcaseHomeLandingPending);
    const setupPending = usePendingSetupIntent() !== null;
    const ranRef = React.useRef(false);

    React.useEffect(() => {
        if (ranRef.current || !showcase.hasUnread) return;
        if (!auth.isAuthenticated) {
            if (!isShowcaseAwaitingSignIn()) markShowcaseAwaitingSignIn();
            return;
        }
        if (!isShowcaseAwaitingSignIn()) {
            ranRef.current = true;
            showcase.markSeen();
            return;
        }
        // Inline auth admits Home in a layout effect of this same commit. Read the live handoff
        // before opening the modal, then use the subscription to wake when the landing settles.
        if (modalStackActive || !welcomeActive || isShowcaseHomeLandingPending() || setupPending || getPendingTerminalConnect()) return;

        ranRef.current = true;
        let modalId: string | null = null;
        const close = () => {
            if (!modalId) return;
            Modal.hide(modalId);
            modalId = null;
        };
        const markSeenAndClose = () => {
            showcase.markSeen();
            markCurrentReleaseNotesSeen();
            close();
        };

        modalId = Modal.show({
            component: OnboardingShowcaseStorySurface,
            phonePresentation: 'sheet',
            onRequestClose: markSeenAndClose,
            props: {
                manifest: showcase.manifest,
                onComplete: markSeenAndClose,
                onDismiss: markSeenAndClose,
                onAskHappier: () => {
                    markSeenAndClose();
                    fireAndForget(import('@/components/sessions/bots/askHappierEntry')
                        .then(({ startAskHappier }) => startAskHappier({ lifetime: null })), { tag: 'Showcase.askHappier' });
                },
            },
        });
    }, [auth.isAuthenticated, landingPending, modalStackActive, setupPending, showcase, welcomeActive]);

    return null;
}
