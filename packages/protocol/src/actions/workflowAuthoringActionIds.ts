import { RPC_METHODS } from '../rpc/methods.js';
import type { EntityDragScopeV1 } from '../plugins/ui/entityDragDrop.js';
/** Action identity must not import the schemas that themselves consume the catalog. */
export const WORKFLOW_AUTHORING_ACTION_ID = {
  conversationBind: 'workflow.authoring.conversation.bind',
  draftGet: 'workflow.authoring.draft.get',
  draftEdit: 'workflow.authoring.draft.edit',
  draftUndo: 'workflow.authoring.draft.undo',
  draftRedo: 'workflow.authoring.draft.redo',
  draftSave: 'workflow.authoring.draft.save',
  draftDiscard: 'workflow.authoring.draft.discard',
  reviewDraftSet: 'workflow.run.review.draft.set',
} as const;
export const WORKFLOW_AUTHORING_ACTION_IDS = [
  WORKFLOW_AUTHORING_ACTION_ID.conversationBind, WORKFLOW_AUTHORING_ACTION_ID.draftGet, WORKFLOW_AUTHORING_ACTION_ID.draftEdit,
  WORKFLOW_AUTHORING_ACTION_ID.draftUndo, WORKFLOW_AUTHORING_ACTION_ID.draftRedo, WORKFLOW_AUTHORING_ACTION_ID.draftSave,
  WORKFLOW_AUTHORING_ACTION_ID.draftDiscard, WORKFLOW_AUTHORING_ACTION_ID.reviewDraftSet,
] as const;
export type WorkflowAuthoringActionId = typeof WORKFLOW_AUTHORING_ACTION_IDS[number];
export function isWorkflowAuthoringActionId(id: string): id is WorkflowAuthoringActionId {
  return (WORKFLOW_AUTHORING_ACTION_IDS as readonly string[]).includes(id);
}

/** The existing reverse-RPC room addresses the mounted owner, not an arbitrary tab. */
export function workflowDraftClientRpcMethod(address: Readonly<{ scope: EntityDragScopeV1; draftId?: string }>): string {
  return `${RPC_METHODS.UI_ACTION_EXECUTE}.workflow.${encodeURIComponent(JSON.stringify([
    address.scope.serverId, address.scope.accountId, address.draftId ?? null,
  ]))}`;
}

export function isWorkflowDraftClientRpcMethod(method: string): boolean {
  const prefix = `${RPC_METHODS.UI_ACTION_EXECUTE}.workflow.`;
  if (!method.startsWith(prefix)) return false;
  try {
    const address: unknown = JSON.parse(decodeURIComponent(method.slice(prefix.length)));
    return Array.isArray(address) && address.length === 3
      && typeof address[0] === 'string' && address[0].length > 0
      && typeof address[1] === 'string' && address[1].length > 0
      && (address[2] === null || typeof address[2] === 'string' && address[2].length > 0);
  } catch { return false; }
}
