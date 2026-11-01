import { test, expect, type Page, type WebSocketRoute } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { createRunDirs } from '../../src/testkit/runDir';
import { createTestAuthMtls } from '../../src/testkit/auth';
import { fetchJson } from '../../src/testkit/http';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { fetchSessionV2 } from '../../src/testkit/sessions';
import { createMachineBoundSessionScopedSocketCollector } from '../../src/testkit/sessionSocketBinding';
import type { SocketCollector } from '../../src/testkit/socketClient';
import { waitFor } from '../../src/testkit/timing';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { startForwardedHeaderProxy } from '../../src/testkit/uiE2e/forwardedHeaderProxy';
import { waitForInitialAppUi } from '../../src/testkit/uiE2e/waitForInitialAppUi';
import { appendBrowserDiagnostics, collectBrowserDiagnostics } from '../../src/testkit/uiE2e/browserDiagnostics';

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
  settingOption: (option: string) => `dropdown-option-${option}`,
  backgroundWorkAttentionModeTrigger: 'settings-session-backgroundWorkAttentionMode-trigger',
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

async function connectAuthenticatedMachinePublisher(params: Readonly<{
  baseUrl: string;
  token: string;
  sessionId: string;
  thinking: boolean;
}>): Promise<SocketCollector> {
  const { socket } = await createMachineBoundSessionScopedSocketCollector(params);
  socket.connect();
  try {
    await waitFor(async () => socket.isConnected(), {
      timeoutMs: 20_000,
      context: `connect authenticated machine publisher for ${params.sessionId}`,
    });
    socket.emit('session-alive', {
      sid: params.sessionId,
      time: Date.now(),
      thinking: params.thinking,
    });
    await waitFor(async () => (await fetchSessionV2(params.baseUrl, params.token, params.sessionId)).active === true, {
      timeoutMs: 20_000,
      context: `persist authenticated runtime presence for ${params.sessionId}`,
    });
    return socket;
  } catch (error) {
    socket.close();
    throw error;
  }
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

async function chooseSessionListSettingOption(params: Readonly<{
  page: Page;
  baseUrl: string;
  triggerTestId: string;
  option: 'off' | 'global' | 'withinGroups' | 'keepWorking' | 'keepWorkingUnread' | 'showUnread';
}>): Promise<void> {
  await gotoDomContentLoadedWithRetries(params.page, `${params.baseUrl}/settings/session?happier_hmr=0`, 180_000);
  await expect(params.page.getByTestId(params.triggerTestId)).toHaveCount(1, { timeout: 60_000 });
  await params.page.getByTestId(params.triggerTestId).click();
  await params.page.getByTestId(sessionListTestIds.settingOption(params.option)).click();
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

function collectPlacementSocketUpdates(page: Page, sessionIds: ReadonlySet<string>) {
  const updates: Record<string, unknown>[] = [];
  const recordPackets = (payload: string) => {
    for (const packet of payload.split('\x1e')) {
      if (!packet.startsWith('42')) continue;
      let event: unknown;
      try {
        event = JSON.parse(packet.slice(2));
      } catch {
        continue;
      }
      if (!Array.isArray(event)) continue;
      const data: unknown = event[1];
      if (!data || typeof data !== 'object') continue;
      const body = event[0] === 'update' && 'body' in data ? data.body : data;
      if (!body || typeof body !== 'object') continue;
      const fields = body as Record<string, unknown>;
      if (typeof fields.id !== 'string' || !sessionIds.has(fields.id)) continue;
      if (fields.t !== 'update-session' && fields.type !== 'activity') continue;
      updates.push({
        receivedAt: Date.now(),
        sessionId: fields.id,
        event: event[0] === 'update' ? 'update-session' : 'activity',
        active: typeof fields.active === 'boolean' ? fields.active : undefined,
        activeAt: typeof fields.activeAt === 'number' ? fields.activeAt : undefined,
        latestTurnStatus: ['in_progress', 'completed', 'cancelled', 'failed'].includes(String(fields.latestTurnStatus))
          ? fields.latestTurnStatus : undefined,
        latestTurnStatusObservedAt: typeof fields.latestTurnStatusObservedAt === 'number'
          ? fields.latestTurnStatusObservedAt : undefined,
      });
    }
  };
  page.on('websocket', (socket) => {
    socket.on('framereceived', ({ payload }) => recordPackets(typeof payload === 'string' ? payload : payload.toString('utf8')));
  });
  page.on('response', (response) => {
    if (new URL(response.url()).pathname !== '/v1/updates/' || response.request().method() !== 'GET') return;
    void response.text().then(recordPackets).catch(() => {
      updates.push({ event: 'polling-response-unavailable' });
    });
  });
  return () => updates;
}

async function readRowInSection(params: Readonly<{
  page: Page;
  headerTestId: string;
  sessionId: string;
}>): Promise<boolean | null> {
  const rowTestId = sessionListTestIds.row(params.sessionId);
  return params.page.evaluate(({ headerTestId, rowTestId }) => {
    const elements = Array.from(document.querySelectorAll<HTMLElement>('[data-testid]'));
    const row = elements.find((element) => element.dataset.testid === rowTestId);
    if (!row) return null;
    const rowRect = row.getBoundingClientRect();
    if (rowRect.width <= 0 || rowRect.height <= 0) return null;

    // Virtualized cells retain DOM order when recycled. Section membership follows
    // their rendered positions, read together so a live move cannot split the sample.
    let precedingHeader: { testId: string; top: number } | null = null;
    for (const element of elements) {
      const testId = element.dataset.testid ?? '';
      if (!testId.startsWith('session-list-header:')) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0 || rect.top > rowRect.top) continue;
      if (!precedingHeader || rect.top > precedingHeader.top) {
        precedingHeader = { testId, top: rect.top };
      }
    }
    return precedingHeader?.testId === headerTestId;
  }, {
    headerTestId: params.headerTestId,
    rowTestId,
  });
}

async function expectRowInSection(params: Parameters<typeof readRowInSection>[0]): Promise<void> {
  await expect.poll(() => readRowInSection(params), { timeout: 60_000 }).toBe(true);
}

async function expectRowNotInSection(params: Parameters<typeof readRowInSection>[0]): Promise<void> {
  await expect.poll(() => readRowInSection(params), { timeout: 60_000 }).toBe(false);
}

async function publishRuntimeActivity(params: Readonly<{
  socket: SocketCollector;
  sessionId: string;
  snapshot: Readonly<{ state: 'active' | 'idle'; activeCount: number }>;
}>): Promise<void> {
  const ack = await params.socket.emitWithAck<{ status?: string }>('session-runtime-activity-snapshot', {
    sessionId: params.sessionId,
    mutationId: `runtime-activity-${randomUUID()}`,
    snapshot: params.snapshot,
  });
  if (ack?.status !== 'applied' && ack?.status !== 'unchanged') {
    throw new Error(`Runtime activity snapshot was not applied (status=${String(ack?.status)})`);
  }
}

async function publishPendingPermissionRequest(params: Readonly<{
  baseUrl: string;
  token: string;
  socket: SocketCollector;
  sessionId: string;
}>): Promise<void> {
  const current = await fetchSessionV2(params.baseUrl, params.token, params.sessionId);
  const ack = await params.socket.emitWithAck<{ result?: string }>('update-state', {
    sid: params.sessionId,
    // Plain sessions carry agent state as JSON, the same shape the CLI publishes with its counts.
    agentState: JSON.stringify({
      requests: { 'e2e-permission': { tool: 'Bash', arguments: { command: 'ls' }, createdAt: Date.now() } },
    }),
    expectedVersion: current.agentStateVersion,
    activitySummaryV1: { pendingPermissionRequestCount: 1, pendingUserActionRequestCount: 0 },
  });
  if (ack?.result !== 'success') {
    throw new Error(`Pending permission request was not published (result=${String(ack?.result)})`);
  }
}

function startPresenceKeepAlive(socket: SocketCollector, sessionId: string): () => void {
  const timer = setInterval(() => {
    socket.emit('session-alive', { sid: sessionId, time: Date.now(), thinking: false });
  }, 10_000);
  return () => clearInterval(timer);
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
    test.setTimeout(180_000);
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
    test.setTimeout(180_000);
    if (!server || !token || !uiBaseUrl || !working || !ready) throw new Error('missing session list attention fixtures');

    // The narrow-density scenario intentionally leaves its shared session in progress. Use a
    // fresh session here so this scenario proves the live in-progress projection it establishes,
    // rather than accidentally accepting the prior test's still-in-progress status.
    const currentWorking = await createPlainSession({
        baseUrl: server.baseUrl,
        token,
        title: 'Static working attention e2e',
    });
    const workingRuntime = await connectAuthenticatedMachinePublisher({
      baseUrl: server.baseUrl,
      token,
      sessionId: currentWorking.id,
      thinking: false,
    });

    try {
      await markWorkingSessionInProgress({
        baseUrl: server.baseUrl,
        token,
        sessionId: currentWorking.id,
      });
      await page.setViewportSize({ width: 1440, height: 900 });
      await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 300_000);
      await waitForInitialAppUi({ page, timeoutMs: 180_000 });

      await chooseSessionListSettingOption({
        page,
        baseUrl: uiBaseUrl,
        triggerTestId: sessionListTestIds.workingPlacementModeTrigger,
        option: 'withinGroups',
      });
      await disableWorkingStatusAnimatedText({ page, baseUrl: uiBaseUrl });
      await chooseSessionListDensity({ page, baseUrl: uiBaseUrl, density: 'cozy' });
      await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 180_000);

      await expect(row(page, currentWorking.id)).toHaveCount(1, { timeout: 120_000 });
      await expect(row(page, ready.id)).toHaveCount(1, { timeout: 120_000 });
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

      const workingStatus = workingSubtitle(page, currentWorking.id);
      await expect(workingStatus).toHaveCount(1, { timeout: 60_000 });
      const workingText = workingSubtitleText(page, currentWorking.id);
      await expect(workingText).not.toHaveText('', { timeout: 60_000 });
      const firstStatusText = await workingText.textContent();
      await page.waitForTimeout(3_500);
      await expect(workingText).toHaveText(firstStatusText ?? '');
    } finally {
      workingRuntime.close();
    }
  });

  test('keeps live working placement stable and moves unread completion to attention without reload', async ({ page }) => {
    test.setTimeout(180_000);
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

    const browserDiagnostics = collectBrowserDiagnostics({ page });
    const socketUpdates = collectPlacementSocketUpdates(page, new Set([live.id, cancelled.id]));
    const runtimePublishers: SocketCollector[] = [];
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 300_000);
      await waitForInitialAppUi({ page, timeoutMs: 180_000 });

      await chooseSessionListSettingOption({
        page,
        baseUrl: uiBaseUrl,
        triggerTestId: sessionListTestIds.attentionPromotionModeTrigger,
        option: 'global',
      });
      await chooseSessionListSettingOption({
        page,
        baseUrl: uiBaseUrl,
        triggerTestId: sessionListTestIds.workingPlacementModeTrigger,
        option: 'global',
      });
      await chooseSessionListDensity({ page, baseUrl: uiBaseUrl, density: 'narrow' });
      await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 180_000);
      await waitForInitialAppUi({ page, timeoutMs: 180_000 });

      await expect(row(page, background.id)).toHaveCount(1, { timeout: 120_000 });
      await expect(row(page, live.id)).toHaveCount(1, { timeout: 120_000 });

      runtimePublishers.push(await connectAuthenticatedMachinePublisher({
        baseUrl: server.baseUrl,
        token,
        sessionId: live.id,
        thinking: false,
      }));
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
      runtimePublishers.push(await connectAuthenticatedMachinePublisher({
        baseUrl: server.baseUrl,
        token,
        sessionId: cancelled.id,
        thinking: false,
      }));
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
    } catch (error) {
      const serverProjections = await Promise.all([live, cancelled].map(async (session) => {
        try {
          const projection = await fetchSessionV2(server!.baseUrl, token!, session.id);
          return {
            sessionId: session.id,
            active: projection.active,
            activeAt: projection.activeAt,
            latestTurnStatus: projection.latestTurnStatus,
          };
        } catch {
          return { sessionId: session.id, unavailable: true };
        }
      }));
      const visibleOrder = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('[data-testid]'))
        .map((element) => element.dataset.testid)
        .filter((id) => id?.startsWith('session-list-header:') || id?.startsWith('session-list-item-')))
        .catch(() => ['page-unavailable']);
      const diagnostics = JSON.stringify({ serverProjections, socketUpdates: socketUpdates(), visibleOrder }, null, 2);
      await test.info().attach('session-list-placement', { body: diagnostics, contentType: 'application/json' });
      throw appendBrowserDiagnostics(error, `${browserDiagnostics().replaceAll(token, '[redacted]')}\n${diagnostics}`);
    } finally {
      for (const publisher of runtimePublishers) publisher.close();
    }
  });

  test('presents background replies through all three attention modes and returns to Working once read', async ({ page }) => {
    test.setTimeout(240_000);
    if (!server || !token || !uiBaseUrl) throw new Error('missing session list attention fixtures');

    const session = await createPlainSession({
      baseUrl: server.baseUrl,
      token,
      title: 'Background reply attention modes',
    });
    const browserDiagnostics = collectBrowserDiagnostics({ page });
    let publisher: SocketCollector | null = null;
    let stopKeepAlive: (() => void) | null = null;
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 300_000);
      await waitForInitialAppUi({ page, timeoutMs: 180_000 });
      await chooseSessionListSettingOption({
        page,
        baseUrl: uiBaseUrl,
        triggerTestId: sessionListTestIds.attentionPromotionModeTrigger,
        option: 'global',
      });
      await chooseSessionListSettingOption({
        page,
        baseUrl: uiBaseUrl,
        triggerTestId: sessionListTestIds.workingPlacementModeTrigger,
        option: 'global',
      });
      await chooseSessionListDensity({ page, baseUrl: uiBaseUrl, density: 'cozy' });
      await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 180_000);
      await waitForInitialAppUi({ page, timeoutMs: 180_000 });
      await expect(row(page, session.id)).toHaveCount(1, { timeout: 120_000 });

      publisher = await connectAuthenticatedMachinePublisher({
        baseUrl: server.baseUrl,
        token,
        sessionId: session.id,
        thinking: false,
      });
      stopKeepAlive = startPresenceKeepAlive(publisher, session.id);
      await publishRuntimeActivity({ socket: publisher, sessionId: session.id, snapshot: { state: 'active', activeCount: 1 } });
      await seedReadyMarker({ baseUrl: server.baseUrl, token, sessionId: session.id });
      await updateSessionRuntimeStatus({
        baseUrl: server.baseUrl,
        token,
        sessionId: session.id,
        latestTurnStatus: 'completed',
      });

      for (const mode of ['keepWorking', 'keepWorkingUnread', 'showUnread'] as const) {
        await chooseSessionListSettingOption({
          page, baseUrl: uiBaseUrl,
          triggerTestId: sessionListTestIds.backgroundWorkAttentionModeTrigger,
          option: mode,
        });
        await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 180_000);
        await seedReadyMarker({ baseUrl: server.baseUrl, token, sessionId: session.id });
        await expectRowInSection({
          page,
          headerTestId: mode === 'showUnread' ? sessionListTestIds.attentionHeader : sessionListTestIds.workingHeader,
          sessionId: session.id,
        });
        await expect(readySubtitle(page, session.id)).toHaveCount(0);
        const spinner = page.getByTestId(`session-row-attention-indicator-spinner-${session.id}-secondary`);
        if (mode === 'keepWorking') {
          await expect(spinner).toHaveCount(1);
          await expect(page.getByTestId(`session-row-unread-indicator-${session.id}-secondary`)).toHaveCount(0);
          await expect(page.getByTestId(`session-row-unread-center-${session.id}-secondary`)).toHaveCount(1);
          await row(page, session.id).screenshot({ path: test.info().outputPath('working-unread.png') });
        } else {
          await expect(spinner).toHaveCount(0);
          await expect(page.getByTestId(`session-list-attention-indicator-${session.id}-secondary-unread`)).toHaveCount(1);
        }
        await row(page, session.id).click();
        await expect(page).toHaveURL(new RegExp(`/session/${session.id}(?:\\?|$)`), { timeout: 90_000 });
        await expectRowInSection({ page, headerTestId: sessionListTestIds.workingHeader, sessionId: session.id });
        await expect(spinner).toHaveCount(1);
        await expect(page.getByTestId(`session-row-unread-indicator-${session.id}-secondary`)).toHaveCount(0);
        await expect(page.getByTestId(`session-row-unread-center-${session.id}-secondary`)).toHaveCount(0);
        if (mode === 'keepWorking') await row(page, session.id).screenshot({ path: test.info().outputPath('working-read.png') });
      }
      // A new unread completed reply becomes ready only after reported work settles.
      await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 180_000);
      await seedReadyMarker({ baseUrl: server.baseUrl, token, sessionId: session.id });
      await publishRuntimeActivity({ socket: publisher, sessionId: session.id, snapshot: { state: 'idle', activeCount: 0 } });
      await expectRowInSection({ page, headerTestId: sessionListTestIds.attentionHeader, sessionId: session.id });
      await expect(readySubtitle(page, session.id)).toHaveCount(1);

    } catch (error) {
      throw appendBrowserDiagnostics(error, browserDiagnostics().replaceAll(token, '[redacted]'));
    } finally {
      stopKeepAlive?.();
      publisher?.close();
    }
  });

  test('keeps delayed background observations in Working until reported activity settles', async ({ page }) => {
    test.setTimeout(360_000);
    if (!server || !token || !uiBaseUrl) throw new Error('missing session list attention fixtures');
    const session = await createPlainSession({ baseUrl: server.baseUrl, token, title: 'Delayed background observation' });
    const browserDiagnostics = collectBrowserDiagnostics({ page });
    let publisher: SocketCollector | null = null;
    let stopKeepAlive: (() => void) | null = null;
    let holdObservations = false;
    let heldObservations = 0;
    // Hold only this Session's repeating observations at the real transport boundary. The
    // publisher stays alive, while the UI's existing freshness deadline runs on the real clock.
    await page.routeWebSocket(url => url.pathname === '/v1/updates/', route => {
      const upstream = route.connectToServer();
      upstream.onMessage(message => {
        if (holdObservations && typeof message === 'string' && message.startsWith('42')) {
          let event: unknown;
          try { event = JSON.parse(message.slice(2)); } catch { /* Other Socket.IO packets pass through. */ }
          const data: unknown = Array.isArray(event) ? event[1] : null;
          const body = data && typeof data === 'object' && Array.isArray(event) && event[0] === 'update'
            && 'body' in data ? data.body : data;
          if (body && typeof body === 'object' && 'id' in body && body.id === session.id
            && (('type' in body && body.type === 'activity') || 'activeAt' in body)) {
            heldObservations += 1;
            return;
          }
        }
        route.send(message);
      });
    });
    try {
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.setViewportSize({ width: 1440, height: 900 });
      await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 180_000);
      await waitForInitialAppUi({ page, timeoutMs: 180_000 });
      for (const [triggerTestId, option] of [
        [sessionListTestIds.attentionPromotionModeTrigger, 'global'],
        [sessionListTestIds.workingPlacementModeTrigger, 'global'],
        [sessionListTestIds.backgroundWorkAttentionModeTrigger, 'keepWorking'],
      ] as const) {
        await chooseSessionListSettingOption({ page, baseUrl: uiBaseUrl, triggerTestId, option });
      }
      await chooseSessionListDensity({ page, baseUrl: uiBaseUrl, density: 'cozy' });
      await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 180_000);
      await waitForInitialAppUi({ page, timeoutMs: 180_000 });
      publisher = await connectAuthenticatedMachinePublisher({
        baseUrl: server.baseUrl, token, sessionId: session.id, thinking: false,
      });
      stopKeepAlive = startPresenceKeepAlive(publisher, session.id);
      await publishRuntimeActivity({ socket: publisher, sessionId: session.id, snapshot: { state: 'active', activeCount: 1 } });
      await seedReadyMarker({ baseUrl: server.baseUrl, token, sessionId: session.id });
      await updateSessionRuntimeStatus({ baseUrl: server.baseUrl, token, sessionId: session.id, latestTurnStatus: 'completed' });
      const spinner = page.getByTestId(`session-row-attention-indicator-spinner-${session.id}-secondary`);
      await expectRowInSection({ page, headerTestId: sessionListTestIds.workingHeader, sessionId: session.id });
      await publishRuntimeActivity({ socket: publisher, sessionId: session.id, snapshot: { state: 'active', activeCount: 2 } });
      await expectRowInSection({ page, headerTestId: sessionListTestIds.workingHeader, sessionId: session.id });
      const hasRunningAnimation = () => spinner.evaluate(element => element.getAnimations({ subtree: true })
        .some(animation => animation.playState === 'running'));
      await expect.poll(hasRunningAnimation).toBe(true);
      holdObservations = true;
      await expect(workingSubtitleText(page, session.id)).toContainText('awaiting updates', { timeout: 180_000 });
      expect(heldObservations).toBeGreaterThan(0);
      await expectRowInSection({ page, headerTestId: sessionListTestIds.workingHeader, sessionId: session.id });
      await expect(spinner).toHaveCount(1);
      await expect.poll(hasRunningAnimation).toBe(false);
      await row(page, session.id).screenshot({ path: test.info().outputPath('background-awaiting-updates-wide.png') });
      await page.setViewportSize({ width: 390, height: 844 });
      await expectRowInSection({ page, headerTestId: sessionListTestIds.workingHeader, sessionId: session.id });
      await expect(workingSubtitleText(page, session.id)).toContainText('awaiting updates');
      await row(page, session.id).screenshot({ path: test.info().outputPath('background-awaiting-updates-phone.png') });

      holdObservations = false;
      await publishRuntimeActivity({ socket: publisher, sessionId: session.id, snapshot: { state: 'idle', activeCount: 0 } });
      await expectRowInSection({ page, headerTestId: sessionListTestIds.attentionHeader, sessionId: session.id });
      await expect(readySubtitle(page, session.id)).toHaveCount(1);
    } catch (error) {
      throw appendBrowserDiagnostics(error, browserDiagnostics().replaceAll(token, '[redacted]'));
    } finally {
      stopKeepAlive?.();
      publisher?.close();
    }
  });

  test('keeps an approved permission settled when an old socket update arrives', async ({ page }) => {
    test.setTimeout(360_000);
    if (!server || !token || !uiBaseUrl) throw new Error('missing session list attention fixtures');

    const session = await createPlainSession({ baseUrl: server.baseUrl, token, title: 'Settled permission e2e' });
    const browserDiagnostics = collectBrowserDiagnostics({ page });
    let publisher: SocketCollector | null = null;
    let stopKeepAlive: (() => void) | null = null;
    let pendingUpdate: Readonly<{ route: WebSocketRoute; packet: string }> | null = null;
    const readPendingUpdate = () => pendingUpdate;
    // Replay a real server packet at the transport boundary. The UI still runs its
    // actual decoding, socket handler, batching, store and row subscriptions.
    await page.routeWebSocket(url => url.pathname === '/v1/updates/', route => {
      const upstream = route.connectToServer();
      upstream.onMessage(message => {
        if (typeof message === 'string' && message.startsWith('42')) {
          let event: unknown;
          try { event = JSON.parse(message.slice(2)); } catch { /* Other Socket.IO packets pass through. */ }
          const data: unknown = Array.isArray(event) && event[0] === 'update' ? event[1] : null;
          const body = data && typeof data === 'object' && 'body' in data ? data.body : null;
          if (body && typeof body === 'object' && 'id' in body && body.id === session.id
            && 'pendingPermissionRequestCount' in body && body.pendingPermissionRequestCount === 1) {
            pendingUpdate = { route, packet: message };
          }
        }
        route.send(message);
      });
    });
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 180_000);
      await waitForInitialAppUi({ page, timeoutMs: 180_000 });
      await chooseSessionListDensity({ page, baseUrl: uiBaseUrl, density: 'cozy' });
      await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 180_000);
      await waitForInitialAppUi({ page, timeoutMs: 180_000 });
      await expect(row(page, session.id)).toHaveCount(1, { timeout: 120_000 });
      publisher = await connectAuthenticatedMachinePublisher({ baseUrl: server.baseUrl, token, sessionId: session.id, thinking: false });
      stopKeepAlive = startPresenceKeepAlive(publisher, session.id);
      await publishRuntimeActivity({ socket: publisher, sessionId: session.id, snapshot: { state: 'active', activeCount: 1 } });
      await publishPendingPermissionRequest({ baseUrl: server.baseUrl, token, socket: publisher, sessionId: session.id });
      const permissionIndicator = page.getByTestId(`session-list-attention-indicator-${session.id}-secondary-permission_required`);
      await expect(permissionIndicator).toHaveCount(1, { timeout: 60_000 });
      await expect.poll(() => pendingUpdate !== null).toBe(true);
      await row(page, session.id).click();
      await expect(page).toHaveURL(new RegExp(`/session/${session.id}(?:\\?|$)`), { timeout: 90_000 });
      const composerStatus = page.getByTestId('agent-input-connection-status-text');
      await expect(composerStatus).toContainText(/permission required/i, { timeout: 60_000 });

      const current = await fetchSessionV2(server.baseUrl, token, session.id);
      const ack = await publisher.emitWithAck<{ result?: string }>('update-state', {
        sid: session.id,
        agentState: JSON.stringify({ requests: {}, completedRequests: {
          'e2e-permission': { tool: 'Bash', arguments: { command: 'ls' }, status: 'approved', completedAt: Date.now() },
        } }),
        expectedVersion: current.agentStateVersion,
        activitySummaryV1: { pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0 },
      });
      expect(ack?.result).toBe('success');
      await expect(permissionIndicator).toHaveCount(0, { timeout: 60_000 });
      await expect(composerStatus).not.toContainText(/permission required/i);
      await expect(workingSubtitle(page, session.id)).toHaveCount(1);
      const stale = readPendingUpdate();
      if (!stale) throw new Error('Missing captured pending update');
      stale.route.send(stale.packet);
      // A subsequent real update provides an observable barrier after the replay.
      await publishRuntimeActivity({ socket: publisher, sessionId: session.id, snapshot: { state: 'idle', activeCount: 0 } });
      await expect(workingSubtitle(page, session.id)).toHaveCount(0, { timeout: 60_000 });
      await expect(permissionIndicator).toHaveCount(0);
      await expect(composerStatus).not.toContainText(/permission required/i);
      await row(page, session.id).screenshot({ path: test.info().outputPath('permission-settled-after-stale-update.png') });
    } catch (error) {
      throw appendBrowserDiagnostics(error, browserDiagnostics().replaceAll(token, '[redacted]'));
    } finally {
      stopKeepAlive?.();
      publisher?.close();
    }
  });

  test('keeps a background request in attention past the runtime freshness window', async ({ page }) => {
    test.setTimeout(360_000);
    if (!server || !token || !uiBaseUrl) throw new Error('missing session list attention fixtures');

    const session = await createPlainSession({
      baseUrl: server.baseUrl,
      token,
      title: 'Waiting request e2e',
    });
    const browserDiagnostics = collectBrowserDiagnostics({ page });
    let publisher: SocketCollector | null = null;
    let stopKeepAlive: (() => void) | null = null;
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 180_000);
      await waitForInitialAppUi({ page, timeoutMs: 180_000 });
      await chooseSessionListSettingOption({
        page,
        baseUrl: uiBaseUrl,
        triggerTestId: sessionListTestIds.attentionPromotionModeTrigger,
        option: 'global',
      });
      await chooseSessionListSettingOption({
        page,
        baseUrl: uiBaseUrl,
        triggerTestId: sessionListTestIds.workingPlacementModeTrigger,
        option: 'global',
      });
      await chooseSessionListDensity({ page, baseUrl: uiBaseUrl, density: 'cozy' });
      await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 180_000);
      await waitForInitialAppUi({ page, timeoutMs: 180_000 });
      await expect(row(page, session.id)).toHaveCount(1, { timeout: 120_000 });

      publisher = await connectAuthenticatedMachinePublisher({
        baseUrl: server.baseUrl,
        token,
        sessionId: session.id,
        thinking: false,
      });
      stopKeepAlive = startPresenceKeepAlive(publisher, session.id);
      // The foreground turn has ended; a background agent is still running and asks for permission.
      await updateSessionRuntimeStatus({
        baseUrl: server.baseUrl,
        token,
        sessionId: session.id,
        latestTurnStatus: 'completed',
      });
      await publishRuntimeActivity({ socket: publisher, sessionId: session.id, snapshot: { state: 'active', activeCount: 1 } });
      await publishPendingPermissionRequest({ baseUrl: server.baseUrl, token, socket: publisher, sessionId: session.id });

      // No reload: the row was offline when the list loaded, so this also proves the live update
      // brings it back online.
      const permissionIndicator = page.getByTestId(`session-list-attention-indicator-${session.id}-secondary-permission_required`);
      await expect(permissionIndicator).toHaveCount(1, { timeout: 60_000 });

      // The request's observation instant is never refreshed while it waits; it must not age out.
      await page.waitForTimeout(150_000);
      await expect(permissionIndicator).toHaveCount(1);
      await expectRowInSection({ page, headerTestId: sessionListTestIds.attentionHeader, sessionId: session.id });
    } catch (error) {
      throw appendBrowserDiagnostics(error, browserDiagnostics().replaceAll(token, '[redacted]'));
    } finally {
      stopKeepAlive?.();
      publisher?.close();
    }
  });
});
