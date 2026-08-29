import { describe, expect, it } from 'vitest';

import { personalHomeScenarios } from '../../src/scenarios/personalHome.scenario';

describe('Personal Home contract scenarios', () => {
  it('keeps the named F-PH coverage set stable', () => {
    expect(personalHomeScenarios.map(({ id }) => id)).toEqual([
      'F-PH-01', 'F-PH-02', 'F-PH-03', 'F-PH-04', 'F-PH-05',
    ]);
  });

  describe.each(personalHomeScenarios)('$id: $name', (scenario) => {
    it('passes against canonical Personal Home owners', async () => {
      await expect(scenario.run()).resolves.toBeUndefined();
    });
  });
});
