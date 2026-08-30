import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createTestAuthMtls } from '../../src/testkit/auth';
import { registerMachineIdentity } from '../../src/testkit/machineIdentity';
import { repoRootDir } from '../../src/testkit/paths';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { createRunDirs } from '../../src/testkit/runDir';
import { startForwardedHeaderProxy } from '../../src/testkit/uiE2e/forwardedHeaderProxy';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import {
  createPlainSession,
  readVisibleSessionRowOrder,
} from '../../src/testkit/uiE2e/sessionFoldersDrag';
import {
  fetchSessionOrganizationSnapshot,
  readPinnedSessionIdsFromOrganizationSnapshot,
} from '../../src/testkit/uiE2e/sessionOrganization';
import { waitForInitialAppUi } from '../../src/testkit/uiE2e/waitForInitialAppUi';

const run = createRunDirs({ runLabel: 'ui-e2e-session-list-multi-select-actions' });

const SEEDED_MACHINE_ID = 'seeded-session-list-multi-select-machine';
const IDENTITY_HEADERS = {
  email: `session-list-multi-select-${run.runId}@example.com`,
  issuer: 'happier-ui-e2e-session-list-multi-select',
  fingerprint: `session-list-multi-select-${run.runId}`,
} as const;

const SESSION_CREATE_TIMESTAMP_SEPARATION_MS = 35;

const testIds = {
  row: (sessionId: string) => `session-list-item-${sessionId}`,
  selectionCheckbox: (sessionId: string) => `session-list-selection-checkbox-${sessionId}`,
  selectionActionBar: 'session-list-selection-action-bar',
  selectionCount: 'session-list-selection-count',
  selectionProgress: 'session-list-selection-progress',
  selectionResult: 'session-list-selection-result',
  selectionResultDismiss: 'session-list-selection-result-dismiss',
  selectionAction: (actionId: string) => `session-list-selection-action-${safeActionId(actionId)}`,
  selectionConfirm: (actionId: string) => `session-list-selection-confirm-${safeActionId(actionId)}`,
} as const;

type Deferred = Readonly<{
  promise: Promise<void>;
  resolve: () => void;
}>;

function createDeferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function safeActionId(actionId: string): string {
  return actionId.replace(/[^a-zA-Z0-9_-]+/g, '-');
}

function platformSelectionModifier(): 'Control' | 'Meta' {
  return process.platform === 'darwin' ? 'Meta' : 'Control';
}

async function pauseForDistinctCreatedAt(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, SESSION_CREATE_TIMESTAMP_SEPARATION_MS));
}

async function expectPinnedSessions(params: Readonly<{
  baseUrl: string;
  token: string;
  sessionIds: readonly string[];
}>): Promise<void> {
  await expect.poll(async () => {
    const snapshot = await fetchSessionOrganizationSnapshot({
      baseUrl: params.baseUrl,
      token: params.token,
      request: {
        includeFolders: false,
        includeTags: false,
        includeLabels: false,
      },
    });
    const pinnedSessionIds = new Set(readPinnedSessionIdsFromOrganizationSnapshot(snapshot));
    return params.sessionIds.every((sessionId) => pinnedSessionIds.has(sessionId));
  }, { timeout: 60_000 }).toBe(true);
}

async function expectRowsVisible(page: Page, sessionIds: readonly string[]): Promise<void> {
  for (const sessionId of sessionIds) {
    await expect(page.getByTestId(testIds.row(sessionId))).toHaveCount(1, { timeout: 120_000 });
  }
}

async function readVisibleOrderForSeededSessions(page: Page, sessionIds: readonly string[]): Promise<string[]> {
  const expectedIds = new Set(sessionIds);
  await expect.poll(async () => {
    const visibleOrder = await readVisibleSessionRowOrder(page);
    return visibleOrder.filter((sessionId) => expectedIds.has(sessionId));
  }, { timeout: 120_000 }).toHaveLength(sessionIds.length);

  const visibleOrder = await readVisibleSessionRowOrder(page);
  return visibleOrder.filter((sessionId) => expectedIds.has(sessionId));
}

