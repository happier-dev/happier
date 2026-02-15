import { describe, expect, it } from 'vitest';

import { applyAccountSettingsToProcessEnv } from './applyAccountSettingsToProcessEnv';

describe('applyAccountSettingsToProcessEnv', () => {
  it('sets HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY from account settings when present', () => {
    const prev = process.env.HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY;
    delete process.env.HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY;
    try {
      applyAccountSettingsToProcessEnv({ settings: { scmIncludeCoAuthoredBy: true } });
      expect(process.env.HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY).toBe('1');
    } finally {
      if (prev === undefined) delete process.env.HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY;
      else process.env.HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY = prev;
    }
  });

  it('does not override an explicitly set env var', () => {
    const prev = process.env.HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY;
    process.env.HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY = '0';
    try {
      applyAccountSettingsToProcessEnv({ settings: { scmIncludeCoAuthoredBy: true } });
      expect(process.env.HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY).toBe('0');
    } finally {
      if (prev === undefined) delete process.env.HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY;
      else process.env.HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY = prev;
    }
  });

  it('still applies actions settings even when SCM env override is present', () => {
    const prevScm = process.env.HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY;
    const prevActions = process.env.HAPPIER_ACTIONS_DISABLED_ACTION_IDS;
    process.env.HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY = '0';
    delete process.env.HAPPIER_ACTIONS_DISABLED_ACTION_IDS;
    try {
      applyAccountSettingsToProcessEnv({ settings: { actionsSettingsV1: { v: 1, disabledActionIds: ['review.start'] } } });
      expect(process.env.HAPPIER_ACTIONS_DISABLED_ACTION_IDS).toBe(JSON.stringify(['review.start']));
    } finally {
      if (prevScm === undefined) delete process.env.HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY;
      else process.env.HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY = prevScm;
      if (prevActions === undefined) delete process.env.HAPPIER_ACTIONS_DISABLED_ACTION_IDS;
      else process.env.HAPPIER_ACTIONS_DISABLED_ACTION_IDS = prevActions;
    }
  });

  it('sets HAPPIER_ACTIONS_DISABLED_ACTION_IDS from account settings when present', () => {
    const prev = process.env.HAPPIER_ACTIONS_DISABLED_ACTION_IDS;
    delete process.env.HAPPIER_ACTIONS_DISABLED_ACTION_IDS;
    try {
      applyAccountSettingsToProcessEnv({ settings: { actionsSettingsV1: { v: 1, disabledActionIds: ['review.start'] } } });
      expect(process.env.HAPPIER_ACTIONS_DISABLED_ACTION_IDS).toBe(JSON.stringify(['review.start']));
    } finally {
      if (prev === undefined) delete process.env.HAPPIER_ACTIONS_DISABLED_ACTION_IDS;
      else process.env.HAPPIER_ACTIONS_DISABLED_ACTION_IDS = prev;
    }
  });

  it('does not override an explicitly set HAPPIER_ACTIONS_DISABLED_ACTION_IDS env var', () => {
    const prev = process.env.HAPPIER_ACTIONS_DISABLED_ACTION_IDS;
    process.env.HAPPIER_ACTIONS_DISABLED_ACTION_IDS = JSON.stringify(['plan.start']);
    try {
      applyAccountSettingsToProcessEnv({ settings: { actionsSettingsV1: { v: 1, disabledActionIds: ['review.start'] } } });
      expect(process.env.HAPPIER_ACTIONS_DISABLED_ACTION_IDS).toBe(JSON.stringify(['plan.start']));
    } finally {
      if (prev === undefined) delete process.env.HAPPIER_ACTIONS_DISABLED_ACTION_IDS;
      else process.env.HAPPIER_ACTIONS_DISABLED_ACTION_IDS = prev;
    }
  });
});
