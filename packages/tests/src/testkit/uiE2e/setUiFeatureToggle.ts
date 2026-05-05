import type { Page } from '@playwright/test';

import { gotoDomContentLoadedWithRetries } from './pageNavigation';

type PersistedSettingsEnvelope = {
  settings?: Record<string, unknown>;
};

type PendingSettingsEnvelope = Readonly<Record<string, unknown>>;

type AccountSettingsScope = Readonly<{
  serverId: string;
  accountId: string;
}>;

export async function setUiFeatureToggle(params: Readonly<{
  page: Page;
  baseUrl: string;
  featureId: string;
  enabled: boolean;
  settingsScope?: AccountSettingsScope;
}>): Promise<void> {
  await params.page.evaluate(
    ({ featureId, enabled, settingsScope }) => {
      const mergeFeatureToggleMap = (raw: unknown): Record<string, boolean> => {
        const map = typeof raw === 'object' && raw ? (raw as Record<string, unknown>) : {};
        return {
          ...Object.fromEntries(
            Object.entries(map).filter(([, value]) => typeof value === 'boolean') as Array<[string, boolean]>,
          ),
          [featureId]: enabled,
        };
      };
      const encodeScopePart = (value: string): string => `${value.length}:${value}`;
      const accountSettingsScopeKeySuffix = (scope: AccountSettingsScope): string =>
        `${encodeScopePart(scope.serverId)}${encodeScopePart(scope.accountId)}`;
      const settingsKeyPrefix = 'mmkv.default\\account-settings:v2:';
      const pendingSettingsKeyPrefix = 'mmkv.default\\pending-account-settings:v2:';
      const scopedSettingsKeys: string[] = [];
      for (let index = 0; index < window.localStorage.length; index += 1) {
        const key = window.localStorage.key(index);
        if (key?.startsWith(settingsKeyPrefix)) scopedSettingsKeys.push(key);
      }
      if (scopedSettingsKeys.length === 0) throw new Error('missing scoped persisted settings');
      const requestedSettingsKey = settingsScope
        ? `${settingsKeyPrefix}${accountSettingsScopeKeySuffix(settingsScope)}`
        : null;
      const settingsKey = requestedSettingsKey
        ? scopedSettingsKeys.find((key) => key === requestedSettingsKey)
        : scopedSettingsKeys.length === 1
          ? scopedSettingsKeys[0]
          : null;
      if (!settingsKey) {
        throw new Error(
          requestedSettingsKey
            ? 'missing scoped persisted settings for requested account scope'
            : `settingsScope is required when multiple scoped persisted settings records exist (${scopedSettingsKeys.length})`,
        );
      }
      const pendingSettingsKey = `${pendingSettingsKeyPrefix}${settingsKey.slice(settingsKeyPrefix.length)}`;
      const rawSettings = window.localStorage.getItem(settingsKey);
      if (!rawSettings) throw new Error('missing persisted settings');

      const parsed = JSON.parse(rawSettings) as PersistedSettingsEnvelope;
      const settings = typeof parsed.settings === 'object' && parsed.settings ? parsed.settings : {};
      const rawPending = window.localStorage.getItem(pendingSettingsKey);
      const pending = rawPending ? (JSON.parse(rawPending) as PendingSettingsEnvelope) : {};

      const featureToggles = mergeFeatureToggleMap(settings.featureToggles);
      const pendingFeatureToggles = mergeFeatureToggleMap((pending as any).featureToggles);

      parsed.settings = {
        ...settings,
        experiments: true,
        featureToggles,
      };

      window.localStorage.setItem(settingsKey, JSON.stringify(parsed));
      window.localStorage.setItem(
        pendingSettingsKey,
        JSON.stringify({
          ...pending,
          experiments: true,
          featureToggles: pendingFeatureToggles,
        }),
      );
    },
    { featureId: params.featureId, enabled: params.enabled, settingsScope: params.settingsScope },
  );

  await gotoDomContentLoadedWithRetries(params.page, `${params.baseUrl}/`);
}
