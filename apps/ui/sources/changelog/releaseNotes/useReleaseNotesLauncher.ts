import * as React from 'react';
import { useRouter } from 'expo-router';

import { Modal } from '@/modal';

import { ReleaseNotesStorySurface } from '@/components/changelog/releaseNotes';

import { isReleaseNotesStoryCardsEnabled } from './featureGate';
import { resolveReleaseNotesLaunchOutcome } from './launchPolicy';
import { setLastSeenReleaseId } from './storage';

export type UseReleaseNotesLauncherResult = Readonly<{
    /** Open the release-notes modal if there is unread content for the current release. */
    open: () => boolean;
}>;

export function useReleaseNotesLauncher(): UseReleaseNotesLauncherResult {
    const router = useRouter();

    const open = React.useCallback((): boolean => {
        if (!isReleaseNotesStoryCardsEnabled()) return false;
        const outcome = resolveReleaseNotesLaunchOutcome();
        if (outcome.kind !== 'open-story') return false;
        const release = outcome.release;

        let modalId: string | null = null;
        const close = () => {
            if (modalId) {
                Modal.hide(modalId);
                modalId = null;
            }
        };
        const markSeenAndClose = () => {
            setLastSeenReleaseId(release.releaseId);
            close();
        };

        modalId = Modal.show({
            component: ReleaseNotesStorySurface,
            onRequestClose: markSeenAndClose,
            props: {
                release,
                onComplete: markSeenAndClose,
                onDismiss: markSeenAndClose,
                onViewFullChangelog: () => {
                    setLastSeenReleaseId(release.releaseId);
                    close();
                    router.push('/changelog');
                },
            },
        });
        return true;
    }, [router]);

    return { open };
}
