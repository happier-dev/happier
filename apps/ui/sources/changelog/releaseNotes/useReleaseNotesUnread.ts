import * as React from 'react';

import { resolveReleaseNotesLaunchOutcome } from './launchPolicy';
import { isReleaseNotesFeatureEnabled } from './featureGate';
import {
    getReleaseNotesRuntimeVersion,
    subscribeReleaseNotesRuntime,
} from './storage';

export type UseReleaseNotesUnreadResult = Readonly<{
    hasUnread: boolean;
}>;

/**
 * Lightweight hook for the AppUpdateStatus model and badge composition.
 *
 * Stays separate from `useChangelog` so the changelog domain remains the source of truth
 * for legacy numeric history while `releaseNotes` owns the curated story-deck unread state.
 */
export function useReleaseNotesUnread(): UseReleaseNotesUnreadResult {
    const enabled = isReleaseNotesFeatureEnabled();

    const runtimeVersion = React.useSyncExternalStore(
        subscribeReleaseNotesRuntime,
        getReleaseNotesRuntimeVersion,
        getReleaseNotesRuntimeVersion,
    );

    const hasUnread = React.useMemo(() => {
        if (!enabled) return false;
        const outcome = resolveReleaseNotesLaunchOutcome();
        return outcome.kind === 'open-story';
    }, [enabled, runtimeVersion]);

    return { hasUnread };
}
