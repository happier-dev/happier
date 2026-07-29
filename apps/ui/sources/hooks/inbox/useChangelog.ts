import { useCallback, useEffect, useState } from 'react';
import type { FeatureId } from '@happier-dev/protocol';
import { getFeatureBuildPolicyDecision } from '@/sync/domains/features/featureBuildPolicy';
import {
    getLastViewedReleaseId,
    setLastViewedReleaseId,
    getLatestReleaseId,
} from '@/changelog';
import { setLegacyChangelogAutoSeenBaseline } from '@/changelog/releaseNotes/storage';

const CHANGELOG_FEATURE_ID = 'app.ui.changelog' as const satisfies FeatureId;

export function useChangelog() {
    const enabled = getFeatureBuildPolicyDecision(CHANGELOG_FEATURE_ID) !== 'deny';
    // MMKV reads are synchronous - no need for useEffect
    const latestReleaseId = enabled ? getLatestReleaseId() : null;

    const [hasUnread, setHasUnread] = useState(() => {
        if (!enabled || !latestReleaseId) {
            return false;
        }
        const lastViewedReleaseId = getLastViewedReleaseId();
        if (lastViewedReleaseId === null) {
            return false;
        }

        return latestReleaseId !== lastViewedReleaseId;
    });

    useEffect(() => {
        if (!enabled || !latestReleaseId) {
            setHasUnread(false);
            return;
        }

        const lastViewedReleaseId = getLastViewedReleaseId();
        if (lastViewedReleaseId === null) {
            // On first install, mark as read so users don't see old entries. This must run after
            // commit; writing MMKV during render can synchronously notify other update-status
            // consumers while the pre-auth shell is still rendering.
            setLegacyChangelogAutoSeenBaseline(latestReleaseId);
            setLastViewedReleaseId(latestReleaseId);
            setHasUnread(false);
            return;
        }

        setHasUnread(latestReleaseId !== lastViewedReleaseId);
    }, [enabled, latestReleaseId]);

    const markAsRead = useCallback(() => {
        if (!enabled || !latestReleaseId) {
            return;
        }

        setLastViewedReleaseId(latestReleaseId);
        setHasUnread(false);
    }, [enabled, latestReleaseId]);

    return {
        hasUnread: enabled ? hasUnread : false,
        latestReleaseId,
        markAsRead,
    };
}
