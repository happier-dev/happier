import * as React from 'react';
import type { ReviewArtifactV1 } from '@happier-dev/protocol/reviews/reviewArtifactV1';
import { resolveReviewRunContinuityV1 } from '@happier-dev/protocol/reviews/reviewRoundActionsV1';
import { prepareWorkflowRunStartV1, type WorkflowReviewNewRoundReviewerV1 } from '@happier-dev/protocol/workflows/workflowStartPreparationV1';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import type { ServerAccountScope, ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { resolveActionExecutionErrorMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { t } from '@/text';
import { Modal } from '@/modal';
import type { CustomModalInjectedProps } from '@/modal/types';
import { useExecutionRunHeaders } from '@/hooks/session/useExecutionRunHeaders';
import type { ExecutionRunHeaderReference } from '@/sync/runtime/executionRuns/executionRunHeaderReads';
import { resolveExecutionRunBackendLabel, resolveExecutionRunAgentMarkId } from '@/components/sessions/runs/resolveExecutionRunBackendLabel';
import { ExecutionRunAgentMark } from '@/components/sessions/runs/ExecutionRunAgentMark';
import { resolveExecutionRunTitle } from '@/components/sessions/runs/resolveExecutionRunTitle';
import { useUnistyles } from 'react-native-unistyles';
import { createWorkflowRunDetailActions } from '@/sync/domains/workflows/workflowRunDetailActions';
import { useExecutableParticipantLabels } from '@/components/sessions/authoring/useExecutableParticipantLabel';
import { useSharePrincipalNames } from '@/components/sharing/sharePrincipalNames';
import { presentSharePrincipal, sharePrincipalKey } from '@/components/sharing/sharePrincipalPresentation';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { resolveBundledAgentIdFromContributionIdentity } from '@/agents/catalog/catalog';

import { ReviewNewRoundDialog, showReviewNewRoundDialog, type ReviewNewRoundReviewer, type ReviewNewRoundStart } from './ReviewNewRoundDialog';

type Round = ReviewArtifactV1['rounds'][number];
type NativeRef = Extract<Round['runs'][number], { kind: 'execution' }>;
type Execution = ReturnType<typeof useMountedActionExecution>;
type WorkflowPreview = Readonly<{ kind: 'loading' } | { kind: 'failed'; message: string }
    | { kind: 'ready'; machineId: string; reviewers: readonly WorkflowReviewNewRoundReviewerV1[] }>;

/** The accepted Workflow owns the repeat roster and a single replay, including every executable leaf. */
function WorkflowReviewNewRoundDialog(props: CustomModalInjectedProps & Readonly<{
    previousRound: number; runId: string; lifetime: ServerAccountScopeLifetime; execute: Execution['execute'];
}>) {
    const [preview, setPreview] = React.useState<WorkflowPreview>({ kind: 'loading' });
    const [attempt, retry] = React.useReducer(value => value + 1, 0);
    React.useEffect(() => {
        const controller = new AbortController();
        setPreview({ kind: 'loading' });
        void createWorkflowRunDetailActions({ accountLifetime: props.lifetime }).getRun(props.runId, controller.signal)
            .then(opened => {
                const prepared = prepareWorkflowRunStartV1({ definition: opened.authoredDefinition,
                    acceptedContext: opened.acceptedContext, replay: { runId: props.runId, intent: 'another_round' } });
                if (!controller.signal.aborted) setPreview(prepared.reviewReviewers ? { kind: 'ready', machineId: opened.run.machineId,
                    reviewers: prepared.reviewReviewers }
                    : { kind: 'failed', message: t('common.unavailable') });
            }).catch(error => {
                if (!controller.signal.aborted) setPreview({ kind: 'failed',
                    message: resolveActionExecutionErrorMessage(error, t('common.error')) });
            });
        return () => controller.abort();
    }, [attempt, props.lifetime, props.runId]);
    const selected = React.useMemo(() => preview.kind === 'ready' ? preview.reviewers.map(row => row.reviewer) : [], [preview]);
    const labels = useExecutableParticipantLabels(selected, props.lifetime.scope.serverId);
    const principals = React.useMemo(() => selected.flatMap(reviewer => reviewer.kind === 'person' ? [reviewer.principal] : []), [selected]);
    const { names } = useSharePrincipalNames(principals.length > 0 ? principals : null, props.lifetime.scope.serverId);
    const reviewers = preview.kind !== 'ready' ? [] : preview.reviewers.map((row, index): ReviewNewRoundReviewer => {
        const reviewer = row.reviewer;
        if (reviewer.kind === 'person') {
            const presented = presentSharePrincipal({ ref: reviewer.principal,
                name: names?.get(sharePrincipalKey(reviewer.principal)) ?? null, viewerAccountId: props.lifetime.scope.accountId });
            return { id: row.id, label: reviewer.principal.kind === 'account' && reviewer.principal.accountId === props.lifetime.scope.accountId
                ? t('reviewWalkthrough.detail.you') : presented.displayName,
                mark: presented.avatar ? <Avatar id={presented.avatar.id} imageUrl={presented.avatar.imageUrl ?? null} size={18} /> : null,
                continuity: row.continuity, required: reviewer.required };
        }
        return { id: row.id, label: labels[index] ?? (reviewer.kind === 'engine' ? reviewer.engineId : t('runPage.intentTitles.review')),
            mark: reviewer.kind === 'model' ? <ExecutionRunAgentMark size={18}
                agentId={resolveBundledAgentIdFromContributionIdentity(reviewer.launch.agentTarget.identity)} /> : null,
            continuity: row.continuity };
    });
    return <ReviewNewRoundDialog {...props} reviewers={reviewers} ready={preview.kind === 'ready'} loading={preview.kind === 'loading'}
        reason={preview.kind === 'failed' ? preview.message : null} onRetry={preview.kind === 'failed' ? retry : undefined}
        onStart={async () => {
            if (preview.kind !== 'ready') return { ok: false, message: t('common.unavailable') };
            const result = await props.execute('review.new_round', { runId: props.runId }, {
                externalActionTarget: { kind: 'machine', machineId: preview.machineId } });
            return result.ok ? { ok: true } : { ok: false, message: resolveActionExecutionErrorMessage(result, t('common.error')) };
        }} />;
}

/** The sealed native reference demands only its own header, and only while confirmation is open. */
function NativeReviewNewRoundDialog(props: CustomModalInjectedProps & Readonly<{
    previousRound: number; reference: NativeRef; lifetime: ServerAccountScopeLifetime;
    execute: Execution['execute']; people: readonly ReviewNewRoundReviewer[];
}>) {
    const { theme } = useUnistyles();
    const [fresh, setFresh] = React.useState(false);
    const [continuationFailure, setContinuationFailure] = React.useState<string | null>(null);
    const [refresh, retry] = React.useReducer(value => value + 1, 0);
    const source = React.useMemo(() => props.reference.sessionId
        ? { kind: 'execution_run' as const, sessionId: props.reference.sessionId, runId: props.reference.runId }
        : { kind: 'execution_run' as const, machineId: props.reference.machineId, runId: props.reference.runId }, [props.reference]);
    const references = React.useMemo((): readonly ExecutionRunHeaderReference[] => [{ source, demanded: true,
        refreshKey: String(refresh) }], [refresh, source]);
    const headers = useExecutionRunHeaders(props.lifetime, references);
    const snapshot = headers.owner?.read(source);
    const run = snapshot?.run;
    const continuity = run ? resolveReviewRunContinuityV1(run, { kind: 'new_round', ...(fresh ? { fresh: true } : {}) }) : null;
    const continuationUnavailable = !fresh && continuationFailure !== null;
    const ready = Boolean(run && continuity?.ok && !continuationUnavailable && !snapshot?.loading && !snapshot?.failed && !snapshot?.unavailable);
    const reviewer: ReviewNewRoundReviewer | null = run ? { id: run.runId,
        label: resolveExecutionRunBackendLabel(run.backendTarget) ?? resolveExecutionRunTitle(run),
        mark: <ExecutionRunAgentMark agentId={resolveExecutionRunAgentMarkId(run.backendTarget, theme)} size={18} />,
        continuity: continuity?.ok && !continuationUnavailable ? continuity.continuity : 'unavailable' } : null;
    const onStart: ReviewNewRoundStart = async () => {
        const result = await props.execute('review.new_round', { runId: props.reference.runId,
            ...(props.reference.sessionId ? { sessionId: props.reference.sessionId } : { target: { kind: 'detached' } }),
            ...(fresh ? { fresh: true } : {}) }, props.reference.sessionId ? undefined : {
            executionRunTargetMachineId: props.reference.machineId });
        if (!result.ok && !fresh && (result.errorCode === 'review_follow_up_resume_unavailable'
            || result.errorCode === 'review_follow_up_ended' || result.errorCode === 'review_follow_up_not_resumable')) {
            setContinuationFailure(resolveActionExecutionErrorMessage(result, t('common.unavailable')));
        }
        return result.ok ? { ok: true } : { ok: false, message: resolveActionExecutionErrorMessage(result, t('common.error')) };
    };
    const failed = snapshot?.failed || snapshot?.unavailable;
    return <ReviewNewRoundDialog {...props} reviewers={reviewer ? [reviewer, ...props.people] : props.people}
        ready={ready} loading={snapshot?.loading ?? true} onStart={onStart}
        reason={continuationUnavailable ? continuationFailure : continuity && !continuity.ok ? resolveActionExecutionErrorMessage(continuity, t('common.unavailable'))
            : failed ? t('common.unavailable') : null}
        onFresh={(continuationUnavailable || continuity && !continuity.ok) && !failed ? () => setFresh(true) : undefined}
        onRetry={failed ? retry : undefined} />;
}

/** Repeat the opened Review through its public Action, retaining mounted approval and Account custody. */
export function useReviewNewRound(input: Readonly<{
    scope: ServerAccountScope | null;
    record: ReviewArtifactV1 | null;
    canEdit: boolean;
    people: readonly ReviewNewRoundReviewer[];
}>) {
    const execution = useMountedActionExecution(input.scope);
    const previous = input.record?.rounds.at(-1);
    const personOnly = previous?.runs.length === 0 && previous.reviewerIds.length === 0;
    const native = previous?.runs.find((run): run is NativeRef => run.kind === 'execution');
    const workflow = previous?.runs.find(run => run.kind === 'workflow');
    const available = input.canEdit && execution.ready && previous?.state !== 'running' && (personOnly || Boolean(native || workflow));
    const open = React.useCallback(() => {
        if (!available || !input.record || !previous) return;
        if (workflow && execution.binding) {
            Modal.show({ component: WorkflowReviewNewRoundDialog, props: { previousRound: previous.ordinal,
                runId: workflow.runId, lifetime: execution.binding, execute: execution.execute } });
            return;
        }
        if (native && execution.binding) {
            Modal.show({ component: NativeReviewNewRoundDialog, props: { previousRound: previous.ordinal,
                reference: native, lifetime: execution.binding, execute: execution.execute, people: input.people } });
            return;
        }
        showReviewNewRoundDialog({ previousRound: previous.ordinal, reviewers: input.people,
            onStart: async () => {
                const result = await execution.execute('review.new_round', { reviewId: input.record!.reviewId });
                return result.ok ? { ok: true } : { ok: false,
                    message: resolveActionExecutionErrorMessage(result, t('common.error')) };
            } });
    }, [available, execution.binding, execution.execute, input.people, input.record, native, previous, workflow]);
    return { available, open, approval: execution.approval };
}
