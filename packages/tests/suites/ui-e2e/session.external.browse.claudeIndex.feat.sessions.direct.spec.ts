import { expect, test, type Page } from '@playwright/test';
import {
  mkdir,
  readFile,
  readdir,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import {
  resolveUiWebBeforeAllTimeoutMs,
  startUiWeb,
  type StartedUiWeb,
} from '../../src/testkit/process/uiWeb';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import {
  startCliAuthLoginForTerminalConnect,
  type StartedCliTerminalConnect,
} from '../../src/testkit/uiE2e/cliTerminalConnect';
import { approveTerminalConnect } from '../../src/testkit/uiE2e/approveTerminalConnect';
import { enableDirectSessionsFeature } from '../../src/testkit/uiE2e/enableDirectSessionsFeature';
import {
  createAccountAndReachConnectMachineState,
  gotoDomContentLoadedWithRetries,
  normalizeLoopbackBaseUrl,
} from '../../src/testkit/uiE2e/pageNavigation';

const run = createRunDirs({ runLabel: 'ui-e2e' });
const corpusSize = 10_000;
const candidatePageSize = 50;
const corpusWriteConcurrency = 128;

type CandidateIndexRecord = Readonly<{
  v: 2;
  state: 'building' | 'complete';
  indexGeneration?: string;
  scanned: number;
  candidates: ReadonlyArray<Readonly<{
    remoteSessionId: string;
    updatedAtMs: number;
    title?: unknown;
  }>>;
}>;

function jsonlLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function candidateId(index: number): string {
  return `e10-session-${String(index).padStart(5, '0')}`;
}

function candidateTitle(index: number): string {
  return `E10 candidate ${String(index).padStart(5, '0')}`;
}

function initialExpectedOrder(): number[] {
  const order: number[] = [];
  for (let pair = (corpusSize / 2) - 1; pair >= 0; pair -= 1) {
    order.push(pair * 2, (pair * 2) + 1);
  }
  return order;
}

async function mapWithConcurrency(
  count: number,
  concurrency: number,
  worker: (index: number) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (nextIndex < count) {
      const index = nextIndex;
      nextIndex += 1;
      await worker(index);
    }
  }));
}

async function createClaudeCandidateCorpus(params: Readonly<{
  claudeConfigDir: string;
  baseMtimeMs: number;
}>): Promise<void> {
  const projectsDir = join(params.claudeConfigDir, 'projects');
  await mkdir(projectsDir, { recursive: true });
  await Promise.all(Array.from({ length: corpusSize / 100 }, (_, projectIndex) => (
    mkdir(join(projectsDir, `project-${String(projectIndex).padStart(3, '0')}`), {
      recursive: true,
    })
  )));

  await mapWithConcurrency(corpusSize, corpusWriteConcurrency, async (index) => {
    const projectId = `project-${String(Math.floor(index / 100)).padStart(3, '0')}`;
    const filePath = join(projectsDir, projectId, `${candidateId(index)}.jsonl`);
    await writeFile(
      filePath,
      jsonlLine({
        type: 'user',
        uuid: `e10-user-${index}`,
        cwd: `/tmp/e10-project-${projectId}`,
        message: { content: candidateTitle(index) },
      }),
      'utf8',
    );
    // Equal-timestamp pairs exercise the deterministic remoteSessionId tie-breaker.
    const updatedAt = new Date(params.baseMtimeMs + (Math.floor(index / 2) * 1_000));
    await utimes(filePath, updatedAt, updatedAt);
  });
}

async function addNewestClaudeCandidate(params: Readonly<{
  claudeConfigDir: string;
  updatedAtMs: number;
}>): Promise<string> {
  const remoteSessionId = 'e10-session-newest';
  const projectId = 'project-099';
  const filePath = join(
    params.claudeConfigDir,
    'projects',
    projectId,
    `${remoteSessionId}.jsonl`,
  );
  await writeFile(
    filePath,
    jsonlLine({
      type: 'user',
      uuid: 'e10-user-newest',
      cwd: `/tmp/e10-project-${projectId}`,
      message: { content: 'E10 candidate newest after mutation' },
    }),
    'utf8',
  );
  const updatedAt = new Date(params.updatedAtMs);
  await utimes(filePath, updatedAt, updatedAt);
  return remoteSessionId;
}

