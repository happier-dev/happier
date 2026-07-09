import type { Page } from '@playwright/test';

import type { UiE2eAccountSettingsScope } from './accountSettingsScopeKeySuffix';
import { gotoDomContentLoadedWithRetries } from './pageNavigation';
import { mutateUiE2eScopedAccountSettings } from './scopedAccountSettingsStorage';

export async function setUiFeatureToggle(params: Readonly<{
  page: Page;
  baseUrl: string;
  featureId: string;
  enabled: boolean;
  settingsScope?: UiE2eAccountSettingsScope;
  applyToAllScopes?: boolean;
  reloadUrl?: string;
}>): Promise<void> {
  await mutateUiE2eScopedAccountSettings({
    page: params.page,
    settingsScope: params.settingsScope,
    applyToAllScopes: params.applyToAllScopes,
    experiments: true,
    featureToggles: {
      [params.featureId]: params.enabled,
    },
  });

  const reloadUrl = String(params.reloadUrl ?? '').trim() || `${params.baseUrl}/`;
  await gotoDomContentLoadedWithRetries(params.page, reloadUrl);
}
