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
});

