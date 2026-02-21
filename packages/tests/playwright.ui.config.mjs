// @ts-check
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'suites/ui-e2e',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list'], ['html']],
  outputDir: '.project/logs/e2e/ui-playwright',
  use: {
    testIdAttribute: 'data-testid',
    // Keep UI e2e deterministic by avoiding responsive split-view layouts.
    // A phone-sized viewport ensures a single primary navigation stack on Expo web.
    viewport: { width: 390, height: 844 },
    actionTimeout: 15_000,
    navigationTimeout: 90_000,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
});
