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
    const suffix = '8:server-a9:account-a';
    const settingsKey = `mmkv.default\\account-settings:v2:${suffix}`;
    const pendingSettingsKey = `mmkv.default\\pending-account-settings:v2:${suffix}`;
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
    expect(values.has('mmkv.default\\settings')).toBe(false);
    expect(values.has('mmkv.default\\pending-settings')).toBe(false);
    expect(gotoDomContentLoadedWithRetries).toHaveBeenCalledWith(page, 'http://127.0.0.1:8081/');
  });

  it('updates the requested active scope when multiple scoped settings records exist', async () => {
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
    expect(JSON.parse(values.get(`mmkv.default\\pending-account-settings:v2:${suffixB}`) ?? '{}')).toEqual({
      experiments: true,
      featureToggles: {
        'files.diffSyntaxHighlighting': true,
      },
    });
    expect(values.has(`mmkv.default\\pending-account-settings:v2:${suffixA}`)).toBe(false);
  });

  it('can update every scoped settings record and reload a requested URL', async () => {
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
      featureId: 'connectedServices',
      enabled: true,
      applyToAllScopes: true,
      reloadUrl: 'http://127.0.0.1:8081/new?happier_hmr=0',
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
    expect(gotoDomContentLoadedWithRetries).toHaveBeenCalledWith(
      page,
      'http://127.0.0.1:8081/new?happier_hmr=0',
    );
  });
});
