import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { createRunDirs } from '../../src/testkit/runDir';
import { createTestAuthMtls } from '../../src/testkit/auth';
import { fetchJson } from '../../src/testkit/http';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { fetchSessionV2 } from '../../src/testkit/sessions';
import { createSessionScopedSocketCollector } from '../../src/testkit/socketClient';
import { waitFor } from '../../src/testkit/timing';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { startForwardedHeaderProxy } from '../../src/testkit/uiE2e/forwardedHeaderProxy';
import { waitForInitialAppUi } from '../../src/testkit/uiE2e/waitForInitialAppUi';

const run = createRunDirs({ runLabel: 'ui-e2e' });

const IDENTITY_HEADERS = {
  email: 'session-list-attention@example.com',
  issuer: 'CN=Example Root CA',
  fingerprint: 'sha256:session-list-attention',
} as const;

const sessionListTestIds = {
  row: (sessionId: string) => `session-list-item-${sessionId}`,
  attentionIndicator: (
    sessionId: string,
    state: 'working' | 'ready' | 'permission_required' | 'action_required' | 'failed',
  ) => `session-list-attention-indicator-${sessionId}-${state}`,
  anyAttentionIndicatorSelector: (sessionId: string) => `[data-testid^="session-list-attention-indicator-${sessionId}-"]`,
  statusSubtitle: (
    sessionId: string,
    state: 'working' | 'ready',
  ) => `session-list-status-subtitle-${sessionId}-${state}`,
  statusSubtitleText: (
    sessionId: string,
    state: 'working' | 'ready',
  ) => `session-list-status-subtitle-text-${sessionId}-${state}`,
  secondaryReadyIndicator: (sessionId: string) => `session-list-attention-indicator-${sessionId}-secondary-ready`,
  attentionHeader: 'session-list-header:attention-promotion-v1',
  workingHeader: 'session-list-header:working-placement-v1',
  attentionPromotionModeTrigger: 'settings-session-attentionPromotionMode-trigger',
  workingPlacementModeTrigger: 'settings-session-workingPlacementMode-trigger',
  densityOption: (density: 'narrow' | 'cozy' | 'detailed') => `dropdown-option-${density}`,
  placementOption: (placement: 'off' | 'global' | 'withinGroups') => `dropdown-option-${placement}`,
  densityTrigger: 'settings-session-sessionListDensity-trigger',
  workingStatusAnimatedTextToggle: 'settings-session-workingStatusAnimatedText-toggle',
  workingStatusAnimatedTextItem: 'settings-session-workingStatusAnimatedText-item',
} as const;

type SeededSession = Readonly<{
  id: string;
  title: string;
}>;

type SessionCreateResponse = Readonly<{
  session?: Readonly<{
    id?: unknown;
  }>;
}>;

type MessageCreateResponse = Readonly<{
  didWrite?: unknown;
  message?: Readonly<{
    seq?: unknown;
  }>;
}>;

type RuntimeStatusResponse = Readonly<{
  session?: Readonly<{
    latestTurnStatus?: unknown;
  }>;
}>;

type SessionTurnMutationResponse = Readonly<{
  success?: unknown;
  applied?: unknown;
  reason?: unknown;
}>;

type PrimaryTurnStatus = 'in_progress' | 'completed' | 'cancelled';

function requireString(value: unknown, context: string): string {
  if (typeof value === 'string' && value.trim()) return value;
  throw new Error(`Missing ${context}`);
}

function requireFiniteNumber(value: unknown, context: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new Error(`Missing ${context}`);
}

