import { randomUUID } from '@/platform/randomUUID';
import { WORKFLOW_AUTHORING_ACTION_ID } from '@happier-dev/protocol/actions/workflowAuthoringActionIds';
import { WorkflowDraftMutationResultV1Schema } from '@happier-dev/protocol/actions/workflowAuthoringAction';
import { ActionApprovalRequestCreatedResultSchema, withActionAutomationNoticesV1, type ActionAutomationNoticeV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { WorkflowDefinitionV1 } from '@happier-dev/protocol/workflows/workflowV1';
import type { WorkflowIntendedTriggerV1 } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { callWorkflowAction, type WorkflowActionCallerContext, type WorkflowActionOperation } from '@/sync/domains/workflows/callWorkflowAction';
import { createWorkflowDefinition, updateWorkflowDefinition } from '@/sync/domains/workflows/workflowDefinitionActions';
import type { WorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';
import { workflowEditorSnapshotsEqual } from './useWorkflowEditorHistory';

export type WorkflowEditorSavedRevision = Pick<Awaited<ReturnType<typeof createWorkflowDefinition>>, 'definitionId' | 'revision'>;
export type PendingWorkflowDefinitionCreate = Readonly<{
    input: Pick<Parameters<typeof createWorkflowDefinition>[0], 'definitionId' | 'definition' | 'metadata' | 'intendedTriggers'>;
    draft: WorkflowEditorDraft;
    description: string;
}>;

export function parseMountedWorkflowDraftMutation(value: unknown) {
    const mutation = WorkflowDraftMutationResultV1Schema.safeParse(value);
    return mutation.success ? mutation.data : ActionApprovalRequestCreatedResultSchema.parse(value);
}

export async function saveMountedWorkflowDraft(accountLifetime: ServerAccountScopeLifetime, draftId: string, operation?: WorkflowActionOperation) {
    const notices: ActionAutomationNoticeV1[] = [];
    const frontDoor = createFrontDoorActionExecute(undefined, {
        onWorkflowDraftChildSettled: result => notices.push(...(result.automationNotices ?? [])),
    });
    // Both the draft and its children report through the existing notice owner.
    const execute = Object.assign(async (...args: Parameters<typeof frontDoor>) =>
        withActionAutomationNoticesV1(await frontDoor(...args), notices), frontDoor);
    return await callWorkflowAction({ actionId: WORKFLOW_AUTHORING_ACTION_ID.draftSave,
        input: { scope: accountLifetime.scope, draftId }, accountLifetime, execute, ...operation,
        parseResult: parseMountedWorkflowDraftMutation });
}

/** The editor and the in-place sentence retain the same create bytes until acknowledged. */
export async function saveWorkflowEditorDefinition(params: Readonly<{
    draft: WorkflowEditorDraft;
    description: string;
    definition: WorkflowDefinitionV1;
    intendedTriggers?: readonly WorkflowIntendedTriggerV1[];
    saved: WorkflowEditorSavedRevision | null;
    baseline: Readonly<{ draft: WorkflowEditorDraft | null; description: string }>;
    pendingCreate: PendingWorkflowDefinitionCreate | null;
    retainCreate: (pending: PendingWorkflowDefinitionCreate | null) => void;
    copying?: boolean;
    accountLifetime: ServerAccountScopeLifetime;
    caller?: WorkflowActionCallerContext;
    operation?: WorkflowActionOperation;
    isCurrent: () => boolean;
    acknowledge: (result: Awaited<ReturnType<typeof createWorkflowDefinition>>, draft: WorkflowEditorDraft,
        description: string, kind: 'created' | 'updated') => void;
}>): Promise<WorkflowEditorSavedRevision | null> {
    const { draft, description, definition, accountLifetime, caller } = params;
    const trimmedDescription = description.trim();
    const metadata = { title: draft.name.trim(),
        ...(trimmedDescription.length === 0 ? {} : { description: trimmedDescription }),
        ...(draft.captureProvenance === undefined ? {} : { captureProvenance: draft.captureProvenance }) };
    const intended = params.intendedTriggers === undefined ? {} : { intendedTriggers: params.intendedTriggers };
    const options = { accountLifetime, ...(caller === undefined ? {} : { context: caller, signal: caller.signal }), ...params.operation };
    let saved = params.saved;
    let baseline = params.baseline;
    if (params.copying || saved === null || params.pendingCreate !== null) {
        const retained = params.pendingCreate ?? { input: { definitionId: randomUUID(), definition, metadata, ...intended }, draft, description };
        params.retainCreate(retained);
        const result = await createWorkflowDefinition({ ...retained.input, ...options });
        if (!params.isCurrent()) return null;
        saved = { definitionId: result.definitionId, revision: result.revision };
        baseline = { draft: retained.draft, description: retained.description };
        params.acknowledge(result, retained.draft, retained.description, 'created');
        params.retainCreate(null);
    }
    // Later edits use the ordinary revision writer after rejoining the retained create.
    if (saved !== null && (!workflowEditorSnapshotsEqual(draft, baseline.draft) || description !== baseline.description)) {
        const result = await updateWorkflowDefinition({ definitionId: saved.definitionId, expectedRevision: saved.revision,
            definition, metadata, ...intended, ...options });
        if (!params.isCurrent()) return null;
        saved = { definitionId: result.definitionId, revision: result.revision };
        params.acknowledge(result, draft, description, 'updated');
    }
    return saved;
}
