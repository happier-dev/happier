import * as React from 'react';
import type { ScmComparison} from '@happier-dev/protocol/scm/comparison';
import type { ScmReviewedMarksRecord, ScmReviewedMarksSelection, ScmReviewedMarksSource } from '@happier-dev/protocol/scm/reviewedMarks';
import { buildScmReviewScopeId } from '@happier-dev/protocol/scm/comparisonOccurrences';

import { useOptionalAuth } from '@/auth/context/AuthContext';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getActiveServerHomeCarrier, getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { captureAccountEncryptionObservationForHome } from '@/sync/http/accountEncryptionObservationBinding';
import { createServerFetchAtEndpoint } from '@/sync/http/client';
import { createScmReviewedMarksOperations } from '@/sync/ops/scmDiffSummary/reviewedMarks';
import { createScmDiffSummaryResultOperations, type ScmDiffSummaryHost } from '@/sync/ops/scmDiffSummary/results';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import type { ScmReviewedMarksRecordSource } from '@/sync/domains/scm/diffSummary/reviewedMarks';

export type ScmReviewedMarks = Readonly<{
    record: ScmReviewedMarksRecord | null;
    /** Keyed reading owners observe record changes without waking the screen's status consumer. */
    recordSource?: ScmReviewedMarksRecordSource;
    /** True until the first read settles, so a consumer can reserve the room of what the marks will say instead of moving content when they arrive. */
    pending: boolean;
    /** Null while marks can be written; the record remains readable when its host is unavailable. */
    unavailableReason: string | null;
    setReviewed: (refs: readonly string[], reviewed: boolean) => void;
    setReviewedKeys: (keys: readonly string[], reviewed: boolean) => void;
    clear: () => void;
}>;

const UNAVAILABLE: ScmReviewedMarks = { record: null, pending: false, unavailableReason: 'reviewed_marks_unavailable', setReviewed: () => {}, setReviewedKeys: () => {}, clear: () => {} };

/**
 * The person's explicit marks for one content scope, bound to the mounted view and the signed-in
 * Account on the active Home (account KV through its existing per-key CAS and prefix push). The
 * operations retire with the view, the Account or the Home; nothing is marked except on intent.
 */
