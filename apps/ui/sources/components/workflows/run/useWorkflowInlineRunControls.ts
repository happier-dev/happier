import * as React from 'react';
import { useTranscriptRowContentDemand } from '@/components/sessions/transcript/viewport/visibility/TranscriptRowContentDemand';
import { projectWorkflowInvocationRecovery } from './workflowRunDetailPresentation';
import { useShallow } from 'zustand/react/shallow';
import type { WorkflowInvocationDetailV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { subscribeVisibleWorkflowRunListInvalidation } from '@/sync/domains/workflows/workflowRunListInvalidation';
import type { WorkflowRunAcceptedContextV1, WorkflowRunStartResultV1 } from '@happier-dev/protocol/workflows/actionsV1';
import type { WorkflowDefinitionV1 } from '@happier-dev/protocol/workflows/workflowV1';
import type { WorkflowRunSummaryV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { prepareWorkflowRunStartV1 } from '@happier-dev/protocol/workflows';
import { canResumeWorkflowRunBoundary, canStartWorkflowAnotherRound, canStartWorkflowRunAgain, describeWorkflowRunState, isWorkflowRunStopPending } from '../presentation/workflowLifecyclePresentation';
import { describeWorkflowRunProgress } from '../presentation/workflowRunProgress';
import { createWorkflowRunDetailActions } from '@/sync/domains/workflows/workflowRunDetailActions';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useWorkflowRunNowController } from './useWorkflowRunNowController';
import { projectAcceptedWorkflowRunTarget } from './projectAcceptedWorkflowRunTarget';
import { useMountedRef } from '@/hooks/ui/useMountedRef';
import { WorkflowActionError } from '@/sync/domains/workflows/workflowActionError';
import { isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';
import { getStorage } from '@/sync/domains/state/storage';
import { workflowRunRowFromSummary, workflowRunStoreKey } from '@/sync/store/domains/workflowRuns';
import { resolveWorkflowProblemPresentation, type WorkflowProblemPresentation } from '../presentation/workflowProblemPresentation';

/** Managed summary and existing controls; native Workflow activity is a distinct producer. */
export function useWorkflowInlineRunControls(params: Readonly<{
    run: WorkflowRunSummaryV1;
    definition: WorkflowDefinitionV1 | null;
    acceptedContext: WorkflowRunAcceptedContextV1 | null;
    /** Present only when the list owner opened accepted content, including false for ordinary replay. */
    supportsAnotherRound?: boolean;
    accountLifetime: ServerAccountScopeLifetime;
    canEdit: boolean;
    cancelRequested?: boolean;
    onStarted: (result: WorkflowRunStartResultV1) => void;
}>) {
    const { run, definition, acceptedContext, accountLifetime, canEdit, supportsAnotherRound } = params;
    const actions = React.useMemo(() => createWorkflowRunDetailActions({ accountLifetime }), [accountLifetime]);
    // The same Another round intent as the Run page's, so either surface rejoins one pending request.
    const start = useWorkflowRunNowController(accountLifetime, `another-round:${run.id}`);
    const replayStart = useWorkflowRunNowController(accountLifetime, `replay:${run.id}`);
    const mounted = useMountedRef();
    const [pendingControl, setPendingControl] = React.useState<'pause' | 'resume' | 'cancel' | null>(null);
    const [controlError, setControlError] = React.useState<WorkflowProblemPresentation | null>(null);
    const [cancelRequestReceipt, setCancelRequestReceipt] = React.useState(false);
    const pendingControlRef = React.useRef<object | null>(null);
    const cancelRequested = isWorkflowRunStopPending({ ...run, cancelRequested: params.cancelRequested || cancelRequestReceipt });
    React.useEffect(() => {
        pendingControlRef.current = null;
        setPendingControl(null);
        setControlError(null);
        setCancelRequestReceipt(false);
        return () => { pendingControlRef.current = null; };
    }, [accountLifetime, run.id]);
    const submitControl = React.useCallback(async (kind: 'pause' | 'resume' | 'cancel') => {
        if (!canEdit || !accountLifetime.isCurrent() || pendingControlRef.current !== null) return;
        const token = {};
        pendingControlRef.current = token;
        setPendingControl(kind);
        setControlError(null);
        const owns = () => mounted.current && pendingControlRef.current === token && accountLifetime.isCurrent();
        try {
            const current = getStorage().getState().workflowRunsById[workflowRunStoreKey(run.id, accountLifetime.scope)]?.summary ?? run;
            const input = { runId: run.id, expectedRevision: current.revision };
            const result = await (kind === 'pause' ? actions.pauseRun(input)
                : kind === 'resume' ? actions.resumeRun({ ...input, mode: 'boundary' }) : actions.cancelRun(input));
            if (!owns()) return;
            getStorage().getState().upsertWorkflowRuns([workflowRunRowFromSummary(result.run)], accountLifetime.scope);
            // Acceptance can precede cancellation: present the canonical receipt until the Run settles.
            if (result.intent === 'cancel_requested') setCancelRequestReceipt(true);
        } catch (error) {
            if (error instanceof WorkflowActionError && isActionApprovalDeclinedErrorCode(error.rawCode)) return;
            if (owns()) setControlError(resolveWorkflowProblemPresentation(error, 'run'));
        } finally {
            if (pendingControlRef.current === token) {
                pendingControlRef.current = null;
                if (mounted.current) setPendingControl(null);
            }
        }
    }, [accountLifetime, actions, canEdit, mounted, run]);
    const onStartedRef = React.useRef(params.onStarted);
    onStartedRef.current = params.onStarted;
    const hasAcceptedContext = acceptedContext !== null || supportsAnotherRound !== undefined;
    const startAcceptedRun = React.useCallback(async (intent: 'replay' | 'another_round') => {
        const eligible = { run, definition, canEdit, cancelRequested, supportsAnotherRound, hasAcceptedContext };
        if (!accountLifetime.isCurrent() || !(intent === 'another_round'
            ? canStartWorkflowAnotherRound(eligible) : canStartWorkflowRunAgain(eligible))) return;
        const controller = intent === 'another_round' ? start : replayStart;
        const admitted = await controller.runNow({
            prepareRequest: async () => {
                // Pressing a replay action is deliberate detail demand. Reloaded timelines never open
                // full invocation history merely to decide whether to draw this action.
                const detail = definition && acceptedContext ? { run, definition, acceptedContext } : await actions.getRun(run.id);
                const opened = { run: detail.run, definition: detail.definition, canEdit, cancelRequested, hasAcceptedContext: true };
                if (!accountLifetime.isCurrent() || !(intent === 'another_round'
                    ? canStartWorkflowAnotherRound(opened) : canStartWorkflowRunAgain(opened))) {
                    throw new WorkflowActionError({ message: 'invalid_input', rawCode: 'invalid_input' });
                }
                const prepared = prepareWorkflowRunStartV1({ definition: detail.definition, acceptedContext: detail.acceptedContext,
                    replay: { runId: run.id, ...(intent === 'another_round' ? { intent } : {}) } });
                return { ...prepared, ...(prepared.project ? { project: projectAcceptedWorkflowRunTarget(prepared.project) } : {}) };
            }, refusal: 'inline',
            isInvocationCurrent: () => mounted.current && accountLifetime.isCurrent() });
        if (admitted && mounted.current && accountLifetime.isCurrent()) onStartedRef.current(admitted);
    }, [acceptedContext, accountLifetime, actions, canEdit, cancelRequested, definition, hasAcceptedContext, mounted, replayStart, run, start, supportsAnotherRound]);
    const anotherRound = React.useCallback(() => startAcceptedRun('another_round'), [startAcceptedRun]);
    const runAgain = React.useCallback(() => startAcceptedRun('replay'), [startAcceptedRun]);
    return {
        lifecycle: describeWorkflowRunState(params.run.state, { workflowCustodyState: params.run.workflowCustodyState,
            cancelRequested, inAttentionWindow: params.run.attentionRequired }),
        progress: describeWorkflowRunProgress(params.run.stepProgress),
        availability: params.run.availability,
        canResume: canResumeWorkflowRunBoundary(params),
        actions,
        submitControl,
        pendingControl,
        controlError,
        cancelRequested,
        anotherRound: canStartWorkflowAnotherRound({ ...params,
            hasAcceptedContext: params.acceptedContext !== null || supportsAnotherRound === true }) ? anotherRound : null,
        runAgain: canStartWorkflowRunAgain({ ...params, hasAcceptedContext }) ? runAgain : null,
        start,
        replayStart,
    };
}

const NO_INLINE_INVOCATIONS: readonly WorkflowInvocationDetailV1[] = Object.freeze([]);

/** Discussion round facts use the Run page's scoped invocation store and its Account-change wake. */
export function useWorkflowInlineRunInvocations(params: Readonly<{
    runIds: readonly string[];
    accountLifetime: ServerAccountScopeLifetime;
    enabled: boolean;
}>) {
    const { accountLifetime } = params;
    const previousIds = React.useRef(params.runIds);
    if (previousIds.current.length !== params.runIds.length || params.runIds.some((id, index) => id !== previousIds.current[index])) {
        previousIds.current = params.runIds;
    }
    const runIds = previousIds.current;
    const facts = getStorage()(useShallow(state => runIds.map(id =>
        state.workflowRunInvocationsByRunId[workflowRunStoreKey(id, accountLifetime.scope)]?.factsById)));
    const [errors, setErrors] = React.useState<Readonly<Record<string, WorkflowProblemPresentation>>>({});
    const requestRef = React.useRef<((ids: readonly string[]) => void) | null>(null);
    React.useEffect(() => {
        if (!params.enabled || runIds.length === 0) return;
        const controller = new AbortController();
        const retirement = accountLifetime.onRetire(() => controller.abort());
        const actions = createWorkflowRunDetailActions({ accountLifetime });
        const load = async (runId: string) => {
            let cursor: string | undefined;
            do {
                const page = await actions.listInvocations({ runId, includeContent: true, ...(cursor ? { cursor } : {}) }, controller.signal);
                if (controller.signal.aborted || !accountLifetime.isCurrent()) return;
                const state = getStorage().getState();
                state.applyWorkflowRunInvocationPage({ scope: accountLifetime.scope, runId,
                    invocations: page.invocations, invocationDetails: page.invocationDetails,
                    nextCursor: page.nextCursor ?? null, parentRevision: page.parentRevision,
                    mode: cursor ? 'append' : state.workflowRunInvocationsByRunId[workflowRunStoreKey(runId, accountLifetime.scope)]?.history.loaded ? 'refresh' : 'replace' });
                cursor = page.nextCursor ?? undefined;
            } while (cursor);
            if (!controller.signal.aborted && accountLifetime.isCurrent()) setErrors(previous => {
                if (!previous[runId]) return previous;
                const next = { ...previous };
                delete next[runId];
                return next;
            });
        };
        // Reconnect and per-run Account-change events restate facts; nothing polls.
        const request = (ids: readonly string[]) => {
            for (const runId of ids) void load(runId).catch(error => {
                if (!controller.signal.aborted && accountLifetime.isCurrent()) {
                    setErrors(previous => ({ ...previous, [runId]: resolveWorkflowProblemPresentation(error, 'run') }));
                }
            });
        };
        requestRef.current = request;
        const state = getStorage().getState();
        request(runIds.filter(runId => {
            const key = workflowRunStoreKey(runId, accountLifetime.scope);
            const known = state.workflowRunInvocationsByRunId[key];
            return !known?.history.loaded || known.history.nextCursor !== null
                || known.history.parentRevision !== state.workflowRunsById[key]?.revision
                || known.history.invocationIds.some(id => known.factsById[id]?.opened?.parentRevision !== known.history.parentRevision);
        }));
        const unsubscribe = subscribeVisibleWorkflowRunListInvalidation({ lifetime: accountLifetime, runIds,
            isVisibleWindowLoaded: () => true, invalidate: change => request(change.runIds ?? runIds) });
        return () => { requestRef.current = null; controller.abort(); retirement.dispose(); unsubscribe(); };
    }, [accountLifetime, params.enabled, runIds]);
    const byRunId = React.useMemo(() => new Map(runIds.map((id, index) => [id,
        facts[index] ? Object.values(facts[index]).flatMap(fact => fact.opened ? [fact.opened] : []) : NO_INLINE_INVOCATIONS])), [facts, runIds]);
    const retry = React.useCallback((runId: string) => requestRef.current?.([runId]), []);
    const byInvocationId = React.useMemo(() => new Map([...byRunId].map(([id, invocations]) => [id, new Map(invocations.map(fact => [fact.index.id, fact]))])), [byRunId]);
    return { byRunId, byInvocationId, errors, retry };
}

/** Inline recovery consumes the same exact private-evidence projection as the Run screen. */
export function useWorkflowInlineInvocationRetry(params: Readonly<{
    run: WorkflowRunSummaryV1;
    invocation: WorkflowInvocationDetailV1;
    accountLifetime: ServerAccountScopeLifetime;
    canEdit: boolean;
}>) {
    const { run, invocation, accountLifetime, canEdit } = params;
    const contentDemand = useTranscriptRowContentDemand();
    const actions = React.useMemo(() => createWorkflowRunDetailActions({ accountLifetime }), [accountLifetime]);
    const opened = getStorage()(state => state.workflowRunInvocationsByRunId[workflowRunStoreKey(run.id, accountLifetime.scope)]
        ?.factsById[invocation.index.id]?.opened ?? invocation);
    const recovery = projectWorkflowInvocationRecovery({ run, invocation: opened.index, progress: opened.progress,
        recoveryAvailability: opened.recoveryAvailability, machineHomeDirectory: null });
    const mounted = useMountedRef();
    const pendingRef = React.useRef(false);
    const [pending, setPending] = React.useState(false);
    const [accepted, setAccepted] = React.useState(false);
    const [error, setError] = React.useState<WorkflowProblemPresentation | null>(null);
    React.useEffect(() => {
        setPending(false);
        setAccepted(false);
        setError(null);
    }, [accountLifetime, invocation.index.id]);
    React.useEffect(() => {
        if (!contentDemand || !canEdit || opened.recoveryAvailability !== undefined) return;
        const controller = new AbortController();
        const retirement = accountLifetime.onRetire(() => controller.abort());
        void actions.getInvocation({ runId: run.id, invocationId: invocation.index.id }, controller.signal).then(result => {
            if (controller.signal.aborted || !accountLifetime.isCurrent()) return;
            getStorage().getState().upsertWorkflowRunInvocation({ scope: accountLifetime.scope, runId: run.id,
                parentRevision: result.invocation.parentRevision, invocation: { ...result.invocation.index, opened: result.invocation } });
        }, failure => {
            if (!controller.signal.aborted && accountLifetime.isCurrent()) setError(resolveWorkflowProblemPresentation(failure, 'run'));
        });
        return () => { controller.abort(); retirement.dispose(); };
    }, [accountLifetime, actions, canEdit, contentDemand, invocation.index.id, opened.recoveryAvailability, run.id]);
    const retry = React.useCallback(async () => {
        if (!canEdit || pendingRef.current || !accountLifetime.isCurrent()
            || !recovery.canRetrySameConversation || recovery.requiresUncertaintyAcknowledgement) return;
        pendingRef.current = true;
        setPending(true);
        setError(null);
        try {
            const current = getStorage().getState().workflowRunsById[workflowRunStoreKey(run.id, accountLifetime.scope)]?.summary ?? run;
            const result = await actions.retryInvocation({ runId: run.id, expectedRevision: current.revision,
                invocation: { recordId: opened.index.id }, causalInvocationIds: [...recovery.retryCausalInvocationIds],
                conversation: 'same_conversation', input: { kind: 'original' } });
            if (!mounted.current || !accountLifetime.isCurrent()) return;
            getStorage().getState().upsertWorkflowRuns([workflowRunRowFromSummary(result.run)], accountLifetime.scope);
            if (result.disposition === 'accepted') {
                getStorage().getState().upsertWorkflowRunInvocation({ scope: accountLifetime.scope, runId: run.id,
                    parentRevision: result.run.revision, invocation: result.invocation });
                setAccepted(true);
            } else setError(resolveWorkflowProblemPresentation(new WorkflowActionError({ message: result.disposition, rawCode: 'invalid_input' }), 'run'));
        } catch (failure) {
            if (failure instanceof WorkflowActionError && isActionApprovalDeclinedErrorCode(failure.rawCode)) return;
            if (mounted.current && accountLifetime.isCurrent()) setError(resolveWorkflowProblemPresentation(failure, 'run'));
        } finally {
            pendingRef.current = false;
            if (mounted.current) setPending(false);
        }
    }, [accountLifetime, actions, canEdit, mounted, opened.index.id, recovery.canRetrySameConversation,
        recovery.requiresUncertaintyAcknowledgement, recovery.retryCausalInvocationIds, run]);
    return { retry, pending, accepted, error,
        canRetry: canEdit && recovery.canRetrySameConversation && !recovery.requiresUncertaintyAcknowledgement };
}
