import type { Page } from '@playwright/test';

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
}>): Promise<void> {
  await params.page.evaluate(
    ({ featureId, enabled }) => {
      const mergeFeatureToggleMap = (raw: unknown): Record<string, boolean> => {
        const map = typeof raw === 'object' && raw ? (raw as Record<string, unknown>) : {};
        return {
          ...Object.fromEntries(
            Object.entries(map).filter(([, value]) => typeof value === 'boolean') as Array<[string, boolean]>,
          ),
          [featureId]: enabled,
        };
      };
      const settingsKey = 'mmkv.default\\settings';
      const pendingSettingsKey = 'mmkv.default\\pending-settings';
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
    { featureId: params.featureId, enabled: params.enabled },
  );

  await gotoDomContentLoadedWithRetries(params.page, `${params.baseUrl}/`);
}
