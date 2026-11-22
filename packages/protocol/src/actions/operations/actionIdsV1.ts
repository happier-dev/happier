/** Import-free leaf: Action-id registries read this without loading operation schemas. */
export const ACTION_OPERATION_GET_ACTION_ID_V1 = 'action.operations.get' as const;
export const ACTION_OPERATION_CANCEL_ACTION_ID_V1 = 'action.operations.cancel';
export const ACTION_OPERATION_LIST_ACTION_ID_V1 = 'action.operations.list';
export const ACTION_OPERATION_TASK_RESPOND_ACTION_ID_V1 = 'action.operations.task.respond';
export function isRequesterOperationActionIdV1(value: string): value is
  typeof ACTION_OPERATION_GET_ACTION_ID_V1 | typeof ACTION_OPERATION_LIST_ACTION_ID_V1 | typeof ACTION_OPERATION_CANCEL_ACTION_ID_V1 {
  return value === ACTION_OPERATION_GET_ACTION_ID_V1 || value === ACTION_OPERATION_LIST_ACTION_ID_V1
    || value === ACTION_OPERATION_CANCEL_ACTION_ID_V1;
}
export const ACTION_OPERATION_CONTROL_ACTION_IDS_V1 = [
  ACTION_OPERATION_LIST_ACTION_ID_V1, ACTION_OPERATION_GET_ACTION_ID_V1, ACTION_OPERATION_CANCEL_ACTION_ID_V1,
  ACTION_OPERATION_TASK_RESPOND_ACTION_ID_V1,
] as const;
export const ACTION_OPERATION_ACTION_IDS_V1 = [
  ...ACTION_OPERATION_CONTROL_ACTION_IDS_V1,
  'projects.execution.output.read', 'projects.execution.output.open', 'projects.execution.output.copy',
] as const;
export type ActionOperationActionIdV1 = typeof ACTION_OPERATION_ACTION_IDS_V1[number];