async function seedSessions(params: Readonly<{
  baseUrl: string;
  token: string;
  count: number;
  titlePrefix: string;
}>): Promise<string[]> {
  const rootPath = repoRootDir();
  const sessionIds: string[] = [];
  for (let index = 0; index < params.count; index += 1) {
    if (index > 0) await pauseForDistinctCreatedAt();
    sessionIds.push(await createPlainSession({
      baseUrl: params.baseUrl,
      token: params.token,
      title: `${params.titlePrefix} ${index + 1} ${run.runId}`,
      rootPath,
      machineId: SEEDED_MACHINE_ID,
      tagPrefix: 'session-list-multi-select',
    }));
  }
  return sessionIds;
}

async function expectSelectionCount(page: Page, count: number): Promise<void> {
  await expect(page.getByTestId(testIds.selectionActionBar)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId(testIds.selectionCount)).toHaveAttribute('data-selected-count', String(count), {
    timeout: 60_000,
  });
}

function normalizeSelectedState(value: string | null): boolean | null {
  if (value === 'true' || value === 'checked' || value === 'selected') return true;
  if (value === 'false' || value === 'unchecked' || value === 'unselected') return false;
  return null;
}

async function readSelectionControlState(locator: Locator): Promise<boolean | null> {
  const value = await locator.evaluate((element) => (
    element.getAttribute('aria-checked')
    ?? element.getAttribute('data-selected')
    ?? element.getAttribute('data-state')
  ));
  return normalizeSelectedState(value);
}

async function expectSessionSelectionState(page: Page, sessionId: string, selected: boolean): Promise<void> {
  const checkbox = page.getByTestId(testIds.selectionCheckbox(sessionId));
  await expect(checkbox).toHaveCount(1, { timeout: 60_000 });
  await expect.poll(
    async () => readSelectionControlState(checkbox),
    { timeout: 60_000 },
  ).toBe(selected);
}

async function waitForVisible(locator: Locator, timeout: number): Promise<boolean> {
  return locator.waitFor({ state: 'visible', timeout }).then(
    () => true,
    () => false,
  );
}

async function clickSelectionAction(page: Page, actionId: string): Promise<void> {
  const action = page.getByTestId(testIds.selectionAction(actionId));
  await expect(action).toHaveCount(1, { timeout: 60_000 });
  await action.click();

  const confirm = page.getByTestId(testIds.selectionConfirm(actionId));
  const actionStarted = await Promise.race([
    waitForVisible(confirm, 5_000).then((visible) => (visible ? 'confirm' as const : 'timeout' as const)),
    waitForVisible(page.getByTestId(testIds.selectionProgress), 5_000).then((visible) => (
      visible ? 'started' as const : 'timeout' as const
    )),
    waitForVisible(page.getByTestId(testIds.selectionResult), 5_000).then((visible) => (
      visible ? 'started' as const : 'timeout' as const
    )),
  ]);
  if (actionStarted === 'confirm') {
    await expect(confirm).toBeEnabled({ timeout: 60_000 });
    await confirm.click();
  }
}

async function expectBulkResult(params: Readonly<{
  page: Page;
  succeeded: number;
  failed?: number;
  skipped?: number;
}>): Promise<void> {
  const result = params.page.getByTestId(testIds.selectionResult);
  await expect(result).toBeVisible({ timeout: 120_000 });
  await expect(result).toHaveAttribute('data-succeeded-count', String(params.succeeded), { timeout: 60_000 });
  await expect(result).toHaveAttribute('data-failed-count', String(params.failed ?? 0), { timeout: 60_000 });
  await expect(result).toHaveAttribute('data-skipped-count', String(params.skipped ?? 0), { timeout: 60_000 });
}

async function dismissSelectionResult(page: Page): Promise<void> {
  const dismiss = page.getByTestId(testIds.selectionResultDismiss);
  await dismiss.waitFor({ state: 'visible', timeout: 5_000 }).then(
    async () => {
      await dismiss.click();
    },
    () => undefined,
  );
  await expect(page.getByTestId(testIds.selectionActionBar)).toHaveCount(0, { timeout: 60_000 });
}

