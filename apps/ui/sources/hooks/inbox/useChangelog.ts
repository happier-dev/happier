import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { FeatureId } from '@happier-dev/protocol/features/catalog';
import { getFeatureBuildPolicyDecision } from '@/sync/domains/features/featureBuildPolicy';
import {
    getLastViewedReleaseId,
    setLastViewedReleaseId,
    getLatestReleaseId,
    hasUnreadChangelog,
    subscribeChangelogReadState,
} from '@/changelog';
import { setLegacyChangelogAutoSeenBaseline } from '@/changelog/releaseNotes/storage';

const CHANGELOG_FEATURE_ID = 'app.ui.changelog' as const satisfies FeatureId;
const subscribeDisabled = () => () => {};

export function useChangelog() {
    const enabled = getFeatureBuildPolicyDecision(CHANGELOG_FEATURE_ID) !== 'deny';
    // MMKV reads are synchronous - no need for useEffect
    const latestReleaseId = enabled ? getLatestReleaseId() : null;

    const getSnapshot = useCallback(
        () => enabled && hasUnreadChangelog(latestReleaseId),
        [enabled, latestReleaseId],
    );
    const hasUnread = useSyncExternalStore(
        enabled ? subscribeChangelogReadState : subscribeDisabled,
        getSnapshot,
        getSnapshot,
    );

    useEffect(() => {
        if (!enabled || !latestReleaseId) {
            return;
        }

        const lastViewedReleaseId = getLastViewedReleaseId();
        if (lastViewedReleaseId === null) {
            // On first install, mark as read so users don't see old entries. This must run after
            // commit; writing MMKV during render can synchronously notify other update-status
            // consumers while the pre-auth shell is still rendering.
            setLegacyChangelogAutoSeenBaseline(latestReleaseId);
            setLastViewedReleaseId(latestReleaseId);
            return;
        }

    }, [enabled, latestReleaseId]);

    const markAsRead = useCallback(() => {
        if (!enabled || !latestReleaseId) {
            return;
        }

        setLastViewedReleaseId(latestReleaseId);
    }, [enabled, latestReleaseId]);

    return {
        hasUnread: enabled ? hasUnread : false,
        latestReleaseId,
        markAsRead,
    };
}
