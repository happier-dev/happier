import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { FeatureId } from '@happier-dev/protocol';
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
        if (enabled && latestReleaseId && getLastViewedReleaseId() === null) {
            // First installs start at the bundled history; existing numeric markers
            // remain older release identities rather than being auto-acknowledged.
            setLegacyChangelogAutoSeenBaseline(latestReleaseId);
            setLastViewedReleaseId(latestReleaseId);
        }
    }, [enabled, latestReleaseId]);

    const markAsRead = useCallback(() => {
        if (enabled && latestReleaseId) setLastViewedReleaseId(latestReleaseId);
    }, [enabled, latestReleaseId]);

    return { hasUnread, latestReleaseId, markAsRead };
}
