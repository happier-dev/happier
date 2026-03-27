import { describe, it, expect } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';

import { isActionApprovalRequiredByEnv } from './actionsSettings';

describe('isActionApprovalRequiredByEnv', () => {
  it('returns true when ActionsSettingsV1 marks the surface as approval-required', () => {
    const env = createEnvKeyScope(['HAPPIER_ACTIONS_SETTINGS_V1']);
    env.patch({
      HAPPIER_ACTIONS_SETTINGS_V1: JSON.stringify({
        v: 1,
        actions: {
          'session.message.send': {
            approvalRequiredSurfaces: ['cli'],
          },
        },
      }),
    });

    expect(isActionApprovalRequiredByEnv('session.message.send', { surface: 'cli' })).toBe(true);
    env.restore();
  });

  it('returns false when the surface is not configured', () => {
    const env = createEnvKeyScope(['HAPPIER_ACTIONS_SETTINGS_V1']);
    env.patch({
      HAPPIER_ACTIONS_SETTINGS_V1: JSON.stringify({
        v: 1,
        actions: {
          'session.message.send': {
            approvalRequiredSurfaces: ['mcp'],
          },
        },
      }),
    });

    expect(isActionApprovalRequiredByEnv('session.message.send', { surface: 'cli' })).toBe(false);
    env.restore();
  });
});
