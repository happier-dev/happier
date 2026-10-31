import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';

import { test, expect, type Page, type Request } from '@playwright/test';
import { Agent as UndiciAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from 'undici';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { reserveAvailablePort } from '../../src/testkit/network/reserveAvailablePort';
import {
  startHttpRequestRecordingProxy,
  type HttpRequestRecordingProxy,
} from '../../src/testkit/httpRequestRecordingProxy';
import {
  createEphemeralTlsServerFixture,
  type EphemeralTlsServerFixture,
} from '../../src/testkit/tls/ephemeralTlsServerFixture.mjs';
import {
  gotoCommittedWithRetries,
  normalizeLoopbackBaseUrl,
  waitForAuthenticatedHomeUi,
} from '../../src/testkit/uiE2e/pageNavigation';
import { fetchJson } from '../../src/testkit/http';
import { secretBearingBrowserCapturePolicy } from '../../src/testkit/uiE2e/secretBearingBrowserCapture';

/**
 * Lane 02 A7/A10 loaded web journey: unauthenticated Welcome → selected sign-in service
 * discovery → restricted `account_directory` key authentication → Directory discovery →
 * preferred Home enrollment → explicit open → normal authenticated shell.
 *
 * Everything runs through production entry points; no Account Directory, profile-adoption,
 * focus, or credential owner is mocked:
 *   WelcomeDecisionPanel (`useAccountServiceEntryOptions` → exact-endpoint discovery)
 *   → "Choose sign-in service" (full-screen `AccountServiceSelectionForm` → `setAccountServiceEndpoint`)
 *   → "Use a key" (`authenticateSelectedAccountServiceWithKey` → key-challenge v2 restricted
 *     credential in the dedicated `account_directory_auth_credentials` namespace; the A10
 *     same-service bootstrap on the dual-role service publishes its own linked preferred Home)
 *   → `completeAccountServicePostAuth` with exact automatic Home entry intent
 *   → assertion mint → destination-bound redemption → sealed `{ token }` credential
 *   → Directory-owned enrollment/material completion and exact Home entry
 *   → `setActiveServerAndSwitch` → authenticated shell.
 *
 * Mocked boundaries (external only):
 *   - `https://api.happier.dev` (the real default Happier Cloud endpoint) is aborted at the
 *     browser network boundary so the selected-service decision is deterministic in any
 *     environment; the journey then selects the local service through the production form.
 *   - The service's public origin is the existing ephemeral-TLS recording proxy used by the
 *     Account Directory core E2Es: the server publishes its real HTTPS ingress descriptor
 *     through it, and the browser trusts that fixture origin via per-file `ignoreHTTPSErrors`.
 *
 * A second, unrelated server is the UI's initially configured Home
 * (`EXPO_PUBLIC_HAPPY_SERVER_URL`). The journey must never send authentication, Account
 * Directory, or credentialed requests to it, and must never store a credential for it.
 */

const run = createRunDirs({ runLabel: 'ui-e2e' });

const SERVICE_IDENTITY = 'srv_welcome_e2e_account_service_a1';
const UNRELATED_HOME_IDENTITY = 'srv_welcome_e2e_unrelated_home_a1';
// The one default endpoint Welcome resolves before the user selects a service.
const DEFAULT_ACCOUNT_SERVICE_ORIGIN = 'https://api.happier.dev';
const ROUTINE_TERMINOLOGY_FORBIDDEN_RE = /account service|account directory/i;

// The loaded journey carries bearer credentials; never retain captures (see testkit policy).
// Worker-scoped options must be declared at file top level.
test.use(secretBearingBrowserCapturePolicy);

test.describe('ui e2e: welcome Account Service sign-in journey', () => {
  test.describe.configure({ mode: 'serial' });
  // The selected service's public origin is the ephemeral fixture-TLS ingress; scope this
  // exception to this spec file only.
  test.use({ ignoreHTTPSErrors: true });
  test.use({ storageState: { cookies: [], origins: [] } });

  const suiteDir = run.testDir('setup-welcome-account-service-sign-in-suite');

  let unrelatedHome: StartedServer | null = null;
  let serviceInternal: StartedServer | null = null;
  let serviceIngress: HttpRequestRecordingProxy | null = null;
  let serviceCanonicalIngress: HttpRequestRecordingProxy | null = null;
  let tlsFixture: EphemeralTlsServerFixture | null = null;
  let exactCaDispatcher: UndiciAgent | null = null;
  let previousDispatcher: Dispatcher | null = null;
  let ui: StartedUiWeb | null = null;
  let uiBaseUrl: string | null = null;

  const uiWebEnv = {
    ...process.env,
    EXPO_PUBLIC_DEBUG: '1',
    // Filled with the unrelated Home below: the journey must not retarget it.
    EXPO_PUBLIC_HAPPY_SERVER_URL: '',
    EXPO_PUBLIC_HAPPIER_FEATURE_APP_UI_ONBOARDING_TOUR__ENABLED: '0',
    EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY: 'app.ui.onboardingTour',
    EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-${run.runId}-welcome-account-service`,
    HAPPIER_E2E_UI_WEB_MODE: process.env.HAPPIER_E2E_UI_WEB_MODE ?? 'export',
  };

  test.beforeAll(async () => {
    test.setTimeout(resolveUiWebBeforeAllTimeoutMs(uiWebEnv) + 120_000);
    await mkdir(suiteDir, { recursive: true });

    // Unrelated, initially configured Home. Ordinary HTTP server; never selected as the
    // sign-in service and never expected to see auth/directory/credentialed traffic.
    unrelatedHome = await startServerLight({
      testDir: `${suiteDir}/unrelated-home`,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_SERVER_IDENTITY_ID: UNRELATED_HOME_IDENTITY,
        AUTH_ANONYMOUS_SIGNUP_ENABLED: '0',
        HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '0',
        HAPPIER_FEATURE_AUTH_UI__AUTO_REDIRECT_ENABLED: '1',
        HAPPIER_FEATURE_AUTH_UI__AUTO_REDIRECT_PROVIDER_ID: 'mtls',
        HAPPIER_FEATURE_AUTH_MTLS__ENABLED: '1',
        HAPPIER_FEATURE_AUTH_MTLS__MODE: 'forwarded',
        HAPPIER_FEATURE_AUTH_MTLS__TRUST_FORWARDED_HEADERS: '1',
        HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: '1',
        HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
      },
    });

    // Selected sign-in service: one dual-role (Account Service + Home) server whose public
    // HTTPS ingress is the ephemeral-TLS recording proxy — the same fixture corridor the
    // Account Directory core E2Es use, so the server publishes a real, reachable Home
    // connection descriptor for its own A10 same-service bootstrap.
    const serviceInternalPort = await reserveAvailablePort();
    const serviceInternalBaseUrl = `http://127.0.0.1:${serviceInternalPort}`;
    tlsFixture = await createEphemeralTlsServerFixture();
    const [tlsKey, tlsCert, tlsCa] = await Promise.all([
      readFile(tlsFixture.privateKeyPath),
      readFile(tlsFixture.leafCertificatePath),
      readFile(tlsFixture.caCertificatePath),
    ]);
    serviceIngress = await startHttpRequestRecordingProxy({
      targetBaseUrl: serviceInternalBaseUrl,
      tls: { key: tlsKey, cert: tlsCert },
    });
    // Keep the stable canonical authentication URL distinct from the HTTPS origin that can
    // actually receive the Home bearer. Account Directory adoption must authorize the exact
    // selected application endpoint, not incorrectly infer that the canonical URL is itself an
    // application endpoint. Both fixture origins remain reachable so the loaded shell can prove
    // the stored descriptor works after focus switches.
    serviceCanonicalIngress = await startHttpRequestRecordingProxy({
      targetBaseUrl: serviceInternalBaseUrl,
      tls: { key: tlsKey, cert: tlsCert },
    });
    serviceInternal = await startServerLight({
      testDir: `${suiteDir}/account-service`,
      dbProvider: 'sqlite',
      __portAllocator: async () => serviceInternalPort,
      extraEnv: {
        HAPPIER_SERVER_IDENTITY_ID: SERVICE_IDENTITY,
        HAPPIER_PUBLIC_SERVER_URL: serviceIngress.baseUrl,
        HAPPIER_CANONICAL_SERVER_URL: serviceCanonicalIngress.baseUrl,
        // Positive no-approval vertical: a valid assertion from the pinned linked service is
        // sufficient, so Welcome enrolls and opens without a Home-owned decision.
        HAPPIER_HOME_DEVICE_APPROVAL_REQUIRED: '0',
        HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
      },
    });

    ui = await startUiWeb({
      testDir: suiteDir,
      env: {
        ...uiWebEnv,
        EXPO_PUBLIC_HAPPY_SERVER_URL: unrelatedHome.baseUrl,
      },
    });
    uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);

    // Test-process probes against the fixture-TLS service origin must trust exactly this
    // fixture's CA. Install the scoped dispatcher only after the testkit completed its own
    // loopback readiness probes (plain-HTTP targets are unaffected); restore the previous
    // owner in afterAll. Certificate validation stays enabled and no unrelated CA is trusted.
    previousDispatcher = getGlobalDispatcher();
    exactCaDispatcher = new UndiciAgent({ connect: { ca: tlsCa } });
    setGlobalDispatcher(exactCaDispatcher);
  });

  test.afterAll(async () => {
    test.setTimeout(120_000);
    if (previousDispatcher) setGlobalDispatcher(previousDispatcher);
    await ui?.stop().catch(() => {});
    await serviceInternal?.stop().catch(() => {});
    await unrelatedHome?.stop().catch(() => {});
    await serviceIngress?.stop().catch(() => {});
    await serviceCanonicalIngress?.stop().catch(() => {});
    await exactCaDispatcher?.close().catch(() => {});
    exactCaDispatcher = null;
    await tlsFixture?.cleanup().catch(() => {});
  });

  interface CapturedRequest {
    url: string;
    pathname: string;
    hasAuthorizationHeader: boolean;
  }

  function collectRequests(page: Page): () => Promise<CapturedRequest[]> {
    const requests: Request[] = [];
    page.on('request', (request) => requests.push(request));
    return async () => {
      const captured = await Promise.all(requests.map(async (request) => {
        let url: URL;
        try {
          url = new URL(request.url());
        } catch {
          return null;
        }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
        return {
          url: url.origin,
          pathname: url.pathname,
          hasAuthorizationHeader: await request.headerValue('authorization') !== null,
        };
      }));
      return captured.filter((request): request is CapturedRequest => request !== null);
    };
  }

  async function openFreshWelcome(page: Page): Promise<void> {
    if (!uiBaseUrl) throw new Error('missing ui base url');

    // Deterministic selected-service decision: the real default endpoint (Happier Cloud) is
    // unreachable by test construction, so Welcome presents its production recovery path and
    // the user selects the local service through it.
    await page.route(`${DEFAULT_ACCOUNT_SERVICE_ORIGIN}/**`, (route) => route.abort());

    // Fresh device: zero Home profiles, no selected service, no credentials.
    await page.addInitScript(() => {
      try {
        const marker = '__happier_e2e_welcome_account_service_cleared__=1';
        const name = typeof window.name === 'string' ? window.name : '';
        if (!name.includes(marker)) {
          try { localStorage.clear(); } catch {}
          try { sessionStorage.clear(); } catch {}
          window.name = name ? `${name};${marker}` : marker;
        }
      } catch {
        // Best-effort only; continue even if storage is unavailable.
      }
    });

    await page.setViewportSize({ width: 1100, height: 820 });
    await gotoCommittedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 240_000);

    const brandGetStarted = page.getByTestId('brand-hero-get-started');
    if (await brandGetStarted.isVisible().catch(() => false)) {
      await brandGetStarted.click();
    }
    await expect(page.getByTestId('welcome-decision-panel')).toBeVisible({ timeout: 180_000 });

    // Some current web compositions present the optional first-run product tour above the
    // unauthenticated decision panel even when the build-time tour capability is denied. Exercise
    // its real user-visible Skip action before continuing; forced clicks would hide a genuine
    // interaction obstruction and would not represent the production journey.
    const optionalTour = page.getByRole('dialog').filter({ hasText: 'Welcome to Happier' });
    if (await optionalTour.isVisible().catch(() => false)) {
      await optionalTour.getByRole('button', { name: 'Skip' }).click();
      await expect(optionalTour).toBeHidden({ timeout: 30_000 });
    }
  }

  async function chooseSignInService(page: Page, serviceOrigin: string): Promise<void> {
    // Default endpoint unavailable → the production recovery block owns service selection.
    await expect(page.getByTestId('welcome-account-service-recovery')).toBeVisible({ timeout: 120_000 });
    await expect(page.getByTestId('welcome-decision-panel')).not.toContainText(ROUTINE_TERMINOLOGY_FORBIDDEN_RE);

    const chooseService = page.getByTestId('welcome-account-service-choose');
    try {
      await chooseService.click({ timeout: 3_000 });
    } catch (error) {
      // The optional first-run tour is initialized independently and may mount just after the
      // Welcome panel. If it owns the interaction layer, take its real Skip path and retry the
      // intended action. Re-throw any other obstruction instead of bypassing hit testing.
      const lateTour = page.getByRole('dialog').filter({ hasText: 'Welcome to Happier' });
      const skip = lateTour.getByRole('button', { name: 'Skip' });
      if (!(await skip.isVisible().catch(() => false))) throw error;
      await skip.click();
      await expect(lateTour).toBeHidden({ timeout: 30_000 });
      await chooseService.click();
    }
    // A remembered (unavailable) default endpoint is offered first; entering a
    // different address is the explicit "another" choice that reveals the input.
    const anotherChoice = page.getByTestId('account-service-another-choice');
    await expect(anotherChoice).toBeVisible({ timeout: 30_000 });
    await anotherChoice.click();
    const input = page.getByTestId('account-service-url-input');
    await expect(input).toHaveCount(1, { timeout: 30_000 });
    // The service-selection step is routine UI too.
    await expect(page.getByText(ROUTINE_TERMINOLOGY_FORBIDDEN_RE)).toHaveCount(0);
    await input.fill(serviceOrigin);
    await page.getByTestId('account-service-url-submit').click();

    // Discovery of the exact selected endpoint succeeds → its advertised methods own the
    // welcome sign-in path. This service advertises key login only.
    const keyAction = page.getByTestId('welcome-account-service-key');
    await expect(keyAction).toBeVisible({ timeout: 120_000 });
    await expect(keyAction).toBeEnabled({ timeout: 120_000 });
    await expect(page.getByTestId('welcome-account-service-key-title')).toHaveText('Use a key');
    await expect(page.getByTestId('welcome-scan-existing-home')).toBeVisible({ timeout: 120_000 });
    await expect(page.getByTestId('welcome-use-different-home')).toBeVisible({ timeout: 120_000 });
    await expect(page.getByTestId('welcome-decision-panel')).not.toContainText(ROUTINE_TERMINOLOGY_FORBIDDEN_RE);
  }

  test('welcome key sign-in discovers the selected service, enrolls the preferred Home, and opens the authenticated shell', async ({ page }) => {
    test.setTimeout(420_000);
    if (!serviceIngress) throw new Error('missing service ingress');
    if (!serviceCanonicalIngress) throw new Error('missing canonical service ingress');
    const serviceOrigin = serviceIngress.baseUrl;
    const canonicalServiceOrigin = serviceCanonicalIngress.baseUrl;

    const secretSeed = randomBytes(32);
    const secretKeyBase64Url = secretSeed.toString('base64url');

    // Capture before the first navigation. This makes the legacy active-Home auto-redirect
    // corridor observable: the unrelated Home deliberately advertises mTLS auto-redirect,
    // while the selected sign-in service advertises only key authentication.
    const readRequests = collectRequests(page);

    await openFreshWelcome(page);
    await chooseSignInService(page, serviceOrigin);

    // Familiar advertised method → restricted `account_directory` key ceremony (key-challenge
    // v2) → Directory refresh → preferred Home enrollment → explicit open.
    await page.getByTestId('welcome-account-service-key').click();
    const secretInput = page.getByTestId('restore-manual-secret-input');
    await expect(secretInput).toHaveCount(1, { timeout: 30_000 });
    await secretInput.fill(secretKeyBase64Url);
    await page.getByTestId('restore-manual-submit').click();

    // The post-sign-in continuation (finding Homes, enrollment, any result card)
    // must speak the same routine vocabulary before the shell takes over.
    await expect(page.getByText(ROUTINE_TERMINOLOGY_FORBIDDEN_RE)).toHaveCount(0);
    for (const text of await page.locator('[data-testid^="account-service-continuation-"]').allTextContents()) {
      expect(text).not.toMatch(ROUTINE_TERMINOLOGY_FORBIDDEN_RE);
    }

    await waitForAuthenticatedHomeUi({ page, timeoutMs: 300_000 });

    // --- Routine shell keeps implementation terminology out of the journey. ---
    await expect(page.getByText(ROUTINE_TERMINOLOGY_FORBIDDEN_RE)).toHaveCount(0);

    // --- Exact-target: every authentication/Directory request stays on the selected service.
    const requests = await readRequests();
    const accountServiceCustodyRequests = requests.filter(
      (request) => request.pathname.startsWith('/v1/auth/account-directory')
        || request.pathname.startsWith('/v1/account-directory'),
    );
    expect(accountServiceCustodyRequests.length).toBeGreaterThan(0);
    for (const request of accountServiceCustodyRequests) {
      expect(
        request.url,
        `Account sign-in/directory request ${request.pathname} targeted ${request.url}`,
      ).toBe(serviceOrigin);
    }

    // After the explicit Home open, ordinary Home authentication may correctly use the
    // descriptor's distinct canonical authentication URL. Both origins terminate at the exact
    // dual-role service identity; neither permits the unrelated initially configured Home to
    // receive authentication or bearer traffic.
    const ordinaryHomeAuthRequests = requests.filter(
      (request) => request.pathname.startsWith('/v1/auth')
        && !request.pathname.startsWith('/v1/auth/account-directory'),
    );
    for (const request of ordinaryHomeAuthRequests) {
      expect(
        [serviceOrigin, canonicalServiceOrigin],
        `ordinary Home authentication request ${request.pathname} targeted ${request.url}`,
      ).toContain(request.url);
    }

    // --- The unrelated initially configured Home is never authenticated against, never used
    // as an Account Directory target, and never sees a credential. Its availability probe
    // (/v1/features) is the only expected traffic.
    if (unrelatedHome) {
      const unrelatedViolations = requests.filter(
        (request) => request.url === normalizeLoopbackBaseUrl(unrelatedHome!.baseUrl)
          && (request.pathname.startsWith('/v1/auth')
            || request.pathname.startsWith('/v1/account-directory')
            || request.hasAuthorizationHeader),
      );
      expect(unrelatedViolations).toEqual([]);
    }

    // --- Credential outcome: distinct restricted/Home credentials in distinct namespaces,
    // persisted for the enrolled Home only. Read through the browser's own storage the same
    // way the existing onboarding specs do, without reproducing key derivation.
    const storage = await page.evaluate(() => {
      const entries: Array<{ key: string; value: string }> = [];
      for (let index = 0; index < window.localStorage.length; index += 1) {
        const key = window.localStorage.key(index);
        if (!key) continue;
        const value = window.localStorage.getItem(key);
        if (value) entries.push({ key, value });
      }
      return entries;
    });

    const tokensFrom = (keyPattern: RegExp): string[] => {
      const tokens = new Set<string>();
      for (const entry of storage) {
        if (!keyPattern.test(entry.key)) continue;
        for (const match of entry.value.matchAll(/"token":"([^"]+)"/g)) {
          tokens.add(match[1]!);
        }
      }
      return [...tokens];
    };
    const restrictedTokens = tokensFrom(/account_directory_auth_credentials/);
    const homeCredentialTokens = tokensFrom(/^auth_credentials/);

    // Assertions observe counts/distinctness only — raw token bytes never enter failure
    // output or attachments.
    expect(restrictedTokens.length, 'restricted Account Service credential persisted').toBe(1);
    expect(homeCredentialTokens.length, 'ordinary Home credential persisted').toBe(1);
    // Same-service dual role: two separately signed, separately stored credentials.
    expect(restrictedTokens[0] !== homeCredentialTokens[0], 'restricted and Home credentials are distinct').toBe(true);

    const activeServerState = storage.find((entry) => entry.key.includes('server-state-v1'));
    expect(activeServerState, 'home profile state persisted').toBeTruthy();
    const activeServerStateParsed = JSON.parse(activeServerState!.value) as {
      activeServerId?: unknown;
      servers?: Record<string, { serverIdentityId?: unknown; serverUrl?: unknown }>;
    };
    const adoptedEntries = Object.values(activeServerStateParsed.servers ?? {}).filter(
      (entry) => entry.serverIdentityId === SERVICE_IDENTITY,
    );
    expect(adoptedEntries).toHaveLength(1);
    expect(adoptedEntries[0]!.serverUrl).toBe(canonicalServiceOrigin);
    // Routine web selection is intentionally tab-scoped. The persisted device default may remain
    // the environment-seeded Home; the canonical effective selection is the profile id in this
    // tab's session storage.
    const tabActiveServerId = await page.evaluate(() => window.sessionStorage.getItem('activeServerId'));
    expect(tabActiveServerId).toBeTruthy();
    const activeEntry = Object.entries(activeServerStateParsed.servers ?? {}).find(
      ([id]) => id === tabActiveServerId,
    );
    expect(activeEntry, 'the enrolled preferred Home is the focused Home').toBeTruthy();
    expect(activeEntry![1].serverIdentityId).toBe(SERVICE_IDENTITY);

    // --- Credential authority (test process via the fixture-CA dispatcher): the restricted
    // token is admitted by exactly the Account Directory routes and fails closed on an
    // ordinary Home API; the ordinary Home credential is the one that works there.
    const meResponse = await fetchJson<unknown>(`${serviceOrigin}/v1/account-directory/me`, {
      headers: { Authorization: `Bearer ${restrictedTokens[0]}` },
      timeoutMs: 15_000,
    });
    expect(meResponse.status).toBe(200);

    const restrictedOnOrdinaryRoute = await fetch(
      `${serviceOrigin}/v2/sessions`,
      { headers: { Authorization: `Bearer ${restrictedTokens[0]}` } },
    );
    expect([401, 403]).toContain(restrictedOnOrdinaryRoute.status);

    const homeOnOrdinaryRoute = await fetchJson<unknown>(`${serviceOrigin}/v2/sessions`, {
      headers: { Authorization: `Bearer ${homeCredentialTokens[0]}` },
      timeoutMs: 15_000,
    });
    expect(homeOnOrdinaryRoute.status).toBe(200);
  });
});
