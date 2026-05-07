import type { Page } from '@playwright/test';

import { gotoDomContentLoadedWithRetries } from '../uiE2e/pageNavigation';

type SingleAccountSettingsUpdate = Readonly<{
  page: Page;
  baseUrl: string;
  featureToggles?: Readonly<Record<string, boolean>>;
  settingsPatch?: Readonly<Record<string, unknown>>;
}>;

async function updateSingleAccountSettings(params: SingleAccountSettingsUpdate): Promise<void> {
  await params.page.evaluate(
    ({ featureToggles, settingsPatch }) => {
      const accountSettingsLogicalKeyPrefix = 'account-settings:v2:';
      const pendingAccountSettingsLogicalKeyPrefix = 'pending-account-settings:v2:';
      const parseSettings = (raw: string | null): Record<string, unknown> => {
        if (!raw) return {};
        const parsed = JSON.parse(raw) as unknown;
        return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
          ? parsed as Record<string, unknown>
          : {};
      };
      const readObjectRecord = (raw: unknown): Record<string, unknown> => (
        typeof raw === 'object' && raw !== null && !Array.isArray(raw)
          ? raw as Record<string, unknown>
          : {}
      );
      const mergeFeatureToggleMap = (raw: unknown): Record<string, boolean> => {
        const map = readObjectRecord(raw);
        return {
          ...Object.fromEntries(
            Object.entries(map).filter(([, value]) => typeof value === 'boolean') as Array<[string, boolean]>,
          ),
          ...(featureToggles ?? {}),
        };
      };
      const applySettingsPatch = (raw: Record<string, unknown>): Record<string, unknown> => {
        const next = {
          ...raw,
          ...(settingsPatch ?? {}),
        };
        if (featureToggles) {
          next.experiments = true;
          next.featureToggles = mergeFeatureToggleMap(raw.featureToggles);
        }
        return next;
      };

      const scopedSettingsKeys: Array<{ fullKey: string; logicalKey: string; storageNamespace: string }> = [];
      for (let index = 0; index < window.localStorage.length; index += 1) {
        const rawKey = window.localStorage.key(index);
        if (!rawKey) continue;
        const separatorIndex = rawKey.lastIndexOf('\\');
        if (separatorIndex <= 0 || separatorIndex >= rawKey.length - 1) continue;
        const storageNamespace = rawKey.slice(0, separatorIndex);
        const logicalKey = rawKey.slice(separatorIndex + 1);
        if (!logicalKey.startsWith(accountSettingsLogicalKeyPrefix)) continue;
        scopedSettingsKeys.push({ fullKey: rawKey, logicalKey, storageNamespace });
      }
      if (scopedSettingsKeys.length !== 1) {
        throw new Error(`expected one scoped persisted settings record, got ${scopedSettingsKeys.length}`);
      }

      const settingsKey = scopedSettingsKeys[0]!;
      const pendingSettingsKey = `${settingsKey.storageNamespace}\\${pendingAccountSettingsLogicalKeyPrefix}${settingsKey.logicalKey.slice(accountSettingsLogicalKeyPrefix.length)}`;
      const parsed = parseSettings(window.localStorage.getItem(settingsKey.fullKey));
      const settings = readObjectRecord(parsed.settings);
      const pending = parseSettings(window.localStorage.getItem(pendingSettingsKey));

      window.localStorage.setItem(
        settingsKey.fullKey,
        JSON.stringify({
          ...parsed,
          settings: applySettingsPatch(settings),
        }),
      );
      window.localStorage.setItem(
        pendingSettingsKey,
        JSON.stringify(applySettingsPatch(pending)),
      );
    },
    { featureToggles: params.featureToggles, settingsPatch: params.settingsPatch },
  );

  await gotoDomContentLoadedWithRetries(params.page, `${params.baseUrl}/`);
}

export async function setSingleAccountUiFeatureToggle(params: Readonly<{
  page: Page;
  baseUrl: string;
  featureId: string;
  enabled: boolean;
}>): Promise<void> {
  await updateSingleAccountSettings({
    page: params.page,
    baseUrl: params.baseUrl,
    featureToggles: { [params.featureId]: params.enabled },
  });
}

export async function setSingleAccountPetsEnabled(params: Readonly<{
  page: Page;
  baseUrl: string;
  enabled: boolean;
}>): Promise<void> {
  await updateSingleAccountSettings({
    page: params.page,
    baseUrl: params.baseUrl,
    settingsPatch: { petsEnabled: params.enabled },
  });
}
