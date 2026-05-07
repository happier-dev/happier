import { afterEach, describe, expect, it, vi } from 'vitest';

import { setUiFeatureToggle } from './setUiFeatureToggle';
import { gotoDomContentLoadedWithRetries } from './pageNavigation';

vi.mock('./pageNavigation', () => ({
  gotoDomContentLoadedWithRetries: vi.fn(),
}));

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

describe('setUiFeatureToggle', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(globalThis, 'window');
  });

  it('updates scoped account settings and pending settings keys', async () => {
    const values = new Map<string, string>();
    const storageNamespace = 'mmkv.e2e-settings-scope';
    const suffix = '8:server-a9:account-a';
    const settingsKey = `${storageNamespace}\\account-settings:v2:${suffix}`;
    const pendingSettingsKey = `${storageNamespace}\\pending-account-settings:v2:${suffix}`;
    values.set(settingsKey, JSON.stringify({
      settings: {
        experiments: false,
        featureToggles: {
          existingFeature: false,
        },
      },
      version: 4,
    }));
    values.set(pendingSettingsKey, JSON.stringify({
      featureToggles: {
        pendingFeature: true,
      },
    }));

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        localStorage: createLocalStorage(values),
      },
    });

    const page = {
      evaluate: async (fn: (args: unknown) => unknown, args: unknown) => fn(args),
    };

    await setUiFeatureToggle({
      page: page as never,
      baseUrl: 'http://127.0.0.1:8081',
      featureId: 'files.diffSyntaxHighlighting',
      enabled: true,
    });

    const savedSettings = JSON.parse(values.get(settingsKey) ?? '{}');
    expect(savedSettings).toEqual({
      settings: {
        experiments: true,
        featureToggles: {
          existingFeature: false,
          'files.diffSyntaxHighlighting': true,
        },
      },
      version: 4,
    });

    const savedPending = JSON.parse(values.get(pendingSettingsKey) ?? '{}');
    expect(savedPending).toEqual({
      featureToggles: {
        pendingFeature: true,
        'files.diffSyntaxHighlighting': true,
      },
      experiments: true,
    });
    expect(values.has(`${storageNamespace}\\settings`)).toBe(false);
    expect(values.has(`${storageNamespace}\\pending-settings`)).toBe(false);
    expect(gotoDomContentLoadedWithRetries).toHaveBeenCalledWith(page, 'http://127.0.0.1:8081/');
  });

  it('updates the requested active scope when multiple scoped settings records exist', async () => {
    const values = new Map<string, string>();
    const storageNamespace = 'mmkv.other-settings-scope';
    const suffixA = '8:server-a9:account-a';
    const suffixB = '8:server-b9:account-b';
    const settingsKeyA = `${storageNamespace}\\account-settings:v2:${suffixA}`;
    const settingsKeyB = `${storageNamespace}\\account-settings:v2:${suffixB}`;
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
        featureToggles: {
          existingFeature: true,
        },
      },
      version: 2,
    }));

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        localStorage: createLocalStorage(values),
      },
    });

    const page = {
      evaluate: async (fn: (args: unknown) => unknown, args: unknown) => fn(args),
    };

    await setUiFeatureToggle({
      page: page as never,
      baseUrl: 'http://127.0.0.1:8081',
      featureId: 'files.diffSyntaxHighlighting',
      enabled: true,
      settingsScope: { serverId: 'server-b', accountId: 'account-b' },
    });

    expect(JSON.parse(values.get(settingsKeyA) ?? '{}')).toEqual({
      settings: {
        featureToggles: {
          existingFeature: false,
        },
      },
      version: 1,
    });
    expect(JSON.parse(values.get(settingsKeyB) ?? '{}')).toEqual({
      settings: {
        experiments: true,
        featureToggles: {
          existingFeature: true,
          'files.diffSyntaxHighlighting': true,
        },
      },
      version: 2,
    });
    expect(JSON.parse(values.get(`${storageNamespace}\\pending-account-settings:v2:${suffixB}`) ?? '{}')).toEqual({
      experiments: true,
      featureToggles: {
        'files.diffSyntaxHighlighting': true,
      },
    });
    expect(values.has(`${storageNamespace}\\pending-account-settings:v2:${suffixA}`)).toBe(false);
  });
});