async function findCandidateIndexPath(rootDir: string): Promise<string | null> {
  const rootStat = await stat(rootDir).catch(() => null);
  if (!rootStat) return null;
  if (!rootStat.isDirectory()) return null;

  const pending = [rootDir];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (entry.isFile() && entry.name === 'index.json') {
        return entryPath;
      }
    }
  }
  return null;
}

async function readCandidateIndex(cliHomeDir: string): Promise<CandidateIndexRecord | null> {
  const indexPath = await findCandidateIndexPath(join(cliHomeDir, 'servers'));
  if (!indexPath) return null;
  const parsed = JSON.parse(await readFile(indexPath, 'utf8')) as CandidateIndexRecord;
  return parsed;
}

async function openClaudeBrowse(page: Page): Promise<void> {
  const browseAction = page.getByTestId('external-sessions-browse-button');
  await expect(browseAction).toHaveCount(1, { timeout: 120_000 });
  await browseAction.click();
  await expect(page.getByTestId('direct-sessions-browse-modal')).toHaveCount(1, {
    timeout: 60_000,
  });

  const agentPicker = page.getByTestId('direct-session-provider-picker-trigger');
  await expect(agentPicker).toHaveCount(1, { timeout: 60_000 });
  await agentPicker.focus();
  await agentPicker.press('Enter');
  const claudeOption = page.getByTestId('dropdown-option-claude');
  await expect(claudeOption).toHaveCount(1, { timeout: 60_000 });
  await claudeOption.click();
}

async function closeBrowse(page: Page): Promise<void> {
  const close = page.getByTestId('external-session-browse-cancel');
  await expect(close).toHaveCount(1, { timeout: 60_000 });
  await close.click();
  await expect(page.getByTestId('direct-sessions-browse-modal')).toHaveCount(0, {
    timeout: 60_000,
  });
}

async function readActiveCandidate(page: Page): Promise<Readonly<{
  ordinal: number;
  setSize: number;
  scrollTop: number;
}>> {
  let result: Readonly<{
    ordinal: number;
    setSize: number;
    scrollTop: number;
  }> | null = null;
  await expect.poll(async () => {
    result = await page.evaluate(() => {
      const input = document.querySelector(
        '[data-testid="direct-session-candidates-search-input"]',
      );
      const activeId = input?.getAttribute('aria-activedescendant');
      const active = activeId ? document.getElementById(activeId) : null;
      const match = active?.textContent?.match(/E10 candidate (\d{5})/);
      const scrollOwner = document.querySelector(
        '[data-testid="direct-session-candidates:bodyVirtualizedList"]',
      );
      if (!active || !match || !scrollOwner) return null;
      return {
        ordinal: Number(match[1]),
        setSize: Number(active.getAttribute('aria-setsize') ?? '0'),
        scrollTop: scrollOwner.scrollTop,
      };
    });
    return result?.ordinal ?? null;
  }, { timeout: 30_000 }).not.toBeNull();
  if (!result) throw new Error('missing active Claude candidate');
  return result;
}

