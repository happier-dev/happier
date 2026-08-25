import * as React from 'react';

import { useAuth } from '@/auth/context/AuthContext';
import { getCurrentReleaseId } from '@/changelog/releaseNotes/manifestRuntime';
import { setLastSeenReleaseId } from '@/changelog/releaseNotes/storage';
import { OnboardingShowcaseStorySurface } from '@/components/onboarding/showcase';
import { Modal, useModal } from '@/modal';

import { useOnboardingShowcaseState } from './useOnboardingShowcaseState';

function markCurrentReleaseNotesSeen(): void {
    const releaseId = getCurrentReleaseId();
    if (releaseId) setLastSeenReleaseId(releaseId);
}

/** Shows the evergreen tour once, before auth. Existing users are silently seeded as seen. */
export function OnboardingShowcaseAutoShowMount(): null {
    const auth = useAuth();
    const showcase = useOnboardingShowcaseState();
    const modal = useModal();
    const modalStackActive = modal.state.modals.length > 0;
    const ranRef = React.useRef(false);

    React.useEffect(() => {
        if (ranRef.current || !showcase.hasUnread) return;
        if (auth.isAuthenticated) {
            ranRef.current = true;
            showcase.markSeen();
            return;
        }
        if (modalStackActive) return;

        const timer = setTimeout(() => {
            if (ranRef.current) return;
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
                onRequestClose: markSeenAndClose,
                props: {
                    manifest: showcase.manifest,
                    onComplete: markSeenAndClose,
                    onDismiss: markSeenAndClose,
                },
            });
        }, 250);

        return () => clearTimeout(timer);
    }, [auth.isAuthenticated, modalStackActive, showcase]);

    return null;
}
