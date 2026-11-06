/** The Workflow Actions whose `definitionId` names a saved definition (an Artifact), never a built-in or plugin reference. */
export const WORKFLOW_SAVED_DEFINITION_ACTION_IDS = [
  'workflow.definition.get', 'workflow.definition.update', 'workflow.definition.edit',
  'workflow.definition.delete', 'workflow.definition.export',
] as const;

export function isWorkflowSavedDefinitionActionId(id: string | null | undefined): boolean {
  return id != null && (WORKFLOW_SAVED_DEFINITION_ACTION_IDS as readonly string[]).includes(id);
}
