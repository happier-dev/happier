import { describe, expect, it } from 'vitest';

import { workspaceSyncScenarios } from '../../scenarios/workspaceSync.scenario';

describe('Lane 09 workspace-sync scenarios', () => {
  it('keeps every Mutagen replacement case blocked until Lane 08 publishes its owner seam', () => {
    expect(workspaceSyncScenarios.map(({ id }) => id)).toEqual([
      'F-MU-01', 'F-MU-02', 'F-MU-03', 'F-MU-04', 'F-MU-05', 'F-MU-06',
    ]);
    for (const scenario of workspaceSyncScenarios) {
      expect(scenario.status).toBe('blocked');
      expect(scenario.blocker.code).toBe('missing_lane08_coordinator_contract');
      expect(scenario.blocker.owner).toBe('Lane 08');
      expect(scenario.blocker.wakeCondition).toContain('coordinator/broker API');
      expect(scenario).not.toHaveProperty('execute');
    }
  });
});
