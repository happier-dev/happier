import type { Page } from '@playwright/test';

type JsonObject = Record<string, unknown>;

type BrowserMutationArgs = Readonly<{
  storageKey: string;
  settingsPatch: JsonObject;
}>;

type BrowserReadArgs = Readonly<{
  storageKey: string;
}>;

const LOCAL_SETTINGS_STORAGE_KEY = 'mmkv.default\\local-settings';

export async function mutateUiE2eLocalSettings(params: Readonly<{
  page: Page;
  settingsPatch: JsonObject;
}>): Promise<void> {
  await params.page.evaluate(
    (args: BrowserMutationArgs) => {
      const isBrowserRecord = (value: unknown): value is JsonObject =>
        typeof value === 'object' && value !== null && !Array.isArray(value);
      const raw = window.localStorage.getItem(args.storageKey);
      const parsed = raw ? JSON.parse(raw) : {};
      const settings = isBrowserRecord(parsed) ? parsed : {};
      window.localStorage.setItem(args.storageKey, JSON.stringify({
        ...settings,
        ...args.settingsPatch,
      }));
    },
    { settingsPatch: params.settingsPatch, storageKey: LOCAL_SETTINGS_STORAGE_KEY },
  );
}

export async function readUiE2eLocalSettings(params: Readonly<{
  page: Page;
}>): Promise<JsonObject> {
  return params.page.evaluate((args: BrowserReadArgs) => {
    const isBrowserRecord = (value: unknown): value is JsonObject =>
      typeof value === 'object' && value !== null && !Array.isArray(value);
    const raw = window.localStorage.getItem(args.storageKey);
    const parsed = raw ? JSON.parse(raw) : {};
    return isBrowserRecord(parsed) ? parsed : {};
  }, { storageKey: LOCAL_SETTINGS_STORAGE_KEY });
}
