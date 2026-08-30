import { test, expect, type Page, type Response } from '@playwright/test';
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
import {
  fetchSessionOrganizationSnapshot,
  importSessionOrganization,
  readPinnedSessionIdsFromOrganizationSnapshot,
} from '../../src/testkit/uiE2e/sessionOrganization';
import { waitForInitialAppUi } from '../../src/testkit/uiE2e/waitForInitialAppUi';

const run = createRunDirs({ runLabel: 'ui-e2e-session-organization-pinned-bootstrap' });

const PINNED_SESSION_COUNT = 101;
const SEED_CONCURRENCY = 10;
const SEEDED_MACHINE_ID = 'seeded-session-organization-pinned-machine';
const IDENTITY_HEADERS = {
  email: `session-organization-pinned-${run.runId}@example.com`,
  issuer: 'happier-ui-e2e-session-organization-pinned',
  fingerprint: `session-organization-pinned-${run.runId}`,
} as const;

type SessionListCapture = Readonly<{
  url: string;
  sessionIds: readonly string[];
  hasCursor: boolean;
  hasPinnedSessionIdsParam: boolean;
}>;

type SessionListResponseBody = Readonly<{
  sessions?: ReadonlyArray<Readonly<{
    id?: unknown;
  }>>;
}>;

function sortKeyForIndex(index: number): string {
  return String(index + 1).padStart(8, '0');
}

function createSessionListCaptureCollector(page: Page): SessionListCapture[] {
  const captures: SessionListCapture[] = [];

  page.on('response', (response) => {
    void captureSessionListResponse({ response, captures });
  });

  return captures;
}

async function captureSessionListResponse(params: Readonly<{
  response: Response;
  captures: SessionListCapture[];
}>): Promise<void> {
  const url = params.response.url();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (parsed.pathname !== '/v2/sessions' || !params.response.ok()) return;

  const body = await params.response.json().catch(() => null) as SessionListResponseBody | null;
  const sessionIds = Array.isArray(body?.sessions)
    ? body.sessions
      .map((session) => session.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
    : [];

  params.captures.push({
    url,
    sessionIds,
    hasCursor: parsed.searchParams.has('cursor'),
    hasPinnedSessionIdsParam: parsed.searchParams.has('pinnedSessionIds'),
  });
}

async function seedSessions(params: Readonly<{
  baseUrl: string;
  token: string;
  count: number;
}>): Promise<string[]> {
  const rootPath = repoRootDir();
  const sessionIds = new Array<string>(params.count);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < params.count) {
      const index = nextIndex;
      nextIndex += 1;
      sessionIds[index] = await createPlainSession({
        baseUrl: params.baseUrl,
        token: params.token,
        title: `pinned bootstrap ${index + 1} ${run.runId}`,
        rootPath,
        machineId: SEEDED_MACHINE_ID,
        tagPrefix: 'session-organization-pinned-bootstrap',
      });
    }
  }

  await Promise.all(Array.from(
    { length: Math.min(SEED_CONCURRENCY, params.count) },
    () => worker(),
  ));
  return sessionIds;
}

async function expectInitialSessionListResponseContainsPinnedSessions(params: Readonly<{
  captures: readonly SessionListCapture[];
  pinnedSessionIds: readonly string[];
}>): Promise<void> {
  const pinnedSessionIdSet = new Set(params.pinnedSessionIds);

  await expect.poll(() => {
    const matching = params.captures.find((capture) => {
      if (capture.hasCursor || capture.hasPinnedSessionIdsParam) return false;
      const responseSessionIds = new Set(capture.sessionIds);
      for (const sessionId of pinnedSessionIdSet) {
        if (!responseSessionIds.has(sessionId)) return false;
      }
      return true;
    });
    return matching?.sessionIds.length ?? 0;
  }, { timeout: 180_000 }).toBeGreaterThanOrEqual(params.pinnedSessionIds.length);
}

test.describe('ui e2e: session organization pinned bootstrap', () => {
  const suiteDir = run.testDir('session-organization-pinned-bootstrap-suite');
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
      metadata: 'session-organization-pinned-bootstrap-machine',
    });

    ui = await startUiWeb({
      testDir: suiteDir,
      env: {
        ...process.env,
        EXPO_PUBLIC_DEBUG: '1',
        EXPO_PUBLIC_HAPPY_SERVER_URL: proxy.baseUrl,
        EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-session-organization-pinned-${run.runId}`,
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

  test('loads more than 100 server-backed pins in the pinned section from the initial session list response', async ({ page }) => {
    test.setTimeout(900_000);
    if (!server || !uiBaseUrl || !token) throw new Error('missing server/ui fixtures');

    const pinnedSessionIds = await seedSessions({
      baseUrl: server.baseUrl,
      token,
      count: PINNED_SESSION_COUNT,
    });

    await importSessionOrganization({
      baseUrl: server.baseUrl,
      token,
      request: {
        pins: pinnedSessionIds.map((sessionId, index) => ({
          sessionId,
          sortKey: sortKeyForIndex(index),
        })),
        folders: [],
        tags: [],
        tagAssignments: [],
        orderEntries: [],
        labels: [],
      },
    });

    const snapshot = await fetchSessionOrganizationSnapshot({
      baseUrl: server.baseUrl,
      token,
      request: {
        includeFolders: false,
        includeTags: false,
        includeLabels: false,
      },
    });
    expect(readPinnedSessionIdsFromOrganizationSnapshot(snapshot)).toHaveLength(PINNED_SESSION_COUNT);

    const initialListCaptures = createSessionListCaptureCollector(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 300_000);
    await waitForInitialAppUi({ page, timeoutMs: 180_000 });

    await expectInitialSessionListResponseContainsPinnedSessions({
      captures: initialListCaptures,
      pinnedSessionIds,
    });
    await expect(page.getByTestId('session-list-header:pinned-v1')).toHaveCount(1, { timeout: 120_000 });
    await expect(page.getByTestId(`session-list-item-${pinnedSessionIds[0]}`)).toHaveCount(1, { timeout: 120_000 });
  });
});
