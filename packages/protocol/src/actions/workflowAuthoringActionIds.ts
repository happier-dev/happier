/** Action identity must not import the schemas that themselves consume the catalog. */
export const WORKFLOW_AUTHORING_ACTION_IDS = [
  'workflow.authoring.conversation.bind', 'workflow.authoring.draft.get', 'workflow.authoring.draft.edit',
  'workflow.authoring.draft.undo', 'workflow.authoring.draft.redo', 'workflow.authoring.draft.save',
  'workflow.authoring.draft.discard', 'workflow.run.review.draft.set',
] as const;
export type WorkflowAuthoringActionId = typeof WORKFLOW_AUTHORING_ACTION_IDS[number];
export function isWorkflowAuthoringActionId(id: string): id is WorkflowAuthoringActionId {
  return (WORKFLOW_AUTHORING_ACTION_IDS as readonly string[]).includes(id);
}
