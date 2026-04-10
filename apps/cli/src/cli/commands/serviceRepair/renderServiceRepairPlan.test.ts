import { describe, expect, it } from 'vitest';

import { renderServiceRepairPlan } from './renderServiceRepairPlan';

describe('renderServiceRepairPlan', () => {
  it('lists remove and install actions for aggregated repair plans', () => {
    const rendered = renderServiceRepairPlan({
      commandPath: 'happier service repair',
      plan: {
        currentReleaseChannel: 'stable',
        existingServices: [],
        actions: [
          {
            kind: 'remove-service',
            service: {
              label: 'happier-daemon.default',
              mode: 'system',
              releaseChannel: 'stable',
              targetMode: 'default-following',
              instanceId: 'default',
            },
          },
          {
            kind: 'install-default-following-service',
            releaseChannel: 'stable',
            mode: 'user',
          },
        ],
        manualWarnings: [],
      },
    });

    expect(rendered).toContain('Remove happier-daemon.default (system, stable, default-following)');
    expect(rendered).toContain('Install one default background service on stable (user)');
    expect(rendered).toContain('Run happier service repair --yes');
  });
});
