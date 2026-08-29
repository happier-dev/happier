import { describe, expect, it } from 'vitest';

import { readActionsSettingsFromEnv, listDisabledActionIdsForSurfaceFromEnv } from './actionsSettings';
import { createActionSettingsProvider } from './actionsSettingsProvider';

describe('actionsSettings (env)', () => {
  it('gives an explicit environment override precedence over live Account settings', () => {
    const previous = process.env.HAPPIER_ACTIONS_SETTINGS_V1;
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: { 'session.message.send': { enabled: false } },
    });
    try {
      const provider = createActionSettingsProvider({
        getAccountSettings: () => ({
          actionsSettingsV1: {
            v: 1,
            actions: { 'session.message.send': { enabled: true } },
          },
        }) as any,
      });
      expect(provider.getActionsSettings().actions['session.message.send']?.enabled).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
      else process.env.HAPPIER_ACTIONS_SETTINGS_V1 = previous;
    }
  });

  it('keeps a valid environment sibling when another known Action override is malformed', () => {
    const previous = process.env.HAPPIER_ACTIONS_SETTINGS_V1;
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: {
        'session.message.send': { enabled: false },
        'session.stop': { disabledSurfaces: 'api' },
      },
    });
    try {
      const settings = readActionsSettingsFromEnv();
      expect(settings.actions['session.message.send']?.enabled).toBe(false);
      expect(settings.actions['session.stop']?.enabled).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
      else process.env.HAPPIER_ACTIONS_SETTINGS_V1 = previous;
    }
  });

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
        'review.start': { enabled: true, disabledSurfaces: ['voice'], disabledPlacements: [] },
        'subagents.plan.start': { enabled: false, disabledSurfaces: [], disabledPlacements: [] },
      },
    });
    try {
      expect(listDisabledActionIdsForSurfaceFromEnv('voice')).toEqual(['review.start', 'subagents.plan.start']);
    } finally {
      if (prev === undefined) delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
      else process.env.HAPPIER_ACTIONS_SETTINGS_V1 = prev;
    }
  });
});
