import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { upsertPlainAccountSettingsV2 } from '../../src/testkit/accountSettings';
import { createTestAuthMtls } from '../../src/testkit/auth';
import { fetchJson } from '../../src/testkit/http';
import { registerMachineIdentity } from '../../src/testkit/machineIdentity';
import { repoRootDir } from '../../src/testkit/paths';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { createRunDirs } from '../../src/testkit/runDir';
import { startForwardedHeaderProxy } from '../../src/testkit/uiE2e/forwardedHeaderProxy';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import {
  createPlainSession,
  readSessionFolderDragSettings,
  readVisibleSessionRowOrder,
  resolveCanonicalServerIdForUi,
  sessionOrderKey,
} from '../../src/testkit/uiE2e/sessionFoldersDrag';
import {
  buildSessionOrganizationImportRequestFromFolderSettings,
  importSessionOrganization,
} from '../../src/testkit/uiE2e/sessionOrganization';
import { waitForInitialAppUi } from '../../src/testkit/uiE2e/waitForInitialAppUi';
import { appendBrowserDiagnostics, collectBrowserDiagnostics } from '../../src/testkit/uiE2e/browserDiagnostics';

const run = createRunDirs({ runLabel: 'ui-e2e-session-list-ordering-mode' });

const SEEDED_MACHINE_ID = 'seeded-session-list-ordering-machine';
const IDENTITY_HEADERS = {
  email: `session-list-ordering-${run.runId}@example.com`,
  issuer: 'happier-ui-e2e-session-list-ordering',
  fingerprint: `session-list-ordering-${run.runId}`,
} as const;

const SESSION_CREATE_TIMESTAMP_SEPARATION_MS = 35;
async function pauseForDistinctCreatedAt(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, SESSION_CREATE_TIMESTAMP_SEPARATION_MS));
}

async function selectOrderingMode(page: Page, mode: 'custom' | 'created' | 'updated'): Promise<void> {
  await page.getByTestId('session-list-ordering-menu-trigger').first().click();
  const option = page.getByTestId(`session-list-ordering-mode-${mode}`);
  await expect(option).toHaveCount(1, { timeout: 60_000 });
  await option.click();
}

async function waitForVisibleSessionOrder(page: Page, sessionIds: readonly string[]): Promise<string[]> {
  const expectedIds = new Set(sessionIds);
  await expect.poll(async () => {
    const visible = await readVisibleSessionRowOrder(page);
    return visible.filter((id) => expectedIds.has(id));
  }, { timeout: 120_000 }).toHaveLength(sessionIds.length);

  const visible = await readVisibleSessionRowOrder(page);
  return visible.filter((id) => expectedIds.has(id));
}

async function readFirstProjectGroupKey(page: Page): Promise<string> {
  const testId = await page.locator('[data-testid^="session-list-project-header:"]').first().getAttribute('data-testid');
  const prefix = 'session-list-project-header:';
  if (!testId?.startsWith(prefix)) throw new Error('missing session list project header testID');
  return testId.slice(prefix.length);
}

async function expectVisibleSessionOrder(page: Page, orderedSessionIds: readonly string[]): Promise<void> {
  const expectedIds = new Set(orderedSessionIds);
  await expect.poll(async () => {
    const visible = await readVisibleSessionRowOrder(page);
    return visible.filter((id) => expectedIds.has(id));
  }, { timeout: 120_000 }).toEqual([...orderedSessionIds]);
}

async function reloadAndWaitForImportedOrganizationProjection(params: Readonly<{
  page: Page;
  uiBaseUrl: string;
  projectGroupKey: string;
  orderedSessionIds: readonly string[];
}>): Promise<void> {
  const organizationResponse = params.page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname.endsWith('/v2/session-organization')
      && response.request().method() === 'GET'
      && response.status() === 200;
  }, { timeout: 120_000 });

  await gotoDomContentLoadedWithRetries(params.page, `${params.uiBaseUrl}/?happier_hmr=0`, 120_000);
  const response = await organizationResponse;
  const body = await response.json() as {
    snapshot?: {
      version?: unknown;
      orderEntries?: Array<{
        scopeKind?: unknown;
        scopeKey?: unknown;
        itemKind?: unknown;
        itemKey?: unknown;
        sortKey?: unknown;
      }>;
    };
  };
  expect(body.snapshot?.version).toEqual(expect.any(Number));
  const importedOrder = (body.snapshot?.orderEntries ?? [])
    .filter((entry) => entry.scopeKind === 'group'
      && entry.scopeKey === params.projectGroupKey
      && entry.itemKind === 'session'
      && typeof entry.itemKey === 'string')
    .sort((left, right) => String(left.sortKey ?? '').localeCompare(String(right.sortKey ?? '')))
    .map((entry) => entry.itemKey as string)
    .filter((sessionId) => params.orderedSessionIds.includes(sessionId));
  expect(importedOrder).toEqual([...params.orderedSessionIds]);
  await expectVisibleSessionOrder(params.page, params.orderedSessionIds);
}