async function createPlainSession(params: Readonly<{
  baseUrl: string;
  token: string;
  title: string;
}>): Promise<SeededSession> {
  const tag = `session-list-attention-${randomUUID()}`;
  const res = await fetchJson<SessionCreateResponse>(`${params.baseUrl}/v1/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      tag,
      metadata: JSON.stringify({
        v: 1,
        name: params.title,
        path: `/tmp/${tag}`,
        flavor: 'claude',
      }),
      agentState: null,
      dataEncryptionKey: null,
      encryptionMode: 'plain',
    }),
    timeoutMs: 20_000,
  });

  if (res.status !== 200) {
    throw new Error(`Failed to create seeded session ${params.title} (status=${res.status})`);
  }

  return {
    id: requireString(res.data?.session?.id, `session id for ${params.title}`),
    title: params.title,
  };
}

async function postPlainMessage(params: Readonly<{
  baseUrl: string;
  token: string;
  sessionId: string;
  localId: string;
  value: unknown;
}>): Promise<number> {
  const res = await fetchJson<MessageCreateResponse>(`${params.baseUrl}/v2/sessions/${params.sessionId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': params.localId,
    },
    body: JSON.stringify({
      localId: params.localId,
      content: {
        t: 'plain',
        v: params.value,
      },
    }),
    timeoutMs: 20_000,
  });

  if (res.status !== 200 || res.data?.didWrite !== true) {
    throw new Error(`Failed to seed message ${params.localId} (status=${res.status})`);
  }

  return requireFiniteNumber(res.data?.message?.seq, `message seq for ${params.localId}`);
}

async function markWorkingSessionInProgress(params: Readonly<{
  baseUrl: string;
  token: string;
  sessionId: string;
}>): Promise<void> {
  await updateSessionRuntimeStatus({
    ...params,
    latestTurnStatus: 'in_progress',
  });
}

async function connectWorkingSessionInProgress(params: Readonly<{
  baseUrl: string;
  token: string;
  sessionId: string;
}>): Promise<Readonly<{ close: () => void }>> {
  await updateSessionRuntimeStatus({
    ...params,
    latestTurnStatus: 'in_progress',
  });
  return { close: () => {} };
}

async function updateSessionRuntimeStatus(params: Readonly<{
  baseUrl: string;
  token: string;
  sessionId: string;
  latestTurnStatus: PrimaryTurnStatus;
}>): Promise<void> {
  const observedAt = Date.now();
  const turnId = `turn-${randomUUID()}`;
  await postSessionTurnMutation({
    ...params,
    mutation: {
      v: 1,
      action: 'begin',
      sessionId: params.sessionId,
      turnId,
      mutationId: `mutation-${randomUUID()}`,
      observedAt,
      provider: 'claude',
    },
  });

  if (params.latestTurnStatus !== 'in_progress') {
    const action = params.latestTurnStatus === 'completed' ? 'complete' : 'cancel';
    await postSessionTurnMutation({
      ...params,
      mutation: {
        v: 1,
        action,
        sessionId: params.sessionId,
        turnId,
        mutationId: `mutation-${randomUUID()}`,
        observedAt: observedAt + 1,
        provider: 'claude',
      },
    });
  }

  await waitFor(async () => {
    const res = await fetchJson<RuntimeStatusResponse>(`${params.baseUrl}/v2/sessions/${params.sessionId}`, {
      headers: { Authorization: `Bearer ${params.token}` },
      timeoutMs: 15_000,
    });
    return res.status === 200 && res.data?.session?.latestTurnStatus === params.latestTurnStatus;
  }, {
    timeoutMs: 20_000,
    context: `persist ${params.latestTurnStatus} turn status for ${params.sessionId}`,
  });
}

async function postSessionTurnMutation(params: Readonly<{
  baseUrl: string;
  token: string;
  sessionId: string;
  mutation: Readonly<Record<string, unknown>>;
}>): Promise<void> {
  const res = await fetchJson<SessionTurnMutationResponse>(`${params.baseUrl}/v1/sessions/${params.sessionId}/turns/mutations`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params.mutation),
    timeoutMs: 20_000,
  });

  if (res.status !== 200 || res.data?.success !== true) {
    throw new Error(`Failed to post session turn mutation (status=${res.status}, reason=${String(res.data?.reason)})`);
  }
}

async function connectLegacyThinkingFallback(params: Readonly<{
  baseUrl: string;
  token: string;
  sessionId: string;
}>): Promise<ReturnType<typeof createSessionScopedSocketCollector>> {
  const socket = createSessionScopedSocketCollector(params.baseUrl, params.token, params.sessionId);
  socket.connect();

  try {
    await waitFor(async () => socket.isConnected(), {
      timeoutMs: 20_000,
      context: `connect legacy thinking fallback socket for ${params.sessionId}`,
    });
    socket.emit('session-alive', {
      sid: params.sessionId,
      time: Date.now(),
      thinking: true,
    });
    return socket;
  } catch (error) {
    socket.close();
    throw error;
  }
}

