import { sessionListOccurrenceId } from '../../src/testkit/uiE2e/sessionListRowTestId';
import { resolveCanonicalServerIdForUi } from '../../src/testkit/uiE2e/sessionFoldersDrag';
import type { SocketCollector } from '../../src/testkit/socketClient';
import { appendBrowserDiagnostics, collectBrowserDiagnostics } from '../../src/testkit/uiE2e/browserDiagnostics';
import { expect, test, type WebSocketRoute } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

import { createTestAuthMtls } from '../../src/testkit/auth';
import { fetchSessionV2 } from '../../src/testkit/sessions';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { createRunDirs } from '../../src/testkit/runDir';
import {
  anySessionAttentionIndicator,
  chooseSessionListDensity,
  chooseSessionListSettingOption,
  connectAuthenticatedSessionPublisher,
  expectRowInSection,
  expectRowNotInSection,
  publishRuntimeActivity,
  startPresenceKeepAlive,
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
let rowServerId: string;

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

    rowServerId = await resolveCanonicalServerIdForUi(proxy.baseUrl);

    ui = await startUiWeb({
      testDir: suiteDir,
      env: {
        ...process.env,
        EXPO_PUBLIC_DEBUG: '1',
        EXPO_PUBLIC_HAPPY_SERVER_URL: proxy.baseUrl,
        EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-session-list-attention-status-${run.runId}`,
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

    await expect(sessionRow(page, quiet.id, rowServerId)).toHaveCount(1, { timeout: 120_000 });
    await expect(sessionRow(page, working.id, rowServerId)).toHaveCount(1, { timeout: 120_000 });
    await expect(sessionRow(page, ready.id, rowServerId)).toHaveCount(1, { timeout: 120_000 });

    const workingPublisher = await connectAuthenticatedSessionPublisher({
      baseUrl: server.baseUrl,
      token,
      sessionId: working.id,
    });
    try {
      await updateSessionRuntimeStatus({ baseUrl: server.baseUrl, token, sessionId: working.id, latestTurnStatus: 'in_progress' });
      await seedReadyMarker({ baseUrl: server.baseUrl, token, sessionId: ready.id });
      await updateSessionRuntimeStatus({ baseUrl: server.baseUrl, token, sessionId: ready.id, latestTurnStatus: 'completed' });

      await expect(anySessionAttentionIndicator(page, quiet.id, rowServerId)).toHaveCount(0);
      await expect(page.getByTestId(sessionListAttentionTestIds.attentionIndicator(working.id, 'working', rowServerId))).toHaveCount(1, { timeout: 60_000 });
      await expect(page.getByTestId(sessionListAttentionTestIds.attentionIndicator(ready.id, 'ready', rowServerId))).toHaveCount(1, { timeout: 60_000 });
      await expect(sessionStatusSubtitle(page, working.id, 'working', rowServerId)).toHaveCount(0);
      await expect(sessionStatusSubtitle(page, ready.id, 'ready', rowServerId)).toHaveCount(0);
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

    await expect(sessionRow(page, working.id, rowServerId)).toHaveCount(1, { timeout: 120_000 });
    await expect(sessionRow(page, ready.id, rowServerId)).toHaveCount(1, { timeout: 120_000 });

    const workingPublisher = await connectAuthenticatedSessionPublisher({
      baseUrl: server.baseUrl,
      token,
      sessionId: working.id,
    });
    try {
      await updateSessionRuntimeStatus({ baseUrl: server.baseUrl, token, sessionId: working.id, latestTurnStatus: 'in_progress' });
      await seedReadyMarker({ baseUrl: server.baseUrl, token, sessionId: ready.id });
      await updateSessionRuntimeStatus({ baseUrl: server.baseUrl, token, sessionId: ready.id, latestTurnStatus: 'completed' });

      await expect(sessionStatusSubtitle(page, ready.id, 'ready', rowServerId)).toHaveCount(1, { timeout: 60_000 });
      await expect(page.getByTestId(sessionListAttentionTestIds.secondaryReadyIndicator(ready.id, rowServerId))).toHaveCount(1, { timeout: 60_000 });
      await expect(sessionStatusSubtitleText(page, ready.id, 'ready', rowServerId)).not.toHaveText('', { timeout: 60_000 });

      await expect(sessionStatusSubtitle(page, working.id, 'working', rowServerId)).toHaveCount(1, { timeout: 60_000 });
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
    await chooseSessionListSettingOption({ page, baseUrl: uiBaseUrl, triggerTestId: sessionListAttentionTestIds.attentionPromotionModeTrigger });
    await chooseSessionListSettingOption({ page, baseUrl: uiBaseUrl, triggerTestId: sessionListAttentionTestIds.workingPlacementModeTrigger });
    await chooseSessionListDensity({ page, baseUrl: uiBaseUrl, density: 'narrow' });
    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 180_000);

    await expect(sessionRow(page, live.id, rowServerId)).toHaveCount(1, { timeout: 120_000 });
    await expect(sessionRow(page, cancelled.id, rowServerId)).toHaveCount(1, { timeout: 120_000 });
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
      await expectRowInSection({ serverId: rowServerId, page, headerTestId: sessionListAttentionTestIds.workingHeader, sessionId: live.id });

      await seedReadyMarker({ baseUrl: server.baseUrl, token, sessionId: live.id });
      await updateSessionRuntimeStatus({ baseUrl: server.baseUrl, token, sessionId: live.id, latestTurnStatus: 'completed' });
      await expect(page.getByTestId(sessionListAttentionTestIds.attentionHeader)).toHaveCount(1, { timeout: 60_000 });
      await expectRowInSection({ serverId: rowServerId, page, headerTestId: sessionListAttentionTestIds.attentionHeader, sessionId: live.id });
      await expectRowNotInSection({ serverId: rowServerId, page, headerTestId: sessionListAttentionTestIds.workingHeader, sessionId: live.id });

      await updateSessionRuntimeStatus({ baseUrl: server.baseUrl, token, sessionId: cancelled.id, latestTurnStatus: 'in_progress' });
      await expectRowInSection({ serverId: rowServerId, page, headerTestId: sessionListAttentionTestIds.workingHeader, sessionId: cancelled.id });
      await updateSessionRuntimeStatus({ baseUrl: server.baseUrl, token, sessionId: cancelled.id, latestTurnStatus: 'cancelled' });
      await expectRowNotInSection({ serverId: rowServerId, page, headerTestId: sessionListAttentionTestIds.workingHeader, sessionId: cancelled.id });
    } finally {
      cancelledPublisher?.close();
      livePublisher.close();
    }
  });
  test('keeps an approved permission settled when an old socket update arrives', async ({ page }) => {
    test.setTimeout(360_000);
    if (!server || !token || !uiBaseUrl) throw new Error('missing session list attention fixtures');

    const session = await seedAttentionSession({ baseUrl: server.baseUrl, token, title: 'Settled permission e2e' });
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
      await expect(sessionRow(page, session.id, rowServerId)).toHaveCount(1, { timeout: 120_000 });
      publisher = await connectAuthenticatedSessionPublisher({ baseUrl: server.baseUrl, token, sessionId: session.id, thinking: false });
      stopKeepAlive = startPresenceKeepAlive(publisher, session.id);
      await publishRuntimeActivity({ socket: publisher, sessionId: session.id, snapshot: { state: 'active', activeCount: 1 } });
      const initial = await fetchSessionV2(server.baseUrl, token, session.id);
      const pendingAck = await publisher.emitWithAck<{ result?: string }>('update-state', {
        sid: session.id,
        agentState: JSON.stringify({ requests: {
          'e2e-permission': { tool: 'Bash', arguments: { command: 'ls' }, createdAt: Date.now() },
        } }),
        expectedVersion: initial.agentStateVersion,
        activitySummaryV1: { pendingPermissionRequestCount: 1, pendingUserActionRequestCount: 0 },
      });
      expect(pendingAck?.result).toBe('success');
      const permissionIndicator = page.getByTestId(`session-list-attention-indicator-${sessionListOccurrenceId(rowServerId, session.id)}-secondary-permission_required`);
      await expect(permissionIndicator).toHaveCount(1, { timeout: 60_000 });
      await expect.poll(() => pendingUpdate !== null).toBe(true);
      await sessionRow(page, session.id, rowServerId).click();
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
      await expect(sessionStatusSubtitle(page, session.id, 'working', rowServerId)).toHaveCount(1);
      const stale = readPendingUpdate();
      if (!stale) throw new Error('Missing captured pending update');
      stale.route.send(stale.packet);
      // A subsequent real update provides an observable barrier after the replay.
      await publishRuntimeActivity({ socket: publisher, sessionId: session.id, snapshot: { state: 'idle', activeCount: 0 } });
      await expect(sessionStatusSubtitle(page, session.id, 'working', rowServerId)).toHaveCount(0, { timeout: 60_000 });
      await expect(permissionIndicator).toHaveCount(0);
      await expect(composerStatus).not.toContainText(/permission required/i);
      await sessionRow(page, session.id, rowServerId).screenshot({ path: test.info().outputPath('permission-settled-after-stale-update.png') });
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
    const session = await seedAttentionSession({ baseUrl: server.baseUrl, token, title: 'Background design review' });
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
      await page.setViewportSize({ width: 1440, height: 900 });
      await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 180_000);
      await waitForInitialAppUi({ page, timeoutMs: 180_000 });
      await chooseSessionListSettingOption({ page, baseUrl: uiBaseUrl,
        triggerTestId: sessionListAttentionTestIds.workingPlacementModeTrigger, option: 'global' });
      await chooseSessionListDensity({ page, baseUrl: uiBaseUrl, density: 'cozy' });
      await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 180_000);
      await waitForInitialAppUi({ page, timeoutMs: 180_000 });
      publisher = await connectAuthenticatedSessionPublisher({ baseUrl: server.baseUrl, token,
        sessionId: session.id, thinking: false });
      stopKeepAlive = startPresenceKeepAlive(publisher, session.id);
      await publishRuntimeActivity({ socket: publisher, sessionId: session.id, snapshot: { state: 'active', activeCount: 2 } });
      await seedReadyMarker({ baseUrl: server.baseUrl, token, sessionId: session.id });
      await updateSessionRuntimeStatus({ baseUrl: server.baseUrl, token, sessionId: session.id, latestTurnStatus: 'completed' });
      await expectRowInSection({ page, serverId: rowServerId,
        headerTestId: sessionListAttentionTestIds.workingHeader, sessionId: session.id });
      const workingRow = sessionRow(page, session.id, rowServerId, 'working');
      holdObservations = true;
      await expect(workingRow).toContainText(/awaiting updates/i, { timeout: 180_000 });
      expect(heldObservations).toBeGreaterThan(0);
      await workingRow.screenshot({ path: test.info().outputPath('background-awaiting-updates-wide.png') });
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(workingRow).toContainText(/awaiting updates/i);
      await workingRow.screenshot({ path: test.info().outputPath('background-awaiting-updates-phone.png') });
      holdObservations = false;
      await publishRuntimeActivity({ socket: publisher, sessionId: session.id, snapshot: { state: 'idle', activeCount: 0 } });
      await expect(workingRow).toHaveCount(0, { timeout: 60_000 });
    } catch (error) {
      throw appendBrowserDiagnostics(error, browserDiagnostics().replaceAll(token, '[redacted]'));
    } finally {
      stopKeepAlive?.();
      publisher?.close();
    }
  });

  test('presents background replies through all three attention modes and returns to Working once read', async ({ page }) => {
    test.setTimeout(240_000);
    if (!server || !token || !uiBaseUrl) throw new Error('missing session list attention fixtures');

    const session = await seedAttentionSession({
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
        triggerTestId: sessionListAttentionTestIds.attentionPromotionModeTrigger,
        option: 'global',
      });
      await chooseSessionListSettingOption({
        page,
        baseUrl: uiBaseUrl,
        triggerTestId: sessionListAttentionTestIds.workingPlacementModeTrigger,
        option: 'global',
      });
      await chooseSessionListDensity({ page, baseUrl: uiBaseUrl, density: 'cozy' });
      await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 180_000);
      await waitForInitialAppUi({ page, timeoutMs: 180_000 });
      await expect(sessionRow(page, session.id, rowServerId)).toHaveCount(1, { timeout: 120_000 });

      publisher = await connectAuthenticatedSessionPublisher({
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
          triggerTestId: sessionListAttentionTestIds.backgroundWorkAttentionModeTrigger,
          option: mode,
        });
        await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 180_000);
        await seedReadyMarker({ baseUrl: server.baseUrl, token, sessionId: session.id });
        await expectRowInSection({ serverId: rowServerId,
          page,
          headerTestId: mode === 'showUnread' ? sessionListAttentionTestIds.attentionHeader : sessionListAttentionTestIds.workingHeader,
          sessionId: session.id,
        });
        const occurrenceRole = mode === 'showUnread' ? 'needsYou' : 'working';
        const occurrenceId = sessionListOccurrenceId(rowServerId, session.id, occurrenceRole);
        await expect(page.getByTestId(sessionListAttentionTestIds.secondaryReadyIndicator(session.id, rowServerId, occurrenceRole))).toHaveCount(0);
        const spinner = page.getByTestId(`session-row-attention-indicator-spinner-${occurrenceId}-secondary`);
        if (mode === 'keepWorking') {
          await expect(spinner).toHaveCount(1);
          await expect(page.getByTestId(`session-row-unread-indicator-${occurrenceId}-secondary`)).toHaveCount(0);
          await expect(page.getByTestId(`session-row-unread-center-${occurrenceId}-secondary`)).toHaveCount(1);
          await sessionRow(page, session.id, rowServerId, 'working').screenshot({ path: test.info().outputPath('working-unread.png') });
        } else {
          await expect(spinner).toHaveCount(0);
          await expect(page.getByTestId(`session-list-attention-indicator-${occurrenceId}-secondary-unread`)).toHaveCount(1);
        }
        await sessionRow(page, session.id, rowServerId, mode === 'showUnread' ? 'needsYou' : 'working').click();
        await expectRowInSection({ serverId: rowServerId, page, headerTestId: sessionListAttentionTestIds.workingHeader, sessionId: session.id });
        const workingOccurrenceId = sessionListOccurrenceId(rowServerId, session.id, 'working');
        await expect(page.getByTestId(`session-row-attention-indicator-spinner-${workingOccurrenceId}-secondary`)).toHaveCount(1);
        await expect(page.getByTestId(`session-row-unread-indicator-${workingOccurrenceId}-secondary`)).toHaveCount(0);
        await expect(page.getByTestId(`session-row-unread-center-${workingOccurrenceId}-secondary`)).toHaveCount(0);
        if (mode === 'keepWorking') await sessionRow(page, session.id, rowServerId, 'working').screenshot({ path: test.info().outputPath('working-read.png') });
      }
      // A new unread completed reply becomes ready only after reported work settles.
      await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 180_000);
      await seedReadyMarker({ baseUrl: server.baseUrl, token, sessionId: session.id });
      await publishRuntimeActivity({ socket: publisher, sessionId: session.id, snapshot: { state: 'idle', activeCount: 0 } });
      await expectRowInSection({ serverId: rowServerId, page, headerTestId: sessionListAttentionTestIds.attentionHeader, sessionId: session.id });
      await expect(page.getByTestId(sessionListAttentionTestIds.secondaryReadyIndicator(session.id, rowServerId, 'needsYou'))).toHaveCount(1);

    } catch (error) {
      throw appendBrowserDiagnostics(error, browserDiagnostics().replaceAll(token, '[redacted]'));
    } finally {
      stopKeepAlive?.();
      publisher?.close();
    }
  });


});
