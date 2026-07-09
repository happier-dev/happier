import type { Page } from '@playwright/test';

import {
  accountSettingsScopeKeySuffix,
  type UiE2eAccountSettingsScope,
} from './accountSettingsScopeKeySuffix';

type JsonObject = Record<string, unknown>;

type ScopedAccountSettingsKey = Readonly<{
  fullKey: string;
  logicalKey: string;
  storageNamespace: string;
}>;

export type UiE2eScopedAccountSettingsMutation = Readonly<{
  settingsPatch?: JsonObject;
  pendingPatch?: JsonObject;
  featureToggles?: Record<string, boolean>;
  experiments?: boolean;
  settingsScope?: UiE2eAccountSettingsScope;
  applyToAllScopes?: boolean;
}>;

type BrowserMutationArgs = Readonly<{
  applyToAllScopes: boolean;
  experiments: boolean | null;
  featureToggles: Record<string, boolean>;
  pendingPatch: JsonObject;
  scopedSettingsSuffix: string | null;
  settingsPatch: JsonObject;
}>;

type BrowserReadArgs = Readonly<{
  scopedSettingsSuffix: string | null;
}>;

async function waitForScopedPersistedSettings(page: Page): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const hasSettings = await page.evaluate(() => {
      const accountSettingsLogicalKeyPrefix = 'account-settings:v2:';
      for (let index = 0; index < window.localStorage.length; index += 1) {
        const rawKey = window.localStorage.key(index);
        if (rawKey?.includes(`\\${accountSettingsLogicalKeyPrefix}`)) return true;
      }
      return false;
    }).catch(() => false);
    if (hasSettings) return;
    await page.waitForTimeout(250);
  }
}

export async function mutateUiE2eScopedAccountSettings(
  params: Readonly<{ page: Page }> & UiE2eScopedAccountSettingsMutation,
): Promise<void> {
  await waitForScopedPersistedSettings(params.page);
  const scopedSettingsSuffix = params.settingsScope ? accountSettingsScopeKeySuffix(params.settingsScope) : null;
  await params.page.evaluate(
    (args: BrowserMutationArgs) => {
      const accountSettingsLogicalKeyPrefix = 'account-settings:v2:';
      const pendingAccountSettingsLogicalKeyPrefix = 'pending-account-settings:v2:';
      const isRecord = (value: unknown): value is JsonObject =>
        typeof value === 'object' && value !== null && !Array.isArray(value);
      const parseScopedSettingsKey = (rawKey: string): ScopedAccountSettingsKey | null => {
        const separatorIndex = rawKey.lastIndexOf('\\');
        if (separatorIndex <= 0 || separatorIndex >= rawKey.length - 1) return null;

        const storageNamespace = rawKey.slice(0, separatorIndex);
        const logicalKey = rawKey.slice(separatorIndex + 1);
        if (!logicalKey.startsWith(accountSettingsLogicalKeyPrefix)) return null;

        return {
          fullKey: rawKey,
          logicalKey,
          storageNamespace,
        };
      };
      const readScopedSettingsKeys = (): ScopedAccountSettingsKey[] => {
        const keys: ScopedAccountSettingsKey[] = [];
        for (let index = 0; index < window.localStorage.length; index += 1) {
          const rawKey = window.localStorage.key(index);
          if (!rawKey) continue;

          const parsedKey = parseScopedSettingsKey(rawKey);
          if (parsedKey) keys.push(parsedKey);
        }
        return keys;
      };
      const selectScopedSettingsKeys = (keys: ScopedAccountSettingsKey[]): ScopedAccountSettingsKey[] | null => {
        const requestedLogicalKey = args.scopedSettingsSuffix
          ? `${accountSettingsLogicalKeyPrefix}${args.scopedSettingsSuffix}`
          : null;
        if (requestedLogicalKey) {
          const requested = keys.find((key) => key.logicalKey === requestedLogicalKey);
          return requested ? [requested] : null;
        }
        if (args.applyToAllScopes) return keys;
        return keys.length === 1 ? [keys[0]!] : null;
      };
      const mergeFeatureToggleMap = (raw: unknown): Record<string, boolean> => {
        const map = isRecord(raw) ? raw : {};
        return {
          ...Object.fromEntries(
            Object.entries(map).filter(([, value]) => typeof value === 'boolean') as Array<[string, boolean]>,
          ),
          ...args.featureToggles,
        };
      };
      const featureToggleEntries = Object.entries(args.featureToggles);
      const shouldWriteFeatureToggles = featureToggleEntries.length > 0;
      const scopedSettingsKeys = readScopedSettingsKeys();
      if (scopedSettingsKeys.length === 0) throw new Error('missing scoped persisted settings');

      const selectedKeys = selectScopedSettingsKeys(scopedSettingsKeys);
      if (!selectedKeys) {
        throw new Error(
          args.scopedSettingsSuffix
            ? 'missing scoped persisted settings for requested account scope'
            : `settingsScope is required when multiple scoped persisted settings records exist (${scopedSettingsKeys.length})`,
        );
      }

      for (const settingsKey of selectedKeys) {
        const pendingSettingsKey = `${settingsKey.storageNamespace}\\${pendingAccountSettingsLogicalKeyPrefix}${settingsKey.logicalKey.slice(accountSettingsLogicalKeyPrefix.length)}`;
        const rawSettings = window.localStorage.getItem(settingsKey.fullKey);
        if (!rawSettings) throw new Error('missing persisted settings');

        const parsedEnvelope = JSON.parse(rawSettings);
        const envelope = isRecord(parsedEnvelope) ? parsedEnvelope : {};
        const settings = isRecord(envelope.settings) ? envelope.settings : {};
        const rawPending = window.localStorage.getItem(pendingSettingsKey);
        const parsedPending = rawPending ? JSON.parse(rawPending) : {};
        const pending = isRecord(parsedPending) ? parsedPending : {};
        const nextSettings: JsonObject = { ...settings, ...args.settingsPatch };
        const nextPending: JsonObject = { ...pending, ...args.pendingPatch };
        if (args.experiments !== null) {
          nextSettings.experiments = args.experiments;
          nextPending.experiments = args.experiments;
        }
        if (shouldWriteFeatureToggles) {
          nextSettings.featureToggles = mergeFeatureToggleMap(settings.featureToggles);
          nextPending.featureToggles = mergeFeatureToggleMap(pending.featureToggles);
        }

        window.localStorage.setItem(settingsKey.fullKey, JSON.stringify({
          ...envelope,
          settings: nextSettings,
        }));
        window.localStorage.setItem(pendingSettingsKey, JSON.stringify(nextPending));
      }
    },
    {
      applyToAllScopes: params.applyToAllScopes === true,
      experiments: typeof params.experiments === 'boolean' ? params.experiments : null,
      featureToggles: params.featureToggles ?? {},
      pendingPatch: params.pendingPatch ?? params.settingsPatch ?? {},
      scopedSettingsSuffix,
      settingsPatch: params.settingsPatch ?? {},
    },
  );
}

