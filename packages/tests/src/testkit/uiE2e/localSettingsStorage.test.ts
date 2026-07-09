import { afterEach, describe, expect, it } from 'vitest';

import {
  mutateUiE2eLocalSettings,
  readUiE2eLocalSettings,
} from './localSettingsStorage';

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

describe('localSettingsStorage', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'window');
  });

  it('merges patches into the persisted MMKV local settings record', async () => {
    const values = new Map<string, string>();
    const localSettingsKey = 'mmkv.default\\local-settings';
    values.set(localSettingsKey, JSON.stringify({
      sessionListFolderSortModeV1: 'foldersFirst',
      themePreference: 'adaptive',
    }));

    await mutateUiE2eLocalSettings({
      page: createPage(values) as never,
      settingsPatch: {
        sessionListFolderSortModeV1: 'mixed',
      },
    });

    expect(JSON.parse(values.get(localSettingsKey) ?? '{}')).toEqual({
      sessionListFolderSortModeV1: 'mixed',
      themePreference: 'adaptive',
    });
  });

  it('reads the persisted MMKV local settings record', async () => {
    const values = new Map<string, string>();
    values.set('mmkv.default\\local-settings', JSON.stringify({
      sessionListFolderSortModeV1: 'mixed',
    }));

    await expect(readUiE2eLocalSettings({
      page: createPage(values) as never,
    })).resolves.toEqual({
      sessionListFolderSortModeV1: 'mixed',
    });
  });
});
