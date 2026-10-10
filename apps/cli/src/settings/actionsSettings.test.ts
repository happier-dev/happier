import { describe, expect, it } from 'vitest';

import { accountSettingsParse, isApprovalRequiredByActionsSettings } from '@happier-dev/protocol';
import { clearActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from './accountSettings/activeAccountSettingsSnapshot';

import { readActionsSettingsFromEnv, listDisabledActionIdsForSurfaceFromEnv } from './actionsSettings';
import { createActionSettingsProvider } from './actionsSettingsProvider';

describe('actionsSettings (env)', () => {
  it('reads an admitted invocation getter for scoped policy without borrowing the focused Account', () => {
    resetActiveAccountSettingsSnapshotForTests();
    const focusedSettings = accountSettingsParse({
      actionsSettingsV1: { v: 1, actions: { 'execution.run.start': { enabled: true } } },
    });
    setActiveAccountSettingsSnapshot({ scopeKey: 'focused-bob', source: 'network',
      settingsVersion: 99, settings: focusedSettings, rawSettings: {}, settingsSecretsReadKeys: [], loadedAtMs: 1 });
    let admittedSettings: ReturnType<typeof accountSettingsParse> | null = accountSettingsParse({
      actionsSettingsV1: { v: 1, actions: { 'execution.run.start': { enabled: false, approvalRequiredSurfaces: ['agent'] } } },
    });
    const provider = createActionSettingsProvider({
      scopeKey: 'owning-alice', getAccountSettings: () => admittedSettings,
    });
    try {
      expect(provider.getAccountSettings()).toBe(admittedSettings);
      expect(provider.getActionsSettings().actions['execution.run.start']?.enabled).toBe(false);
      expect(isApprovalRequiredByActionsSettings('execution.run.start', provider.getActionsSettings(), { surface: 'agent' })).toBe(true);
      admittedSettings = accountSettingsParse({
        actionsSettingsV1: { v: 1, actions: { 'execution.run.start': { enabled: true } } },
      });
      expect(provider.getAccountSettings()).toBe(admittedSettings);
      expect(provider.getActionsSettings().actions['execution.run.start']?.enabled).toBe(true);
      admittedSettings = null;
      expect(provider.getAccountSettings()).toBeNull();
    } finally { clearActiveAccountSettingsSnapshot(); resetActiveAccountSettingsSnapshotForTests(); }
  });
  it('reads current Role authority separately from cached preferences and never reactivates a retired binding', () => {
    resetActiveAccountSettingsSnapshotForTests();
    const publish = (scopeKey: string, version: number, rawSettings: Record<string, unknown>) => setActiveAccountSettingsSnapshot({
      scopeKey, source: 'network', settingsVersion: version, settings: accountSettingsParse(rawSettings), rawSettings,
      settingsSecretsReadKeys: [], loadedAtMs: version,
      promptLibraryCatalog: { status: 'ready', rows: [], tombstones: [], diagnostics: [] },
    });
    try {
      publish('alice', 1, { rolesV1: { overrides: { builder: { roleId: 'builder', workspaceWrites: 'deny' } } } });
      const provider = createActionSettingsProvider({ scopeKey: 'alice' });
      expect(provider.getAccountRoleOverrides()).toEqual({ status: 'ready', overrides: { builder: { roleId: 'builder', workspaceWrites: 'deny' } } });
      publish('alice', 2, { rolesV1: { overrides: { builder: { roleId: 'builder', workspaceWrites: 'invalid' } } } });
      expect(provider.getAccountRoleOverrides()).toEqual({ status: 'unavailable', reason: 'invalid-stored-content' });
      publish('bob', 1, {});
      expect(provider.getAccountRoleOverrides()).toEqual({ status: 'unavailable', reason: 'scope-retired' });
      publish('alice', 3, {});
      expect(provider.getAccountRoleOverrides()).toEqual({ status: 'unavailable', reason: 'scope-retired' });
    } finally { clearActiveAccountSettingsSnapshot(); resetActiveAccountSettingsSnapshotForTests(); }
  });
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

  it('keeps credential-scoped Account disable and approval policy authoritative over a permissive environment', () => {
    const previous = process.env.HAPPIER_ACTIONS_SETTINGS_V1;
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: { 'session.message.send': { enabled: true } },
      approvalWaivedSurfaces: { 'session.message.send': ['agent'] },
    });
    try {
      const provider = createActionSettingsProvider({
        scopeKey: 'account-alice',
        accountSettings: {
          actionsSettingsV1: {
            v: 1,
            actions: {
              'session.message.send': {
                enabled: false,
                approvalRequiredSurfaces: ['agent'],
              },
            },
          },
        } as any,
      });
      const settings = provider.getActionsSettings();
      expect(settings.actions['session.message.send']?.enabled).toBe(false);
      expect(isApprovalRequiredByActionsSettings('session.message.send', settings, {
        surface: 'agent',
      })).toBe(true);
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

  it('preserves unknown Action policy rows for round-tripping', () => {
    const prev = process.env.HAPPIER_ACTIONS_SETTINGS_V1;
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: {
        'review.start': { enabled: false, disabledSurfaces: [], disabledPlacements: [] },
        'unknown.action': { enabled: false, disabledSurfaces: [], disabledPlacements: [] },
      },
    });
    try {
      expect(readActionsSettingsFromEnv().actions['unknown.action']).toMatchObject({ enabled: false });
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
