import { describe, expect, it } from 'vitest';

import { readDisabledActionIdsFromEnv } from './actionsSettings';

describe('actionsSettings (env)', () => {
  it('parses HAPPIER_ACTIONS_DISABLED_ACTION_IDS as a validated list', () => {
    const prev = process.env.HAPPIER_ACTIONS_DISABLED_ACTION_IDS;
    process.env.HAPPIER_ACTIONS_DISABLED_ACTION_IDS = JSON.stringify(['review.start', 'unknown.action', 'review.start']);
    try {
      expect(readDisabledActionIdsFromEnv()).toEqual(['review.start']);
    } finally {
      if (prev === undefined) delete process.env.HAPPIER_ACTIONS_DISABLED_ACTION_IDS;
      else process.env.HAPPIER_ACTIONS_DISABLED_ACTION_IDS = prev;
    }
  });
});

