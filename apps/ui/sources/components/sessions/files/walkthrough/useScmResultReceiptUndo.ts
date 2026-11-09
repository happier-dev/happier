import * as React from 'react';
import { isScmCommitPlanApplicationLocked } from '@happier-dev/protocol/scm/diffSummaryCommitPlan';
import type { ScmDiffSummaryPublishedResult } from '@/sync/domains/scm/diffSummary/publicationReceipt';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { applySavedScmDiffSummaryResult, getScmDiffSummaryState, loadSavedScmDiffSummaryResult, subscribeScmDiffSummaryState } from '@/sync/ops/scmDiffSummary/generate';
import { createScmDiffSummaryResultOperations } from '@/sync/ops/scmDiffSummary/results';
import type { UiScmActionFailure } from '@/sync/ops/scm/scmActionInvocation';
import { t } from '@/text';

type ReceiptUndoFailure = UiScmActionFailure & Readonly<{ latestRevision?: number }>;

/** Data callback for the existing receipt composition; rendering stays with its card. */
export function useScmResultReceiptUndo(params: Readonly<{
    receipt: ScmDiffSummaryPublishedResult;
    sessionId: string;
    serverId?: string | null;
    canControl: boolean;
    /** An existing binding can immediately rule out a stale receipt; transcript rows need no key. */
    requestKey?: string | null;
}>): Readonly<{ onUndo?: () => Promise<void>; undoing: boolean; undone: boolean; error: string | null; failure: ReceiptUndoFailure | null }> {
    const { receipt, sessionId, serverId, canControl, requestKey } = params;
    const { binding } = useServerCredentialAccountScopeBinding(serverId);
    const scope = binding?.isCurrent() ? binding.scope : null;
    const scopeKey = scope ? serverAccountScopeKeySuffix(scope) : null;
    const resultId = receipt.output.resultId;
    const revision = receipt.output.revision;
    const cwd = receipt.output.comparison.repository.rootPath;
    const identity = JSON.stringify([scopeKey, sessionId, cwd, resultId]);
    const receiptKey = JSON.stringify([identity, revision]);
    const [admitted, setAdmitted] = React.useState<Readonly<{ identity: string; key: string }> | null>(null);
    const activeRequestKey = admitted?.identity === identity ? admitted.key : requestKey ?? null;
    // The saved result owns availability; the local key only addresses its admitted projection.
    const getSnapshot = React.useCallback(() => {
        const entry = activeRequestKey ? getScmDiffSummaryState().entriesByKey[activeRequestKey] : undefined;
        return scopeKey && entry?.scopeKey === scopeKey && entry.sessionId === sessionId && entry.savedResult?.resultId === resultId
            && entry.input.cwd === cwd ? entry.savedResult : null;
    }, [scopeKey, sessionId, resultId, activeRequestKey, cwd]);
    const saved = React.useSyncExternalStore(subscribeScmDiffSummaryState, getSnapshot, getSnapshot);
    const isCurrent = React.useCallback(() => binding?.isCurrent() === true, [binding]);
    const operations = React.useMemo(() => scope ? createScmDiffSummaryResultOperations({ sessionId,
        serverId: scope.serverId, accountId: scope.accountId, shouldContinue: isCurrent }) : null,
    [sessionId, scope?.serverId, scope?.accountId, isCurrent]);
    const [undoing, setUndoing] = React.useState(false);
    const [failed, setFailed] = React.useState<Readonly<{ key: string; failure: ReceiptUndoFailure }> | null>(null);
    const pending = React.useRef(false);
    React.useEffect(() => {
        if (!receipt.publication.canUndo || !operations || !scope || !isCurrent() || getSnapshot()) return;
        let mounted = true;
        void operations.read({ cwd, resultId }).then(read => {
            if (!mounted || !isCurrent()) return;
            if (!read.success) { setFailed({ key: receiptKey, failure: read }); return; }
            if (read.result.resultId !== resultId || !read.result.output.success || read.result.output.comparison?.repository.rootPath !== cwd) return;
            const key = loadSavedScmDiffSummaryResult({ sessionId, scope, result: read.result });
            if (key) setAdmitted({ identity, key });
        });
        return () => { mounted = false; };
    }, [receipt.publication.canUndo, operations, scopeKey, isCurrent, getSnapshot, cwd, resultId, sessionId, identity, receiptKey]);
    // A later, different edit is not this receipt's Undo. The saved notice identifies the undone revision.
    const undone = Boolean(saved && !saved.canUndo && saved.updateNotice?.kind === 'undo'
        && saved.updateNotice.revision === revision + 1 && saved.revision >= saved.updateNotice.revision);
    const enabled = Boolean(canControl && receipt.publication.canUndo && saved?.canUndo && saved.revision === revision
        && !isScmCommitPlanApplicationLocked(saved.application) && operations && isCurrent());
    const undo = React.useCallback(async () => {
        if (!enabled || !operations || !activeRequestKey || pending.current || !isCurrent()) return;
        // A previously rendered callback cannot undo a later edit, even before React catches up.
        const current = getSnapshot();
        if (!current || !current.canUndo || current.revision !== revision || isScmCommitPlanApplicationLocked(current.application)) return;
        pending.current = true;
        setUndoing(true);
        setFailed(null);
        // A receipt is not an editor: when the walkthrough moved on after this update, say that, not the draft-conflict copy.
        const fail = (failure: ReceiptUndoFailure) => setFailed({ key: receiptKey, failure: failure.errorCode === 'revision_conflict'
            ? { ...failure, error: t('walkthrough.receipt.changedSince') } : failure });
        try {
            const response = await operations.undo({ cwd, resultId, expectedRevision: revision });
            if (!isCurrent()) return;
            if (response.success) applySavedScmDiffSummaryResult(activeRequestKey, response.result);
            else fail(response);
        } catch (failure) {
            if (isCurrent()) fail({ success: false, errorCode: 'result_unavailable',
                error: failure instanceof Error ? failure.message : t('walkthroughStart.unavailable') });
        } finally { pending.current = false; setUndoing(false); }
    }, [enabled, getSnapshot, isCurrent, operations, activeRequestKey, cwd, resultId, revision, receiptKey]);
    const failure: ReceiptUndoFailure | null = !isCurrent() || undone ? null : failed?.key === receiptKey ? failed.failure
        : saved && saved.revision > revision ? { success: false, errorCode: 'revision_conflict', latestRevision: saved.revision,
            error: t('walkthrough.receipt.changedSince') } : null;
    return { onUndo: enabled && !undoing ? undo : undefined, undoing, undone: undone && isCurrent(),
        error: failure?.error ?? null, failure };
}
