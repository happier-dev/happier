import type { Page } from '@playwright/test';

import {
  accountSettingsScopeKeySuffix,
  type AccountSettingsScope,
} from '../../../../../apps/ui/sources/sync/domains/settings/scope/accountSettingsScope';

import { gotoDomContentLoadedWithRetries } from './pageNavigation';

type PersistedSettingsEnvelope = {
  settings?: Record<string, unknown>;
};

type PendingSettingsEnvelope = Readonly<Record<string, unknown>>;

export async function setUiFeatureToggle(params: Readonly<{
  page: Page;
  baseUrl: string;
  featureId: string;
  enabled: boolean;
  settingsScope?: AccountSettingsScope;
}>): Promise<void> {
  const scopedSettingsSuffix = params.settingsScope ? accountSettingsScopeKeySuffix(params.settingsScope) : null;

  await params.page.evaluate(
    ({
      featureId,
      enabled,
      scopedSettingsSuffix,
    }) => {
      const mergeFeatureToggleMap = (raw: unknown): Record<string, boolean> => {
        const map = typeof raw === 'object' && raw ? (raw as Record<string, unknown>) : {};
        return {
          ...Object.fromEntries(
            Object.entries(map).filter(([, value]) => typeof value === 'boolean') as Array<[string, boolean]>,
          ),
          [featureId]: enabled,
        };
      };
      const accountSettingsLogicalKeyPrefix = 'account-settings:v2:';
      const pendingAccountSettingsLogicalKeyPrefix = 'pending-account-settings:v2:';
      type ParsedScopedSettingsKey = Readonly<{
        fullKey: string;
        logicalKey: string;
        storageNamespace: string;
      }>;
      const parseScopedSettingsKey = (rawKey: string): ParsedScopedSettingsKey | null => {
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

      const scopedSettingsKeys: ParsedScopedSettingsKey[] = [];
      for (let index = 0; index < window.localStorage.length; index += 1) {
        const rawKey = window.localStorage.key(index);
        if (!rawKey) continue;

        const parsedKey = parseScopedSettingsKey(rawKey);
        if (parsedKey) scopedSettingsKeys.push(parsedKey);
      }
      if (scopedSettingsKeys.length === 0) throw new Error('missing scoped persisted settings');

      const requestedLogicalKey = scopedSettingsSuffix
        ? `${accountSettingsLogicalKeyPrefix}${scopedSettingsSuffix}`
        : null;

      const settingsKey = requestedLogicalKey
        ? scopedSettingsKeys.find((key) => key.logicalKey === requestedLogicalKey)
        : scopedSettingsKeys.length === 1
          ? scopedSettingsKeys[0]!
          : null;
      if (!settingsKey) {
        throw new Error(
          requestedLogicalKey
            ? 'missing scoped persisted settings for requested account scope'
            : `settingsScope is required when multiple scoped persisted settings records exist (${scopedSettingsKeys.length})`,
        );
      }

      const pendingSettingsKey = `${settingsKey.storageNamespace}\\${pendingAccountSettingsLogicalKeyPrefix}${settingsKey.logicalKey.slice(accountSettingsLogicalKeyPrefix.length)}`;
      const rawSettings = window.localStorage.getItem(settingsKey.fullKey);
      if (!rawSettings) throw new Error('missing persisted settings');

      const parsed = JSON.parse(rawSettings) as PersistedSettingsEnvelope;
      const settings = typeof parsed.settings === 'object' && parsed.settings ? parsed.settings : {};
      const rawPending = window.localStorage.getItem(pendingSettingsKey);
      const pending = rawPending ? (JSON.parse(rawPending) as PendingSettingsEnvelope) : {};

      const featureToggles = mergeFeatureToggleMap(settings.featureToggles);
      const pendingFeatureToggles = mergeFeatureToggleMap(pending.featureToggles);

      parsed.settings = {
        ...settings,
        experiments: true,
        featureToggles,
      };

      window.localStorage.setItem(settingsKey.fullKey, JSON.stringify(parsed));
      window.localStorage.setItem(
        pendingSettingsKey,
        JSON.stringify({
          ...pending,
          experiments: true,
          featureToggles: pendingFeatureToggles,
        }),
      );
    },
    { featureId: params.featureId, enabled: params.enabled, scopedSettingsSuffix },
  );

  await gotoDomContentLoadedWithRetries(params.page, `${params.baseUrl}/`);
}
