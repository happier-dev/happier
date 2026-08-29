import { describe, expect, it } from 'vitest';

import { accountDirectoryScenarios } from '../../src/scenarios/accountDirectory.scenario';

describe('Account Directory contract scenarios', () => {
  it('keeps the named F-AD coverage set stable', () => {
    expect(accountDirectoryScenarios.map(({ id }) => id)).toEqual([
      'F-AD-01', 'F-AD-02', 'F-AD-03', 'F-AD-04', 'F-AD-05', 'F-AD-06',
    ]);
  });

  describe.each(accountDirectoryScenarios)('$id: $name', (scenario) => {
    it('passes against protocol-owned Account Directory contracts', async () => {
      await expect(scenario.run()).resolves.toBeUndefined();
    });
  });
});
