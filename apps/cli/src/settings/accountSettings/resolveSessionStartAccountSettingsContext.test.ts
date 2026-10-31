import { describe, expect, it } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol';

import { resolveSessionStartAccountSettingsContext } from './resolveSessionStartAccountSettingsContext';
import type { AccountSettingsContext } from './bootstrapAccountSettingsContext';

describe('resolveSessionStartAccountSettingsContext', () => {
  it('settles an explicit refresh even when an older cached snapshot exists', async () => {
    const settings = accountSettingsParse({});
    const refreshed: AccountSettingsContext = {
      source: 'network', settings, settingsVersion: 2, loadedAtMs: 200,
      settingsSecretsReadKeys: [], whenRefreshed: null,
    };
    const cached: AccountSettingsContext = {
      ...refreshed, source: 'cache', settingsVersion: 1, whenRefreshed: Promise.resolve(refreshed),
    };
    expect(await resolveSessionStartAccountSettingsContext({ startedBy: 'terminal', snapshot: cached, refreshRequested: true })).toBe(refreshed);
  });
  it('awaits the first background refresh for terminal session starts when bootstrap had no settings yet', async () => {
    const emptySettings = accountSettingsParse({ schemaVersion: 2 }) as AccountSettingsContext['settings'];
    const refreshedSettings = accountSettingsParse({
      schemaVersion: 2,
      mcpServersSettingsV1: { v: 1, strictMode: false, servers: [], bindings: [] },
    }) as AccountSettingsContext['settings'];

    const refreshed = {
      source: 'network',
      settings: refreshedSettings,
      settingsVersion: 3,
      loadedAtMs: 200,
      whenRefreshed: null,
    } as AccountSettingsContext;

    const whenRefreshed: Promise<AccountSettingsContext> = Promise.resolve(refreshed);

    const result = await resolveSessionStartAccountSettingsContext({
      startedBy: 'terminal',
      snapshot: {
        source: 'none',
        settings: emptySettings,
        settingsVersion: 0,
        loadedAtMs: 100,
        whenRefreshed,
      } as AccountSettingsContext,
    });

    expect(result).toBe(refreshed);
  });

  it('awaits the first background refresh for daemon session starts when bootstrap had no settings yet', async () => {
    const emptySettings = accountSettingsParse({ schemaVersion: 2 }) as AccountSettingsContext['settings'];
    const refreshedSettings = accountSettingsParse({
      schemaVersion: 2,
      claudeUnifiedTerminalEnabled: true,
    }) as AccountSettingsContext['settings'];

    const refreshed = {
      source: 'network',
      settings: refreshedSettings,
      settingsVersion: 4,
      loadedAtMs: 300,
      whenRefreshed: null,
    } as AccountSettingsContext;

    const whenRefreshed: Promise<AccountSettingsContext> = Promise.resolve(refreshed);

    const result = await resolveSessionStartAccountSettingsContext({
      startedBy: 'daemon',
      snapshot: {
        source: 'none',
        settings: emptySettings,
        settingsVersion: 0,
        loadedAtMs: 100,
        whenRefreshed,
      } as AccountSettingsContext,
    });

    expect(result).toBe(refreshed);
  });

  it('uses cached daemon settings without waiting for a background refresh', async () => {
    const cachedSettings = accountSettingsParse({
      schemaVersion: 2,
      claudeUnifiedTerminalEnabled: false,
    }) as AccountSettingsContext['settings'];
    const refreshedSettings = accountSettingsParse({
      schemaVersion: 2,
      claudeUnifiedTerminalEnabled: true,
    }) as AccountSettingsContext['settings'];

    const refreshed = {
      source: 'network',
      settings: refreshedSettings,
      settingsVersion: 4,
      loadedAtMs: 300,
      whenRefreshed: null,
    } as AccountSettingsContext;

    const result = await resolveSessionStartAccountSettingsContext({
      startedBy: 'daemon',
      snapshot: {
        source: 'cache',
        settings: cachedSettings,
        settingsVersion: 3,
        loadedAtMs: 100,
        whenRefreshed: Promise.resolve(refreshed),
      } as AccountSettingsContext,
    });

    expect(result.settings).toBe(cachedSettings);
  });
});
