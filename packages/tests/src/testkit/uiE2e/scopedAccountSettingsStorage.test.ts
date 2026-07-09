import { afterEach, describe, expect, it } from 'vitest';

import {
  mutateUiE2eScopedAccountSettings,
  readUiE2eScopedAccountSettings,
} from './scopedAccountSettingsStorage';

function createLocalStorage(values: Map<string, string>): Storage {
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => Array.from(values.keys())[index] ?? null,
    removeItem: (key: string) => {
      values.delete(key);
    },
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

function createPage(values: Map<string, string>) {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage: createLocalStorage(values),
    },
  });

  return {
    evaluate: async <Result>(fn: (args: unknown) => Result | Promise<Result>, args: unknown) => fn(args),
  };
}

describe('scopedAccountSettingsStorage', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'window');
  });

  it('merges settings patches into persisted and pending scoped account settings', async () => {
    const values = new Map<string, string>();
    const settingsKey = 'mmkv.default\\account-settings:v2:8:server-a9:account-a';
    const pendingSettingsKey = 'mmkv.default\\pending-account-settings:v2:8:server-a9:account-a';
    values.set(settingsKey, JSON.stringify({
      settings: {
        existing: true,
      },
      version: 4,
    }));

    await mutateUiE2eScopedAccountSettings({
      page: createPage(values) as never,
      settingsPatch: {
        sessionFolderViewModeV1: 'tree',
      },
    });

    expect(JSON.parse(values.get(settingsKey) ?? '{}')).toEqual({
      settings: {
        existing: true,
        sessionFolderViewModeV1: 'tree',
      },
      version: 4,
    });
    expect(JSON.parse(values.get(pendingSettingsKey) ?? '{}')).toEqual({
      sessionFolderViewModeV1: 'tree',
    });
  });

  it('updates feature toggles for every scoped account settings record when requested', async () => {
    const values = new Map<string, string>();
    const suffixA = '8:server-a9:account-a';
    const suffixB = '8:server-b9:account-b';
    const settingsKeyA = `mmkv.default\\account-settings:v2:${suffixA}`;
    const settingsKeyB = `mmkv.default\\account-settings:v2:${suffixB}`;
    values.set(settingsKeyA, JSON.stringify({
      settings: {
        featureToggles: {
          existingFeature: false,
        },
      },
      version: 1,
    }));
    values.set(settingsKeyB, JSON.stringify({
      settings: {
        experiments: false,
        featureToggles: {
          otherFeature: true,
        },
      },
      version: 2,
    }));

    await mutateUiE2eScopedAccountSettings({
      page: createPage(values) as never,
      applyToAllScopes: true,
      experiments: true,
      featureToggles: {
        connectedServices: true,
      },
    });

    expect(JSON.parse(values.get(settingsKeyA) ?? '{}')).toEqual({
      settings: {
        experiments: true,
        featureToggles: {
          existingFeature: false,
          connectedServices: true,
        },
      },
      version: 1,
    });
    expect(JSON.parse(values.get(settingsKeyB) ?? '{}')).toEqual({
      settings: {
        experiments: true,
        featureToggles: {
          otherFeature: true,
          connectedServices: true,
        },
      },
      version: 2,
    });
    expect(JSON.parse(values.get(`mmkv.default\\pending-account-settings:v2:${suffixA}`) ?? '{}')).toEqual({
      experiments: true,
      featureToggles: {
        connectedServices: true,
      },
    });
    expect(JSON.parse(values.get(`mmkv.default\\pending-account-settings:v2:${suffixB}`) ?? '{}')).toEqual({
      experiments: true,
      featureToggles: {
        connectedServices: true,
      },
    });
  });

  it('reads the requested scoped account settings record', async () => {
    const values = new Map<string, string>();
    const settingsKeyA = 'mmkv.default\\account-settings:v2:8:server-a9:account-a';
    const settingsKeyB = 'mmkv.default\\account-settings:v2:8:server-b9:account-b';
    values.set(settingsKeyA, JSON.stringify({
      settings: {
        sessionFolderViewModeV1: 'flat',
      },
    }));
    values.set(settingsKeyB, JSON.stringify({
      settings: {
        sessionFolderViewModeV1: 'tree',
      },
    }));

    await expect(readUiE2eScopedAccountSettings({
      page: createPage(values) as never,
      settingsScope: { serverId: 'server-b', accountId: 'account-b' },
    })).resolves.toEqual({
      sessionFolderViewModeV1: 'tree',
    });
  });
});