async function seedReadyMarker(params: Readonly<{
  baseUrl: string;
  token: string;
  sessionId: string;
}>): Promise<void> {
  await postPlainMessage({
    baseUrl: params.baseUrl,
    token: params.token,
    sessionId: params.sessionId,
    localId: `ready-text-${randomUUID()}`,
    value: {
      role: 'agent',
      content: {
        type: 'output',
        data: {
          type: 'assistant',
          uuid: `ready-assistant-${randomUUID()}`,
          message: {
            content: [{ type: 'text', text: 'Seeded ready row response.' }],
          },
        },
      },
    },
  });
  await postPlainMessage({
    baseUrl: params.baseUrl,
    token: params.token,
    sessionId: params.sessionId,
    localId: `ready-event-${randomUUID()}`,
    value: {
      role: 'agent',
      content: {
        type: 'event',
        id: `ready-${randomUUID()}`,
        data: { type: 'ready' },
      },
    },
  });
}

async function chooseSessionListDensity(params: Readonly<{
  page: Page;
  baseUrl: string;
  density: 'narrow' | 'cozy' | 'detailed';
}>): Promise<void> {
  await gotoDomContentLoadedWithRetries(params.page, `${params.baseUrl}/settings/session?happier_hmr=0`, 180_000);
  await expect(params.page.getByTestId(sessionListTestIds.densityTrigger)).toHaveCount(1, { timeout: 60_000 });
  await params.page.getByTestId(sessionListTestIds.densityTrigger).click();
  await params.page.getByTestId(sessionListTestIds.densityOption(params.density)).click();
}

async function chooseSessionListPlacementMode(params: Readonly<{
  page: Page;
  baseUrl: string;
  triggerTestId: string;
  placement: 'off' | 'global' | 'withinGroups';
}>): Promise<void> {
  await gotoDomContentLoadedWithRetries(params.page, `${params.baseUrl}/settings/session?happier_hmr=0`, 180_000);
  await expect(params.page.getByTestId(params.triggerTestId)).toHaveCount(1, { timeout: 60_000 });
  await params.page.getByTestId(params.triggerTestId).click();
  await params.page.getByTestId(sessionListTestIds.placementOption(params.placement)).click();
}

async function disableWorkingStatusAnimatedText(params: Readonly<{
  page: Page;
  baseUrl: string;
}>): Promise<void> {
  await gotoDomContentLoadedWithRetries(params.page, `${params.baseUrl}/settings/session?happier_hmr=0`, 180_000);
  const toggle = params.page.getByTestId(sessionListTestIds.workingStatusAnimatedTextToggle);
  const item = params.page.getByTestId(sessionListTestIds.workingStatusAnimatedTextItem);
  await expect
    .poll(
      async () => (await toggle.count()) + (await item.count()),
      { timeout: 60_000 },
    )
    .toBeGreaterThan(0);

  if ((await toggle.count()) > 0) {
    if (await toggle.getAttribute('aria-checked') !== 'false') {
      await toggle.click();
    }
    return;
  }
  await item.click();
}

function row(page: Page, sessionId: string) {
  return page.getByTestId(sessionListTestIds.row(sessionId));
}

function attentionHeader(page: Page) {
  return page.getByTestId(sessionListTestIds.attentionHeader);
}

function workingHeader(page: Page) {
  return page.getByTestId(sessionListTestIds.workingHeader);
}

function anyAttentionIndicator(page: Page, sessionId: string) {
  return page.locator(sessionListTestIds.anyAttentionIndicatorSelector(sessionId));
}

function readySubtitle(page: Page, sessionId: string) {
  return page.getByTestId(sessionListTestIds.statusSubtitle(sessionId, 'ready'));
}

function workingSubtitle(page: Page, sessionId: string) {
  return page.getByTestId(sessionListTestIds.statusSubtitle(sessionId, 'working'));
}

function readySubtitleText(page: Page, sessionId: string) {
  return page.getByTestId(sessionListTestIds.statusSubtitleText(sessionId, 'ready'));
}

function workingSubtitleText(page: Page, sessionId: string) {
  return page.getByTestId(sessionListTestIds.statusSubtitleText(sessionId, 'working'));
}

