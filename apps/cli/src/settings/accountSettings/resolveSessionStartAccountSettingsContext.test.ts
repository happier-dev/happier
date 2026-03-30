import { describe, expect, it } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol';

import { resolveSessionStartAccountSettingsContext } from './resolveSessionStartAccountSettingsContext';
import type { AccountSettingsContext } from './bootstrapAccountSettingsContext';

describe('resolveSessionStartAccountSettingsContext', () => {
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
});
