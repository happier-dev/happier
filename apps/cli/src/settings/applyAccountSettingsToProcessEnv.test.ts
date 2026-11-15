import { describe, expect, it } from 'vitest';

import {
  __resetApplyAccountSettingsToProcessEnvStateForTests,
  applyAccountSettingsToProcessEnv,
  readAccountSettingsEnvironmentOverrideKeys,
} from './applyAccountSettingsToProcessEnv';

describe('applyAccountSettingsToProcessEnv', () => {
  function resetBackendCliSourcePreferenceEnv(prev: string | undefined): void {
    __resetApplyAccountSettingsToProcessEnvStateForTests();
    if (prev === undefined) delete process.env.HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON;
    else process.env.HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON = prev;
  }

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

  it('refreshes SCM env when settings change after an earlier settings-managed write', () => {
    const prev = process.env.HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY;
    delete process.env.HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY;
    try {
      applyAccountSettingsToProcessEnv({ settings: { scmIncludeCoAuthoredBy: true } });
      expect(process.env.HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY).toBe('1');

      applyAccountSettingsToProcessEnv({ settings: { scmIncludeCoAuthoredBy: false } });
      expect(process.env.HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY).toBe('0');

      applyAccountSettingsToProcessEnv({ settings: {} });
      expect(process.env.HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY).toBeUndefined();
    } finally {
      __resetApplyAccountSettingsToProcessEnvStateForTests();
      if (prev === undefined) delete process.env.HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY;
      else process.env.HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY = prev;
    }
  });

  it('stops managing SCM env after an explicit override replaces a settings-managed value', () => {
    const prev = process.env.HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY;
    delete process.env.HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY;
    try {
      applyAccountSettingsToProcessEnv({ settings: { scmIncludeCoAuthoredBy: true } });
      expect(process.env.HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY).toBe('1');

      process.env.HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY = '0';

      applyAccountSettingsToProcessEnv({ settings: { scmIncludeCoAuthoredBy: true } });
      expect(process.env.HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY).toBe('0');
    } finally {
      __resetApplyAccountSettingsToProcessEnvStateForTests();
      if (prev === undefined) delete process.env.HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY;
      else process.env.HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY = prev;
    }
  });

  it('does not mirror Account Action policy into the environment across refreshes', () => {
    const previous = process.env.HAPPIER_ACTIONS_SETTINGS_V1;
    delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
    try {
      for (const settings of [
        { actionsSettingsV1: { v: 1, actions: { 'review.start': { enabled: false } } } },
        { actionsSettingsV1: { v: 1, actions: { 'review.start': { enabled: true } } } },
        {},
      ]) {
        applyAccountSettingsToProcessEnv({ settings });
        expect(process.env.HAPPIER_ACTIONS_SETTINGS_V1).toBeUndefined();
        expect(readAccountSettingsEnvironmentOverrideKeys(process.env)).not.toContain('HAPPIER_ACTIONS_SETTINGS_V1');
      }
    } finally {
      __resetApplyAccountSettingsToProcessEnvStateForTests();
      if (previous === undefined) delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
      else process.env.HAPPIER_ACTIONS_SETTINGS_V1 = previous;
    }
  });

  it('preserves an explicitly supplied Action policy and its child transport marker', () => {
    const previous = process.env.HAPPIER_ACTIONS_SETTINGS_V1;
    const override = JSON.stringify({ v: 1, actions: { 'review.start': { enabled: true } } });
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = override;
    try {
      applyAccountSettingsToProcessEnv({ settings: {
        actionsSettingsV1: { v: 1, actions: { 'review.start': { enabled: false } } },
      } });
      applyAccountSettingsToProcessEnv({ settings: {} });
      expect(process.env.HAPPIER_ACTIONS_SETTINGS_V1).toBe(override);
      expect(readAccountSettingsEnvironmentOverrideKeys(process.env)).toContain('HAPPIER_ACTIONS_SETTINGS_V1');
    } finally {
      __resetApplyAccountSettingsToProcessEnvStateForTests();
      if (previous === undefined) delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
      else process.env.HAPPIER_ACTIONS_SETTINGS_V1 = previous;
    }
  });

  it('sets HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON from account settings when present', () => {
    const prev = process.env.HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON;
    delete process.env.HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON;
    try {
      applyAccountSettingsToProcessEnv({
        settings: {
          backendCliSourcePreferenceById: {
            codex: 'managed-first',
            gemini: 'system-first',
            invalid: 'ignored',
          },
        },
      });
      expect(process.env.HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON).toBe(
        JSON.stringify({
          codex: 'managed-first',
          gemini: 'system-first',
        }),
      );
    } finally {
      resetBackendCliSourcePreferenceEnv(prev);
    }
  });

  it('prefers target-keyed backend CLI source preferences when present', () => {
    const prev = process.env.HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON;
    delete process.env.HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON;
    try {
      applyAccountSettingsToProcessEnv({
        settings: {
          backendCliSourcePreferenceByTargetKey: {
            'agent:codex': 'managed-first',
            'agent:gemini': 'system-first',
          },
          backendCliSourcePreferenceById: {
            codex: 'system-first',
          },
        },
      });
      expect(process.env.HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON).toBe(
        JSON.stringify({
          'agent:codex': 'managed-first',
          'agent:gemini': 'system-first',
        }),
      );
    } finally {
      resetBackendCliSourcePreferenceEnv(prev);
    }
  });

  it('does not override an explicitly set backend source preference env var', () => {
    const prev = process.env.HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON;
    process.env.HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON = JSON.stringify({ codex: 'system-first' });
    try {
      applyAccountSettingsToProcessEnv({
        settings: {
          backendCliSourcePreferenceById: {
            codex: 'managed-first',
          },
        },
      });
      expect(process.env.HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON).toBe(
        JSON.stringify({ codex: 'system-first' }),
      );
    } finally {
      resetBackendCliSourcePreferenceEnv(prev);
    }
  });

  it('refreshes backend source preference env when settings change after an earlier settings-managed write', () => {
    const prev = process.env.HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON;
    delete process.env.HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON;
    try {
      applyAccountSettingsToProcessEnv({ settings: { backendCliSourcePreferenceByTargetKey: { 'agent:codex': 'managed-first' } } });
      expect(process.env.HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON).toBe(JSON.stringify({ 'agent:codex': 'managed-first' }));

      applyAccountSettingsToProcessEnv({ settings: { backendCliSourcePreferenceByTargetKey: { 'agent:codex': 'system-first' } } });
      expect(process.env.HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON).toBe(JSON.stringify({ 'agent:codex': 'system-first' }));

      applyAccountSettingsToProcessEnv({ settings: {} });
      expect(process.env.HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON;
      else process.env.HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON = prev;
    }
  });

  it('stops managing backend source preference env after an explicit override replaces a settings-managed value', () => {
    const prev = process.env.HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON;
    delete process.env.HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON;
    try {
      applyAccountSettingsToProcessEnv({ settings: { backendCliSourcePreferenceByTargetKey: { 'agent:codex': 'managed-first' } } });
      expect(process.env.HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON).toBe(JSON.stringify({ 'agent:codex': 'managed-first' }));

      process.env.HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON = JSON.stringify({ 'agent:codex': 'system-first' });

      applyAccountSettingsToProcessEnv({ settings: { backendCliSourcePreferenceByTargetKey: { 'agent:codex': 'managed-first' } } });
      expect(process.env.HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON).toBe(JSON.stringify({ 'agent:codex': 'system-first' }));
    } finally {
      resetBackendCliSourcePreferenceEnv(prev);
    }
  });
});
