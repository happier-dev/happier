import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

import { createTestAuthMtls } from '../../src/testkit/auth';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { createRunDirs } from '../../src/testkit/runDir';
import {
  anySessionAttentionIndicator,
  chooseSessionListDensity,
  chooseSessionListPlacementMode,
  connectAuthenticatedSessionPublisher,
  expectRowInSection,
  expectRowNotInSection,
  seedAttentionSession,
  seedReadyMarker,
  sessionListAttentionTestIds,
  sessionRow,
  sessionStatusSubtitle,
  sessionStatusSubtitleText,
  toggleWorkingStatusAnimatedTextOff,
  updateSessionRuntimeStatus,
} from '../../src/testkit/uiE2e/sessionListAttentionStatus';
import { startForwardedHeaderProxy } from '../../src/testkit/uiE2e/forwardedHeaderProxy';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { waitForInitialAppUi } from '../../src/testkit/uiE2e/waitForInitialAppUi';

const run = createRunDirs({ runLabel: 'ui-e2e-session-list-attention-status' });

const IDENTITY_HEADERS = {
  email: `session-list-attention-${run.runId}@example.com`,
  issuer: 'happier-ui-e2e-session-list-attention',
  fingerprint: `session-list-attention-${run.runId}`,
} as const;

test.describe('ui e2e: session list attention status', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('session-list-attention-status-suite');

  let server: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let uiBaseUrl: string | null = null;
  let proxyStop: (() => Promise<void>) | null = null;
  let token: string | null = null;

  test.beforeAll(async () => {
    test.setTimeout(900_000);
    await mkdir(suiteDir, { recursive: true });

    server = await startServerLight({
      testDir: suiteDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_BUILD_FEATURES_DENY: 'sharing.contentKeys',
        HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '0',
        AUTH_ANONYMOUS_SIGNUP_ENABLED: '0',
        AUTH_SIGNUP_PROVIDERS: '',

        HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: '1',
        HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
        HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: 'plain',

        HAPPIER_FEATURE_AUTH_MTLS__ENABLED: '1',
        HAPPIER_FEATURE_AUTH_MTLS__MODE: 'forwarded',
        HAPPIER_FEATURE_AUTH_MTLS__TRUST_FORWARDED_HEADERS: '1',
        HAPPIER_FEATURE_AUTH_MTLS__AUTO_PROVISION: '1',
        HAPPIER_FEATURE_AUTH_MTLS__IDENTITY_SOURCE: 'san_email',
        HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_EMAIL_DOMAINS: 'example.com',
        HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_ISSUERS: IDENTITY_HEADERS.issuer,
        HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_EMAIL_HEADER: 'x-happier-client-cert-email',
        HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_ISSUER_HEADER: 'x-happier-client-cert-issuer',
        HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_FINGERPRINT_HEADER: 'x-happier-client-cert-sha256',

        HAPPIER_FEATURE_AUTH_UI__AUTO_REDIRECT_ENABLED: '1',
        HAPPIER_FEATURE_AUTH_UI__AUTO_REDIRECT_PROVIDER_ID: 'mtls',
      },
    });

    const proxy = await startForwardedHeaderProxy({
      targetBaseUrl: server.baseUrl,
      identityHeaders: {
        'x-happier-client-cert-email': IDENTITY_HEADERS.email,
        'x-happier-client-cert-issuer': IDENTITY_HEADERS.issuer,
        'x-happier-client-cert-sha256': IDENTITY_HEADERS.fingerprint,
      },
    });
    proxyStop = proxy.stop;

    const auth = await createTestAuthMtls(server.baseUrl, {
      email: IDENTITY_HEADERS.email,
      issuer: IDENTITY_HEADERS.issuer,
      fingerprint: IDENTITY_HEADERS.fingerprint,
    });
    token = auth.token;

    ui = await startUiWeb({
      testDir: suiteDir,
      env: {
        ...process.env,
        EXPO_PUBLIC_DEBUG: '1',
        EXPO_PUBLIC_HAPPY_SERVER_URL: proxy.baseUrl,
        EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-session-list-attention-status-${run.runId}`,
        HAPPIER_E2E_UI_WEB_MODE: 'export',
      },
    });

    uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
  });

  test.afterAll(async () => {
    test.setTimeout(120_000);
    await ui?.stop().catch(() => {});
    await proxyStop?.().catch(() => {});
    await server?.stop().catch(() => {});
  });

  test('keeps narrow rows compact while quiet rows have no attention indicator', async ({ page }) => {
    test.setTimeout(420_000);
    if (!server || !token || !uiBaseUrl) throw new Error('missing session list attention fixtures');

    const quiet = await seedAttentionSession({ baseUrl: server.baseUrl, token, title: `Quiet attention ${run.runId}` });
    const working = await seedAttentionSession({ baseUrl: server.baseUrl, token, title: `Working attention ${run.runId}` });
    const ready = await seedAttentionSession({ baseUrl: server.baseUrl, token, title: `Ready attention ${run.runId}` });

    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 300_000);
    await waitForInitialAppUi({ page, timeoutMs: 180_000 });
    await chooseSessionListDensity({ page, baseUrl: uiBaseUrl, density: 'narrow' });
    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 180_000);

    await expect(sessionRow(page, quiet.id)).toHaveCount(1, { timeout: 120_000 });
    await expect(sessionRow(page, working.id)).toHaveCount(1, { timeout: 120_000 });
    await expect(sessionRow(page, ready.id)).toHaveCount(1, { timeout: 120_000 });

    const workingPublisher = await connectAuthenticatedSessionPublisher({
      baseUrl: server.baseUrl,
      token,
      sessionId: working.id,
    });
    try {
      await updateSessionRuntimeStatus({ baseUrl: server.baseUrl, token, sessionId: working.id, latestTurnStatus: 'in_progress' });
      await seedReadyMarker({ baseUrl: server.baseUrl, token, sessionId: ready.id });
      await updateSessionRuntimeStatus({ baseUrl: server.baseUrl, token, sessionId: ready.id, latestTurnStatus: 'completed' });

      await expect(anySessionAttentionIndicator(page, quiet.id)).toHaveCount(0);
      await expect(page.getByTestId(sessionListAttentionTestIds.attentionIndicator(working.id, 'working'))).toHaveCount(1, { timeout: 60_000 });
      await expect(page.getByTestId(sessionListAttentionTestIds.attentionIndicator(ready.id, 'ready'))).toHaveCount(1, { timeout: 60_000 });
      await expect(sessionStatusSubtitle(page, working.id, 'working')).toHaveCount(0);
      await expect(sessionStatusSubtitle(page, ready.id, 'ready')).toHaveCount(0);
    } finally {
      workingPublisher.close();
    }
  });

  test('shows ready subtitle outside narrow mode and exposes a working-text animation toggle', async ({ page }) => {
    test.setTimeout(420_000);
    if (!server || !token || !uiBaseUrl) throw new Error('missing session list attention fixtures');

    const working = await seedAttentionSession({ baseUrl: server.baseUrl, token, title: `Working text toggle ${run.runId}` });
    const ready = await seedAttentionSession({ baseUrl: server.baseUrl, token, title: `Ready subtitle ${run.runId}` });

    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 300_000);
    await waitForInitialAppUi({ page, timeoutMs: 180_000 });
    await toggleWorkingStatusAnimatedTextOff({ page, baseUrl: uiBaseUrl });
    await chooseSessionListDensity({ page, baseUrl: uiBaseUrl, density: 'cozy' });
    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 180_000);

    await expect(sessionRow(page, working.id)).toHaveCount(1, { timeout: 120_000 });
    await expect(sessionRow(page, ready.id)).toHaveCount(1, { timeout: 120_000 });

    const workingPublisher = await connectAuthenticatedSessionPublisher({
      baseUrl: server.baseUrl,
      token,
      sessionId: working.id,
    });
    try {
      await updateSessionRuntimeStatus({ baseUrl: server.baseUrl, token, sessionId: working.id, latestTurnStatus: 'in_progress' });
      await seedReadyMarker({ baseUrl: server.baseUrl, token, sessionId: ready.id });
      await updateSessionRuntimeStatus({ baseUrl: server.baseUrl, token, sessionId: ready.id, latestTurnStatus: 'completed' });

      await expect(sessionStatusSubtitle(page, ready.id, 'ready')).toHaveCount(1, { timeout: 60_000 });
      await expect(page.getByTestId(sessionListAttentionTestIds.secondaryReadyIndicator(ready.id))).toHaveCount(1, { timeout: 60_000 });
      await expect(sessionStatusSubtitleText(page, ready.id, 'ready')).not.toHaveText('', { timeout: 60_000 });

      await expect(sessionStatusSubtitle(page, working.id, 'working')).toHaveCount(1, { timeout: 60_000 });
    } finally {
      workingPublisher.close();
    }
  });

  test('moves live working rows to the working section and unread completion to attention', async ({ page }) => {
    test.setTimeout(540_000);
    if (!server || !token || !uiBaseUrl) throw new Error('missing session list attention fixtures');

    const live = await seedAttentionSession({ baseUrl: server.baseUrl, token, title: `Live working placement ${run.runId}` });
    const cancelled = await seedAttentionSession({ baseUrl: server.baseUrl, token, title: `Cancelled working placement ${run.runId}` });

    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 300_000);
    await waitForInitialAppUi({ page, timeoutMs: 180_000 });
    await chooseSessionListPlacementMode({ page, baseUrl: uiBaseUrl, triggerTestId: sessionListAttentionTestIds.attentionPromotionModeTrigger });
    await chooseSessionListPlacementMode({ page, baseUrl: uiBaseUrl, triggerTestId: sessionListAttentionTestIds.workingPlacementModeTrigger });
    await chooseSessionListDensity({ page, baseUrl: uiBaseUrl, density: 'narrow' });
    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 180_000);

    await expect(sessionRow(page, live.id)).toHaveCount(1, { timeout: 120_000 });
    await expect(sessionRow(page, cancelled.id)).toHaveCount(1, { timeout: 120_000 });
    const livePublisher = await connectAuthenticatedSessionPublisher({
      baseUrl: server.baseUrl,
      token,
      sessionId: live.id,
    });
    let cancelledPublisher: Readonly<{ close: () => void }> | null = null;
    try {
      cancelledPublisher = await connectAuthenticatedSessionPublisher({
        baseUrl: server.baseUrl,
        token,
        sessionId: cancelled.id,
      });
      await updateSessionRuntimeStatus({ baseUrl: server.baseUrl, token, sessionId: live.id, latestTurnStatus: 'in_progress' });
      await expect(page.getByTestId(sessionListAttentionTestIds.workingHeader)).toHaveCount(1, { timeout: 60_000 });
      await expectRowInSection({ page, headerTestId: sessionListAttentionTestIds.workingHeader, sessionId: live.id });

      await seedReadyMarker({ baseUrl: server.baseUrl, token, sessionId: live.id });
      await updateSessionRuntimeStatus({ baseUrl: server.baseUrl, token, sessionId: live.id, latestTurnStatus: 'completed' });
      await expect(page.getByTestId(sessionListAttentionTestIds.attentionHeader)).toHaveCount(1, { timeout: 60_000 });
      await expectRowInSection({ page, headerTestId: sessionListAttentionTestIds.attentionHeader, sessionId: live.id });
      await expectRowNotInSection({ page, headerTestId: sessionListAttentionTestIds.workingHeader, sessionId: live.id });

      await updateSessionRuntimeStatus({ baseUrl: server.baseUrl, token, sessionId: cancelled.id, latestTurnStatus: 'in_progress' });
      await expectRowInSection({ page, headerTestId: sessionListAttentionTestIds.workingHeader, sessionId: cancelled.id });
      await updateSessionRuntimeStatus({ baseUrl: server.baseUrl, token, sessionId: cancelled.id, latestTurnStatus: 'cancelled' });
      await expectRowNotInSection({ page, headerTestId: sessionListAttentionTestIds.workingHeader, sessionId: cancelled.id });
    } finally {
      cancelledPublisher?.close();
      livePublisher.close();
    }
  });
});
