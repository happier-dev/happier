import { describe, expect, it } from 'vitest';

import {
  DAEMON_SPAWN_HOOK_EVENT_IDS_BY_PHASE_V1,
  DAEMON_SPAWN_HOOK_EVENT_IDS_V1,
} from './daemonSpawnHookCatalog.js';

describe('daemonSpawnHookCatalog', () => {
  it('exposes the daemon spawn hook family ids', () => {
    expect(DAEMON_SPAWN_HOOK_EVENT_IDS_V1).toEqual([
      'agent.resolvePrerequisites',
      'agent.spawnEnv.augment',
    ]);
  });

  it('exposes the daemon spawn hook event ids grouped by phase', () => {
    expect(DAEMON_SPAWN_HOOK_EVENT_IDS_BY_PHASE_V1).toEqual({
      preflight: ['agent.resolvePrerequisites'],
      environment: ['agent.spawnEnv.augment'],
    });
  });
});
