import { describe, expect, it } from 'vitest';

import { readActionsSettingsFromEnv, listDisabledActionIdsForSurfaceFromEnv } from './actionsSettings';

describe('actionsSettings (env)', () => {
  it('parses HAPPIER_ACTIONS_SETTINGS_V1 as a validated settings object and filters unknown action ids', () => {
    const prev = process.env.HAPPIER_ACTIONS_SETTINGS_V1;
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: {
        'review.start': { enabled: false, disabledSurfaces: [], disabledPlacements: [] },
        'unknown.action': { enabled: false, disabledSurfaces: [], disabledPlacements: [] },
      },
    });
    try {
      expect(Object.keys(readActionsSettingsFromEnv().actions)).toEqual(['review.start']);
    } finally {
      if (prev === undefined) delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
      else process.env.HAPPIER_ACTIONS_SETTINGS_V1 = prev;
    }
  });

  it('derives disabledActionIds for a specific surface', () => {
    const prev = process.env.HAPPIER_ACTIONS_SETTINGS_V1;
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: {
        'review.start': { enabled: true, disabledSurfaces: ['voice_tool'], disabledPlacements: [] },
        'plan.start': { enabled: false, disabledSurfaces: [], disabledPlacements: [] },
      },
    });
    try {
      expect(listDisabledActionIdsForSurfaceFromEnv('voice_tool')).toEqual(['plan.start', 'review.start']);
    } finally {
      if (prev === undefined) delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
      else process.env.HAPPIER_ACTIONS_SETTINGS_V1 = prev;
    }
  });
});
