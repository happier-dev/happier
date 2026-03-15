import { test, expect, type Locator, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { startCliAuthLoginForTerminalConnect, type StartedCliTerminalConnect } from '../../src/testkit/uiE2e/cliTerminalConnect';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { runCliJson } from '../../src/testkit/uiE2e/cliJson';

const run = createRunDirs({ runLabel: 'ui-e2e' });

function resolveServerLightSqliteDbPath(params: { suiteDir: string }): string {
  return resolve(join(params.suiteDir, 'server-light-data', 'happier-server-light.sqlite'));
}

function readLatestMachineIdFromServerLightDb(params: { suiteDir: string }): string {
  const dbPath = resolveServerLightSqliteDbPath({ suiteDir: params.suiteDir });
  try {
    const raw = execFileSync('sqlite3', ['-json', dbPath, 'select id from Machine order by createdAt desc limit 1;'], {
      encoding: 'utf8',
    });
    const parsed = JSON.parse(raw) as Array<{ id?: unknown }>;
    const id = parsed?.[0]?.id;
    if (typeof id === 'string' && id.trim()) return id.trim();
  } catch {
    // ignore - pollers can retry
  }
  throw new Error(`Failed to read machine id from server light sqlite db: ${dbPath}`);
}

async function waitForLatestMachineId(params: { suiteDir: string; timeoutMs?: number }): Promise<string> {
  const timeoutMs = params.timeoutMs ?? 60_000;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return readLatestMachineIdFromServerLightDb({ suiteDir: params.suiteDir });
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  return readLatestMachineIdFromServerLightDb({ suiteDir: params.suiteDir });
}

function parseSessionIdFromUrl(url: string): string {
  const pathname = new URL(url).pathname;
  const parts = pathname.split('/').filter(Boolean);
  const sessionId = parts[0] === 'session' ? parts[1] : null;
  if (!sessionId) {
    throw new Error(`failed to parse session id from url: ${url}`);
  }
  return sessionId;
}

async function createSessionFromComposer(params: {
  page: Page;
  uiBaseUrl: string;
  machineId: string;
  prompt: string;
}): Promise<string> {
  const { page, uiBaseUrl, machineId, prompt } = params;
  await page.goto(`${uiBaseUrl}/new`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('new-session-composer-input')).toHaveCount(1, { timeout: 60_000 });
  await expect(page.getByTestId('agent-input-machine-chip')).toHaveCount(1, { timeout: 120_000 });
  await page.getByTestId('agent-input-machine-chip').click();
  await expect(page.getByTestId(`new-session-machine:${machineId}`)).toHaveCount(1, { timeout: 120_000 });
  await page.getByTestId(`new-session-machine:${machineId}`).click();
  await expect(page.getByTestId('new-session-composer-input')).toHaveCount(1, { timeout: 60_000 });

  await page.getByTestId('new-session-composer-input').fill(prompt);
  await page.getByTestId('new-session-composer-input').press('Enter');

  await expect(page.getByTestId('session-composer-input')).toHaveCount(1, { timeout: 180_000 });
  return parseSessionIdFromUrl(page.url());
}

type TranscriptScrollMetrics = {
  scrollTop: number;
  maxScrollTop: number;
};

async function readTranscriptScrollMetrics(transcriptRoot: Locator): Promise<TranscriptScrollMetrics> {
  return transcriptRoot.evaluate((el) => {
    const root = el as unknown as HTMLElement;
    const isScrollable = (node: HTMLElement): boolean => {
      try {
        const cs = window.getComputedStyle(node);
        const overflowY = cs?.overflowY;
        if (!(overflowY === 'auto' || overflowY === 'scroll')) return false;
        const sh = (node as any).scrollHeight;
        const ch = (node as any).clientHeight;
        if (typeof sh !== 'number' || typeof ch !== 'number') return false;
        return sh > ch + 50;
      } catch {
        return false;
      }
    };

    const candidates: HTMLElement[] = [root];
    try {
      const desc = root.querySelectorAll?.('*') as NodeListOf<HTMLElement> | undefined;
      if (desc) candidates.push(...Array.from(desc));
    } catch {
      // ignore
    }

    let best: HTMLElement | null = null;
    let bestScrollHeight = 0;
    for (const node of candidates) {
      if (!isScrollable(node)) continue;
      const scrollHeight = typeof (node as any).scrollHeight === 'number' ? (node as any).scrollHeight : 0;
      if (!best || scrollHeight > bestScrollHeight) {
        best = node;
        bestScrollHeight = scrollHeight;
      }
    }

    // If we couldn't find a scroll container inside the root, fall back to ancestors.
    if (!best) {
      let node: HTMLElement | null = root.parentElement;
      let steps = 0;
      while (node && steps < 30) {
        if (isScrollable(node)) {
          best = node;
          break;
        }
        node = node.parentElement;
        steps += 1;
      }
    }

    if (!best) {
      throw new Error('failed to find transcript scroll container');
    }

    const sh = (best as any).scrollHeight;
    const ch = (best as any).clientHeight;
    const maxScrollTop = typeof sh === 'number' && typeof ch === 'number' ? Math.max(0, Math.trunc(sh - ch)) : 0;
    const scrollTopRaw = (best as any).scrollTop;
    const scrollTop =
      typeof scrollTopRaw === 'number' && Number.isFinite(scrollTopRaw) ? Math.max(0, Math.trunc(scrollTopRaw)) : 0;
    return { scrollTop, maxScrollTop };
  });
}

async function setTranscriptScrollTop(transcriptRoot: Locator, scrollTop: number): Promise<void> {
  await transcriptRoot.evaluate(
    (el, scrollTopValue) => {
      const root = el as unknown as HTMLElement;
      const nextScrollTop =
        typeof scrollTopValue === 'number' && Number.isFinite(scrollTopValue) ? Math.max(0, Math.trunc(scrollTopValue)) : 0;

      const isScrollable = (node: HTMLElement): boolean => {
        try {
          const cs = window.getComputedStyle(node);
          const overflowY = cs?.overflowY;
          if (!(overflowY === 'auto' || overflowY === 'scroll')) return false;
          const sh = (node as any).scrollHeight;
          const ch = (node as any).clientHeight;
          if (typeof sh !== 'number' || typeof ch !== 'number') return false;
          return sh > ch + 50;
        } catch {
          return false;
        }
      };

      const candidates: HTMLElement[] = [root];
      try {
        const desc = root.querySelectorAll?.('*') as NodeListOf<HTMLElement> | undefined;
        if (desc) candidates.push(...Array.from(desc));
      } catch {
        // ignore
      }

      let best: HTMLElement | null = null;
      let bestScrollHeight = 0;
      for (const node of candidates) {
        if (!isScrollable(node)) continue;
        const scrollHeight = typeof (node as any).scrollHeight === 'number' ? (node as any).scrollHeight : 0;
        if (!best || scrollHeight > bestScrollHeight) {
          best = node;
          bestScrollHeight = scrollHeight;
        }
      }

      // If we couldn't find a scroll container inside the root, fall back to ancestors.
      if (!best) {
        let node: HTMLElement | null = root.parentElement;
        let steps = 0;
        while (node && steps < 30) {
          if (isScrollable(node)) {
            best = node;
            break;
          }
          node = node.parentElement;
          steps += 1;
        }
      }

      if (!best) {
        throw new Error('failed to find transcript scroll container');
      }

      const node: any = best as any;
      try {
        // Prefer direct `scrollTop` writes: in RNW, ScrollView can override `scrollTo` with an RN-style signature
        // ({ x, y, animated }) which does not accept DOM-style `{ top }` args.
        node.scrollTop = nextScrollTop;
      } catch {
        node.scrollTop = nextScrollTop;
      }

      try {
        best.dispatchEvent(new Event('scroll'));
      } catch {
        // ignore
      }
    },
    scrollTop,
  );
}

test.describe('ui e2e: transcript reconnect catch-up', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('session-transcript-catchup-suite');
  const cliHomeDir = resolve(join(suiteDir, 'cli-home'));

  let server: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let uiBaseUrl: string | null = null;
  let daemon: StartedDaemon | null = null;

  test.beforeAll(async () => {
    test.setTimeout(420_000);
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(resolve(join(cliHomeDir, 'AGENTS.md')), '# UI e2e fixture\n', 'utf8');

    server = await startServerLight({
      testDir: suiteDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_BUILD_FEATURES_DENY: 'sharing.contentKeys',
        HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
        HAPPIER_PRESENCE_SESSION_TIMEOUT_MS: '60000',
        HAPPIER_PRESENCE_MACHINE_TIMEOUT_MS: '60000',
        HAPPIER_PRESENCE_TIMEOUT_TICK_MS: '1000',
      },
    });

    ui = await startUiWeb({
      testDir: suiteDir,
      env: {
        ...process.env,
        EXPO_PUBLIC_DEBUG: '1',
        EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl,
        EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-${run.runId}`,
        // Make catch-up thresholds small so we can trigger "large gap" behavior with only a handful of missed messages.
        EXPO_PUBLIC_HAPPIER_SYNC_TUNING_JSON: JSON.stringify({
          messageLargeGapSeq: 2,
          messageMaxIncrementalPagesOnResume: 2,
          transcriptForwardPrefetchThresholdPx: 120,
          transcriptWebInitialPinStabilizeMs: 0,
          messageCatchUpConcurrencyLimit: 1,
          resumeConcurrencyLimit: 2,
          bootstrapConcurrencyLimit: 3,
          changesPageLimit: 200,
        }),
      },
    });

    uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
  });

  test.afterAll(async () => {
    test.setTimeout(120_000);
    await daemon?.stop().catch(() => {});
    await ui?.stop().catch(() => {});
    await server?.stop().catch(() => {});
  });

  test('uses snapshot tail reset when pinned and defers forward loading when mid-history', async ({ page }) => {
    test.setTimeout(540_000);
    if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoDomContentLoadedWithRetries(page, uiBaseUrl);

    await page.getByTestId('welcome-create-account').click();
    await expect(page.getByTestId('session-getting-started-kind-connect_machine')).not.toHaveCount(0, { timeout: 120_000 });

    const testDir = resolve(join(suiteDir, 't1-reconnect-catchup'));
    await mkdir(testDir, { recursive: true });

    const cliLogin: StartedCliTerminalConnect = await startCliAuthLoginForTerminalConnect({
      testDir,
      cliHomeDir,
      serverUrl: server.baseUrl,
      webappUrl: uiBaseUrl,
      env: {
        ...process.env,
        HOME: cliHomeDir,
        CI: '1',
        HAPPIER_DISABLE_CAFFEINATE: '1',
        HAPPIER_VARIANT: 'dev',
      },
    });

    await page.goto(cliLogin.connectUrl, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('terminal-connect-approve')).toHaveCount(1, { timeout: 60_000 });
    await page.getByTestId('terminal-connect-approve').click();
    await cliLogin.waitForSuccess();
    await cliLogin.stop().catch(() => {});

    const fakeClaudeLogPath = resolve(join(testDir, 'fake-claude.jsonl'));
    const fakeClaudePath = fakeClaudeFixturePath();

    daemon = await startTestDaemon({
      testDir,
      happyHomeDir: cliHomeDir,
      env: {
        ...process.env,
        HOME: cliHomeDir,
        CI: '1',
        HAPPIER_HOME_DIR: cliHomeDir,
        HAPPIER_SERVER_URL: server.baseUrl,
        HAPPIER_WEBAPP_URL: uiBaseUrl,
        HAPPIER_DISABLE_CAFFEINATE: '1',
        HAPPIER_VARIANT: 'dev',
        HAPPIER_CLAUDE_PATH: fakeClaudePath,
        HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeClaudeLogPath,
        HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: `fake-claude-session-${run.runId}`,
        HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID: `fake-claude-invocation-${run.runId}`,
      },
    });

    const machineId = await waitForLatestMachineId({ suiteDir, timeoutMs: 120_000 });

    // --- Scenario A: pinned + large gap => tail reset (snapshot `/messages`, no `afterSeq`) ---
    const sessionPinnedId = await createSessionFromComposer({ page, uiBaseUrl, machineId, prompt: 'hello pinned' });
    await page.goto(`${uiBaseUrl}/session/${sessionPinnedId}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('transcript-chat-list')).toHaveCount(1, { timeout: 120_000 });

    const requests: Array<{ url: string; ts: number }> = [];
    page.on('request', (req) => {
      requests.push({ url: req.url(), ts: Date.now() });
    });

    await page.context().setOffline(true);
    await page.waitForTimeout(500);

    for (let i = 0; i < 3; i += 1) {
      const message = `missed pinned ${i} ${run.runId}`;
      const sendEnvelope = await runCliJson({
        testDir,
        cliHomeDir,
        serverUrl: server.baseUrl,
        webappUrl: uiBaseUrl,
        env: { ...process.env, HOME: cliHomeDir },
        label: `session-send-pinned-missed-${i}`,
        args: ['session', 'send', sessionPinnedId, message, '--json'],
        timeoutMs: 120_000,
      });
      expect(sendEnvelope.ok).toBe(true);
      expect(sendEnvelope.kind).toBe('session_send');
    }

    const reconnectStart = Date.now();
    await page.context().setOffline(false);

    await expect
      .poll(
        async () => {
          const after = requests.filter((r) => r.ts >= reconnectStart).map((r) => r.url);
          const hasChanges = after.some((u) => u.includes('/v2/changes'));
          const hasSnapshot = after.some((u) => u.includes(`/v1/sessions/${sessionPinnedId}/messages`) && !u.includes('afterSeq='));
          return { hasChanges, hasSnapshot, after };
        },
        { timeout: 60_000 },
      )
      .toMatchObject({ hasChanges: true, hasSnapshot: true });

    const afterPinnedReconnect = requests.filter((r) => r.ts >= reconnectStart).map((r) => r.url);
    const pinnedAfterSeqFetches = afterPinnedReconnect.filter((u) => u.includes(`/v1/sessions/${sessionPinnedId}/messages?`) && u.includes('afterSeq='));
    expect(pinnedAfterSeqFetches).toEqual([]);

    // --- Scenario B: mid-history + large gap => defer, then forward-load on scroll near bottom ---
    const sessionMidId = await createSessionFromComposer({ page, uiBaseUrl, machineId, prompt: 'hello mid-history' });
    await page.goto(`${uiBaseUrl}/session/${sessionMidId}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('transcript-chat-list')).toHaveCount(1, { timeout: 120_000 });

    // Create enough content to allow scroll-unpin.
    await expect(page.getByTestId('session-composer-input')).toHaveCount(1, { timeout: 120_000 });
    for (let i = 0; i < 80; i++) {
      await page.getByTestId('session-composer-input').fill(`seed ${i}`);
      await page.getByTestId('session-composer-input').press('Enter');
      await page.waitForTimeout(100);
    }

    const transcript = page.getByTestId('transcript-chat-list');
    await expect(transcript).toHaveCount(1, { timeout: 60_000 });
    // Avoid relying on RNW DOM `id` forwarding for the underlying ChatList root; `testID` is our stable UI-e2e API.
    const transcriptRoot = transcript;

    // Scroll to mid-history (unpinned). Use direct scrollTop mutation + a dispatched scroll event so RNW/FlashList
    // updates pinned state in sync, then verify we didn't immediately auto-repin.
    await expect
      .poll(async () => (await readTranscriptScrollMetrics(transcriptRoot)).maxScrollTop, { timeout: 60_000 })
      .toBeGreaterThan(800);

    await transcript.hover();
    // Unpin using real wheel scroll so ChatList records web scroll intent (`onWheel`) and avoids auto-repin.
    // Use multiple small deltas rather than one huge delta to keep behavior consistent across browsers.
    for (let i = 0; i < 18; i += 1) {
      await page.mouse.wheel(0, -200);
      await page.waitForTimeout(20);
    }
    await expect
      .poll(async () => {
        const { scrollTop, maxScrollTop } = await readTranscriptScrollMetrics(transcriptRoot);
        return maxScrollTop - scrollTop;
      }, { timeout: 30_000 })
      .toBeGreaterThan(400);
    await page.waitForTimeout(250);
    await expect
      .poll(async () => {
        const { scrollTop, maxScrollTop } = await readTranscriptScrollMetrics(transcriptRoot);
        return maxScrollTop - scrollTop;
      }, { timeout: 10_000 })
      .toBeGreaterThan(300);

    // Prove we're unpinned by generating new activity and asserting the jump button appears.
    const unpinnedProbe = await runCliJson({
      testDir,
      cliHomeDir,
      serverUrl: server.baseUrl,
      webappUrl: uiBaseUrl,
      env: { ...process.env, HOME: cliHomeDir },
      label: 'session-send-mid-unpinned-probe',
      args: ['session', 'send', sessionMidId, `unpinned probe ${run.runId}`, '--json'],
      timeoutMs: 120_000,
    });
    expect(unpinnedProbe.ok).toBe(true);
    expect(unpinnedProbe.kind).toBe('session_send');
    await expect
      .poll(async () => {
        const { scrollTop, maxScrollTop } = await readTranscriptScrollMetrics(transcriptRoot);
        return maxScrollTop - scrollTop;
      }, { timeout: 60_000 })
      .toBeGreaterThan(300);
    await expect(page.getByTestId('transcript-jump-to-bottom')).toHaveCount(1, { timeout: 60_000 });

    await page.context().setOffline(true);
    await page.waitForTimeout(500);

    for (let i = 0; i < 3; i += 1) {
      const message = `missed mid-history ${i} ${run.runId}`;
      const sendEnvelope = await runCliJson({
        testDir,
        cliHomeDir,
        serverUrl: server.baseUrl,
        webappUrl: uiBaseUrl,
        env: { ...process.env, HOME: cliHomeDir },
        label: `session-send-mid-missed-${i}`,
        args: ['session', 'send', sessionMidId, message, '--json'],
        timeoutMs: 120_000,
      });
      expect(sendEnvelope.ok).toBe(true);
      expect(sendEnvelope.kind).toBe('session_send');
    }

    // Refresh pinned state right before reconnect (defensive against web scroll anchoring).
    const beforeReconnectScroll = await readTranscriptScrollMetrics(transcriptRoot);
    await setTranscriptScrollTop(transcriptRoot, Math.max(0, Math.trunc(beforeReconnectScroll.scrollTop - 50)));
    await page.waitForTimeout(50);
    await expect
      .poll(async () => {
        const { scrollTop, maxScrollTop } = await readTranscriptScrollMetrics(transcriptRoot);
        return maxScrollTop - scrollTop;
      }, { timeout: 5_000 })
      .toBeGreaterThan(300);

    const midReconnectStart = Date.now();
    await page.context().setOffline(false);

    // Reconnect should run, but message catch-up should be deferred while unpinned (no immediate `/messages` fetch).
    await expect
      .poll(
        async () => {
          const after = requests.filter((r) => r.ts >= midReconnectStart).map((r) => r.url);
          const hasChanges = after.some((u) => u.includes('/v2/changes'));
          const hasAnyMessagesFetch = after.some((u) => u.includes(`/v1/sessions/${sessionMidId}/messages`));
          return { hasChanges, hasAnyMessagesFetch, after };
        },
        { timeout: 60_000 },
      )
      .toMatchObject({ hasChanges: true, hasAnyMessagesFetch: false });

    // Scroll back down near the bottom (still unpinned, but within the configured prefetch threshold),
    // which should trigger forward pagination (`afterSeq`).
    const beforePrefetch = await readTranscriptScrollMetrics(transcriptRoot);
    await transcript.hover();
    // Move close to bottom without entering pinned range (72px). Keep re-reading maxScrollTop because
    // new activity can change content height while reconnect finishes applying changes.
    await transcript.dispatchEvent('wheel', { deltaX: 0, deltaY: 0, bubbles: true, cancelable: true });
    await expect
      .poll(async () => {
        const { maxScrollTop } = await readTranscriptScrollMetrics(transcriptRoot);
        await setTranscriptScrollTop(transcriptRoot, Math.max(0, Math.trunc(maxScrollTop - 100)));
        await page.waitForTimeout(50);
        const { scrollTop, maxScrollTop: nextMaxScrollTop } = await readTranscriptScrollMetrics(transcriptRoot);
        const distanceFromBottom = nextMaxScrollTop - scrollTop;
        return { distanceFromBottom, inRange: distanceFromBottom > 72 && distanceFromBottom <= 120 };
      }, { timeout: 20_000 })
      .toMatchObject({ inRange: true });

    await expect
      .poll(
        async () => {
          const after = requests.filter((r) => r.ts >= midReconnectStart).map((r) => r.url);
          return after.some((u) => u.includes(`/v1/sessions/${sessionMidId}/messages?`) && u.includes('afterSeq='));
        },
        { timeout: 60_000 },
      )
      .toBe(true);
  });
});
