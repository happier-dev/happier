import type { WorkflowConversationBindInputV1 } from '@happier-dev/protocol';
import type { EntityDragScopeV1 } from '@happier-dev/protocol/plugins/ui';
import { entityDragScopesEqualV1 } from '@happier-dev/protocol/plugins/ui';
import { findWorkflowBlock, setWorkflowDefaultField, setWorkflowStepExecutionField } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import type { WorkflowExistingSessionOption } from './workflowAuthoring';
import type { WorkflowEditorDraft } from './workflowEditorDraft';

export type WorkflowSessionBindingContext = Readonly<{
    scope: EntityDragScopeV1 | null;
    draft: WorkflowEditorDraft;
    editable: boolean;
    whereMachineId: string | null;
    candidates: readonly WorkflowExistingSessionOption[];
}>;
export type WorkflowSessionBindingRefusal = 'workflow_binding_scope_mismatch' | 'workflow_draft_unavailable'
    | 'workflow_draft_read_only' | 'workflow_step_unavailable' | 'workflow_session_unavailable' | 'workflow_where_machine_mismatch';
export type WorkflowSessionBindingAdmission = Readonly<{ status: 'allowed'; option: WorkflowExistingSessionOption }>
    | Readonly<{ status: 'refused'; reason: WorkflowSessionBindingRefusal }>;

/** Candidacy is supplied by its current host projection; references never select another Home's facts. */
export function resolveWorkflowSessionBinding(context: WorkflowSessionBindingContext, request: WorkflowConversationBindInputV1): WorkflowSessionBindingAdmission {
    if (!context.scope || !entityDragScopesEqualV1(context.scope, request.scope) || request.address.serverId !== context.scope.serverId) {
        return { status: 'refused', reason: 'workflow_binding_scope_mismatch' };
    }
    if (context.draft.draftId !== request.draftId) return { status: 'refused', reason: 'workflow_draft_unavailable' };
    if (!context.editable) return { status: 'refused', reason: 'workflow_draft_read_only' };
    if (request.stepId !== null && findWorkflowBlock(context.draft, request.stepId)?.kind !== 'step') {
        return { status: 'refused', reason: 'workflow_step_unavailable' };
    }
    const option = context.candidates.find(candidate => candidate.sessionId === request.address.sessionId);
    if (!option) return { status: 'refused', reason: 'workflow_session_unavailable' };
    if (context.whereMachineId !== null && option.machineId !== context.whereMachineId) {
        return { status: 'refused', reason: 'workflow_where_machine_mismatch' };
    }
    return { status: 'allowed', option };
}

/** Pointer, picker and agent all author this same field, leaving prompt, inputs and execution untouched. */
export function bindWorkflowSessionConversation(context: WorkflowSessionBindingContext, request: WorkflowConversationBindInputV1) {
    const admission = resolveWorkflowSessionBinding(context, request);
    if (admission.status === 'refused') return admission;
    const conversation = { kind: 'existing_session' as const, sessionId: admission.option.sessionId, machineId: admission.option.machineId };
    const block = request.stepId === null ? null : findWorkflowBlock(context.draft, request.stepId);
    const current = request.stepId === null ? context.draft.defaults.conversation
        : block?.kind === 'step' ? block.execution?.conversation : undefined;
    if (current?.kind === 'existing_session' && current.sessionId === conversation.sessionId && current.machineId === conversation.machineId) {
        return { status: 'unchanged' as const };
    }
    const draft = request.stepId === null ? setWorkflowDefaultField(context.draft, 'conversation', conversation)
        : setWorkflowStepExecutionField(context.draft, request.stepId, 'conversation', conversation);
    return { status: 'applied' as const, draft };
}
