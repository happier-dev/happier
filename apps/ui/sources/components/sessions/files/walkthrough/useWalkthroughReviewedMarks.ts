import * as React from 'react';
import type { ScmComparison, ScmReviewedMarksRecord } from '@happier-dev/protocol';

import { useOptionalAuth } from '@/auth/context/AuthContext';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getActiveServerHomeCarrier, getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { createServerFetchAtEndpoint } from '@/sync/http/client';
import { createScmReviewedMarksOperations } from '@/sync/ops/scmDiffSummary/reviewedMarks';
import { createScmDiffSummaryResultOperations, type ScmDiffSummaryHost } from '@/sync/ops/scmDiffSummary/results';

export type WalkthroughReviewedMarks = Readonly<{
    record: ScmReviewedMarksRecord | null;
    /** Null while marks can be written; otherwise why not (no account, another Home, unreadable record). */
    unavailableReason: string | null;
    setReviewed: (refs: readonly string[], reviewed: boolean) => void;
}>;

const UNAVAILABLE: WalkthroughReviewedMarks = { record: null, unavailableReason: 'reviewed_marks_unavailable', setReviewed: () => {} };

/**
 * The person's explicit marks for one exact comparison, bound to the mounted view and the signed-in
 * Account on the active Home (account KV through its existing per-key CAS and prefix push). The
 * operations retire with the view, the Account or the Home; nothing is marked except on intent.
 */
export function useWalkthroughReviewedMarks(params: Readonly<{
    comparison: ScmComparison | null; serverId: string | null;
    host: ScmDiffSummaryHost | null;
}>): WalkthroughReviewedMarks {
    const credentials = useOptionalAuth()?.credentials ?? null;
    const server = useActiveServerSnapshot(credentials !== null);
    const comparison = params.comparison;
    const comparisonId = comparison?.id ?? null;
    const sameHome = params.serverId === null || params.serverId === server.serverId;
    const [state, setState] = React.useState<WalkthroughReviewedMarks>(UNAVAILABLE);
    const comparisonRef = React.useRef(comparison);
    comparisonRef.current = comparison;
    const sessionId = params.host?.sessionId;
    const machineId = params.host?.machineId;

    React.useEffect(() => {
        const captured = comparisonRef.current;
        const host: ScmDiffSummaryHost | null = sessionId ? { sessionId } : machineId ? { machineId } : null;
        if (!captured || !host || !credentials || !sameHome || !server.serverUrl || !server.serverId) {
            setState(UNAVAILABLE);
            return;
        }
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime || lifetime.scope.serverId !== server.serverId) {
            setState(UNAVAILABLE);
            return;
        }
        const carrier = getActiveServerHomeCarrier();
        let stopped = false;
        const shouldContinue = () => {
            const current = getActiveServerSnapshot();
            return !stopped && lifetime.isCurrent() && current.serverId === server.serverId
                && current.serverUrl === server.serverUrl && current.generation === server.generation
                && getActiveServerHomeCarrier() === carrier;
        };
        const request = createServerFetchAtEndpoint({
            endpointUrl: server.serverUrl,
            serverId: server.serverId,
            ...(server.runtimeOrigin ? { runtimeOrigin: server.runtimeOrigin } : {}),
            ...(carrier ? { homeCarrier: carrier } : {}),
            credentials,
            isCurrent: shouldContinue,
        });
        const actions = createScmDiffSummaryResultOperations({ ...host, serverId: server.serverId,
            accountId: lifetime.scope.accountId, shouldContinue });
        const operations = createScmReviewedMarksOperations({ comparison: captured, credentials, request, shouldContinue,
            setReviewedAction: (refs, reviewed) => actions.setReviewed({ v: 2, cwd: captured.repository.rootPath,
                comparisonId: captured.id, source: captured.source, ...(sessionId ? { sessionId } : {}), changeRefs: [...refs] }, reviewed),
        });
        const setReviewed = (refs: readonly string[], reviewed: boolean) => { void operations.setReviewed(refs, reviewed); };
        const publish = () => {
            const snapshot = operations.getSnapshot();
            setState({
                record: snapshot.status === 'ready' ? snapshot.record : null,
                unavailableReason: snapshot.status === 'ready' || snapshot.status === 'idle' ? null : snapshot.errorCode ?? 'reviewed_marks_unavailable',
                setReviewed,
            });
        };
        const unsubscribe = operations.subscribe(publish);
        publish();
        void operations.read().catch(() => { /* the snapshot carries the typed failure */ });
        return () => {
            stopped = true;
            unsubscribe();
            operations.retire();
        };
        // The comparison's identity, not its object, decides the record.
    }, [comparisonId, credentials, sameHome, server.generation, server.runtimeOrigin, server.serverId, server.serverUrl, sessionId, machineId]);

    return params.host ? state : UNAVAILABLE;
}
