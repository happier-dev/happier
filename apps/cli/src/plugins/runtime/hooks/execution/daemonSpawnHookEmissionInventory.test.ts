import { describe, expect, it } from 'vitest';

import { DAEMON_SPAWN_HOOK_EMISSION_INVENTORY_V1 } from './daemonSpawnHookEmissionInventory';

describe('daemonSpawnHookEmissionInventory', () => {
  it('tracks every typed daemon spawn hook id at the real resolveSpawnChildEnvironment seam', () => {
    expect(DAEMON_SPAWN_HOOK_EMISSION_INVENTORY_V1).toEqual([
      {
        eventId: 'agent.resolvePrerequisites',
        phase: 'preflight',
        owner: 'resolveSpawnChildEnvironment',
        seam: 'readPluginSpawnDecision',
        notes: 'Evaluated after backend-owned prerequisite validation and fails closed on denial or handler rejection.',
      },
      {
        eventId: 'agent.spawnEnv.augment',
        phase: 'environment',
        owner: 'resolveSpawnChildEnvironment',
        seam: 'readPluginSpawnEnvAugmentation',
        notes: 'Evaluated before final child env publication so plugin env augmentation joins built-in daemon spawn env hooks.',
      },
    ]);
  });
});