export async function readUiE2eScopedAccountSettings(params: Readonly<{
  page: Page;
  settingsScope?: UiE2eAccountSettingsScope;
}>): Promise<JsonObject> {
  const scopedSettingsSuffix = params.settingsScope ? accountSettingsScopeKeySuffix(params.settingsScope) : null;
  return params.page.evaluate(
    (args: BrowserReadArgs) => {
      const accountSettingsLogicalKeyPrefix = 'account-settings:v2:';
      const isRecord = (value: unknown): value is JsonObject =>
        typeof value === 'object' && value !== null && !Array.isArray(value);
      const keys: ScopedAccountSettingsKey[] = [];
      for (let index = 0; index < window.localStorage.length; index += 1) {
        const rawKey = window.localStorage.key(index);
        if (!rawKey) continue;

        const separatorIndex = rawKey.lastIndexOf('\\');
        if (separatorIndex <= 0 || separatorIndex >= rawKey.length - 1) continue;

        const storageNamespace = rawKey.slice(0, separatorIndex);
        const logicalKey = rawKey.slice(separatorIndex + 1);
        if (logicalKey.startsWith(accountSettingsLogicalKeyPrefix)) {
          keys.push({ fullKey: rawKey, logicalKey, storageNamespace });
        }
      }
      if (keys.length === 0) throw new Error('missing scoped persisted settings');

      const requestedLogicalKey = args.scopedSettingsSuffix
        ? `${accountSettingsLogicalKeyPrefix}${args.scopedSettingsSuffix}`
        : null;
      const settingsKey = requestedLogicalKey
        ? keys.find((key) => key.logicalKey === requestedLogicalKey)
        : keys.length === 1
          ? keys[0]!
          : null;
      if (!settingsKey) {
        throw new Error(
          requestedLogicalKey
            ? 'missing scoped persisted settings for requested account scope'
            : `settingsScope is required when multiple scoped persisted settings records exist (${keys.length})`,
        );
      }

      const rawSettings = window.localStorage.getItem(settingsKey.fullKey);
      if (!rawSettings) throw new Error('missing persisted settings');

      const parsedEnvelope = JSON.parse(rawSettings);
      const envelope = isRecord(parsedEnvelope) ? parsedEnvelope : {};
      return isRecord(envelope.settings) ? envelope.settings : {};
    },
    { scopedSettingsSuffix },
  );
}
