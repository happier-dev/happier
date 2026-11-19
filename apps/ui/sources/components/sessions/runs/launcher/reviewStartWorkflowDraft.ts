import { ReviewStartInputSchema } from '@happier-dev/protocol/reviews/reviewStart';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { updateWorkflowBlock } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import type { WorkflowActionFieldBindingV1 } from '@happier-dev/protocol/workflows/workflowV1';

import { randomUUID } from '@/platform/randomUUID';
import { createWorkflowEditorDraft, insertWorkflowEditorBlock } from '@/sync/domains/workflows/workflowEditorDraft';
import type { WorkflowDefinitionDraftSeed } from '@/sync/domains/workflows/workflowDefinitionDraftSeed';

import { compileReviewLauncherInput } from './reviewLauncherSelection';

/** Keep the current recipe as one editable Action; runtime admission still owns its execution graph. */
export function buildReviewStartWorkflowDraftSeed(params: Readonly<{
    input: Record<string, unknown>;
    instructions: string;
    sourceSession: Readonly<{ serverId: string; sessionId: string }> | null;
    name: string;
    project: WorkflowDefinitionDraftSeed['project'];
    executionTarget: NonNullable<WorkflowDefinitionDraftSeed['executionTarget']>;
}>): WorkflowDefinitionDraftSeed {
    const { sessionId: _sessionId, sourceSession, ...input } = ReviewStartInputSchema.parse(
        compileReviewLauncherInput(params.input, params.instructions, params.sourceSession));
    const bindings: Record<string, WorkflowActionFieldBindingV1> = {};
    // Workflow Reviews execute against the admitted workspace; a source Session is an input, never placement.
    for (const [key, value] of Object.entries({ ...input, target: { kind: 'detached' } })) {
        if (value !== undefined) bindings[key] = { kind: 'literal', value: projectNativeJsonValueForTransport(value) };
    }
    if (sourceSession) bindings.sourceSession = { kind: 'input', name: 'sourceSession' };
    const initialDraft = createWorkflowEditorDraft({ draftId: randomUUID(), name: params.name, blocks: [] });
    const inserted = insertWorkflowEditorBlock({ ...initialDraft, inputs: sourceSession ? [{ name: 'sourceSession',
        valueType: 'json', required: true, inputType: { hostType: 'session' }, defaultFrom: 'origin_session' }] : [] }, {
        request: { kind: 'action', actionId: 'review.start' }, list: { kind: 'root' },
    });
    const draft = updateWorkflowBlock(inserted.draft, inserted.block.id, block => block.kind === 'action'
        ? { ...block, input: bindings } : block);
    return { name: params.name, draft, ...(sourceSession ? { inputValues: { sourceSession } } : {}), executionTarget: params.executionTarget, ...(params.project ? { project: params.project } : {}) };
}
