export const SESSION_BRIDGE_LIFECYCLE_HOOK_EVENT_IDS_V1 = [
  'session.spawn_new',
  'session.message.send',
] as const;

export const EXECUTION_RUN_BRIDGE_LIFECYCLE_HOOK_EVENT_IDS_V1 = [
  'execution_run.start',
  'execution_run.send',
  'execution_run.stop',
  'execution_run.terminal',
] as const;

export const BRIDGE_LIFECYCLE_HOOK_EVENT_IDS_V1 = [
  ...SESSION_BRIDGE_LIFECYCLE_HOOK_EVENT_IDS_V1,
  ...EXECUTION_RUN_BRIDGE_LIFECYCLE_HOOK_EVENT_IDS_V1,
] as const;

export const BRIDGE_LIFECYCLE_HOOK_EVENT_IDS_BY_BRIDGE_V1 = Object.freeze({
  session: SESSION_BRIDGE_LIFECYCLE_HOOK_EVENT_IDS_V1,
  execution_run: EXECUTION_RUN_BRIDGE_LIFECYCLE_HOOK_EVENT_IDS_V1,
} as const);

export type SessionBridgeLifecycleHookEventIdV1 = (typeof SESSION_BRIDGE_LIFECYCLE_HOOK_EVENT_IDS_V1)[number];
export type ExecutionRunBridgeLifecycleHookEventIdV1 = (typeof EXECUTION_RUN_BRIDGE_LIFECYCLE_HOOK_EVENT_IDS_V1)[number];
export type BridgeLifecycleHookEventIdV1 = (typeof BRIDGE_LIFECYCLE_HOOK_EVENT_IDS_V1)[number];