async function expectRowInSection(params: Readonly<{
  page: Page;
  headerTestId: string;
  sessionId: string;
}>): Promise<void> {
  const rowTestId = sessionListTestIds.row(params.sessionId);
  await expect
    .poll(
      async () => params.page.evaluate(({ headerTestId, rowTestId }) => {
        const elements = Array.from(document.querySelectorAll<HTMLElement>('[data-testid]'));
        const headerIndex = elements.findIndex((element) => element.dataset.testid === headerTestId);
        const rowIndex = elements.findIndex((element) => element.dataset.testid === rowTestId);
        if (headerIndex < 0 || rowIndex < 0 || rowIndex <= headerIndex) return false;
        const nextHeaderIndex = elements.findIndex((element, index) => {
          const testId = element.dataset.testid ?? '';
          return index > headerIndex && testId.startsWith('session-list-header:');
        });
        return nextHeaderIndex < 0 || rowIndex < nextHeaderIndex;
      }, {
        headerTestId: params.headerTestId,
        rowTestId,
      }),
      { timeout: 60_000 },
    )
    .toBe(true);
}

async function expectRowNotInSection(params: Readonly<{
  page: Page;
  headerTestId: string;
  sessionId: string;
}>): Promise<void> {
  const rowTestId = sessionListTestIds.row(params.sessionId);
  await expect
    .poll(
      async () => params.page.evaluate(({ headerTestId, rowTestId }) => {
        const elements = Array.from(document.querySelectorAll<HTMLElement>('[data-testid]'));
        const headerIndex = elements.findIndex((element) => element.dataset.testid === headerTestId);
        const rowIndex = elements.findIndex((element) => element.dataset.testid === rowTestId);
        if (headerIndex < 0 || rowIndex < 0 || rowIndex <= headerIndex) return true;
        const nextHeaderIndex = elements.findIndex((element, index) => {
          const testId = element.dataset.testid ?? '';
          return index > headerIndex && testId.startsWith('session-list-header:');
        });
        return nextHeaderIndex >= 0 && rowIndex > nextHeaderIndex;
      }, {
        headerTestId: params.headerTestId,
        rowTestId,
      }),
      { timeout: 60_000 },
    )
    .toBe(true);
}

