import {
  DAEMON_SPAWN_HOOK_EVENT_IDS_BY_PHASE_V1,
  type DaemonSpawnHookEventIdV1,
} from '@happier-dev/protocol';

export type DaemonSpawnHookEmissionInventoryEntry = Readonly<{
  eventId: DaemonSpawnHookEventIdV1;
  phase: 'preflight' | 'environment';
  owner: string;
  seam: string;
  notes: string;
}>;

const DAEMON_SPAWN_HOOK_EMISSION_NOTES_BY_EVENT_ID_V1: Readonly<Record<DaemonSpawnHookEventIdV1, Readonly<{
  owner: string;
  seam: string;
  notes: string;
}>>> = Object.freeze({
  'agent.resolvePrerequisites': {
    owner: 'resolveSpawnChildEnvironment',
    seam: 'readPluginSpawnDecision',
    notes: 'Evaluated after backend-owned prerequisite validation and fails closed on denial or handler rejection.',
  },
  'agent.spawnEnv.augment': {
    owner: 'resolveSpawnChildEnvironment',
    seam: 'readPluginSpawnEnvAugmentation',
    notes: 'Evaluated before final child env publication so plugin env augmentation joins built-in daemon spawn env hooks.',
  },
});

function buildDaemonSpawnHookEmissionInventoryEntry(params: Readonly<{
  eventId: DaemonSpawnHookEventIdV1;
  phase: 'preflight' | 'environment';
}>): DaemonSpawnHookEmissionInventoryEntry {
  const details = DAEMON_SPAWN_HOOK_EMISSION_NOTES_BY_EVENT_ID_V1[params.eventId];
  return {
    eventId: params.eventId,
    phase: params.phase,
    owner: details.owner,
    seam: details.seam,
    notes: details.notes,
  };
}

export const DAEMON_SPAWN_HOOK_EMISSION_INVENTORY_V1: readonly DaemonSpawnHookEmissionInventoryEntry[] = Object.freeze([
  ...DAEMON_SPAWN_HOOK_EVENT_IDS_BY_PHASE_V1.preflight.map((eventId) => (
    buildDaemonSpawnHookEmissionInventoryEntry({ eventId, phase: 'preflight' })
  )),
  ...DAEMON_SPAWN_HOOK_EVENT_IDS_BY_PHASE_V1.environment.map((eventId) => (
    buildDaemonSpawnHookEmissionInventoryEntry({ eventId, phase: 'environment' })
  )),
]);
