import * as React from 'react';

import {
    getActiveManifest,
    getCurrentReleaseEntry,
    getCurrentReleaseId,
} from './manifestRuntime';
import { resolveReleaseNotesLaunchOutcome, type ReleaseNotesLaunchOutcome } from './launchPolicy';
import {
    getLastSeenReleaseId,
    getReleaseNotesRuntimeVersion,
    setLastSeenReleaseId,
    subscribeReleaseNotesRuntime,
} from './storage';
import type { ReleaseNotesRelease } from './types';

export type UseReleaseNotesStateResult = Readonly<{
    currentReleaseId: string | null;
    currentRelease: ReleaseNotesRelease | null;
    lastSeenReleaseId: string | null;
    launchOutcome: ReleaseNotesLaunchOutcome;
    markCurrentSeen: () => void;
}>;

export function useReleaseNotesState(): UseReleaseNotesStateResult {
    const runtimeVersion = React.useSyncExternalStore(
        subscribeReleaseNotesRuntime,
        getReleaseNotesRuntimeVersion,
        getReleaseNotesRuntimeVersion,
    );

    const currentReleaseId = React.useMemo(() => getCurrentReleaseId(), []);
    const currentRelease = React.useMemo(() => getCurrentReleaseEntry(), [runtimeVersion]);
    const lastSeenReleaseId = React.useMemo(() => getLastSeenReleaseId(), [runtimeVersion]);

    void getActiveManifest(); // warm cache

    const launchOutcome = React.useMemo(
        () => resolveReleaseNotesLaunchOutcome(),
        [currentReleaseId, runtimeVersion],
    );

    const markCurrentSeen = React.useCallback(() => {
        const id = getCurrentReleaseId();
        if (!id) return;
        setLastSeenReleaseId(id);
    }, []);

    return {
        currentReleaseId,
        currentRelease,
        lastSeenReleaseId,
        launchOutcome,
        markCurrentSeen,
    };
}
