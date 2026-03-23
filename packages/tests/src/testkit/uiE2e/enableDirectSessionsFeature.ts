import type { Page } from '@playwright/test';

import { setUiFeatureToggle } from './setUiFeatureToggle';

export async function enableDirectSessionsFeature(page: Page, baseUrl: string): Promise<void> {
  await setUiFeatureToggle({
    page,
    baseUrl,
    featureId: 'sessions.direct',
    enabled: true,
  });
}
