import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { createRunDirs } from '../../src/testkit/runDir';
import { createTestAuth } from '../../src/testkit/auth';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { writeUsageEvent } from '../../src/testkit/usageAnalytics';
import {
  gotoDomContentLoadedWithRetries,
  normalizeLoopbackBaseUrl,
  waitForAuthenticatedRouteUi,
} from '../../src/testkit/uiE2e/pageNavigation';
import { buildAuthBootstrapStorageSnapshot } from '../../src/testkit/uiE2e/buildAuthBootstrapStorageSnapshot';
import { installAuthBootstrapStorageSnapshot } from '../../src/testkit/uiE2e/readLegacyAuthSecretFromLocalStorage';
import { createSession } from '../../src/testkit/sessions';

const run = createRunDirs({ runLabel: 'ui-e2e' });
const dashboardTestIds = [
  'usage-filter-period',
  'usage-filter-metric',
  'usage-filter-cost-mode',
  'usage-summary-total-card',
  'usage-insights-section',
  'usage-activity-section',
  'usage-activity-track-months',
  'usage-activity-track-weekdays',
  'usage-activity-track-hours',
  'usage-timeline-section',
  'usage-model-timeline-card',
  'usage-engine-timeline-card',
  'usage-leaders-section',
  'usage-recap-section',
  'usage-export-actions',
  'usage-breakdown-row-provider-anthropic',
  'usage-breakdown-row-model-claude-3.7-sonnet',
  'usage-breakdown-row-provider-openai',
] as const;

