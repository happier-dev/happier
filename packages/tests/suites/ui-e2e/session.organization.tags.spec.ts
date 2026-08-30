import { test, expect, type Page } from '@playwright/test';
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
import { createPlainSession } from '../../src/testkit/uiE2e/sessionFoldersDrag';
import { readSessionTagLabelsFromOrganizationSnapshot } from '../../src/testkit/uiE2e/sessionOrganization';
import { waitForInitialAppUi } from '../../src/testkit/uiE2e/waitForInitialAppUi';

const run = createRunDirs({ runLabel: 'ui-e2e-session-organization-tags' });

const SEEDED_MACHINE_ID = 'seeded-session-organization-tags-machine';
const IDENTITY_HEADERS = {
  email: `session-organization-tags-${run.runId}@example.com`,
  issuer: 'happier-ui-e2e-session-organization-tags',
  fingerprint: `session-organization-tags-${run.runId}`,
} as const;

const SESSION_CREATE_TIMESTAMP_SEPARATION_MS = 35;

const testIds = {
  row: (sessionId: string) => `session-list-item-${sessionId}`,
  rowTagAction: 'session-item-tag-action',
  createTagOption: 'dropdown-option-__create__',
  existingTagOption: (tagLabel: string) => `dropdown-option-${safeDropdownItemId(tagLabel)}`,
  tagFilterTrigger: 'session-list-tag-filter-trigger',
  tagFilterOption: (tagLabel: string) => `dropdown-option-session-list-tag-filter_${safeDropdownItemId(tagLabel)}`,
} as const;

function safeDropdownItemId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

async function pauseForDistinctCreatedAt(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, SESSION_CREATE_TIMESTAMP_SEPARATION_MS));
}

async function seedSessions(params: Readonly<{
  baseUrl: string;
  token: string;
  count: number;
}>): Promise<string[]> {
  const rootPath = repoRootDir();
  const sessionIds: string[] = [];
  for (let index = 0; index < params.count; index += 1) {
    if (index > 0) await pauseForDistinctCreatedAt();
    sessionIds.push(await createPlainSession({
      baseUrl: params.baseUrl,
      token: params.token,
      title: `tag e2e ${index + 1} ${run.runId}`,
      rootPath,
      machineId: SEEDED_MACHINE_ID,
      tagPrefix: 'session-organization-tags',
    }));
  }
  return sessionIds;
}

async function expectAssignedTagLabels(params: Readonly<{
  baseUrl: string;
  token: string;
  sessionId: string;
  labels: readonly string[];
}>): Promise<void> {
  await expect.poll(
    () => readSessionTagLabelsFromOrganizationSnapshot(params),
    { timeout: 60_000 },
  ).toEqual([...params.labels].sort((left, right) => left.localeCompare(right)));
}

async function expectRowsVisible(page: Page, sessionIds: readonly string[]): Promise<void> {
  for (const sessionId of sessionIds) {
    await expect(page.getByTestId(testIds.row(sessionId))).toHaveCount(1, { timeout: 120_000 });
  }
}

async function openSessionTagMenu(page: Page, sessionId: string): Promise<void> {
  const row = page.getByTestId(testIds.row(sessionId));
  await expect(row).toHaveCount(1, { timeout: 120_000 });
  await row.hover();
  const tagAction = row.getByTestId(testIds.rowTagAction);
  await expect(tagAction).toBeVisible({ timeout: 60_000 });
  await tagAction.click({ force: true });
  await expect(page.locator('input[placeholder^="Add or search tag"]')).toBeVisible({ timeout: 60_000 });
}

async function dismissSetupDialogIfPresent(page: Page): Promise<void> {
  const dialog = page.getByRole('dialog', { name: 'Dialog' });
  const cancel = dialog.getByRole('button', { name: 'Cancel' });
  const visible = await cancel.isVisible({ timeout: 2_000 }).catch(() => false);
  if (!visible) return;
  await cancel.click();
  await expect(dialog).toHaveCount(0, { timeout: 60_000 });
}

async function reloadSessionList(page: Page, uiBaseUrl: string): Promise<void> {
  await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 300_000);
  await waitForInitialAppUi({ page, timeoutMs: 180_000 });
  await dismissSetupDialogIfPresent(page);
}

test.describe('ui e2e: session organization tags', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('session-organization-tags-suite');
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
      metadata: 'session-organization-tags-machine',
    });

    ui = await startUiWeb({
      testDir: suiteDir,
      env: {
        ...process.env,
        EXPO_PUBLIC_DEBUG: '1',
        EXPO_PUBLIC_HAPPY_SERVER_URL: proxy.baseUrl,
        EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-session-organization-tags-${run.runId}`,
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

  test('creates, persists, filters, and removes a server-backed session tag assignment', async ({ page }) => {
    test.setTimeout(720_000);
    if (!server || !uiBaseUrl || !token) throw new Error('missing server/ui fixtures');

    const [taggedSessionId, untaggedSessionId] = await seedSessions({
      baseUrl: server.baseUrl,
      token,
      count: 2,
    });
    const tagLabel = `ui-e2e-tag-${run.runId}`;

    await page.setViewportSize({ width: 1440, height: 900 });
    await reloadSessionList(page, uiBaseUrl);
    await expectRowsVisible(page, [taggedSessionId, untaggedSessionId]);

    await openSessionTagMenu(page, taggedSessionId);
    await page.locator('input[placeholder^="Add or search tag"]').fill(tagLabel);
    await page.getByTestId(testIds.createTagOption).click();
    await expectAssignedTagLabels({
      baseUrl: server.baseUrl,
      token,
      sessionId: taggedSessionId,
      labels: [tagLabel],
    });

    await reloadSessionList(page, uiBaseUrl);
    await expectRowsVisible(page, [taggedSessionId, untaggedSessionId]);

    await page.getByTestId(testIds.tagFilterTrigger).click();
    await expect(page.getByTestId(testIds.tagFilterOption(tagLabel))).toBeVisible({ timeout: 60_000 });
    await page.getByTestId(testIds.tagFilterOption(tagLabel)).click();
    await expect(page.getByTestId(testIds.row(taggedSessionId))).toHaveCount(1, { timeout: 60_000 });
    await expect(page.getByTestId(testIds.row(untaggedSessionId))).toHaveCount(0, { timeout: 60_000 });

    await page.getByTestId(testIds.tagFilterOption(tagLabel)).click();
    await page.keyboard.press('Escape');
    await expectRowsVisible(page, [taggedSessionId, untaggedSessionId]);

    await openSessionTagMenu(page, taggedSessionId);
    await page.getByTestId(testIds.existingTagOption(tagLabel)).click();
    await expectAssignedTagLabels({
      baseUrl: server.baseUrl,
      token,
      sessionId: taggedSessionId,
      labels: [],
    });

    await reloadSessionList(page, uiBaseUrl);
    await expectRowsVisible(page, [taggedSessionId, untaggedSessionId]);
  });
});
