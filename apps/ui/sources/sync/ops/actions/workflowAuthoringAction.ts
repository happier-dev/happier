import { WORKFLOW_AUTHORING_ACTION_SPECS, WorkflowConversationBindInputV1Schema,
    type WorkflowConversationBindResultV1, type WorkflowAuthoringActionId, type WorkflowMountedDraftV1,
    type WorkflowDraftMutationResultV1, type WorkflowDraftGetResultV1 } from '@happier-dev/protocol/actions/workflowAuthoringAction';
import { entityDragScopesEqualV1, type EntityDragScopeV1 } from '@happier-dev/protocol/plugins/ui';
import { bindWorkflowSessionConversation, type WorkflowSessionBindingContext } from '@/sync/domains/workflows/workflowAuthoringSessionBinding';
import type { WorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';
import type { WorkflowActionCallerContext } from '@/sync/domains/workflows/callWorkflowAction';

type BindingRequest = Readonly<{ input: unknown; signal?: AbortSignal }>;
type WorkflowConversationBindingOwner = Readonly<{
    getContext: () => WorkflowSessionBindingContext;
    onChange: (draft: WorkflowEditorDraft) => void;
}>;
export type WorkflowMountedDraftActions = Readonly<{
    getSnapshot: () => WorkflowMountedDraftV1 | null;
    execute: (actionId: WorkflowAuthoringActionId, input: unknown, signal?: AbortSignal,
        context?: WorkflowActionCallerContext) => Promise<WorkflowDraftMutationResultV1>;
}>;
type MountedWorkflowDraftOwner = (WorkflowConversationBindingOwner & Readonly<{
    kind: 'workflow'; actions?: WorkflowMountedDraftActions;
}>) | Readonly<{
    kind: 'review';
    getAddress: () => Readonly<{ scope: EntityDragScopeV1; draftId: string }> | null;
    execute: WorkflowMountedDraftActions['execute'];
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
const mountedOwners = new Set<MountedWorkflowDraftOwner>();
type MountedDraftAddress = Readonly<{ scope: EntityDragScopeV1; draftId: string }>;
let mountedAddresses: readonly MountedDraftAddress[] = [];
const mountedOwnerListeners = new Set<() => void>();
export const getMountedWorkflowDraftAddresses = (): readonly MountedDraftAddress[] => mountedAddresses;
export function subscribeMountedWorkflowDraftOwners(listener: () => void): () => void {
    mountedOwnerListeners.add(listener);
    return () => { mountedOwnerListeners.delete(listener); };
}
function publishMountedAddresses(): void {
    mountedAddresses = [...mountedOwners].flatMap(owner => {
        const address = owner.kind === 'review' ? owner.getAddress() : (() => {
            const context = owner.getContext();
            return context.scope ? { scope: context.scope, draftId: context.draft.draftId } : null;
        })();
        return address ? [address] : [];
    });
    for (const listener of mountedOwnerListeners) listener();
}
export function registerMountedWorkflowDraftOwner(owner: MountedWorkflowDraftOwner): () => void {
    mountedOwners.add(owner);
    publishMountedAddresses();
    return () => { if (mountedOwners.delete(owner)) publishMountedAddresses(); };
}
export async function invokeWorkflowAuthoringAction(request: BindingRequest & Readonly<{
    actionId: WorkflowAuthoringActionId;
    context: WorkflowActionCallerContext;
}>): Promise<WorkflowDraftGetResultV1> {
    const spec = WORKFLOW_AUTHORING_ACTION_SPECS.find(spec => spec.id === request.actionId);
    const parsed = spec?.inputSchema.safeParse(request.input);
    if (!parsed?.success) return { status: 'refused', reason: 'invalid_parameters' } as const;
    if (request.signal?.aborted) return { status: 'refused', reason: 'cancelled' } as const;
    const { serverId, runtimeAccountId: accountId } = request.context;
    if (!serverId || !accountId) return { status: 'unavailable' } as const;
    if (!entityDragScopesEqualV1({ serverId, accountId }, parsed.data.scope)) {
        return { status: 'refused', reason: 'workflow_binding_scope_mismatch' } as const;
    }
    const matches = [...mountedOwners].flatMap(owner => {
        if ((request.actionId === 'workflow.run.review.draft.set') !== (owner.kind === 'review')) return [];
        const address = owner.kind === 'review' ? owner.getAddress() : (() => {
            const context = owner.getContext();
            return context.scope ? { scope: context.scope, draftId: context.draft.draftId } : null;
        })();
        return address && entityDragScopesEqualV1(address.scope, parsed.data.scope)
            && (parsed.data.draftId === undefined || address.draftId === parsed.data.draftId) ? [{ owner, address }] : [];
    });
    if (request.actionId === 'workflow.authoring.draft.get') {
        if (parsed.data.draftId !== undefined && matches.length !== 1) return { status: 'unavailable' } as const;
        if (new Set(matches.map(match => match.address.draftId)).size !== matches.length) return { status: 'unavailable' };
        const drafts = matches.flatMap(({ owner }) => owner.kind === 'workflow' ? owner.actions?.getSnapshot() ?? [] : []);
        if (drafts.length === 0) return { status: 'unavailable' } as const;
        return { status: 'available', drafts } as const;
    }
    if (matches.length !== 1) return { status: 'unavailable' } as const;
    const { owner } = matches[0]!;
    if (request.actionId === 'workflow.authoring.conversation.bind' && owner.kind === 'workflow') {
        return executeWorkflowConversationBinding(owner, request);
    }
    const execute = owner.kind === 'review' ? owner.execute : owner.actions?.execute;
    return execute ? await execute(request.actionId, parsed.data, request.signal, {
        surface: request.context.surface, authority: request.context.authority,
        executeChildAction: request.context.executeChildAction,
        serverId, serverIdentityId: request.context.serverIdentityId,
        runtimeAccountId: accountId, expectedAccountId: request.context.expectedAccountId,
        actionCaller: request.context.actionCaller, defaultSessionId: request.context.defaultSessionId,
        defaultSessionMachineId: request.context.defaultSessionMachineId,
        runtimeRunId: request.context.runtimeRunId, runtimeRunOccurrenceId: request.context.runtimeRunOccurrenceId,
        workspaceWrites: request.context.workspaceWrites, sessionListAccess: request.context.sessionListAccess,
        callerPermissionMode: request.context.callerPermissionMode, sessionAgentSpawnPolicyV1: request.context.sessionAgentSpawnPolicyV1,
        // Absence is distinct from a present invalid causal authority at admission.
        ...(Object.prototype.hasOwnProperty.call(request.context, 'causalPermissionAuthority')
            ? { causalPermissionAuthority: request.context.causalPermissionAuthority } : {}),
        sessionInputSource: request.context.sessionInputSource,
        agentStartContext: request.context.agentStartContext, sessionRoleConfiguration: request.context.sessionRoleConfiguration,
        requesterWorkAttributionV1: request.context.requesterWorkAttributionV1, actionsSettings: request.context.actionsSettings,
        approvalOrigin: request.context.approvalOrigin, externalActionCredential: request.context.externalActionCredential,
        externalActionTarget: request.context.externalActionTarget, rpcSessionAuthorization: request.context.rpcSessionAuthorization,
        requiredContributedActionDangerLevel: request.context.requiredContributedActionDangerLevel,
        expectedContributedActionOccurrenceId: request.context.expectedContributedActionOccurrenceId,
        signal: request.signal ?? request.context.signal,
    }) : { status: 'unavailable' } as const;
}
