import { describe, expect, it } from 'vitest';

import { irohScenarios } from '../../scenarios/iroh.scenario';

describe('Lane 09 Iroh scenarios', () => {
  it('keeps every Iroh release case explicitly blocked until the real Lane 06 SPI exists', () => {
    expect(irohScenarios.map(({ id }) => id)).toEqual([
      'F-IR-01', 'F-IR-02', 'F-IR-03', 'F-IR-04',
      'F-IR-05', 'F-IR-06', 'F-IR-07', 'F-IR-08',
    ]);
    for (const scenario of irohScenarios) {
      expect(scenario.status).toBe('blocked');
      expect(scenario.blocker.code).toBe('missing_iroh_test_controller');
      expect(scenario.blocker.owner).toBe('Lane 06');
      expect(scenario.blocker.wakeCondition).toContain('forceDirectOnly');
      expect(scenario).not.toHaveProperty('execute');
    }
  });
});
