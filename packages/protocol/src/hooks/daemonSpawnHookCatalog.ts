export const DAEMON_SPAWN_HOOK_EVENT_IDS_V1 = [
  'agent.resolvePrerequisites',
  'agent.spawnEnv.augment',
] as const;

export const DAEMON_SPAWN_HOOK_EVENT_IDS_BY_PHASE_V1 = Object.freeze({
  preflight: ['agent.resolvePrerequisites'],
  environment: ['agent.spawnEnv.augment'],
} as const);

export type DaemonSpawnHookEventIdV1 = (typeof DAEMON_SPAWN_HOOK_EVENT_IDS_V1)[number];
export type DaemonSpawnHookPhaseV1 = keyof typeof DAEMON_SPAWN_HOOK_EVENT_IDS_BY_PHASE_V1;
