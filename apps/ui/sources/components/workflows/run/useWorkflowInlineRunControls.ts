import * as React from 'react';
import type { WorkflowRunAcceptedContextV1, WorkflowRunStartResultV1 } from '@happier-dev/protocol/workflows/actionsV1';
import type { WorkflowDefinitionV1 } from '@happier-dev/protocol/workflows/workflowV1';
import type { WorkflowRunSummaryV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { prepareWorkflowRunStartV1 } from '@happier-dev/protocol/workflows';
import { canStartWorkflowAnotherRound, describeWorkflowRunState, isWorkflowRunStopPending } from '../presentation/workflowLifecyclePresentation';
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
    /** Private authored fact from the opened list owner; never inferred from a title or pattern id. */
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
    const mounted = useMountedRef();
    const [pendingControl, setPendingControl] = React.useState<'pause' | 'cancel' | null>(null);
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
    const submitControl = React.useCallback(async (kind: 'pause' | 'cancel') => {
        if (!canEdit || !accountLifetime.isCurrent() || pendingControlRef.current !== null) return;
        const token = {};
        pendingControlRef.current = token;
        setPendingControl(kind);
        setControlError(null);
        const owns = () => mounted.current && pendingControlRef.current === token && accountLifetime.isCurrent();
        try {
            const current = getStorage().getState().workflowRunsById[workflowRunStoreKey(run.id, accountLifetime.scope)]?.summary ?? run;
            const input = { runId: run.id, expectedRevision: current.revision };
            const result = await (kind === 'pause' ? actions.pauseRun(input) : actions.cancelRun(input));
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
    const anotherRound = React.useCallback(async () => {
        if (!accountLifetime.isCurrent() || !canStartWorkflowAnotherRound({ run, definition, canEdit, cancelRequested,
            supportsAnotherRound, hasAcceptedContext: acceptedContext !== null || supportsAnotherRound === true })) return;
        const admitted = await start.runNow({
            prepareRequest: async () => {
                // Pressing Another round is deliberate detail demand. Reloaded timelines never open
                // full invocation history merely to decide whether to draw this action.
                const detail = definition && acceptedContext ? { run, definition, acceptedContext } : await actions.getRun(run.id);
                if (!accountLifetime.isCurrent() || !canStartWorkflowAnotherRound({ run: detail.run,
                    definition: detail.definition, canEdit, cancelRequested, hasAcceptedContext: true })) {
                    throw new WorkflowActionError({ message: 'invalid_input', rawCode: 'invalid_input' });
                }
                const prepared = prepareWorkflowRunStartV1({ definition: detail.definition, acceptedContext: detail.acceptedContext,
                    replay: { runId: run.id, intent: 'another_round' } });
                return { ...prepared, ...(prepared.project ? { project: projectAcceptedWorkflowRunTarget(prepared.project) } : {}) };
            }, refusal: 'inline',
            isInvocationCurrent: () => mounted.current && accountLifetime.isCurrent() });
        if (admitted && mounted.current && accountLifetime.isCurrent()) onStartedRef.current(admitted);
    }, [acceptedContext, accountLifetime, actions, canEdit, cancelRequested, definition, mounted, run, start, supportsAnotherRound]);
    return {
        lifecycle: describeWorkflowRunState(params.run.state, { workflowCustodyState: params.run.workflowCustodyState,
            cancelRequested, inAttentionWindow: params.run.attentionRequired }),
        progress: describeWorkflowRunProgress(params.run.stepProgress),
        availability: params.run.availability,
        actions,
        submitControl,
        pendingControl,
        controlError,
        cancelRequested,
        anotherRound: canStartWorkflowAnotherRound({ ...params,
            hasAcceptedContext: params.acceptedContext !== null || supportsAnotherRound === true }) ? anotherRound : null,
        start,
    };
}