test.describe('ui e2e: usage dashboard', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('usage-dashboard-suite');

  let server: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let uiBaseUrl: string | null = null;

  test.beforeAll(async () => {
    const uiWebEnv = {
      ...process.env,
      EXPO_PUBLIC_DEBUG: '1',
      EXPO_PUBLIC_HAPPY_SERVER_URL: server?.baseUrl ?? '',
      EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-usage-dashboard-${run.runId}`,
      HAPPIER_E2E_UI_WEB_MODE: 'export',
      HAPPIER_E2E_UI_WEB_EXPORT_TIMEOUT_MS: process.env.HAPPIER_E2E_UI_WEB_EXPORT_TIMEOUT_MS ?? '900000',
      HAPPIER_E2E_UI_WEB_EXPORT_STARTUP_STALL_TIMEOUT_MS:
        process.env.HAPPIER_E2E_UI_WEB_EXPORT_STARTUP_STALL_TIMEOUT_MS ?? '600000',
      HAPPIER_E2E_UI_WEB_EXPORT_FALLBACK_TO_METRO: '0',
      HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_TIMEOUT_MS: process.env.HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_TIMEOUT_MS ?? '480000',
    };
    test.setTimeout(resolveUiWebBeforeAllTimeoutMs(uiWebEnv));
    await mkdir(suiteDir, { recursive: true });

    server = await startServerLight({
      testDir: suiteDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
      },
    });

    ui = await startUiWeb({
      testDir: suiteDir,
      env: {
        ...uiWebEnv,
        EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl,
      },
    });

    uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
  });

  test.afterAll(async () => {
    test.setTimeout(120_000);
    await ui?.stop().catch(() => {});
    await server?.stop().catch(() => {});
  });

  test('loads the settings usage summary and premium v2 dashboard sections', async ({ page }) => {
    test.setTimeout(540_000);
    if (!server || !uiBaseUrl) throw new Error('missing fixtures');

    const auth = await createTestAuth(server.baseUrl);
    await installAuthBootstrapStorageSnapshot(page, buildAuthBootstrapStorageSnapshot({
      serverUrl: server.baseUrl,
      auth,
      mode: 'legacy',
      storageScope: `e2e-usage-dashboard-${run.runId}`,
    }));
    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/settings?happier_hmr=0`, 420_000);

    const token = auth.token;
    const sessionAlpha = await createSession(server.baseUrl, token);
    const sessionBeta = await createSession(server.baseUrl, token);
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;

    await writeUsageEvent({
      baseUrl: server.baseUrl,
      token,
      request: {
        sessionId: sessionAlpha.sessionId,
        observedAt: now - 2 * day,
        agentId: 'claude',
        backendMode: 'claude:remote',
        modelId: 'claude-3.7-sonnet',
        projectKey: 'project-a',
        workspaceId: 'workspace-a',
        source: 'claude_sdk',
        scope: 'turn_delta',
        externalKey: 'usage-dashboard-alpha-turn-1',
        turnId: 'turn-1',
        isCumulative: false,
        tokens: { input: 90, output: 30, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 120 },
        cost: { reportedUsd: 1.75, estimatedUsd: 1.25, currency: 'USD', costSource: 'provider_reported', billingContext: 'api_usage' },
      },
    });
    await writeUsageEvent({
      baseUrl: server.baseUrl,
      token,
      request: {
        sessionId: sessionAlpha.sessionId,
        observedAt: now - day,
        agentId: 'claude',
        backendMode: 'claude:remote',
        modelId: 'claude-3.7-sonnet',
        projectKey: 'project-a',
        workspaceId: 'workspace-a',
        source: 'claude_sdk',
        scope: 'turn_delta',
        externalKey: 'usage-dashboard-alpha-turn-2',
        turnId: 'turn-2',
        isCumulative: false,
        tokens: { input: 42, output: 18, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 60 },
        cost: { reportedUsd: 0.85, estimatedUsd: 0.55, currency: 'USD', costSource: 'provider_reported', billingContext: 'api_usage' },
      },
    });
    await writeUsageEvent({
      baseUrl: server.baseUrl,
      token,
      request: {
        sessionId: sessionAlpha.sessionId,
        observedAt: now,
        agentId: 'codex',
        backendMode: 'codex:app-server',
        modelId: 'gpt-5-codex',
        projectKey: 'project-b',
        workspaceId: 'workspace-a',
        source: 'codex_app_server',
        scope: 'turn_delta',
        externalKey: 'usage-dashboard-alpha-turn-3',
        turnId: 'turn-3',
        isCumulative: false,
        tokens: { input: 30, output: 14, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 44 },
        cost: { reportedUsd: 0.5, estimatedUsd: 0.42, currency: 'USD', costSource: 'pricing_estimate', billingContext: 'api_usage' },
      },
    });
    await writeUsageEvent({
      baseUrl: server.baseUrl,
      token,
      request: {
        sessionId: sessionBeta.sessionId,
        observedAt: now,
        agentId: 'claude',
        backendMode: 'claude:remote',
        modelId: 'claude-3.7-sonnet',
        projectKey: 'project-b',
        workspaceId: 'workspace-b',
        source: 'claude_sdk',
        scope: 'turn_delta',
        externalKey: 'usage-dashboard-beta-turn-1',
        turnId: 'turn-1',
        isCumulative: false,
        tokens: { input: 18, output: 12, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 30 },
        cost: { reportedUsd: 0.45, estimatedUsd: 0.33, currency: 'USD', costSource: 'provider_reported', billingContext: 'api_usage' },
      },
    });

    await waitForAuthenticatedRouteUi({
      page,
      expectedPathname: '/settings',
      requiredTestIds: [
        'settings-usage-summary-strip',
        'settings-usage-summary-streak-card',
        'settings-usage-summary-week-card',
        'settings-usage-summary-model-card',
        'settings-usage-summary-engine-card',
      ],
      timeoutMs: 180_000,
    });

    await expect(page.getByTestId('settings-usage-summary-strip')).toHaveCount(1, { timeout: 60_000 });
    await expect(page.getByTestId('settings-usage-summary-streak-card')).toHaveCount(1, { timeout: 60_000 });
    await expect(page.getByTestId('settings-usage-summary-week-card')).toHaveCount(1, { timeout: 60_000 });
    await expect(page.getByTestId('settings-usage-summary-model-card')).toHaveCount(1, { timeout: 60_000 });
    await expect(page.getByTestId('settings-usage-summary-engine-card')).toHaveCount(1, { timeout: 60_000 });

    await page.getByTestId('settings-usage-summary-streak-card').click();

    await waitForAuthenticatedRouteUi({
      page,
      expectedPathname: '/settings/usage',
      requiredTestIds: [
        'usage-filter-period',
        'usage-filter-metric',
        'usage-filter-cost-mode',
        'usage-summary-total-card',
        'usage-insights-section',
        'usage-activity-section',
        'usage-timeline-section',
        'usage-leaders-section',
        'usage-recap-section',
        'usage-activity-track-months',
        'usage-activity-track-weekdays',
        'usage-activity-track-hours',
        'usage-model-timeline-card',
        'usage-engine-timeline-card',
        'usage-export-copy-summary',
        'usage-export-json',
        'usage-export-share-summary',
        'usage-breakdown-row-provider-anthropic',
        'usage-breakdown-row-model-claude-3.7-sonnet',
        'usage-breakdown-row-provider-openai',
        `usage-breakdown-row-session-${sessionAlpha.sessionId}`,
      ],
      timeoutMs: 180_000,
    });

    const usageUrl = new URL(page.url());
    expect(usageUrl.pathname).toBe('/settings/usage');
    expect(usageUrl.searchParams.get('period')).toBe('year');
    expect(usageUrl.searchParams.get('metric')).toBe('tokens');

    for (const testId of dashboardTestIds) {
      await expect(page.getByTestId(testId)).toHaveCount(1, { timeout: 60_000 });
    }

    await expect(page.getByTestId(`usage-breakdown-row-session-${sessionAlpha.sessionId}`)).toHaveCount(1, { timeout: 60_000 });
    await page.getByTestId(`usage-breakdown-row-session-${sessionAlpha.sessionId}`).click();
    await expect(page.getByTestId('usage-focus-clear')).toHaveCount(1, { timeout: 60_000 });
    await expect
      .poll(() => {
        const url = new URL(page.url());
        return {
          pathname: url.pathname,
          focusDimension: url.searchParams.get('focusDimension'),
          focusKey: url.searchParams.get('focusKey'),
        };
      }, { timeout: 60_000 })
      .toEqual({
        pathname: '/settings/usage',
        focusDimension: 'session',
        focusKey: sessionAlpha.sessionId,
      });

    await page.getByTestId('usage-breakdown-row-model-claude-3.7-sonnet').click();

    await expect(page.getByTestId('usage-focus-clear')).toHaveCount(1, { timeout: 60_000 });
    await page.getByTestId('usage-focus-clear').click();
    await expect(page.getByTestId('usage-focus-clear')).toHaveCount(0, { timeout: 60_000 });

    await page.getByTestId('usage-trend-metric-cost').click();
    await expect(page.getByTestId('usage-trend-chart')).toHaveCount(1, { timeout: 60_000 });
  });
});
