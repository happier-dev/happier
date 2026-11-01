import { test, expect, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

import { createTestAuthMtls } from '../../src/testkit/auth';
import { fetchJson } from '../../src/testkit/http';
import { registerMachineIdentity } from '../../src/testkit/machineIdentity';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { createRunDirs } from '../../src/testkit/runDir';
import { patchSessionMetadataWithRetry } from '../../src/testkit/sessions';
import { postPlainUiTextMessage } from '../../src/testkit/sessionHandoffUiMessages';
import { appendBrowserDiagnostics, collectBrowserDiagnostics } from '../../src/testkit/uiE2e/browserDiagnostics';
import { startForwardedHeaderProxy } from '../../src/testkit/uiE2e/forwardedHeaderProxy';
import { collectNetworkTransfer, type NetworkTransferSnapshot } from '../../src/testkit/uiE2e/networkTransfer';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { createPlainSession } from '../../src/testkit/uiE2e/sessionFoldersDrag';
import { importSessionOrganization } from '../../src/testkit/uiE2e/sessionOrganization';
import { NETWORK_WORKLOAD_REVISION } from './session.networkTransfer.contract';

const SESSION_COUNT = 101; // Enough for a 100-row ordinary list page plus its oldest, off-page pin.
const BURST_COUNT = 5;
const BURST_PAYLOAD = 'x'.repeat(1024);
const MACHINE_ID = 'network-transfer-fixture-machine';
const ROOT_PATH = '/network-transfer-fixture';

function sessionMetadata(name: string) {
  return {
    v: 1, name, path: ROOT_PATH, homeDir: '/', host: MACHINE_ID, machineId: MACHINE_ID,
    version: '0.0.0', flavor: 'claude', networkFixturePayload: BURST_PAYLOAD,
  };
}

test('reports Home network transfer for cold/warm bootstrap, idle and unopened-session activity', async ({ page, context, browser }, testInfo) => {
  test.setTimeout(resolveUiWebBeforeAllTimeoutMs(process.env) + 180_000 + 30_000);
  const run = createRunDirs({ runLabel: 'ui-e2e-network-transfer' });
  const suiteDir = run.testDir('network-transfer');
  let server: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let proxy: Awaited<ReturnType<typeof startForwardedHeaderProxy>> | null = null;
  let capture: Awaited<ReturnType<typeof collectNetworkTransfer>> | null = null;
  let outcome: 'passed' | 'failed' = 'failed';
  const diagnostics = collectBrowserDiagnostics({ page });
  let seededSessionCount = 0;
  let verifiedBootstraps = 0;
  let openedSessions = 0;
  let reconnects = 0;
  const transcriptText = 'network transcript '.padEnd(1024, 'x');
  const pendingResponses = new Set<Promise<void>>();
  let responseError = false;
  let listsContainingPin = 0;
  let pinnedSessionId = '';

  // IDs and response contents are used only for predicates, never exported.
  page.on('response', (response) => {
    if (new URL(response.url()).pathname !== '/v2/sessions' || !response.ok()) return;
    const pending = (async () => {
      const body: unknown = await response.json();
      if (!body || typeof body !== 'object' || !('sessions' in body) || !Array.isArray(body.sessions)) throw new Error('invalid list response');
      if (body.sessions.some((row: unknown) => row && typeof row === 'object' && 'id' in row && row.id === pinnedSessionId)) listsContainingPin += 1;
    })().catch(() => { responseError = true; });
    pendingResponses.add(pending);
    void pending.finally(() => pendingResponses.delete(pending));
  });

  async function bootstrapCompleted(page: Page, previousLists: number) {
    await expect.poll(() => listsContainingPin, { timeout: 180_000 }).toBeGreaterThan(previousLists);
    await expect(page.getByTestId('session-list-header:pinned-v1')).toBeVisible({ timeout: 120_000 });
    await expect(page.getByTestId(`session-list-item-${pinnedSessionId}`).first()).toBeVisible({ timeout: 120_000 });
    await expect(page.getByTestId(`session-list-item-${pinnedSessionId}`).first()).toContainText('network session 0', { timeout: 120_000 });
    // Home completion is materialized list/pin state plus completed finite requests.
    // Socket.IO can authenticate during polling; the later burst proves WS delivery separately.
    await expect.poll(() => capture!.inFlight(), { timeout: 120_000 }).toBe(0);
    await Promise.all(pendingResponses);
    expect(responseError).toBe(false);
    verifiedBootstraps += 1;
    capture!.endPhase();
  }

  try {
    server = await startServerLight({
      testDir: suiteDir, dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_BUILD_FEATURES_DENY: 'sharing.contentKeys',
        HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '0',
        HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: '1',
        HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
        HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: 'plain',
        HAPPIER_FEATURE_AUTH_MTLS__ENABLED: '1',
        HAPPIER_FEATURE_AUTH_MTLS__MODE: 'forwarded',
        HAPPIER_FEATURE_AUTH_MTLS__TRUST_FORWARDED_HEADERS: '1',
        HAPPIER_FEATURE_AUTH_MTLS__AUTO_PROVISION: '1',
        HAPPIER_FEATURE_AUTH_MTLS__IDENTITY_SOURCE: 'san_email',
        HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_EMAIL_DOMAINS: 'example.com',
        HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_ISSUERS: 'network-transfer-fixture',
        HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_EMAIL_HEADER: 'x-happier-client-cert-email',
        HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_ISSUER_HEADER: 'x-happier-client-cert-issuer',
        HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_FINGERPRINT_HEADER: 'x-happier-client-cert-sha256',
        HAPPIER_FEATURE_AUTH_UI__AUTO_REDIRECT_ENABLED: '1',
        HAPPIER_FEATURE_AUTH_UI__AUTO_REDIRECT_PROVIDER_ID: 'mtls',
      },
    });
    const identity = { email: `network-${run.runId}@example.com`, issuer: 'network-transfer-fixture', fingerprint: run.runId };
    proxy = await startForwardedHeaderProxy({ targetBaseUrl: server.baseUrl, identityHeaders: {
      'x-happier-client-cert-email': identity.email,
      'x-happier-client-cert-issuer': identity.issuer,
      'x-happier-client-cert-sha256': identity.fingerprint,
    } });
    const { token } = await createTestAuthMtls(server.baseUrl, identity);
    await registerMachineIdentity({ baseUrl: server.baseUrl, token, machineId: MACHINE_ID, metadata: 'network-transfer-fixture' });
    const sessionIds: string[] = [];
    for (let index = 0; index < SESSION_COUNT; index += 1) {
      sessionIds.push(await createPlainSession({
        baseUrl: server.baseUrl, token, title: `network session ${index}`, rootPath: ROOT_PATH,
        machineId: MACHINE_ID, tagPrefix: 'network-transfer', metadata: sessionMetadata(`network session ${index}`),
      }));
      seededSessionCount += 1;
    }
    pinnedSessionId = sessionIds[0];
    const ordinaryPage = await fetchJson<{ sessions: Array<{ id: string }>; hasNext: boolean }>(`${server.baseUrl}/v2/sessions?limit=100`, {
      headers: { Authorization: `Bearer ${token}` }, timeoutMs: 20_000,
    });
    expect(ordinaryPage.status).toBe(200);
    expect(ordinaryPage.data.sessions).toHaveLength(100);
    expect(ordinaryPage.data.sessions.some((row) => row.id === pinnedSessionId)).toBe(false);
    await importSessionOrganization({ baseUrl: server.baseUrl, token, request: {
      pins: [{ sessionId: pinnedSessionId, sortKey: '00000001' }], folders: [], tags: [], tagAssignments: [], orderEntries: [], labels: [],
    } });
    ui = await startUiWeb({ testDir: suiteDir, env: {
      ...process.env, EXPO_PUBLIC_DEBUG: '1', EXPO_PUBLIC_HAPPY_SERVER_URL: proxy.baseUrl,
      EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `network-transfer-${run.runId}`,
      HAPPIER_E2E_UI_WEB_MODE: 'export', HAPPIER_E2E_UI_WEB_EXPORT_FALLBACK_TO_METRO: '0',
    } });
    const uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
    await page.setViewportSize({ width: 1440, height: 900 });
    capture = await collectNetworkTransfer(await context.newCDPSession(page), proxy.baseUrl);
    await capture.setCacheDisabled(true);
    capture.beginPhase('cold-home');
    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 300_000);
    await bootstrapCompleted(page, 0);

    await capture.setCacheDisabled(false);
    const previousLists = listsContainingPin;
    capture.beginPhase('warm-home');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await bootstrapCompleted(page, previousLists);

    capture.beginPhase('home-idle-30s');
    await page.waitForTimeout(30_000); // The explicit observation window, not a completion heuristic.
    await expect.poll(() => capture!.inFlight(), { timeout: 120_000 }).toBe(0);
    capture.endPhase();

    const backgroundSessionId = sessionIds.at(-1)!;
    expect(new URL(page.url()).pathname).not.toContain('/session/');
    capture.beginPhase('unopened-session-burst');
    for (let index = 0; index < BURST_COUNT; index += 1) {
      await patchSessionMetadataWithRetry({
        baseUrl: server.baseUrl, token, sessionId: backgroundSessionId,
        ciphertext: JSON.stringify(sessionMetadata(`background ${index}`)), expectedVersion: index + 1,
      });
    }
    await expect(page.getByTestId(`session-list-item-${backgroundSessionId}`).first()).toContainText(`background ${BURST_COUNT - 1}`, { timeout: 120_000 });
    await expect.poll(() => capture!.snapshot().phases.at(-1)?.webSocket.some((row) => row.direction === 'received'
      && row.messages > 0 && !['socket', 'engine', 'websocket', 'development'].includes(row.family)), { timeout: 120_000 }).toBe(true);
    await expect.poll(() => capture!.inFlight(), { timeout: 120_000 }).toBe(0);
    capture.endPhase();

    // Seed after the calibrated Home phases, preserving their list fixture bytes.
    await postPlainUiTextMessage({ baseUrl: server.baseUrl, token, sessionId: backgroundSessionId,
      text: transcriptText, localId: 'network-transcript-fixture' });
    capture.beginPhase('session-open');
    await page.getByTestId(`session-list-item-${backgroundSessionId}`).first().click();
    await expect(page.getByTestId('session-composer-send')).toBeVisible({ timeout: 120_000 });
    await expect(page.getByText(transcriptText, { exact: true }).first()).toBeVisible({ timeout: 120_000 });
    await expect.poll(() => capture!.inFlight(), { timeout: 120_000 }).toBe(0);
    openedSessions += 1;
    capture.endPhase();

    capture.beginPhase('session-leave');
    // At the calibrated desktop viewport the permanent sidebar hides the mobile
    // back button. Browser Back leaves through the same routed navigation stack.
    await page.goBack();
    await expect(page.getByTestId('session-composer-send')).toBeHidden({ timeout: 120_000 });
    await expect(page.getByTestId(`session-list-item-${backgroundSessionId}`).first()).toBeVisible({ timeout: 120_000 });
    await expect.poll(() => capture!.inFlight(), { timeout: 120_000 }).toBe(0);
    capture.endPhase();

    capture.beginPhase('transport-reconnect');
    await context.setOffline(true);
    await expect.poll(() => capture!.snapshot().phases.at(-1)?.socketDisconnects, { timeout: 120_000 }).toBeGreaterThan(0);
    await patchSessionMetadataWithRetry({ baseUrl: server.baseUrl, token, sessionId: backgroundSessionId,
      ciphertext: JSON.stringify(sessionMetadata('recovered session')), expectedVersion: BURST_COUNT + 1 });
    await context.setOffline(false);
    // A live socket alone is insufficient: the edit made in the gap must materialize.
    await expect(page.getByTestId(`session-list-item-${backgroundSessionId}`).first()).toContainText('recovered session', { timeout: 120_000 });
    await expect.poll(() => capture!.inFlight(), { timeout: 120_000 }).toBe(0);
    reconnects += 1;
    capture.endPhase();

    const measured = capture.snapshot();
    for (const phase of measured.phases.filter((phase) => phase.name.endsWith('-home'))) {
      // Ceilings (including no per-pin exact GETs) are enforced by the CI reporter,
      // so PRs can initially observe regressions without failing their checks.
      expect(phase.http.some((row) => row.method === 'GET' && row.route.startsWith('session-list') && typeof row.decodedBodyBytes === 'number' && row.decodedBodyBytes > 0)).toBe(true);
    }
    outcome = 'passed';
  } catch (error) {
    throw appendBrowserDiagnostics(error, diagnostics());
  } finally {
    capture?.endPhase();
    const measurement: NetworkTransferSnapshot = capture?.snapshot() ?? { status: 'incomplete', wsEncodedBytes: 'unavailable', lostEvents: 0, phases: [] };
    const result = {
      schemaVersion: 2, workloadRevision: NETWORK_WORKLOAD_REVISION, sourceLine: '0.2', testStatus: outcome,
      status: outcome === 'failed' ? 'failed' : measurement.status,
      ci: { branch: process.env.GITHUB_HEAD_REF ?? process.env.GITHUB_REF_NAME ?? null, sha: process.env.GITHUB_SHA ?? null, run: process.env.GITHUB_RUN_ID ?? null, attempt: process.env.GITHUB_RUN_ATTEMPT ?? null },
      retry: testInfo.retry, repeatEachIndex: testInfo.repeatEachIndex,
      runtime: { browser: browser.browserType().name(), browserVersion: browser.version(), uiMode: 'export', serverMode: 'light-sqlite', viewport: page.viewportSize() },
      accounting: {
        httpDecodedBodyBytes: 'Sum of CDP dataReceived.dataLength; missing chunks are unavailable except protocol bodyless responses.',
        httpEncodedBodyBytes: 'Sum of CDP dataReceived.encodedDataLength; zero-only encoded evidence for a positive decoded body is unavailable.',
        httpEncodedResponseBytes: 'CDP loadingFinished.encodedDataLength, including response headers and body; excludes request and TLS bytes.',
        wsApplicationBytes: 'CDP payload UTF-8 bytes or base64-decoded binary bytes, including Engine.IO/Socket.IO envelopes, after extension decompression. Heartbeat/control buckets are separate.',
        socketIoCoverage: 'WebSocket payloads; pre-upgrade HTTP polling bytes are reported as engine-transport HTTP, without WS event attribution.',
      },
      fixture: { sessionCount: SESSION_COUNT, seededSessionCount, offPagePins: 1, storageMode: 'plain', burstKind: 'metadata-update', burstCount: BURST_COUNT, burstPayloadBytes: Buffer.byteLength(BURST_PAYLOAD), idleMs: 30_000, coldCache: 'disabled', warmCache: 'enabled', verifiedBootstraps,
        openedSessions, reconnects, transcriptMessages: 1, transcriptPayloadBytes: Buffer.byteLength(transcriptText) },
      measurement,
    };
    const cleanup = await Promise.allSettled([capture?.stop(), ui?.stop(), proxy?.stop(), server?.stop()]);
    const cleanupFailures = cleanup.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (cleanupFailures.length > 0) result.status = 'failed';
    const jsonPath = testInfo.outputPath(`network-transfer.retry-${testInfo.retry}.json`);
    await writeFile(jsonPath, JSON.stringify(result, null, 2));
    await testInfo.attach('network-transfer', { path: jsonPath, contentType: 'application/json' });
    if (cleanupFailures.length > 0) throw new AggregateError(cleanupFailures.map((result) => result.reason), 'network transfer fixture cleanup failed');
  }
});
