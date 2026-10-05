import { WorkflowConversationBindInputV1Schema, type ActionExecutorContext, type WorkflowConversationBindResultV1 } from '@happier-dev/protocol';
import { entityDragScopesEqualV1 } from '@happier-dev/protocol/plugins/ui';
import { bindWorkflowSessionConversation, type WorkflowSessionBindingContext } from '@/sync/domains/workflows/workflowAuthoringSessionBinding';
import type { WorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';

type BindingRequest = Readonly<{ input: unknown; signal?: AbortSignal }>;
export type WorkflowConversationBindingOwner = Readonly<{
    getContext: () => WorkflowSessionBindingContext;
    onChange: (draft: WorkflowEditorDraft) => void;
}>;

export function executeWorkflowConversationBinding(owner: WorkflowConversationBindingOwner, request: BindingRequest): WorkflowConversationBindResultV1 {
    const parsed = WorkflowConversationBindInputV1Schema.safeParse(request.input);
    if (!parsed.success) return { status: 'refused', reason: 'invalid_parameters' };
    if (request.signal?.aborted) return { status: 'refused', reason: 'cancelled' };
    const result = bindWorkflowSessionConversation(owner.getContext(), parsed.data);
    if (result.status === 'applied') owner.onChange(result.draft);
    return result.status === 'applied' ? { status: 'applied' } : result;
}

// Registration is only an answering-client address, never a second draft store or admission owner.
const mountedOwners = new Set<WorkflowConversationBindingOwner>();
export function registerWorkflowConversationBindingOwner(owner: WorkflowConversationBindingOwner): () => void {
    mountedOwners.add(owner);
    return () => { mountedOwners.delete(owner); };
}
export async function invokeWorkflowConversationBinding(request: BindingRequest & Readonly<{
    context: Pick<ActionExecutorContext, 'serverId' | 'runtimeAccountId'>;
}>): Promise<WorkflowConversationBindResultV1> {
    const parsed = WorkflowConversationBindInputV1Schema.safeParse(request.input);
    if (!parsed.success) return { status: 'refused', reason: 'invalid_parameters' };
    const { serverId, runtimeAccountId: accountId } = request.context;
    if (!serverId || !accountId) return { status: 'unavailable' };
    if (!entityDragScopesEqualV1({ serverId, accountId }, parsed.data.scope)) {
        return { status: 'refused', reason: 'workflow_binding_scope_mismatch' };
    }
    const matches = [...mountedOwners].filter(owner => {
        const context = owner.getContext();
        return context.scope && entityDragScopesEqualV1(context.scope, parsed.data.scope) && context.draft.draftId === parsed.data.draftId;
    });
    if (matches.length !== 1) return { status: 'unavailable' };
    return executeWorkflowConversationBinding(matches[0], request);
}