test.describe('ui e2e: session list multi-select actions', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('session-list-multi-select-actions-suite');
  const cliHomeDir = resolve(join(suiteDir, 'cli-home'));

  let server: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let uiBaseUrl: string | null = null;
  let proxyStop: (() => Promise<void>) | null = null;
  let token: string | null = null;

  test.beforeAll(async () => {
    test.setTimeout(resolveUiWebBeforeAllTimeoutMs(process.env));
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(resolve(join(cliHomeDir, 'AGENTS.md')), '# UI e2e fixture\n', 'utf8');

    server = await startServerLight({
      testDir: suiteDir,
      dbProvider: 'sqlite',
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
    await registerMachineIdentity({
      baseUrl: server.baseUrl,
      token,
      machineId: SEEDED_MACHINE_ID,
      metadata: 'session-list-multi-select-machine',
    });

    ui = await startUiWeb({
      testDir: suiteDir,
      env: {
        ...process.env,
        EXPO_PUBLIC_DEBUG: '1',
        EXPO_PUBLIC_HAPPY_SERVER_URL: proxy.baseUrl,
        EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-session-list-multi-select-${run.runId}`,
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

  test('selects non-contiguous sessions with the platform modifier and pins them in one local batch', async ({ page }) => {
    test.setTimeout(720_000);
    if (!server || !uiBaseUrl || !token) throw new Error('missing server/ui fixtures');

    const seededIds = await seedSessions({
      baseUrl: server.baseUrl,
      token,
      count: 3,
      titlePrefix: 'multi-select pin',
    });

    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 300_000);
    await waitForInitialAppUi({ page, timeoutMs: 180_000 });
    await expectRowsVisible(page, seededIds);

    const visibleIds = await readVisibleOrderForSeededSessions(page, seededIds);
    const selectedIds = [visibleIds[0]!, visibleIds[2]!];
    const selectionModifier = platformSelectionModifier();

    await page.getByTestId(testIds.row(selectedIds[0]!)).click({ modifiers: [selectionModifier] });
    await expectSelectionCount(page, 1);
    await expectSessionSelectionState(page, selectedIds[0]!, true);

    await page.getByTestId(testIds.row(selectedIds[1]!)).click({ modifiers: [selectionModifier] });
    await expectSelectionCount(page, 2);
    await expectSessionSelectionState(page, selectedIds[0]!, true);
    await expectSessionSelectionState(page, selectedIds[1]!, true);

    await clickSelectionAction(page, 'session.pin');
    await expectBulkResult({ page, succeeded: selectedIds.length });

    await expectPinnedSessions({
      baseUrl: server.baseUrl,
      token,
      sessionIds: selectedIds,
    });
    await dismissSelectionResult(page);
  });

  test('selects a Shift range and archives it with progress and result state', async ({ page }) => {
    test.setTimeout(720_000);
    if (!server || !uiBaseUrl || !token) throw new Error('missing server/ui fixtures');

    const seededIds = await seedSessions({
      baseUrl: server.baseUrl,
      token,
      count: 4,
      titlePrefix: 'multi-select archive',
    });

    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 300_000);
    await waitForInitialAppUi({ page, timeoutMs: 180_000 });
    await expectRowsVisible(page, seededIds);

    const visibleIds = await readVisibleOrderForSeededSessions(page, seededIds);
    const rangeIds = visibleIds.slice(1, 4);
    const selectionModifier = platformSelectionModifier();

    await page.getByTestId(testIds.row(rangeIds[0]!)).click({ modifiers: [selectionModifier] });
    await expectSelectionCount(page, 1);

    await page.getByTestId(testIds.row(rangeIds[rangeIds.length - 1]!)).click({ modifiers: ['Shift'] });
    await expectSelectionCount(page, rangeIds.length);
    for (const sessionId of rangeIds) {
      await expectSessionSelectionState(page, sessionId, true);
    }

    const archiveGate = createDeferred();
    let delayedFirstArchive = false;
    await page.route('**/v2/sessions/*/archive', async (route) => {
      if (!delayedFirstArchive) {
        delayedFirstArchive = true;
        await archiveGate.promise;
      }
      await route.continue();
    });

    try {
      await clickSelectionAction(page, 'session.archive');
      const progress = page.getByTestId(testIds.selectionProgress);
      await expect(progress).toBeVisible({ timeout: 60_000 });

      archiveGate.resolve();

      await expectBulkResult({ page, succeeded: rangeIds.length });
    } finally {
      archiveGate.resolve();
      await page.unroute('**/v2/sessions/*/archive').catch(() => {});
    }

    for (const sessionId of rangeIds) {
      await expect(page.getByTestId(testIds.row(sessionId))).toHaveCount(0, { timeout: 120_000 });
    }

    await dismissSelectionResult(page);
  });
});
