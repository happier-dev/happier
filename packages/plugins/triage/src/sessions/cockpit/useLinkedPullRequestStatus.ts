import * as React from 'react';
import { useSurfaceContext } from '@happier-dev/plugin-ui';
import type { TriagePullRequestStatusV1 } from '@happier-dev/triage-protocol/v1';
import { selectTriageSessionPullRequestStatusV1, useTriageSessionPullRequestStatusV1, type TriageSessionPullRequestProjectionSnapshotV1 } from '../sessionPullRequestStatus.js';
import type { TriageSessionLinkedEntrySummaryV1 } from './linkedEntrySummary.js';

export type LinkedPullRequestStatusRead = Readonly<{
    status: TriagePullRequestStatusV1 | null;
    phase: 'idle' | 'reading' | 'ready' | 'unavailable';
}>;

/** Expanded rows consume the same Session Resource as SCM and Companion bodies. */
export function useLinkedPullRequestStatus(entry: TriageSessionLinkedEntrySummaryV1 | null, expanded: boolean, refreshRevision: number): LinkedPullRequestStatusRead {
    const { target } = useSurfaceContext();
    const sessionId = target.kind === 'session' ? target.sessionId : null;
    const url = entry?.kind === 'pullRequest' ? entry.locator.webUrl ?? null : null;
    const enabled = expanded && sessionId !== null && url !== null;
    const selectStatus = React.useCallback((snapshot: TriageSessionPullRequestProjectionSnapshotV1) => {
        const native = selectTriageSessionPullRequestStatusV1(snapshot.value, sessionId, url)?.nativeStatus;
        return native !== undefined && native.kind !== 'unavailable' ? native.value : null;
    }, [sessionId, url]);
    const selectPhase = React.useCallback((snapshot: TriageSessionPullRequestProjectionSnapshotV1): LinkedPullRequestStatusRead['phase'] => {
        if (!enabled) return 'idle';
        // Refreshing retains the admitted phase/value; only the first admission reads.
        if (snapshot.value === undefined && snapshot.pending !== 'idle') return 'reading';
        if (snapshot.error !== undefined) return 'unavailable';
        const native = selectTriageSessionPullRequestStatusV1(snapshot.value, sessionId, url)?.nativeStatus;
        return native?.kind === 'current' ? 'ready' : 'unavailable';
    }, [enabled, sessionId, url]);
    const { value: status, refresh } = useTriageSessionPullRequestStatusV1(selectStatus, enabled);
    const { value: phase } = useTriageSessionPullRequestStatusV1(selectPhase, enabled);
    const requested = React.useRef(refreshRevision);
    React.useEffect(() => {
        if (requested.current === refreshRevision) return;
        requested.current = refreshRevision;
        if (enabled) void refresh();
    }, [enabled, refresh, refreshRevision]);
    return { status: enabled ? status : null, phase };
}
