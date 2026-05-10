import { useState, useCallback } from 'react';
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

        // On first install, mark as read so user doesn't see old entries
        if (lastViewedReleaseId === null) {
            setLegacyChangelogAutoSeenBaseline(latestReleaseId);
            setLastViewedReleaseId(latestReleaseId);
            return false;
        }

        return latestReleaseId !== lastViewedReleaseId;
    });

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
