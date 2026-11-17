import * as React from 'react';

import type { ExecutionRunPublicState } from '@happier-dev/protocol/execution/runs/responseSchemas';
import type { ReviewFindingsV1 } from '@happier-dev/protocol/messages/structured/reviewFindingsV1';
import type { ReviewFindingsV2 } from '@happier-dev/protocol/messages/structured/reviewFindingsV2';

import { sessionExecutionRunGet, sessionExecutionRunList } from '@/sync/ops/sessionExecutionRuns';
import { subscribeExecutionRunActivity } from '@/sync/runtime/executionRuns/executionRunActivityBus';
import { serverAccountScopeKeySuffix, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { readReviewPayload } from './readReviewPayload';
import { resolveReviewRunStatus } from './resolveReviewRunStatus';

/** Another reviewer of the same review: its run and, once it has finished, its result. */
export type ReviewGroupSibling = Readonly<{
    runId: string;
    /** The run's own reviewer, for its row while its result is still on its way. */
    backendTarget: ExecutionRunPublicState['backendTarget'];
    status: string;
    payload: ReviewFindingsV1 | ReviewFindingsV2 | null;
}>;

const NO_SIBLINGS: readonly ReviewGroupSibling[] = Object.freeze([]);

/**
 * The other reviewers of a review started on several engines at once: the runs that share this
 * run's `display.groupId` (stamped by `review.start`), in start order, each with its result. Read
 * through the run host's own list and get. A reviewer's own run activity re-reads only that run;
 * an unknown-run signal (reconnect) re-lists. A run without a group has no siblings and reads nothing.
 */
export function useReviewGroupSiblings(params: Readonly<{
    sessionId: string;
    scope: ServerAccountScope | null;
    groupId: string | null;
    selfRunId: string;
}>): readonly ReviewGroupSibling[] {
    const { sessionId, groupId, selfRunId } = params;
    const serverId = params.scope?.serverId ?? null;
    const accountId = params.scope?.accountId ?? null;
    const scope = React.useMemo(() => serverId && accountId ? { serverId, accountId } : null, [serverId, accountId]);
    const key = JSON.stringify([scope ? serverAccountScopeKeySuffix(scope) : null, sessionId, groupId, selfRunId]);
    const [snapshot, setSnapshot] = React.useState<{ key: string; siblings: readonly ReviewGroupSibling[] }>({ key, siblings: NO_SIBLINGS });
    // The listed run of each current reviewer: its identity, and its status while a read fails.
    const listedRef = React.useRef<ReadonlyMap<string, ExecutionRunPublicState>>(new Map());

    const readSibling = React.useCallback(async (run: ExecutionRunPublicState, readScope: ServerAccountScope): Promise<ReviewGroupSibling> => {
        const got = await sessionExecutionRunGet(sessionId, { runId: run.runId, includeStructured: true }, { serverId: readScope.serverId, scope: readScope });
        const payload = 'run' in got ? readReviewPayload(got.structuredMeta, got.reviewFindings) : null;
        return {
            runId: run.runId,
            backendTarget: run.backendTarget,
            status: resolveReviewRunStatus({ run: 'run' in got ? got.run : run, payload }) ?? run.status,
            payload,
        };
    }, [sessionId]);

    const publish = React.useCallback((update: (siblings: readonly ReviewGroupSibling[]) => readonly ReviewGroupSibling[]) => {
        setSnapshot((current) => {
            const next = update(current.key === key ? current.siblings : NO_SIBLINGS);
            return current.key === key && JSON.stringify(current.siblings) === JSON.stringify(next) ? current : { key, siblings: next };
        });
    }, [key]);

    const load = React.useCallback(async (isCurrent: () => boolean) => {
        if (!groupId || !scope) return;
        const listed = await sessionExecutionRunList(sessionId, {}, { serverId: scope.serverId, scope });
        if (!isCurrent() || !('runs' in listed)) return;
        const members = listed.runs
            .filter((run) => run.display?.groupId === groupId && run.runId !== selfRunId)
            .sort((left, right) => left.startedAtMs - right.startedAtMs);
        // One read per other reviewer: a review has as many as the person chose.
        const next = await Promise.all(members.map((run) => readSibling(run, scope)));
        if (!isCurrent()) return;
        listedRef.current = new Map(members.map((run) => [run.runId, run]));
        publish(() => next);
    }, [groupId, publish, readSibling, scope, selfRunId, sessionId]);

    /** A reviewer's own activity changes only that reviewer: re-read its run, not the Session's run list. */
    const refreshSibling = React.useCallback(async (runId: string, isCurrent: () => boolean, readOrder: Map<string, number>) => {
        const listedRun = listedRef.current.get(runId);
        if (!listedRun || !scope) return;
        const order = (readOrder.get(runId) ?? 0) + 1;
        readOrder.set(runId, order);
        const next = await readSibling(listedRun, scope);
        // A later report for the same reviewer supersedes this read.
        if (!isCurrent() || readOrder.get(runId) !== order) return;
        publish((siblings) => siblings.map((sibling) => (sibling.runId === runId ? next : sibling)));
    }, [publish, readSibling, scope]);

    React.useEffect(() => {
        listedRef.current = new Map();
        if (!groupId || !scope) {
            return undefined;
        }
        let current = true;
        const isCurrent = () => current;
        const readOrder = new Map<string, number>();
        fireAndForget(load(isCurrent), { tag: 'useReviewGroupSiblings.load' });
        const unsubscribe = serverId
            ? subscribeExecutionRunActivity({ serverId, sessionId }, (notification) => {
                if (notification.runId === null) {
                    fireAndForget(load(isCurrent), { tag: 'useReviewGroupSiblings.refresh' });
                    return;
                }
                if (!listedRef.current.has(notification.runId)) return;
                fireAndForget(refreshSibling(notification.runId, isCurrent, readOrder), { tag: 'useReviewGroupSiblings.refreshSibling' });
            })
            : () => undefined;
        return () => {
            current = false;
            unsubscribe();
        };
    }, [groupId, load, refreshSibling, scope, serverId, sessionId]);

    return snapshot.key === key ? snapshot.siblings : NO_SIBLINGS;
}
