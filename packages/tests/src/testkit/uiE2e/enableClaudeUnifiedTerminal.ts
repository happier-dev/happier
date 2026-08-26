import { expect, type Page } from '@playwright/test';

import { gotoDomContentLoadedWithRetries } from './pageNavigation';
import { setUiFeatureToggle } from './setUiFeatureToggle';

export async function enableClaudeUnifiedTerminal(params: Readonly<{
  page: Page;
  uiBaseUrl: string;
}>): Promise<void> {
  await setUiFeatureToggle({
    page: params.page,
    baseUrl: params.uiBaseUrl,
    featureId: 'providers.claude.unifiedTerminal',
    enabled: true,
  });

  await gotoDomContentLoadedWithRetries(params.page, `${params.uiBaseUrl}/settings/providers/claude`);
  const unifiedToggle = params.page.getByTestId('settings-provider-field-claudeUnifiedTerminalEnabled');
  await expect(unifiedToggle).toHaveCount(1, { timeout: 60_000 });

  const input = unifiedToggle.locator('input[type="checkbox"]').first();
  if ((await input.count()) > 0) {
    if (!(await input.isChecked().catch(() => false))) {
      await unifiedToggle.click();
      await expect(input).toBeChecked({ timeout: 60_000 });
    }
    return;
  }

  await unifiedToggle.click();
}
