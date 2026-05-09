import { afterEach, describe, expect, it, vi } from 'vitest';

import { gotoDomContentLoadedWithRetries } from '../uiE2e/pageNavigation';
import { setSingleAccountPetsEnabled, setSingleAccountUiFeatureToggle } from './uiPetsFeatureToggle';

vi.mock('../uiE2e/pageNavigation', () => ({
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

describe('uiPetsFeatureToggle', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(globalThis, 'window');
  });

  it('sets companion feature toggle and refreshes with hmr disabled', async () => {
    const values = new Map<string, string>();
    const storageNamespace = 'mmkv.e2e-pets-settings-scope';
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
      version: 1,
    }));
    values.set(pendingSettingsKey, JSON.stringify({
      featureToggles: {
        pendingFeature: true,
      },
    }));

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { localStorage: createLocalStorage(values) },
    });

    const page = {
      evaluate: async (fn: (args: unknown) => unknown, args: unknown) => fn(args),
    };

    await setSingleAccountUiFeatureToggle({
      page: page as never,
      baseUrl: 'http://127.0.0.1:8081',
      featureId: 'pets.companion',
      enabled: true,
    });

    const savedSettings = JSON.parse(values.get(settingsKey) ?? '{}');
    expect(savedSettings.settings.featureToggles).toMatchObject({
      existingFeature: false,
      'pets.companion': true,
    });
    const savedPending = JSON.parse(values.get(pendingSettingsKey) ?? '{}');
    expect(savedPending.featureToggles).toMatchObject({
      pendingFeature: true,
      'pets.companion': true,
    });
    expect(gotoDomContentLoadedWithRetries).toHaveBeenCalledWith(
      page,
      'http://127.0.0.1:8081/?happier_hmr=0',
      180_000,
    );
  });

  it('sets pets enabled override and refreshes with hmr disabled', async () => {
    const values = new Map<string, string>();
    const storageNamespace = 'mmkv.e2e-pets-settings-scope';
    const suffix = '8:server-a9:account-a';
    const settingsKey = `${storageNamespace}\\account-settings:v2:${suffix}`;
    const pendingSettingsKey = `${storageNamespace}\\pending-account-settings:v2:${suffix}`;
    values.set(settingsKey, JSON.stringify({
      settings: {
        petsEnabled: false,
      },
      version: 1,
    }));
    values.set(pendingSettingsKey, JSON.stringify({
      petsEnabled: false,
    }));

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { localStorage: createLocalStorage(values) },
    });

    const page = {
      evaluate: async (fn: (args: unknown) => unknown, args: unknown) => fn(args),
    };

    await setSingleAccountPetsEnabled({
      page: page as never,
      baseUrl: 'http://127.0.0.1:8081',
      enabled: true,
    });

    const savedSettings = JSON.parse(values.get(settingsKey) ?? '{}');
    expect(savedSettings.settings).toMatchObject({
      petsEnabled: true,
    });
    const savedPending = JSON.parse(values.get(pendingSettingsKey) ?? '{}');
    expect(savedPending).toMatchObject({
      petsEnabled: true,
    });
    expect(gotoDomContentLoadedWithRetries).toHaveBeenCalledWith(
      page,
      'http://127.0.0.1:8081/?happier_hmr=0',
      180_000,
    );
  });
});
