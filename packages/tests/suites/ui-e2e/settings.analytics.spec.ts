import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { createTestAuth } from '../../src/testkit/auth';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { waitForInitialAppUi } from '../../src/testkit/uiE2e/waitForInitialAppUi';
import { buildAuthBootstrapStorageSnapshot } from '../../src/testkit/uiE2e/buildAuthBootstrapStorageSnapshot';
import { installAuthBootstrapStorageSnapshot } from '../../src/testkit/uiE2e/readLegacyAuthSecretFromLocalStorage';

const run = createRunDirs({ runLabel: 'ui-e2e' });
const POSTHOG_HOST = 'https://example.posthog.test';
const ANALYTICS_STORAGE_SCOPE = `e2e-settings-analytics-${run.runId}`;

type CapturedAnalyticsRequest = Readonly<{
  url: string;
  method: string;
  body: string;
}>;

async function installPostHogCapture(page: Page, sink: CapturedAnalyticsRequest[]): Promise<void> {
  const bindingName = '__happierE2eRecordPosthogRequest';
  const posthogHosts = [POSTHOG_HOST, 'https://us.i.posthog.com', 'https://eu.i.posthog.com'];
  await page.exposeFunction(bindingName, (request: CapturedAnalyticsRequest) => {
    sink.push(request);
  });

  await page.addInitScript(({ configuredPosthogHosts, captureBindingName }) => {
    const analyticsRequests: Array<{ url: string; method: string; body: string }> = [];
    const hosts = configuredPosthogHosts.map((entry) => String(entry));
    const globalTarget = globalThis as typeof globalThis & {
      __HAPPIER_E2E_POSTHOG_REQUESTS__?: typeof analyticsRequests;
      [key: string]: ((request: { url: string; method: string; body: string }) => void | Promise<void>) | Array<{ url: string; method: string; body: string }> | Navigator | typeof fetch | undefined;
      fetch?: typeof fetch;
      navigator: Navigator;
    };

    const serializeBody = async (value: unknown): Promise<string> => {
      if (typeof value === 'string') return value;
      if (value == null) return '';
      if (value instanceof URLSearchParams) return value.toString();
      if (typeof FormData !== 'undefined' && value instanceof FormData) return '[formdata]';

      try {
        if (
          typeof Blob !== 'undefined' && value instanceof Blob
          || value instanceof ArrayBuffer
          || ArrayBuffer.isView(value)
        ) {
          return await new Response(value as BodyInit).text();
        }
      } catch {
        // Fall through to JSON/string coercion below.
      }

      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    };

    const normalizeCapturedBody = (body: string): string => {
      const trimmed = body.trim();
      if (!trimmed || trimmed.startsWith('{') || trimmed.startsWith('[')) {
        return trimmed;
      }

      try {
        const params = new URLSearchParams(trimmed);
        const entries = Array.from(params.entries());
        if (!entries.length) return trimmed;

        const payloadKeys = ['data', 'batch', 'payload'] as const;
        for (const payloadKey of payloadKeys) {
          const payload = params.get(payloadKey);
          if (payload) {
            return payload;
          }
        }

        return JSON.stringify(Object.fromEntries(entries));
      } catch {
        return trimmed;
      }
    };

    const isTrackedHost = (url: string): boolean => hosts.some((host) => url.startsWith(host));

    const pushRequest = (url: string, method: string, body: string) => {
      if (!isTrackedHost(url)) return;
      const request = { url, method, body: normalizeCapturedBody(body) };
      analyticsRequests.push(request);
      const capture = globalTarget[captureBindingName];
      if (typeof capture === 'function') {
        const recordRequest = capture as (capturedRequest: { url: string; method: string; body: string }) => void | Promise<void>;
        void Promise.resolve(recordRequest(request)).catch(() => {});
      }
    };

    globalTarget.__HAPPIER_E2E_POSTHOG_REQUESTS__ = analyticsRequests;

    const originalFetch = globalTarget.fetch?.bind(globalTarget);
    if (originalFetch) {
      globalTarget.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : input instanceof Request
                ? input.url
                : String(input);

        let body = init?.body;
        if (body == null && input instanceof Request) {
          try {
            body = await input.clone().text();
          } catch {
            body = null;
          }
        }

        if (isTrackedHost(url)) {
          const serializedBody = await serializeBody(body);
          pushRequest(url, init?.method ?? (input instanceof Request ? input.method : 'GET'), serializedBody);
          return new Response(JSON.stringify({ status: 1 }), {
            status: 200,
            headers: {
              'content-type': 'application/json',
              'access-control-allow-origin': '*',
            },
          });
        }

        return originalFetch(input, init);
      };
    }

    const originalSendBeacon = globalTarget.navigator.sendBeacon?.bind(globalTarget.navigator);
    if (originalSendBeacon) {
      globalTarget.navigator.sendBeacon = (url: string | URL, data?: BodyInit | null) => {
        const normalizedUrl = typeof url === 'string' ? url : url.toString();
        if (isTrackedHost(normalizedUrl)) {
          void serializeBody(data).then((serializedBody) => {
            pushRequest(normalizedUrl, 'BEACON', serializedBody);
          });
          return true;
        }
        return originalSendBeacon(url, data);
      };
    }
  }, { configuredPosthogHosts: posthogHosts, captureBindingName: bindingName });

}

