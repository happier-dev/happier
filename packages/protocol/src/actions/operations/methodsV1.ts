export const ACTION_OPERATION_RPC_METHODS_V1 = Object.freeze({
  list: 'actionOperation.list.v1',
  get: 'actionOperation.get.v1',
  cancel: 'actionOperation.cancel.v1',
} as const);

/** Same observation owner, with current domain associations. V1 readers retain
 * their original framing without development-only managed/task references. */
export const ACTION_OPERATION_RPC_METHODS_V2 = Object.freeze({
  list: 'actionOperation.list.v2',
  get: 'actionOperation.get.v2',
} as const);
