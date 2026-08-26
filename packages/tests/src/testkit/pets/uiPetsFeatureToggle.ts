import type { Page } from '@playwright/test';

import { gotoDomContentLoadedWithRetries } from '../uiE2e/pageNavigation';
import {
  mutateUiE2eScopedAccountSettings,
  type UiE2eScopedAccountSettingsMutation,
} from '../uiE2e/scopedAccountSettingsStorage';

type SingleAccountSettingsUpdate = Readonly<{
  page: Page;
  baseUrl: string;
  featureToggles?: UiE2eScopedAccountSettingsMutation['featureToggles'];
  settingsPatch?: UiE2eScopedAccountSettingsMutation['settingsPatch'];
}>;

async function updateSingleAccountSettings(params: SingleAccountSettingsUpdate): Promise<void> {
  await mutateUiE2eScopedAccountSettings({
    page: params.page,
    experiments: params.featureToggles ? true : undefined,
    featureToggles: params.featureToggles,
    settingsPatch: params.settingsPatch,
  });

  await gotoDomContentLoadedWithRetries(params.page, `${params.baseUrl}/?happier_hmr=0`, 180_000);
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
