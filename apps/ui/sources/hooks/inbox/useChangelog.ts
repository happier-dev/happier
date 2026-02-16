import { useState, useCallback } from 'react';
import type { FeatureId } from '@happier-dev/protocol';
import { getFeatureBuildPolicyDecision } from '@/sync/domains/features/featureBuildPolicy';
import {
    getLastViewedVersion,
    setLastViewedVersion,
    getLatestVersion
} from '@/changelog';

const CHANGELOG_FEATURE_ID = 'app.ui.changelog' as const satisfies FeatureId;

export function useChangelog() {
    const enabled = getFeatureBuildPolicyDecision(CHANGELOG_FEATURE_ID) !== 'deny';
    // MMKV reads are synchronous - no need for useEffect
    const latestVersion = enabled ? getLatestVersion() : 0;

    const [hasUnread, setHasUnread] = useState(() => {
        if (!enabled) {
            return false;
        }
        const lastViewed = getLastViewedVersion();

        // On first install, mark as read so user doesn't see old entries
        if (lastViewed === 0 && latestVersion > 0) {
            setLastViewedVersion(latestVersion);
            return false;
        }

        return latestVersion > lastViewed;
    });

    const markAsRead = useCallback(() => {
        if (!enabled) {
            return;
        }
        if (latestVersion > 0) {
            setLastViewedVersion(latestVersion);
            setHasUnread(false);
        }
    }, [enabled, latestVersion]);

    return {
        hasUnread: enabled ? hasUnread : false,
        latestVersion,
        markAsRead
    };
}
