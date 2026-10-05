import type { JsonValue, WorkflowDefinitionV1, WorkflowInvocationCompleteReviewResultV1, WorkflowRunAcceptedContextV1, WorkflowRunStartResultV1, WorkflowRunSummaryV1 } from '@happier-dev/protocol';
import { deriveWorkflowPlanRunIdV1 } from '@happier-dev/protocol/workflows';
import { WorkflowActionInputSchemasV1, WorkflowActionOutputSchemasV1 } from '@happier-dev/protocol/workflows/actionsV1';
import { setWorkflowStepText } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import { WorkflowDefinitionV1Schema } from '@happier-dev/protocol/workflows/workflowV1';

import { callWorkflowAction } from './callWorkflowAction';
import { buildWorkflowDefinitionCandidate } from './workflowAuthoring';
import { workflowDefinitionPromptTitle } from './workflowBlockLabel';
import { createWorkflowEditorDraft } from './workflowEditorDraft';
import type { WorkflowReviewedRunSeed } from './workflowReviewedRunSeed';
import type { WorkflowRunDetailActions } from './workflowRunDetailActions';

export async function startWorkflowPlanReview(params: Readonly<{
    runId: string;
    planRunId?: string;
    invocationId: string;
    expectedContentRevision: string;
    value: JsonValue;
}>, dependencies: Readonly<{
    start: (runId: string) => Promise<WorkflowRunStartResultV1 | null>;
    completeReview: WorkflowRunDetailActions['completeReview'];
}>): Promise<Readonly<{ started: WorkflowRunStartResultV1; review: WorkflowInvocationCompleteReviewResultV1 }> | null> {
    const started = await dependencies.start(params.planRunId ?? deriveWorkflowPlanRunId(params.runId, params.invocationId));
    if (started === null) return null;
    const review = await dependencies.completeReview({
        runId: params.runId,
        invocation: { recordId: params.invocationId },
        expectedContentRevision: params.expectedContentRevision,
        mode: 'use_result',
        value: params.value,
        followUp: { kind: 'run_started', runId: started.run.id },
    });
    return { started, review };
}

export function deriveWorkflowPlanRunId(runId: string, invocationId: string, normalizedProposal?: WorkflowDefinitionV1): string {
    return deriveWorkflowPlanRunIdV1(runId, invocationId, normalizedProposal);
}

export function readWorkflowPlanResult(value: JsonValue): Readonly<{ document: string; proposal?: JsonValue }> | null {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Readonly<{ [key: string]: JsonValue }>;
    if (typeof record.document !== 'string') return null;
    return {
        document: record.document,
        ...(record.proposal === undefined ? {} : { proposal: record.proposal }),
    };
}

export async function validateWorkflowPlanProposal(value: JsonValue, signal?: AbortSignal): Promise<WorkflowDefinitionV1 | null> {
    const plan = readWorkflowPlanResult(value);
    if (plan?.proposal === undefined) return null;
    const request = WorkflowActionInputSchemasV1['workflow.validate'].safeParse({ definition: plan.proposal });
    if (!request.success) return null;
    const result = await callWorkflowAction({
        actionId: 'workflow.validate',
        input: request.data,
        parseResult: (response) => WorkflowActionOutputSchemasV1['workflow.validate'].parse(response),
        signal,
    });
    return result.valid ? result.normalizedDefinition ?? null : null;
}

export function buildWorkflowPlanReviewSeed(params: Readonly<{
    value: JsonValue;
    proposal: WorkflowDefinitionV1 | null;
    run: WorkflowRunSummaryV1;
    acceptedContext: WorkflowRunAcceptedContextV1;
}>): WorkflowReviewedRunSeed {
    const plan = readWorkflowPlanResult(params.value);
    if (plan === null) throw new TypeError('Plan result requires a document');
    let definition = params.proposal;
    if (definition === null) {
        const draft = createWorkflowEditorDraft({ draftId: params.run.id });
        const step = draft.blocks[0];
        const documentDraft = setWorkflowStepText(draft, step.id, plan.document);
        definition = WorkflowDefinitionV1Schema.parse(buildWorkflowDefinitionCandidate(documentDraft));
    }
    return {
        name: workflowDefinitionPromptTitle(definition) ?? '',
        project: params.acceptedContext.workspaceTarget.project,
        definition,
        executionTarget: params.acceptedContext.executionTarget,
        inputs: {},
        sourceRunId: params.run.id,
    };
}