test.describe('ui e2e: settings analytics', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('settings-analytics-suite');

  let server: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let uiBaseUrl: string | null = null;

  test.beforeAll(async () => {
    test.setTimeout(900_000);
    await mkdir(suiteDir, { recursive: true });

    server = await startServerLight({
      testDir: suiteDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_BUILD_FEATURES_DENY: 'sharing.contentKeys',
        HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
      },
    });

    ui = await startUiWeb({
      testDir: suiteDir,
      env: {
        ...process.env,
        EXPO_PUBLIC_DEBUG: '1',
        EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl,
        EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: ANALYTICS_STORAGE_SCOPE,
        EXPO_PUBLIC_POSTHOG_KEY: 'phc_test_key',
        EXPO_PUBLIC_POSTHOG_HOST: POSTHOG_HOST,
      },
    });

    uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
  });

  test.afterAll(async () => {
    test.setTimeout(120_000);
    await ui?.stop().catch(() => {});
    await server?.stop().catch(() => {});
  });

  test('emits safe account, local, feature, and compact-view analytics from settings flows', async ({ page }) => {
    test.setTimeout(540_000);
    if (!uiBaseUrl || !server) throw new Error('missing ui fixture');

    const analyticsRequests: CapturedAnalyticsRequest[] = [];
    await installPostHogCapture(page, analyticsRequests);
    await page.setViewportSize({ width: 1440, height: 900 });
    const auth = await createTestAuth(server.baseUrl);
    await installAuthBootstrapStorageSnapshot(
      page,
      buildAuthBootstrapStorageSnapshot({
        serverUrl: server.baseUrl,
        auth,
        mode: 'legacy',
        storageScope: ANALYTICS_STORAGE_SCOPE,
      }),
    );

    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 420_000);
    await waitForInitialAppUi({ page, timeoutMs: 420_000 });

    analyticsRequests.splice(0, analyticsRequests.length);

    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/settings/appearance?happier_hmr=0`, 180_000);
    await expect(page.getByTestId('settings-appearance-themePreference-cycle')).toHaveCount(1, { timeout: 60_000 });
    await page.getByTestId('settings-appearance-themePreference-cycle').click();

    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/settings/session?happier_hmr=0`, 180_000);
    await expect(page.getByTestId('settings-session-sessionListDensity-trigger')).toHaveCount(1, { timeout: 60_000 });
    await page.getByTestId('settings-session-sessionListDensity-trigger').click();
    await page.getByText('Narrow', { exact: true }).click();

    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/settings/features?happier_hmr=0`, 180_000);
    const diffSyntaxHighlightingToggle = page.getByTestId('settings-feature-toggle-files.diffSyntaxHighlighting');
    await expect(diffSyntaxHighlightingToggle).toHaveCount(1, { timeout: 60_000 });
    await diffSyntaxHighlightingToggle.click();

    const syncAnalyticsRequests = async () => {
      const requests = await page.evaluate(() => {
        const globalTarget = globalThis as typeof globalThis & {
          __HAPPIER_E2E_POSTHOG_REQUESTS__?: Array<{ url: string; method: string; body: string }>;
        };
        return globalTarget.__HAPPIER_E2E_POSTHOG_REQUESTS__ ?? [];
      });
      const existing = new Set(analyticsRequests.map((request) => `${request.method} ${request.url} ${request.body}`));
      for (const request of requests) {
        const key = `${request.method} ${request.url} ${request.body}`;
        if (existing.has(key)) continue;
        existing.add(key);
        analyticsRequests.push(request);
      }
    };

    const bodies = async () => {
      await syncAnalyticsRequests();
      return analyticsRequests.map((request) => request.body).join('\n');
    };

    const analyticsDeadlineMs = Date.now() + 120_000;
    let lastCombinedBodies = '';
    let observed = {
      localTheme: false,
      sessionDensity: false,
      compactDerived: false,
      featurePref: false,
    };
    while (Date.now() < analyticsDeadlineMs) {
      lastCombinedBodies = await bodies();
      const hasSessionDensitySettingKey = lastCombinedBodies.includes('"setting_key":"sessionListDensity"');
      observed = {
        localTheme:
          lastCombinedBodies.includes('local_setting__themePreference')
          || lastCombinedBodies.includes('"setting_key":"themePreference"'),
        sessionDensity:
          lastCombinedBodies.includes('acct_setting__sessionListDensity')
          || hasSessionDensitySettingKey,
        compactDerived:
          lastCombinedBodies.includes('derived__compact_session_view_minimal')
          || lastCombinedBodies.includes('derived__compact_session_view')
          || hasSessionDensitySettingKey,
        featurePref:
          lastCombinedBodies.includes('feature_pref__files.diffSyntaxHighlighting')
          || lastCombinedBodies.includes('"setting_key":"files.diffSyntaxHighlighting"'),
      };
      if (observed.localTheme && observed.sessionDensity && observed.compactDerived && observed.featurePref) {
        break;
      }
      await page.waitForTimeout(500);
    }
    if (!(observed.localTheme && observed.sessionDensity && observed.compactDerived && observed.featurePref)) {
      throw new Error(
        `analytics events not observed within timeout: observed=${JSON.stringify(observed)} sample=${JSON.stringify(lastCombinedBodies.slice(0, 1200))}`,
      );
    }

    const combinedBodies = await bodies();
    expect(combinedBodies).not.toContain('acct_setting__compactSessionView');
    expect(combinedBodies).not.toContain('acct_setting__compactSessionViewMinimal');
    expect(combinedBodies).not.toContain('attachmentsUploadsWorkspaceRelativeDir');
    expect(combinedBodies).not.toContain('inferenceOpenAIKey');
  });
});
