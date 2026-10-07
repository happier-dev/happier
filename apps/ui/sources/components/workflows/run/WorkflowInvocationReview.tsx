import * as React from 'react';
import { View } from 'react-native';
import { WorkflowResultContractSchema, type WorkflowDefinitionV1 } from '@happier-dev/protocol/workflows/workflowV1';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { WorkflowProgressEnvelopeV1, WorkflowRunInvocationIndexV1, WorkflowRunSummaryV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import type { WorkflowRunAcceptedContextV1, WorkflowRunGetResultV1 } from '@happier-dev/protocol/workflows/actionsV1';
import { matchesWorkflowAcceptedDefinitionV1 } from '@happier-dev/protocol/workflows/workflowValidationV1';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { workflowRunDetailActions } from '@/sync/domains/workflows/workflowRunDetailActions';
import { buildWorkflowPlanReviewSeed, deriveWorkflowPlanRunId, readWorkflowPlanResult,
    validateWorkflowPlanProposal } from '@/sync/domains/workflows/workflowPlanReview';
import type { WorkflowReviewedRunSeed } from '@/sync/domains/workflows/workflowReviewedRunSeed';
import { Text } from '@/components/ui/text/Text';
import { resolveWorkflowProblemPresentation } from '../presentation/workflowProblemPresentation';
import { WorkflowFlowView } from '../flow/WorkflowFlowView';
import { projectWorkflowFlow } from '../flow/workflowFlowProjection';
import { t } from '@/text';
import { useMountedRef } from '@/hooks/ui/useMountedRef';
import { requiresUncertainPriorEffectsAcknowledgement } from './workflowRunDetailPresentation';
import { WorkflowReviewCard, decodeWorkflowReviewDraft, type WorkflowReviewChoice,
    type WorkflowReviewDraft, type WorkflowReviewReading } from './WorkflowReviewCard';

export type WorkflowInvocationReviewBuffers = Readonly<{
    drafts: Map<string, WorkflowReviewDraft>;
    readings: Map<string, WorkflowReviewReading>;
}>;

/** The selected exact-attempt UI owner. Typing stays here, not in the run/flow host. */
export function WorkflowInvocationReview(props: Readonly<{
    run: WorkflowRunSummaryV1;
    callerAccess: WorkflowRunGetResultV1['callerAccess'];
    acceptedContext: WorkflowRunAcceptedContextV1;
    invocation: WorkflowRunInvocationIndexV1;
    progress: WorkflowProgressEnvelopeV1;
    contentRevision: string;
    buffers: WorkflowInvocationReviewBuffers;
    active: boolean;
    confirmed: boolean;
    compact: boolean;
    viewerAccountId: string | null;
    current: () => boolean;
    onSettled: (run: WorkflowRunSummaryV1) => void;
    onOpenDraft: (seed: WorkflowReviewedRunSeed) => void;
    onOpenRun: (runId: string) => void;
    onDiscuss?: () => void;
    machineName?: string | null;
    machineReachable?: boolean;
    acknowledgeUncertainPriorEffects?: Readonly<{ recordId: string; contentRevision: string }>;
}>): React.ReactElement {
    const { invocation, progress, buffers } = props;
    const mounted = useMountedRef();
    const [draft, setDraft] = React.useState(() => buffers.drafts.get(invocation.id));
    const [reading, setReading] = React.useState<WorkflowReviewReading>(() => buffers.readings.get(invocation.id)
        ?? { value: progress.result, revision: props.contentRevision });
    React.useEffect(() => { buffers.readings.set(invocation.id, reading); }, [buffers, invocation.id, reading]);
    const contractResult = React.useMemo(() => WorkflowResultContractSchema.safeParse(progress.resultContract), [progress.resultContract]);
    const contract = contractResult.success ? contractResult.data : undefined;
    const shown = React.useMemo(() => draft ? decodeWorkflowReviewDraft(draft.text, contract) : reading.value, [contract, draft, reading]);
    const plan = contract?.kind === 'json' && progress.blockKind !== 'wait' && shown !== undefined ? readWorkflowPlanResult(shown) : null;
    const [validated, setValidated] = React.useState<Readonly<{ value: JsonValue; proposal: WorkflowDefinitionV1 | null }> | null>(null);
    const proposal = validated !== null && validated.value === shown ? validated.proposal : null;
    const uncertaintyAcknowledgementRequired = requiresUncertainPriorEffectsAcknowledgement({ invocation, progress });
    const uncertaintyAcknowledged = props.acknowledgeUncertainPriorEffects?.recordId === invocation.id
        && props.acknowledgeUncertainPriorEffects.contentRevision === props.contentRevision;
    const canGenerate = progress.blockKind === 'step' && (!uncertaintyAcknowledgementRequired || uncertaintyAcknowledged);
    const proposalMap = React.useMemo(() => proposal ? projectWorkflowFlow(proposal) : null, [proposal]);
    const resultSource = progress.review?.resultSource;
    const resultSourceLabel = resultSource?.kind === 'human'
        ? t(resultSource.accountId === props.viewerAccountId ? 'workflows.review.editedByYou' : 'workflows.review.editedByPerson')
        : resultSource?.kind === 'published'
            ? t(resultSource.by === 'agent' ? 'workflows.review.publishedByAgent' : 'workflows.review.publishedByYou') : undefined;
    const [recoveredPlanRun, setRecoveredPlanRun] = React.useState<Readonly<{
        id: string; parentRunId: string; invocationId: string; authoredDefinition: WorkflowDefinitionV1;
    }> | null>(null);
    const recovered = recoveredPlanRun?.parentRunId === props.run.id && recoveredPlanRun.invocationId === invocation.id
        ? recoveredPlanRun : null;
    const matchesRecoveredProposal = React.useMemo(() => proposal !== null && recovered !== null
        && matchesWorkflowAcceptedDefinitionV1(recovered.authoredDefinition, proposal), [proposal, recovered]);
    const startedPlanRunId = matchesRecoveredProposal ? recovered!.id : null;
    const earlierPlanRunId = recovered && proposal && !startedPlanRunId ? recovered.id : null;
    const [pending, setPending] = React.useState(false);
    const busy = React.useRef(false);
    const [error, setError] = React.useState<string | null>(null);

    React.useEffect(() => {
        if (!props.active || plan === null || shown === undefined) return;
        const controller = new AbortController();
        let current = true;
        void validateWorkflowPlanProposal(shown, controller.signal).then((definition) => {
            if (current && props.current()) setValidated({ value: shown, proposal: definition });
        }).catch((cause: unknown) => {
            if (current && props.current()) setError(resolveWorkflowProblemPresentation(cause).message);
        });
        return () => { current = false; controller.abort(); };
    }, [props.active, props.current, plan !== null, shown]);

    const isPlan = plan !== null;
    React.useEffect(() => {
        if (!props.active || !isPlan || !proposal || invocation.lifecycle === 'superseded') return;
        const controller = new AbortController();
        let current = true;
        const baseId = deriveWorkflowPlanRunId(props.run.id, invocation.id);
        void (async () => {
            const first = await workflowRunDetailActions.getRun(baseId, controller.signal);
            if (!current || !props.current()) return;
            setRecoveredPlanRun({ id: first.run.id, parentRunId: props.run.id, invocationId: invocation.id,
                authoredDefinition: first.authoredDefinition });
            if (matchesWorkflowAcceptedDefinitionV1(first.authoredDefinition, proposal)) return;
            // A changed proposal uses its own deterministic admission id. Recover
            // that exact admission too if its response was lost, without a history scan.
            const id = deriveWorkflowPlanRunId(props.run.id, invocation.id, proposal);
            const next = await workflowRunDetailActions.getRun(id, controller.signal);
            if (current && props.current() && matchesWorkflowAcceptedDefinitionV1(next.authoredDefinition, proposal)) {
                setRecoveredPlanRun({ id: next.run.id, parentRunId: props.run.id, invocationId: invocation.id,
                    authoredDefinition: next.authoredDefinition });
            }
        })().catch(() => { /* An unavailable exact read is not evidence that admission never happened. */ });
        return () => { current = false; controller.abort(); };
    }, [props.active, props.current, isPlan, invocation.id, props.run.id, proposal]);

    const perform = async (operation: (current: () => boolean) => Promise<void>) => {
        if (busy.current || !props.callerAccess.canEdit || !props.active || !props.confirmed || !props.current()) return;
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) return;
        const current = () => mounted.current && lifetime.isCurrent() && props.current();
        busy.current = true;
        setPending(true);
        setError(null);
        try { await operation(current); }
        catch (cause) { if (current()) setError(resolveWorkflowProblemPresentation(cause).message); }
        finally { busy.current = false; if (current()) setPending(false); }
    };
    const complete = async (choice: WorkflowReviewChoice) => perform(async (current) => {
        if (choice.mode === 'generate' && (!canGenerate || (uncertaintyAcknowledgementRequired
            && props.acknowledgeUncertainPriorEffects?.contentRevision !== choice.expectedContentRevision))) return;
        const result = await workflowRunDetailActions.completeReview({ runId: props.run.id,
            invocation: { recordId: invocation.id }, ...choice,
            ...(choice.mode === 'generate' && uncertaintyAcknowledgementRequired ? { acknowledgeUncertainPriorEffects: true as const } : {}),
            ...(choice.mode === 'use_result' && startedPlanRunId ? { followUp: { kind: 'run_started' as const, runId: startedPlanRunId } } : {}),
        });
        if (current()) props.onSettled(result.run);
    });
    const editPlan = async (value: JsonValue, revision: string) => perform(async (current) => {
        const seed = buildWorkflowPlanReviewSeed({ value, proposal, run: props.run, acceptedContext: props.acceptedContext });
        if (invocation.lifecycle !== 'completed') {
            const result = await workflowRunDetailActions.completeReview({ runId: props.run.id, invocation: { recordId: invocation.id },
                expectedContentRevision: revision, mode: 'use_result', value, followUp: { kind: 'editing' } });
            if (!current()) return;
            props.onSettled(result.run);
        }
        if (current()) props.onOpenDraft(seed);
    });
    const runPlan = async (value: JsonValue, revision: string) => {
        if (!proposal || busy.current || !props.callerAccess.canEdit || !props.active || !props.confirmed || !props.current()) return;
        props.onOpenDraft({ ...buildWorkflowPlanReviewSeed({ value, proposal, run: props.run, acceptedContext: props.acceptedContext }),
            planReview: { invocationId: invocation.id, expectedContentRevision: revision, value,
                ...(earlierPlanRunId ? { runId: deriveWorkflowPlanRunId(props.run.id, invocation.id, proposal) } : {}),
                completeReview: invocation.lifecycle !== 'completed',
                ...(props.run.origin.originSessionId ? { originSessionId: props.run.origin.originSessionId } : {}) } });
    };
    return <View style={props.compact ? { flex: 1, minHeight: 0 } : undefined}>
        <WorkflowReviewCard progress={progress} contract={contract} waitForYou={progress.blockKind === 'wait'}
            contentRevision={props.contentRevision} lifecycle={invocation.lifecycle} isCurrent={invocation.lifecycle !== 'superseded'}
            reading={reading} onChangeReading={(next) => { buffers.readings.set(invocation.id, next); setReading(next); }}
            draft={draft} onChangeDraft={(next) => {
                if (next) buffers.drafts.set(invocation.id, next); else buffers.drafts.delete(invocation.id);
                setDraft(next);
            }} onComplete={complete} onDiscuss={props.onDiscuss} onEditPlan={editPlan} onRunPlan={runPlan}
            startedPlanRunId={startedPlanRunId} earlierPlanRunId={earlierPlanRunId}
            onOpenPlanRun={props.onOpenRun} planProposalValid={proposal !== null}
            resultSourceLabel={resultSourceLabel}
            planProposalPreview={proposalMap ? <WorkflowFlowView projection={proposalMap} selectedNodeId={null} density="compact" /> : undefined}
            canGenerate={canGenerate} primaryActionPlacement={props.compact ? 'footer' : 'inline'}
            pending={pending} readOnly={!props.callerAccess.canEdit || !props.confirmed || !props.current() || invocation.lifecycle === 'superseded'
                || (progress.resultContract !== undefined && !contractResult.success)}
            parentPaused={props.run.state === 'paused' || props.run.state === 'pause_requested'}
            machineName={props.machineName} machineReachable={props.machineReachable} />
        {error ? <Text accessibilityRole="alert" testID="workflow-review-action-error">{error}</Text> : null}
    </View>;
}
