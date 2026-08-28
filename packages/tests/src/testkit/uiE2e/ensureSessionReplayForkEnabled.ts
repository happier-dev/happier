import { expect, type Page } from '@playwright/test';

async function ensureSessionSettingsSwitchEnabled(params: Readonly<{
  page: Page;
  route: string;
  testId: string;
}>): Promise<void> {
  await gotoDomContentLoadedWithPathFallback(
    params.page,
    params.route,
    new URL(params.route).pathname,
  );

  const item = params.page.getByTestId(params.testId);
  await expect(item).toHaveCount(1, { timeout: 60_000 });

  const toggle = item.getByRole('switch');
  await expect(toggle).toHaveCount(1, { timeout: 60_000 });
  if ((await toggle.getAttribute('aria-checked')) !== 'true') {
    await item.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true', { timeout: 60_000 });
  }
}

export async function ensureSessionReplayForkEnabled(params: Readonly<{
  page: Page;
  uiBaseUrl: string;
}>): Promise<void> {
  await ensureSessionSettingsSwitchEnabled({
    page: params.page,
    route: `${params.uiBaseUrl}/settings/session/resume`,
    testId: 'settings-session-replay-enabled-item',
  });
}

export async function ensureSessionTranscriptToolCallsGrouped(params: Readonly<{
  page: Page;
  uiBaseUrl: string;
}>): Promise<void> {
  await ensureSessionSettingsSwitchEnabled({
    page: params.page,
    route: `${params.uiBaseUrl}/settings/session/transcript`,
    testId: 'settings-session-transcript-tool-calls-group',
  });
}