test.describe('ui e2e: session list ordering mode', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('session-list-ordering-mode-suite');
  const cliHomeDir = resolve(join(suiteDir, 'cli-home'));

  let server: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let uiBaseUrl: string | null = null;
  let proxyStop: (() => Promise<void>) | null = null;
  let token: string | null = null;
  let uiServerUrl: string | null = null;

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
        HAPPIER_FEATURE_SESSIONS_FOLDERS__ENABLED: '1',

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
    uiServerUrl = proxy.baseUrl;

    const auth = await createTestAuthMtls(server.baseUrl, {
      email: IDENTITY_HEADERS.email,
      issuer: IDENTITY_HEADERS.issuer,
      fingerprint: IDENTITY_HEADERS.fingerprint,
    });
    token = auth.token;
    await upsertPlainAccountSettingsV2({
      baseUrl: server.baseUrl,
      token,
      settings: {
        experiments: true,
        featureToggles: { 'sessions.folders': true },
        sessionFolderViewModeV1: 'tree',
        sessionListActiveGroupingV1: 'project',
        sessionListInactiveGroupingV1: 'project',
        sessionListOrderingModeV1: 'custom',
      },
    });
    await registerMachineIdentity({
      baseUrl: server.baseUrl,
      token,
      machineId: SEEDED_MACHINE_ID,
      metadata: 'session-list-ordering-machine',
    });

    ui = await startUiWeb({
      testDir: suiteDir,
      env: {
        ...process.env,
        EXPO_PUBLIC_DEBUG: '1',
        EXPO_PUBLIC_HAPPY_SERVER_URL: proxy.baseUrl,
        EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-session-list-ordering-${run.runId}`,
        HAPPIER_E2E_UI_WEB_MODE: process.env.HAPPIER_E2E_UI_WEB_MODE ?? 'export',
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

  test('filters quoted phrases and minus exclusions through the session list field', async ({ page }) => {
    test.setTimeout(180_000);
    if (!server || !uiBaseUrl || !token) throw new Error('missing server/ui fixtures');
    const diagnostics = collectBrowserDiagnostics({ page });
    try {
      const titles = [
        'Continue with umbrella pigs',
        'Continue with umbrella dancing pigs',
        'Continue another task with dancing pigs',
      ];
      const sessionIds: string[] = [];
      for (const title of titles) {
        sessionIds.push(await createPlainSession({
          baseUrl: server.baseUrl, token, title, rootPath: repoRootDir(),
          machineId: SEEDED_MACHINE_ID, tagPrefix: 'session-list-search',
        }));
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 120_000);
      await waitForInitialAppUi({ page, timeoutMs: 120_000 });
      for (const sessionId of sessionIds) {
        await expect(page.getByTestId(`session-list-item-${sessionId}`)).toHaveCount(1, { timeout: 120_000 });
      }
      const input = page.getByTestId('session-list-search-input').first();
      await expect(input).toBeVisible();
      const cases: ReadonlyArray<readonly [string, readonly number[]]> = [
        ['"continue with"', [0, 1]],
        ['"continue a with"', []],
        ['continue -umbrella', [2]],
        ['continue -"umbrella pigs"', [1, 2]],
        ['-"umbrella pigs"', [1, 2]],
        ['', [0, 1, 2]],
      ];
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await expect(page.getByTestId('navigation-sidebar')).toHaveCount(width === 1440 ? 1 : 0);
        await expect(input).toBeVisible();
        for (const [query, expected] of cases) {
          const originalInput = await input.elementHandle();
          await input.fill(query);
          await expect(input, `search query at width ${width}`).toHaveValue(query);
          for (const [index, sessionId] of sessionIds.entries()) {
            await expect(page.getByTestId(`session-list-item-${sessionId}`)).toHaveCount(expected.includes(index) ? 1 : 0);
          }
          const focusState = await input.evaluate((element, original) => ({
            sameElement: element === original,
            originalConnected: original?.isConnected,
            documentFocused: document.hasFocus(),
            activeElement: document.activeElement?.tagName,
            activeTestId: document.activeElement?.getAttribute('data-testid'),
          }), originalInput);
          await expect(input, `width=${width}, query=${query}, focus=${JSON.stringify(focusState)}`).toBeFocused();
        }
      }
    } catch (error) {
      throw appendBrowserDiagnostics(error, diagnostics());
    }
  });

  test('finds an unopened session by its saved opening message without a memory daemon', async ({ page }) => {
    test.setTimeout(180_000);
    if (!server || !uiBaseUrl || !token) throw new Error('missing server/ui fixtures');
    const diagnostics = collectBrowserDiagnostics({ page });
    try {
      const ids: string[] = [];
      for (const [index, text] of [
        "Drag handles on project headings don't work. When I drag, it shows that it's moving.",
        'Drag handles on project headings sometimes work. umbrella pigs',
      ].entries()) {
        const id = await createPlainSession({
          baseUrl: server.baseUrl, token, title: `Unopened transcript ${index}`,
          rootPath: repoRootDir(), machineId: SEEDED_MACHINE_ID, tagPrefix: 'unopened-search',
        });
        ids.push(id);
        const posted = await fetchJson<{ didWrite: boolean }>(`${server.baseUrl}/v2/sessions/${id}/messages`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ localId: `opening-${index}`, messageRole: 'user',
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text } } } }),
        });
        expect(posted.status).toBe(200);
        expect(posted.data.didWrite).toBe(true);
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 120_000);
      await waitForInitialAppUi({ page, timeoutMs: 120_000 });
      for (const id of ids) await expect(page.getByTestId(`session-list-item-${id}`)).toHaveCount(1, { timeout: 120_000 });
      const input = page.getByTestId('session-list-search-input').first();
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await expect(page.getByTestId('navigation-sidebar')).toHaveCount(width === 1440 ? 1 : 0);
        await expect(input).toBeVisible();
        for (const query of ["Drag handles on project headings don't work.", '"Drag handles on project headings don\'t work."', '"project headings" -"umbrella pigs"']) {
          await input.fill(query);
          await expect(input, `saved-message query at width ${width}`).toHaveValue(query);
          await expect(page.getByTestId(`session-list-item-${ids[0]}`)).toHaveCount(1, { timeout: 30_000 });
          await expect(page.getByTestId(`session-list-item-${ids[1]}`)).toHaveCount(0);
          await expect(input).toBeFocused();
        }
        await input.fill('"project headings" -"When I drag"');
        await expect(page.getByTestId(`session-list-item-${ids[1]}`)).toHaveCount(1, { timeout: 30_000 });
        await expect(page.getByTestId(`session-list-item-${ids[0]}`)).toHaveCount(0);
        await input.fill('');
        for (const id of ids) await expect(page.getByTestId(`session-list-item-${id}`)).toHaveCount(1);
      }
      let failedRead = false;
      await page.route(`**/v1/sessions/${ids[0]}/messages**`, async (route) => {
        if (!failedRead) {
          failedRead = true;
          await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'temporarily unavailable' }) });
        } else {
          await route.continue();
        }
      });
      await input.fill('"project headings" -"not in either transcript"');
      const retry = page.getByTestId('session-list-search-retry');
      await expect(retry).toBeVisible();
      await expect(page.getByTestId(`session-list-item-${ids[0]}`)).toHaveCount(0);
      await retry.click();
      await expect(page.getByTestId(`session-list-item-${ids[0]}`)).toHaveCount(1, { timeout: 30_000 });
      await expect(retry).toHaveCount(0);
      await input.fill('');
    } catch (error) {
      throw appendBrowserDiagnostics(error, diagnostics());
    }
  });

  test('searches unopened transcripts beyond the initial session list page', async ({ page }) => {
    test.setTimeout(180_000);
    if (!server || !uiBaseUrl || !token) throw new Error('missing server/ui fixtures');
    const diagnostics = collectBrowserDiagnostics({ page });
    try {
      const target = await createPlainSession({
        baseUrl: server.baseUrl, token, title: 'Historical conversation',
        rootPath: repoRootDir(), machineId: SEEDED_MACHINE_ID, tagPrefix: 'historical-search',
      });
      const posted = await fetchJson<{ didWrite: boolean }>(`${server.baseUrl}/v2/sessions/${target}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ localId: 'historical-opening', messageRole: 'user',
          content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'older project heading search' } } } }),
      });
      expect(posted.status).toBe(200);
      let newest = '';
      for (let index = 0; index < 5; index += 1) {
        newest = await createPlainSession({
          baseUrl: server.baseUrl, token, title: `Recent unrelated conversation ${index}`,
          rootPath: repoRootDir(), machineId: SEEDED_MACHINE_ID, tagPrefix: 'historical-search-filler',
        });
      }
      // HTTP boundary: use genuine server cursors with small pages to exercise older-history discovery.
      await page.route('**/v2/sessions**', async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === '/v2/sessions') url.searchParams.set('limit', '2');
        await route.continue({ url: url.toString() });
      });
      await page.setViewportSize({ width: 1440, height: 900 });
      await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 120_000);
      await waitForInitialAppUi({ page, timeoutMs: 120_000 });
      await expect(page.getByTestId(`session-list-item-${newest}`)).toHaveCount(1, { timeout: 120_000 });
      await expect(page.getByTestId(`session-list-item-${target}`)).toHaveCount(0);
      const input = page.getByTestId('session-list-search-input').first();
      await input.fill('"older project heading search"');
      await expect(input).toHaveValue('"older project heading search"');
      await expect(page.getByTestId(`session-list-item-${target}`)).toHaveCount(1, { timeout: 30_000 });
      await expect(input).toBeFocused();
      await input.fill('');
      await expect(page.getByTestId(`session-list-item-${newest}`)).toHaveCount(1);
    } catch (error) {
      throw appendBrowserDiagnostics(error, diagnostics());
    }
  });

  test('groups linked worktrees with their repository and supports directory grouping', async ({ page }) => {
    test.setTimeout(180_000);
    if (!server || !uiBaseUrl || !token) throw new Error('missing server/ui fixtures');
    const diagnostics = collectBrowserDiagnostics({ page });
    try {
      const rootPath = repoRootDir();
      const paths = [rootPath, `${rootPath}-clone`, `${rootPath}-topic`];
      const sessionIds: string[] = [];
      for (const path of paths) {
        sessionIds.push(await createPlainSession({
          baseUrl: server.baseUrl, token, rootPath: path,
          title: `repository grouping ${path}`, machineId: SEEDED_MACHINE_ID,
          tagPrefix: 'session-list-repository-grouping',
          metadata: { sessionRepositoryV1: {
            v: 1, machineId: SEEDED_MACHINE_ID,
            rootPath: path.endsWith('-clone') ? path : rootPath, worktreePath: path,
          } },
        }));
        await pauseForDistinctCreatedAt();
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      const visitList = async () => {
        await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 120_000);
        await waitForInitialAppUi({ page, timeoutMs: 120_000 });
        for (const sessionId of sessionIds) {
          await expect(page.getByTestId(`session-list-item-${sessionId}`)).toHaveCount(1, { timeout: 120_000 });
        }
      };
      const projectHeaders = page.locator('[data-testid^="session-list-project-header:"]');
      await visitList();
      await expect(projectHeaders).toHaveCount(2, { timeout: 120_000 });
      for (const count of [3, 2]) {
        await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/settings/session`, 120_000);
        await page.getByTestId('settings-session-worktreeGrouping').click();
        await visitList();
        await expect(projectHeaders).toHaveCount(count, { timeout: 120_000 });
      }
      const basename = rootPath.split('/').at(-1)!;
      const repositoryHeader = projectHeaders.filter({ hasText: basename }).filter({ hasNotText: `${basename}-clone` });
      const headerTestId = await repositoryHeader.getAttribute('data-testid');
      const headerPrefix = 'session-list-project-header:';
      if (!headerTestId?.startsWith(headerPrefix)) throw new Error('missing repository project header identity');
      await page.getByTestId(`session-workspace-create:${headerTestId.slice(headerPrefix.length)}`).click();
      await expect.poll(() => new URL(page.url()).searchParams.get('directory')).toBe(rootPath);
    } catch (error) {
      throw appendBrowserDiagnostics(error, diagnostics());
    }
  });

  test('switches updated and custom modes without mutating dormant custom order', async ({ page }) => {
    test.setTimeout(180_000);
    if (!server || !uiBaseUrl || !token || !uiServerUrl) throw new Error('missing server/ui fixtures');

    const rootPath = repoRootDir();
    const oldestSessionId = await createPlainSession({
      baseUrl: server.baseUrl,
      token,
      title: `ordering oldest ${run.runId}`,
      rootPath,
      machineId: SEEDED_MACHINE_ID,
      tagPrefix: 'session-list-ordering',
    });
    await pauseForDistinctCreatedAt();
    const middleSessionId = await createPlainSession({
      baseUrl: server.baseUrl,
      token,
      title: `ordering middle ${run.runId}`,
      rootPath,
      machineId: SEEDED_MACHINE_ID,
      tagPrefix: 'session-list-ordering',
    });
    await pauseForDistinctCreatedAt();
    const newestSessionId = await createPlainSession({
      baseUrl: server.baseUrl,
      token,
      title: `ordering newest ${run.runId}`,
      rootPath,
      machineId: SEEDED_MACHINE_ID,
      tagPrefix: 'session-list-ordering',
    });

    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 300_000);
    await waitForInitialAppUi({ page, timeoutMs: 180_000 });

    await expect(page.getByTestId(`session-list-item-${oldestSessionId}`)).toHaveCount(1, { timeout: 120_000 });
    await expect(page.getByTestId(`session-list-item-${middleSessionId}`)).toHaveCount(1, { timeout: 120_000 });
    await expect(page.getByTestId(`session-list-item-${newestSessionId}`)).toHaveCount(1, { timeout: 120_000 });

    await expect(page.locator('[data-testid^="session-list-project-header:"]').first()).toHaveCount(1, { timeout: 120_000 });

    const baselineDateOrder = await waitForVisibleSessionOrder(page, [
      oldestSessionId,
      middleSessionId,
      newestSessionId,
    ]);
    const movedSessionId = baselineDateOrder[baselineDateOrder.length - 1]!;
    const customOrder = [
      movedSessionId,
      ...baselineDateOrder.filter((sessionId) => sessionId !== movedSessionId),
    ];

    const projectGroupKey = await readFirstProjectGroupKey(page);
    const serverId = await resolveCanonicalServerIdForUi(uiServerUrl);
    const customOrderMap = {
      [projectGroupKey]: customOrder.map((sessionId) => sessionOrderKey(serverId, sessionId)),
    };
    await importSessionOrganization({
      baseUrl: server.baseUrl,
      token,
      request: buildSessionOrganizationImportRequestFromFolderSettings({
        serverId,
        sessionFoldersV1: { v: 1, folders: [] },
        sessionListGroupOrderV1: customOrderMap,
      }),
    });
    await reloadAndWaitForImportedOrganizationProjection({
      page,
      uiBaseUrl,
      projectGroupKey,
      orderedSessionIds: customOrder,
    });

    const organizationRouteParams = {
      baseUrl: server.baseUrl,
      token,
      serverId,
    };
    const customOrderSnapshot = (await readSessionFolderDragSettings(organizationRouteParams)).sessionListGroupOrderV1;
    expect(Object.values(customOrderSnapshot).some((keys) => Array.isArray(keys) && keys.length >= 2)).toBe(true);

    await selectOrderingMode(page, 'updated');
    await expectVisibleSessionOrder(page, baselineDateOrder);
    expect((await readSessionFolderDragSettings(organizationRouteParams)).sessionListGroupOrderV1).toEqual(customOrderSnapshot);

    await selectOrderingMode(page, 'custom');
    await expectVisibleSessionOrder(page, customOrder);
    expect((await readSessionFolderDragSettings(organizationRouteParams)).sessionListGroupOrderV1).toEqual(customOrderSnapshot);
  });
});
