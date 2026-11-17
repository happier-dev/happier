export const WORKFLOW_TRIGGER_ADD_ACTION_ID = 'workflow.trigger.add';
export const WORKFLOW_TRIGGER_UPDATE_ACTION_ID = 'workflow.trigger.update';
export const WORKFLOW_TRIGGER_REMOVE_ACTION_ID = 'workflow.trigger.remove';
export const WORKFLOW_TRIGGER_MUTATION_ACTION_IDS = [WORKFLOW_TRIGGER_ADD_ACTION_ID,
  WORKFLOW_TRIGGER_UPDATE_ACTION_ID, WORKFLOW_TRIGGER_REMOVE_ACTION_ID] as const;
export type WorkflowTriggerMutationActionId = typeof WORKFLOW_TRIGGER_MUTATION_ACTION_IDS[number];
export function isWorkflowTriggerMutationActionId(id: string): id is WorkflowTriggerMutationActionId {
  return (WORKFLOW_TRIGGER_MUTATION_ACTION_IDS as readonly string[]).includes(id);
}