export function useScmReviewedMarks(params: Readonly<{
    comparison: ScmComparison | null; source?: ScmReviewedMarksSource; serverId: string | null;
    host: ScmDiffSummaryHost | null;
    writeUnavailableReason?: string | null;
    observation?: 'keyed';
}>): ScmReviewedMarks {
    const credentials = useOptionalAuth()?.credentials ?? null;
    const server = useActiveServerSnapshot(credentials !== null);
    const execution = useMountedActionExecution(params.serverId ?? server.serverId, { retainInvocation: true });
    const selection: ScmReviewedMarksSelection | null = params.comparison ? { comparison: params.comparison }
        : params.source ? { source: params.source } : null;
    const selectionRef = React.useRef(selection);
    selectionRef.current = selection;
    const writeTarget = React.useRef({ host: params.host, unavailableReason: params.writeUnavailableReason });
    writeTarget.current = { host: params.host, unavailableReason: params.writeUnavailableReason };
    const executeRef = React.useRef(execution.execute);
    executeRef.current = execution.execute;
    const scopeId = selection ? buildScmReviewScopeId(selection.comparison
        ? { repositoryRootPath: selection.comparison.repository.rootPath, source: selection.comparison.source } : selection.source) : null;
    const sameHome = params.serverId === null || params.serverId === server.serverId;
    const [published, setPublished] = React.useState<Readonly<{
        scopeId: string; credentials: typeof credentials; serverId: typeof server.serverId;
        serverUrl: typeof server.serverUrl; generation: number; current: () => boolean; marks: ScmReviewedMarks;
    }> | null>(null);

    React.useEffect(() => {
        const selected = selectionRef.current;
        if (!selected || !scopeId || !credentials || !sameHome || !server.serverUrl || !server.serverId) {
            setPublished(null);
            return;
        }
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime || lifetime.scope.serverId !== server.serverId) {
            setPublished(null);
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
        const accountEncryptionObservation = captureAccountEncryptionObservationForHome({
            serverId: server.serverId,
            endpointUrl: server.serverUrl,
            credentials,
            isCurrent: shouldContinue,
        });
        const request = createServerFetchAtEndpoint({
            endpointUrl: server.serverUrl,
            serverId: server.serverId,
            ...(server.runtimeOrigin ? { runtimeOrigin: server.runtimeOrigin } : {}),
            ...(carrier ? { homeCarrier: carrier } : {}),
            credentials,
            isCurrent: shouldContinue,
            ...(accountEncryptionObservation ? { accountEncryptionObservation } : {}),
        });
        const operations = createScmReviewedMarksOperations({ ...selected, credentials, request, shouldContinue,
            setReviewedAction: async (input, reviewed) => {
                const target = writeTarget.current;
                if (!target.host || target.unavailableReason || !shouldContinue()) return {
                    success: false, errorCode: 'reviewed_marks_unavailable', error: target.unavailableReason ?? 'The review host is unavailable.',
                };
                return createScmDiffSummaryResultOperations({ ...target.host, serverId: server.serverId,
                    actionExecutor: createFrontDoorActionExecute({ execute: (actionId, actionInput, context) => executeRef.current(actionId, actionInput, {
                        ...(context?.defaultSessionId ? { defaultSessionId: context.defaultSessionId } : {}),
                        ...(context?.externalActionTarget ? { externalActionTarget: context.externalActionTarget } : {}),
                        ...(context?.actionRequestId ? { actionRequestId: context.actionRequestId } : {}),
                    }) }),
                    accountId: lifetime.scope.accountId, shouldContinue: () => shouldContinue() && writeTarget.current.host?.sessionId === target.host?.sessionId
                        && writeTarget.current.host?.machineId === target.host?.machineId && !writeTarget.current.unavailableReason,
                }).setReviewed(input, reviewed);
            },
            getSelection: () => {
                const current = selectionRef.current;
                if (!current) throw new Error('The displayed review scope is unavailable');
                return current;
            },
        });
        const canWrite = () => Boolean(writeTarget.current.host && !writeTarget.current.unavailableReason && shouldContinue());
        const setReviewed = (refs: readonly string[], reviewed: boolean) => { if (canWrite()) void operations.setReviewed(refs, reviewed); };
        const setReviewedKeys = (keys: readonly string[], reviewed: boolean) => { if (canWrite()) void operations.setReviewedKeys(keys, reviewed); };
        const clear = () => { if (canWrite()) void operations.clear(); };
        const publish = () => {
            const snapshot = operations.getSnapshot();
            setPublished({ scopeId, credentials, serverId: server.serverId, serverUrl: server.serverUrl, generation: server.generation,
                current: shouldContinue, marks: {
                get record() { return operations.recordSource.getSnapshot(); },
                recordSource: operations.recordSource,
                pending: snapshot.status === 'idle',
                unavailableReason: snapshot.status === 'ready' || snapshot.status === 'idle' ? null : snapshot.errorCode ?? 'reviewed_marks_unavailable',
                setReviewed,
                setReviewedKeys,
                clear,
            } });
        };
        const unsubscribe = params.observation === 'keyed' ? operations.subscribeStatus(publish) : operations.subscribe(publish);
        publish();
        void operations.read().catch(() => { /* the snapshot carries the typed failure */ });
        return () => {
            stopped = true;
            unsubscribe();
            operations.retire();
        };
        // Evidence changes update the intent ref; only scope or Account/Home changes retire observation.
    }, [scopeId, credentials, sameHome, server.generation, server.runtimeOrigin, server.serverId, server.serverUrl, params.observation]);

    const observed = published && sameHome && published.scopeId === scopeId && published.credentials === credentials
        && published.serverId === server.serverId && published.serverUrl === server.serverUrl
        && published.generation === server.generation && published.current() ? published.marks : UNAVAILABLE;
    const unavailableReason = observed.unavailableReason ?? params.writeUnavailableReason
        ?? (params.host ? null : 'reviewed_marks_unavailable');
    return React.useMemo(() => unavailableReason === observed.unavailableReason ? observed : {
        ...observed, get record() { return observed.record; }, unavailableReason,
    },
        [observed, unavailableReason]);
}
