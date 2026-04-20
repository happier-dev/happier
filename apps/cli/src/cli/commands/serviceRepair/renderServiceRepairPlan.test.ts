import { describe, expect, it } from 'vitest';

import { renderServiceRepairPlan } from './renderServiceRepairPlan';

describe('renderServiceRepairPlan', () => {
  it('lists remove and install actions for aggregated repair plans', () => {
    const rendered = renderServiceRepairPlan({
      commandPath: 'happier service',
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

  it('shows manual warnings even when no automatic repair action is available', () => {
    const rendered = renderServiceRepairPlan({
      commandPath: 'happier service',
      plan: {
        currentReleaseChannel: 'preview',
        existingServices: [],
        actions: [],
        manualWarnings: [
          'Detected default-following background services with missing Happier home metadata (/home/test/.config/systemd/user/happier-daemon.preview.default.service).',
        ],
      },
    });

    expect(rendered).toContain('No automatic background-service repair actions are available.');
    expect(rendered).toContain('Manual cleanup required:');
    expect(rendered).toContain('happier-daemon.preview.default.service');
  });
});