test.describe('ui e2e: authenticated Claude candidate index browse', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('session-external-browse-claude-index-suite');
  const cliHomeDir = resolve(join(suiteDir, 'cli-home'));
  const claudeConfigDir = resolve(join(suiteDir, 'synthetic-claude-home'));
  const corpusBaseMtimeMs = Date.UTC(2026, 0, 1);

  let server: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let uiBaseUrl: string | null = null;
  let daemon: StartedDaemon | null = null;
  let cliLogin: StartedCliTerminalConnect | null = null;

  test.beforeAll(async () => {
    const uiWebEnv = {
      ...process.env,
      EXPO_PUBLIC_DEBUG: '1',
      EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-external-claude-index-${run.runId}`,
      HAPPIER_E2E_UI_WEB_MODE: 'metro',
    };
    test.setTimeout(Math.max(resolveUiWebBeforeAllTimeoutMs(uiWebEnv), 720_000));
    await mkdir(cliHomeDir, { recursive: true });
    await createClaudeCandidateCorpus({
      claudeConfigDir,
      baseMtimeMs: corpusBaseMtimeMs,
    });

    server = await startServerLight({
      testDir: suiteDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_BUILD_FEATURES_DENY: 'sharing.contentKeys',
        HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
        HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'plaintext_only',
        HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD: '1',
      },
    });
    ui = await startUiWeb({
      testDir: suiteDir,
      env: {
        ...uiWebEnv,
        EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl,
      },
      skipWorkspacePrebuild: true,
    });
    uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
  });

  test.afterAll(async () => {
    test.setTimeout(120_000);
    await cliLogin?.stop().catch(() => {});
    cliLogin = null;
    await daemon?.stop().catch(() => {});
    await ui?.stop().catch(() => {});
    await server?.stop().catch(() => {});
  });

  test('cancels cold work, publishes one exact bounded page, reuses it after restart, and refreshes after mutation', async ({
    page,
  }) => {
    test.setTimeout(900_000);
    if (!server || !uiBaseUrl) throw new Error('missing server/UI fixtures');

    const testDir = resolve(join(suiteDir, 'authenticated-claude-index'));
    await mkdir(testDir, { recursive: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoDomContentLoadedWithRetries(page, uiBaseUrl, 180_000);
    await createAccountAndReachConnectMachineState({ page });

    cliLogin = await startCliAuthLoginForTerminalConnect({
      testDir,
      cliHomeDir,
      serverUrl: server.baseUrl,
      webappUrl: uiBaseUrl,
      waitForConnectUrlReady: false,
      env: {
        ...process.env,
        HOME: cliHomeDir,
        CI: '1',
        HAPPIER_DISABLE_CAFFEINATE: '1',
        HAPPIER_VARIANT: 'dev',
        HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
        HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
        HAPPIER_E2E_CLI_SNAPSHOT_NODE_MODULES_MODE: 'symlink',
      },
    });
    await gotoDomContentLoadedWithRetries(page, cliLogin.connectUrl, 180_000);
    await approveTerminalConnect({ page });
    await cliLogin.waitForSuccess();
    await cliLogin.stop().catch(() => {});
    cliLogin = null;

    const startDaemon = async (): Promise<StartedDaemon> => await startTestDaemon({
      testDir,
      happyHomeDir: cliHomeDir,
      snapshotDir: resolve(join(testDir, 'cli-dist')),
      startupTimeoutMs: 120_000,
      env: {
        ...process.env,
        HOME: cliHomeDir,
        CI: '1',
        HAPPIER_HOME_DIR: cliHomeDir,
        HAPPIER_SERVER_URL: server!.baseUrl,
        HAPPIER_WEBAPP_URL: uiBaseUrl!,
        HAPPIER_DISABLE_CAFFEINATE: '1',
        HAPPIER_VARIANT: 'dev',
        HAPPIER_CLAUDE_CONFIG_DIR: claudeConfigDir,
        HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'plaintext_only',
        HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
        HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
        HAPPIER_E2E_CLI_SNAPSHOT_NODE_MODULES_MODE: 'symlink',
      },
    });
    daemon = await startDaemon();
    await enableDirectSessionsFeature(page, uiBaseUrl);
    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/`, 180_000);

    // Passive daemon boot must not create or resume the private index.
    await page.waitForTimeout(1_000);
    expect(await readCandidateIndex(cliHomeDir)).toBeNull();

    await openClaudeBrowse(page);
    const indexing = page.getByTestId('direct-session-candidates:indexing');
    await expect(indexing).toHaveCount(1, { timeout: 120_000 });
    await expect(page.locator('[data-testid^="direct-session-candidate:"]')).toHaveCount(0);

    await page.getByTestId('direct-session-candidates:indexing:cancel').click();
    await expect(page.getByTestId('direct-session-candidates:error')).toHaveCount(1, {
      timeout: 60_000,
    });
    await expect(page.locator('[data-testid^="direct-session-candidate:"]')).toHaveCount(0);
    await page.waitForTimeout(750);
    await expect(page.locator('[data-testid^="direct-session-candidate:"]')).toHaveCount(0);
    const cancelledCheckpoint = await readCandidateIndex(cliHomeDir);
    expect(cancelledCheckpoint?.state).toBe('building');
    await page.waitForTimeout(1_000);
    expect(await readCandidateIndex(cliHomeDir)).toEqual(cancelledCheckpoint);

    await closeBrowse(page);
    await openClaudeBrowse(page);
    const firstCandidate = page.getByText(candidateTitle(corpusSize - 2), { exact: true });
    await expect(firstCandidate).toHaveCount(1, { timeout: 300_000 });
    await expect(page.locator('[data-testid^="direct-session-candidate:"]')).not.toHaveCount(0);

    const expectedOrder = initialExpectedOrder();
    const completeIndexPath = await findCandidateIndexPath(join(cliHomeDir, 'servers'));
    expect(completeIndexPath).not.toBeNull();
    const completeIndexRaw = await readFile(completeIndexPath!, 'utf8');
    const completeIndex = await readCandidateIndex(cliHomeDir);
    expect(completeIndex).toMatchObject({
      v: 2,
      state: 'complete',
      scanned: corpusSize,
    });
    expect(completeIndex?.candidates).toHaveLength(corpusSize);
    expect(new Set(
      completeIndex?.candidates.map((candidate) => candidate.remoteSessionId),
    ).size).toBe(corpusSize);
    expect(completeIndex?.candidates.slice(0, 100).map((candidate) => candidate.remoteSessionId)).toEqual(
      expectedOrder.slice(0, 100).map(candidateId),
    );
    expect(completeIndex?.candidates.every((candidate) => candidate.title === undefined)).toBe(true);
    expect(completeIndexRaw).not.toContain(claudeConfigDir);
    expect(completeIndexRaw).not.toContain('E10 candidate');
    if (process.platform !== 'win32') {
      expect((await stat(completeIndexPath!)).mode & 0o777).toBe(0o600);
      expect((await stat(join(completeIndexPath!, '..'))).mode & 0o777).toBe(0o700);
    }

    // The SelectionList keyboard model exposes the loaded page size. Walking across
    // the first continuation boundary proves page-one exactness plus focus/scroll
    // continuity without relying on recycled-row DOM counts.
    const searchInput = page.getByTestId('direct-session-candidates-search-input');
    const scrollOwner = page.getByTestId('direct-session-candidates:bodyVirtualizedList');
    await expect(searchInput).toHaveCount(1);
    await expect(scrollOwner).toHaveCount(1);
    await searchInput.focus();
    await searchInput.press('ArrowDown');
    let active = await readActiveCandidate(page);
    expect(active).toMatchObject({
      ordinal: expectedOrder[0],
      setSize: candidatePageSize,
    });
    for (let index = 1; index < candidatePageSize; index += 1) {
      await searchInput.press('ArrowDown');
      active = await readActiveCandidate(page);
      expect(active.ordinal).toBe(expectedOrder[index]);
    }
    expect(active.scrollTop).toBeGreaterThan(0);

    await expect.poll(async () => {
      const current = await readActiveCandidate(page);
      return current.setSize;
    }, { timeout: 120_000 }).toBe(candidatePageSize * 2);
    const scrollTopBeforeContinuation = await scrollOwner.evaluate((node) => node.scrollTop);
    await searchInput.press('ArrowDown');
    active = await readActiveCandidate(page);
    expect(active.ordinal).toBe(expectedOrder[candidatePageSize]);
    expect(active.setSize).toBe(candidatePageSize * 2);
    expect(active.scrollTop).toBeGreaterThanOrEqual(scrollTopBeforeContinuation);

    const generationBeforeRestart = completeIndex?.indexGeneration;
    expect(generationBeforeRestart).toMatch(/^[a-f0-9]{64}$/);
    await closeBrowse(page);
    await daemon.stop();
    daemon = null;
    daemon = await startDaemon();
    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/`, 180_000);
    await openClaudeBrowse(page);
    await expect(page.getByText(candidateTitle(corpusSize - 2), { exact: true })).toHaveCount(1, {
      timeout: 180_000,
    });
    const restartedIndex = await readCandidateIndex(cliHomeDir);
    expect(restartedIndex).toMatchObject({
      state: 'complete',
      indexGeneration: generationBeforeRestart,
    });

    await closeBrowse(page);
    const newestRemoteSessionId = await addNewestClaudeCandidate({
      claudeConfigDir,
      updatedAtMs: corpusBaseMtimeMs + corpusSize * 2_000,
    });
    await openClaudeBrowse(page);
    await expect(page.getByText('E10 candidate newest after mutation', { exact: true })).toHaveCount(1, {
      timeout: 300_000,
    });
    const refreshedIndex = await readCandidateIndex(cliHomeDir);
    expect(refreshedIndex).toMatchObject({
      state: 'complete',
      scanned: corpusSize + 1,
    });
    expect(refreshedIndex?.indexGeneration).toMatch(/^[a-f0-9]{64}$/);
    expect(refreshedIndex?.indexGeneration).not.toBe(generationBeforeRestart);
    expect(refreshedIndex?.candidates[0]?.remoteSessionId).toBe(newestRemoteSessionId);
    expect(new Set(
      refreshedIndex?.candidates.map((candidate) => candidate.remoteSessionId),
    ).size).toBe(corpusSize + 1);
  });
});
