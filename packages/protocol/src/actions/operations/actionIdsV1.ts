/** Import-free leaf: Action-id registries read this without loading operation schemas. */
export const ACTION_OPERATION_ACTION_IDS_V1 = [
  'action.operations.list', 'action.operations.get', 'action.operations.cancel',
  'projects.execution.output.read', 'projects.execution.output.open', 'projects.execution.output.copy',
] as const;
export type ActionOperationActionIdV1 = typeof ACTION_OPERATION_ACTION_IDS_V1[number];