test.describe('ui e2e: session list attention', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('session-list-attention-suite');

  let server: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let uiBaseUrl: string | null = null;
  let proxyStop: (() => Promise<void>) | null = null;
  let token: string | null = null;
  let quiet: SeededSession | null = null;
  let working: SeededSession | null = null;
  let ready: SeededSession | null = null;

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

    quiet = await createPlainSession({ baseUrl: server.baseUrl, token, title: 'Quiet attention e2e' });
    working = await createPlainSession({ baseUrl: server.baseUrl, token, title: 'Working attention e2e' });
    ready = await createPlainSession({ baseUrl: server.baseUrl, token, title: 'Ready attention e2e' });

    ui = await startUiWeb({
      testDir: suiteDir,
      env: {
        ...process.env,
        EXPO_PUBLIC_DEBUG: '1',
        EXPO_PUBLIC_HAPPY_SERVER_URL: proxy.baseUrl,
        EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-session-list-attention-${run.runId}`,
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
    if (!server || !token || !uiBaseUrl || !quiet || !working || !ready) throw new Error('missing session list attention fixtures');

    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 300_000);
    await waitForInitialAppUi({ page, timeoutMs: 180_000 });

    await chooseSessionListDensity({ page, baseUrl: uiBaseUrl, density: 'narrow' });
    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 180_000);

    await expect(row(page, quiet.id)).toHaveCount(1, { timeout: 120_000 });
    await expect(row(page, working.id)).toHaveCount(1, { timeout: 120_000 });
    await expect(row(page, ready.id)).toHaveCount(1, { timeout: 120_000 });

    await markWorkingSessionInProgress({ baseUrl: server.baseUrl, token, sessionId: working.id });
    await seedReadyMarker({ baseUrl: server.baseUrl, token, sessionId: ready.id });
    await updateSessionRuntimeStatus({
      baseUrl: server.baseUrl,
      token,
      sessionId: ready.id,
      latestTurnStatus: 'completed',
    });

    await expect(anyAttentionIndicator(page, quiet.id)).toHaveCount(0);
    await expect(workingSubtitle(page, working.id)).toHaveCount(0);
    await expect(readySubtitle(page, ready.id)).toHaveCount(0);
  });

  test('shows ready subtitle outside narrow mode and uses static working text when animation is disabled', async ({ page }) => {
    test.setTimeout(420_000);
    if (!server || !token || !uiBaseUrl || !working || !ready) throw new Error('missing session list attention fixtures');

    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 300_000);
    await waitForInitialAppUi({ page, timeoutMs: 180_000 });

    await chooseSessionListPlacementMode({
      page,
      baseUrl: uiBaseUrl,
      triggerTestId: sessionListTestIds.workingPlacementModeTrigger,
      placement: 'withinGroups',
    });
    await disableWorkingStatusAnimatedText({ page, baseUrl: uiBaseUrl });
    await chooseSessionListDensity({ page, baseUrl: uiBaseUrl, density: 'cozy' });
    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 180_000);

    await expect(row(page, working.id)).toHaveCount(1, { timeout: 120_000 });
    await expect(row(page, ready.id)).toHaveCount(1, { timeout: 120_000 });
    const workingRuntime = await connectWorkingSessionInProgress({ baseUrl: server.baseUrl, token, sessionId: working.id });
    try {
      await seedReadyMarker({ baseUrl: server.baseUrl, token, sessionId: ready.id });
      await updateSessionRuntimeStatus({
        baseUrl: server.baseUrl,
        token,
        sessionId: ready.id,
        latestTurnStatus: 'completed',
      });

      await expect(readySubtitle(page, ready.id)).toHaveCount(1, { timeout: 60_000 });
      await expect(page.getByTestId(sessionListTestIds.secondaryReadyIndicator(ready.id))).toHaveCount(1, { timeout: 60_000 });
      await expect(readySubtitleText(page, ready.id)).not.toHaveText('', { timeout: 60_000 });

      const workingStatus = workingSubtitle(page, working.id);
      await expect(workingStatus).toHaveCount(1, { timeout: 60_000 });
      const workingText = workingSubtitleText(page, working.id);
      await expect(workingText).not.toHaveText('', { timeout: 60_000 });
      const firstStatusText = await workingText.textContent();
      await page.waitForTimeout(3_500);
      await expect(workingText).toHaveText(firstStatusText ?? '');
    } finally {
      workingRuntime.close();
    }
  });

  test('keeps old-preview thinking fallback as a separate working placement path', async ({ page }) => {
    test.setTimeout(420_000);
    if (!server || !token || !uiBaseUrl) throw new Error('missing session list attention fixtures');

    const legacyThinking = await createPlainSession({
      baseUrl: server.baseUrl,
      token,
      title: 'Legacy thinking fallback e2e',
    });
    const before = await fetchSessionV2(server.baseUrl, token, legacyThinking.id);
    expect(before.latestTurnStatus).toBeNull();

    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 300_000);
    await waitForInitialAppUi({ page, timeoutMs: 180_000 });

    await chooseSessionListPlacementMode({
      page,
      baseUrl: uiBaseUrl,
      triggerTestId: sessionListTestIds.workingPlacementModeTrigger,
      placement: 'global',
    });
    await chooseSessionListDensity({ page, baseUrl: uiBaseUrl, density: 'narrow' });
    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 180_000);
    await waitForInitialAppUi({ page, timeoutMs: 180_000 });

    await expect(row(page, legacyThinking.id)).toHaveCount(1, { timeout: 120_000 });
    const legacyRuntime = await connectLegacyThinkingFallback({
      baseUrl: server.baseUrl,
      token,
      sessionId: legacyThinking.id,
    });
    try {
      await expect(workingHeader(page)).toHaveCount(1, { timeout: 60_000 });
      await expectRowInSection({
        page,
        headerTestId: sessionListTestIds.workingHeader,
        sessionId: legacyThinking.id,
      });
    } finally {
      legacyRuntime.close();
    }
  });

  test('keeps live working placement stable and moves unread completion to attention without reload', async ({ page }) => {
    test.setTimeout(540_000);
    if (!server || !token || !uiBaseUrl) throw new Error('missing session list attention fixtures');

    const background = await createPlainSession({
      baseUrl: server.baseUrl,
      token,
      title: 'Live placement background e2e',
    });
    const live = await createPlainSession({
      baseUrl: server.baseUrl,
      token,
      title: 'Live placement working e2e',
    });
    const cancelled = await createPlainSession({
      baseUrl: server.baseUrl,
      token,
      title: 'Live placement cancelled e2e',
    });

    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 300_000);
    await waitForInitialAppUi({ page, timeoutMs: 180_000 });

    await chooseSessionListPlacementMode({
      page,
      baseUrl: uiBaseUrl,
      triggerTestId: sessionListTestIds.attentionPromotionModeTrigger,
      placement: 'global',
    });
    await chooseSessionListPlacementMode({
      page,
      baseUrl: uiBaseUrl,
      triggerTestId: sessionListTestIds.workingPlacementModeTrigger,
      placement: 'global',
    });
    await chooseSessionListDensity({ page, baseUrl: uiBaseUrl, density: 'narrow' });
    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 180_000);
    await waitForInitialAppUi({ page, timeoutMs: 180_000 });

    await expect(row(page, background.id)).toHaveCount(1, { timeout: 120_000 });
    await expect(row(page, live.id)).toHaveCount(1, { timeout: 120_000 });

    await markWorkingSessionInProgress({ baseUrl: server.baseUrl, token, sessionId: live.id });
    await expect(workingHeader(page)).toHaveCount(1, { timeout: 60_000 });
    await expectRowInSection({
      page,
      headerTestId: sessionListTestIds.workingHeader,
      sessionId: live.id,
    });

    await page.evaluate(() => {
      const globalTarget = globalThis as typeof globalThis & {
        __HAPPIER_E2E_ORIGINAL_DATE_NOW__?: typeof Date.now;
      };
      globalTarget.__HAPPIER_E2E_ORIGINAL_DATE_NOW__ = Date.now.bind(Date);
      const staleNow = Date.now() + 180_000;
      Date.now = () => staleNow;
    });
    try {
      await row(page, background.id).click();
      await expect(page).toHaveURL(new RegExp(`/session/${background.id}(?:\\?|$)`), { timeout: 90_000 });
      await expect(workingHeader(page)).toHaveCount(1, { timeout: 60_000 });
      await expectRowInSection({
        page,
        headerTestId: sessionListTestIds.workingHeader,
        sessionId: live.id,
      });
    } finally {
      await page.evaluate(() => {
        const globalTarget = globalThis as typeof globalThis & {
          __HAPPIER_E2E_ORIGINAL_DATE_NOW__?: typeof Date.now;
        };
        if (globalTarget.__HAPPIER_E2E_ORIGINAL_DATE_NOW__) {
          Date.now = globalTarget.__HAPPIER_E2E_ORIGINAL_DATE_NOW__;
          delete globalTarget.__HAPPIER_E2E_ORIGINAL_DATE_NOW__;
        }
      });
    }

    await seedReadyMarker({ baseUrl: server.baseUrl, token, sessionId: live.id });
    await updateSessionRuntimeStatus({
      baseUrl: server.baseUrl,
      token,
      sessionId: live.id,
      latestTurnStatus: 'completed',
    });
    await expect(attentionHeader(page)).toHaveCount(1, { timeout: 60_000 });
    await expectRowInSection({
      page,
      headerTestId: sessionListTestIds.attentionHeader,
      sessionId: live.id,
    });
    await expectRowNotInSection({
      page,
      headerTestId: sessionListTestIds.workingHeader,
      sessionId: live.id,
    });

    await expect(row(page, cancelled.id)).toHaveCount(1, { timeout: 120_000 });
    await markWorkingSessionInProgress({ baseUrl: server.baseUrl, token, sessionId: cancelled.id });
    await expect(workingHeader(page)).toHaveCount(1, { timeout: 60_000 });
    await expectRowInSection({
      page,
      headerTestId: sessionListTestIds.workingHeader,
      sessionId: cancelled.id,
    });

    await updateSessionRuntimeStatus({
      baseUrl: server.baseUrl,
      token,
      sessionId: cancelled.id,
      latestTurnStatus: 'cancelled',
    });
    await expectRowNotInSection({
      page,
      headerTestId: sessionListTestIds.workingHeader,
      sessionId: cancelled.id,
    });
  });
});
