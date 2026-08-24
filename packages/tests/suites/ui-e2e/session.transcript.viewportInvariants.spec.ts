import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { authenticateAndStartDaemon } from '../../src/testkit/uiE2e/authenticateAndStartDaemon';
import { createSessionFromNewSessionComposer } from '../../src/testkit/uiE2e/createSessionFromNewSessionComposer';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';

const run = createRunDirs({ runLabel: 'ui-e2e' });

/**
 * Transcript viewport single-owner invariants (plan §4 A/B/D/E/H, §5 G2) asserted against the
 * live web telemetry buffer `__HAPPIER_TRANSCRIPT_VIEWPORT_EVENTS__()`.
 *
 * Assertion semantics mirror `apps/ui/sources/dev/testkit/transcript/viewportTelemetryAssertions.ts`
 * (Lane 0.3). They are replicated minimally here because `@happier-dev/tests` cannot import
 * `apps/ui` modules (different package; tsconfig `@/*` maps to `apps/cli/src`).
 *
 * Web-specific deltas vs the UI harness:
 * - `scroll-observed` telemetry is native-only in ChatList, so "final write confirmed" (E3) is
 *   asserted via live DOM scroll metrics instead of telemetry observations.
 * - Telemetry is dev-build-gated (`__DEV__`), so this suite runs the Expo web bundle through
 *   metro in dev mode (`HAPPIER_E2E_UI_WEB_MODE=metro` + `HAPPIER_E2E_UI_WEB_NO_DEV=0`).
 * - The override global is installed via `page.addInitScript` BEFORE app load so it survives
 *   full-page navigations (a post-load `page.evaluate` override is wiped by `page.goto`).
 */

type ViewportTelemetryEvent = Readonly<{
  type: string;
  writer?: string;
  reason?: string;
  mode?: string;
  platform?: string;
  sessionId: string;
  targetOffsetY?: number;
  offsetY?: number;
  distanceFromBottom?: number;
  contentHeight?: number;
  layoutHeight?: number;
  trigger?: 'scroll' | 'edge-reached' | 'restore' | 'prepend-restore' | 'jump';
  domScrollTop?: number;
  domScrollHeight?: number;
  domClientHeight?: number;
  flashListContentHeight?: number;
  flashListLayoutHeight?: number;
  scrollable?: boolean;
  paginationPhase?: 'idle' | 'armed' | 'loading' | 'cooldown';
  paginationSuspendedReasons?: Array<'negative-offset' | 'transaction-open' | 'fill-not-done'>;
  coldCount?: number;
  hotCount?: number;
  firstVisibleAnchorTestId?: string;
  pendingWebPrependAnchorKind?: 'stable' | 'item' | 'none';
  pendingWebPrependAnchorId?: string;
  pendingWebPrependAnchorIndex?: number;
  programmaticWebWrite?: boolean;
  timestampMs: number;
}>;

type ViewportTelemetrySnapshot = Readonly<{
  events: ViewportTelemetryEvent[];
  droppedCount: number;
}>;

type TranscriptScrollMetrics = Readonly<{
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  distanceFromBottom: number;
}>;

type VisibleMessageAnchor = Readonly<{
  testId: string;
  rowTopRelativeToScroller: number;
}>;

// Mirrors WRITE_REASON_OWNERS in the Lane 0.3 harness.
const VIEWPORT_WRITE_REASON_OWNERS: Readonly<Record<string, 'entry' | 'prepend' | 'follow' | 'explicit'>> = {
  'initial-open': 'entry',
  'entry-restore': 'entry',
  'prepend-restore': 'prepend',
  'jump-to-bottom': 'explicit',
  'jump-to-seq': 'explicit',
  'stream-append': 'follow',
  'mount-settle': 'follow',
  'content-size-change': 'follow',
  'layout-change': 'follow',
};

// Mirrors TRANSACTION_OUTCOME_REASONS in the Lane 0.3 harness (post-FW4: `abandoned-ttl` was
// deleted from the telemetry union with the no-TTL prepend design).
const PREPEND_OUTCOME_REASONS: ReadonlySet<string> = new Set([
  'mvcp-preserved',
  'fallback-restored',
  'abandoned-layout-timeout',
  'abandoned-identity',
  'abandoned-user-scroll',
]);

// Mirrors TERMINAL_DECISION_REASONS in the Lane 0.3 harness, EXTENDED for web-trace semantics:
// every 'pending' restore decision must close with one of these (Lane E2 contract — web prepends
// emit restore-decision events, NOT native transaction outcomes, so web prepend traces are
// asserted via no-silent-bails). Web-only additions (`ChatList.tsx` recordWebPrependRestoreOutcome):
// 'observed' = the anchor held with NO scroll adjustment needed (browser scroll anchoring — the
// web success analog of mvcp-preserved), 'not-ready' = restore ran without usable metrics. Both
// are observable decisions, which is what never-silent (E5) requires; the native harness keeps
// them non-terminal because native prepend windows close via transaction outcomes only.
const TERMINAL_DECISION_REASONS: ReadonlySet<string> = new Set([
  ...PREPEND_OUTCOME_REASONS,
  'restored',
  'skipped',
  'missing-anchor',
  'entry-anchor-missing',
  'observed',
  'not-ready',
]);

function assertNoSilentBails(events: readonly ViewportTelemetryEvent[], label: string): void {
  const openPendingBySession = new Map<string, ViewportTelemetryEvent[]>();
  for (const event of events) {
    if (event.type !== 'restore-decision' || event.reason === undefined) continue;
    if (event.reason === 'pending') {
      const open = openPendingBySession.get(event.sessionId) ?? [];
      open.push(event);
      openPendingBySession.set(event.sessionId, open);
      continue;
    }
    if (TERMINAL_DECISION_REASONS.has(event.reason)) {
      openPendingBySession.get(event.sessionId)?.pop();
    }
  }
  const unclosed = [...openPendingBySession.values()].flat();
  if (unclosed.length > 0) {
    throw new Error(
      `Silent bail detected (${label}): ${unclosed.length} pending restore decision(s) without a terminal outcome:\n`
      + formatViewportEvents(unclosed),
    );
  }
}

// Mirrors DEFAULT_PIN_THRESHOLD_PX in the Lane 0.3 harness.
const PIN_THRESHOLD_PX = 72;
// Browser layout values can differ by one physical pixel after fractional CSS-pixel rounding.
// Anchor preservation is otherwise exact: proximity thresholds must never certify this contract.
const VIEWPORT_MEASUREMENT_ROUNDING_PX = 1;
// The cold-open initial /messages fetch sends NO limit, so the server returns its default cap
// (150, `registerSessionMessageRoutes.ts`) with an explicit `hasMore`. A session at or under the
// cap materializes ENTIRELY on open (hasMore=false) and `loadOlder` is deterministically no_more —
// no user-triggered older-page request can ever fire. Each seeded turn persists ~5 messages
// (user + agent events + assistant), so 35 turns + the initial turn ≈ 180 messages > 150, which
// guarantees real older pages remain after any cold open (observed live 2026-06-11: a 90-message
// seed made the prepend scenario impossible).
const SEED_TURN_COUNT = 35;

function describeViewportEvent(event: ViewportTelemetryEvent): string {
  const parts = [`t=${event.timestampMs}`, event.type];
  if (event.writer !== undefined) parts.push(`writer=${event.writer}`);
  if (event.reason !== undefined) parts.push(`reason=${event.reason}`);
  if (event.mode !== undefined) parts.push(`mode=${event.mode}`);
  if (event.targetOffsetY !== undefined) parts.push(`target=${event.targetOffsetY}`);
  if (event.offsetY !== undefined) parts.push(`offset=${event.offsetY}`);
  if (event.distanceFromBottom !== undefined) parts.push(`dfb=${event.distanceFromBottom}`);
  parts.push(`session=${event.sessionId}`);
  return parts.join(' ');
}

function formatViewportEvents(events: readonly ViewportTelemetryEvent[]): string {
  if (events.length === 0) return '  (no events)';
  return events.map((event) => `  - ${describeViewportEvent(event)}`).join('\n');
}

function hasViewportField(event: ViewportTelemetryEvent, field: keyof ViewportTelemetryEvent): boolean {
  return Object.prototype.hasOwnProperty.call(event, field);
}

function assertWebWregDiagnostics(events: readonly ViewportTelemetryEvent[], label: string): void {
  const offenders: Array<{ event: ViewportTelemetryEvent; missing: string[] }> = [];
  for (const event of events) {
    if (event.platform !== 'web') continue;
    if (event.type !== 'scroll-observed' && event.type !== 'restore-decision') continue;

    const required: Array<keyof ViewportTelemetryEvent> = [
      'trigger',
      'domScrollTop',
      'domScrollHeight',
      'domClientHeight',
      'flashListContentHeight',
      'flashListLayoutHeight',
      'scrollable',
      'distanceFromBottom',
      'paginationPhase',
      'paginationSuspendedReasons',
      'coldCount',
      'hotCount',
      'pendingWebPrependAnchorKind',
      'programmaticWebWrite',
    ];
    const missing = required.filter((field) => !hasViewportField(event, field)).map(String);
    if (
      event.pendingWebPrependAnchorKind !== undefined &&
      event.pendingWebPrependAnchorKind !== 'none'
    ) {
      if (!hasViewportField(event, 'pendingWebPrependAnchorId')) missing.push('pendingWebPrependAnchorId');
      if (!hasViewportField(event, 'pendingWebPrependAnchorIndex')) missing.push('pendingWebPrependAnchorIndex');
    }
    if (event.type === 'restore-decision' || event.trigger === 'restore' || event.trigger === 'prepend-restore') {
      if (!hasViewportField(event, 'firstVisibleAnchorTestId')) missing.push('firstVisibleAnchorTestId');
    }
    if (missing.length > 0) {
      offenders.push({ event, missing });
    }
  }

  if (offenders.length > 0) {
    throw new Error(
      `WREG telemetry diagnostics missing required web fields (${label}):\n`
      + offenders.map(({ event, missing }) =>
        `  - missing ${missing.join(', ')} :: ${describeViewportEvent(event)}`).join('\n'),
    );
  }
}

function committedScrollWrites(events: readonly ViewportTelemetryEvent[]): ViewportTelemetryEvent[] {
  return events.filter((event) => event.type === 'scroll-write' && event.writer !== 'mvcp-skip');
}

function distinctWriteTargets(writes: readonly ViewportTelemetryEvent[]): number {
  const targets = new Set<number | 'unknown'>();
  for (const write of writes) targets.add(write.targetOffsetY ?? 'unknown');
  return targets.size;
}

function assertTransactionOwnerTargetSpread(events: readonly ViewportTelemetryEvent[], label: string): void {
  const writesByOwner = new Map<string, ViewportTelemetryEvent[]>();
  for (const write of committedScrollWrites(events)) {
    const owner = VIEWPORT_WRITE_REASON_OWNERS[write.reason ?? ''] ?? null;
    if (owner === null || owner === 'follow') continue;
    const writes = writesByOwner.get(owner) ?? [];
    writes.push(write);
    writesByOwner.set(owner, writes);
  }
  for (const [owner, writes] of writesByOwner) {
    const targets = distinctWriteTargets(writes);
    if (targets > 2) {
      throw new Error(
        `Invariant G violated (${label}): owner '${owner}' wrote ${targets} distinct targets (max 2):\n`
        + formatViewportEvents(writes),
      );
    }
  }
}

async function installViewportTelemetryOverride(page: Page): Promise<void> {
  // MUST run before app load: init scripts re-apply on every full-page navigation, while a
  // post-load evaluate override is wiped by the next `page.goto` (plan §2 E10 audit evidence).
  await page.addInitScript(() => {
    (globalThis as Record<string, unknown>).__HAPPIER_TRANSCRIPT_VIEWPORT_TELEMETRY_OVERRIDE__ = {
      enabled: true,
      capacity: 5000,
    };
  });
}

async function readViewportTelemetrySnapshot(page: Page): Promise<ViewportTelemetrySnapshot | null> {
  return await page.evaluate(() => {
    const fn = (globalThis as Record<string, unknown>).__HAPPIER_TRANSCRIPT_VIEWPORT_EVENTS__;
    if (typeof fn !== 'function') return null;
    return (fn as () => { events: unknown[]; droppedCount: number })();
  }) as ViewportTelemetrySnapshot | null;
}

async function waitForViewportTelemetryReadable(page: Page, timeoutMs = 60_000): Promise<void> {
  try {
    await expect
      .poll(async () => (await readViewportTelemetrySnapshot(page)) !== null, { timeout: timeoutMs })
      .toBe(true);
  } catch {
    throw new Error([
      '__HAPPIER_TRANSCRIPT_VIEWPORT_EVENTS__ never became readable.',
      'The viewport telemetry override is dev-build-gated (__DEV__): this suite must run the web UI',
      'through metro in dev mode (HAPPIER_E2E_UI_WEB_MODE=metro, HAPPIER_E2E_UI_WEB_NO_DEV=0) and the',
      'override must be installed via page.addInitScript before app load.',
    ].join('\n'));
  }
}

async function waitForViewportTelemetryQuiescence(
  page: Page,
  options?: Readonly<{ settleMs?: number; timeoutMs?: number }>,
): Promise<ViewportTelemetrySnapshot> {
  const settleMs = options?.settleMs ?? 1_500;
  const timeoutMs = options?.timeoutMs ?? 60_000;
  const startedAt = Date.now();
  let lastCount = -1;
  let stableSinceMs = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = await readViewportTelemetrySnapshot(page);
    const count = snapshot?.events.length ?? -1;
    if (count !== lastCount) {
      lastCount = count;
      stableSinceMs = Date.now();
    } else if (snapshot !== null && Date.now() - stableSinceMs >= settleMs) {
      return snapshot;
    }
    await page.waitForTimeout(250);
  }
  const snapshot = await readViewportTelemetrySnapshot(page);
  if (!snapshot) throw new Error('viewport telemetry never became readable while waiting for quiescence');
  return snapshot;
}

async function readTranscriptScrollMetrics(page: Page): Promise<TranscriptScrollMetrics | null> {
  return await page.evaluate(() => {
    const root = document.querySelector('[data-testid="transcript-chat-list"]');
    if (!root) return null;
    const candidates: Element[] = [root, ...Array.from(root.querySelectorAll('*'))];
    let ancestor: Element | null = root.parentElement;
    for (let depth = 0; ancestor && depth < 6; depth += 1) {
      candidates.push(ancestor);
      ancestor = ancestor.parentElement;
    }
    let best: Element | null = null;
    for (const el of candidates) {
      if (el.scrollHeight > el.clientHeight + 1 && el.clientHeight > 0) {
        if (!best || el.scrollHeight > best.scrollHeight) best = el;
      }
    }
    if (!best) return null;
    const scrollTop = best.scrollTop;
    const scrollHeight = best.scrollHeight;
    const clientHeight = best.clientHeight;
    return {
      scrollTop,
      scrollHeight,
      clientHeight,
      distanceFromBottom: scrollHeight - clientHeight - scrollTop,
    };
  });
}

async function requireTranscriptScrollMetrics(page: Page): Promise<TranscriptScrollMetrics> {
  const metrics = await readTranscriptScrollMetrics(page);
  if (!metrics) throw new Error('failed to resolve a scrollable transcript element under transcript-chat-list');
  return metrics;
}

async function readTopVisibleMessageAnchor(page: Page): Promise<VisibleMessageAnchor | null> {
  return await page.evaluate(() => {
    const root = document.querySelector('[data-testid="transcript-chat-list"]');
    if (!root) return null;
    const candidates: Element[] = [root, ...Array.from(root.querySelectorAll('*'))];
    let ancestor: Element | null = root.parentElement;
    for (let depth = 0; ancestor && depth < 6; depth += 1) {
      candidates.push(ancestor);
      ancestor = ancestor.parentElement;
    }
    let scroller: Element | null = null;
    for (const element of candidates) {
      if (element.scrollHeight > element.clientHeight + 1 && element.clientHeight > 0) {
        if (!scroller || element.scrollHeight > scroller.scrollHeight) scroller = element;
      }
    }
    if (!scroller) return null;

    const scrollerRect = scroller.getBoundingClientRect();
    const nodes = Array.from(root.querySelectorAll('[data-testid^="transcript-message-"]'));
    let best: { testId: string; rowTopRelativeToScroller: number } | null = null;
    for (const node of nodes) {
      const rect = node.getBoundingClientRect();
      if (rect.height <= 0) continue;
      if (rect.bottom <= scrollerRect.top || rect.top >= scrollerRect.bottom) continue;
      const testId = node.getAttribute('data-testid');
      const messageId = testId?.slice('transcript-message-'.length) ?? '';
      if (!testId || !messageId || messageId.includes(':')) continue;
      const rowTopRelativeToScroller = rect.top - scrollerRect.top;
      if (!best || rowTopRelativeToScroller < best.rowTopRelativeToScroller) {
        best = { testId, rowTopRelativeToScroller };
      }
    }
    return best;
  });
}

async function readMessageAnchorTopRelativeToScroller(page: Page, testId: string): Promise<number | null> {
  return await page.evaluate((id) => {
    const root = document.querySelector('[data-testid="transcript-chat-list"]');
    if (!root) return null;
    const candidates: Element[] = [root, ...Array.from(root.querySelectorAll('*'))];
    let ancestor: Element | null = root.parentElement;
    for (let depth = 0; ancestor && depth < 6; depth += 1) {
      candidates.push(ancestor);
      ancestor = ancestor.parentElement;
    }
    let scroller: Element | null = null;
    for (const element of candidates) {
      if (element.scrollHeight > element.clientHeight + 1 && element.clientHeight > 0) {
        if (!scroller || element.scrollHeight > scroller.scrollHeight) scroller = element;
      }
    }
    if (!scroller) return null;
    const node = document.querySelector(`[data-testid="${id}"]`);
    if (!node) return null;
    return node.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  }, testId);
}

async function wheelOverTranscript(page: Page, deltaY: number): Promise<void> {
  const transcript = page.locator('[data-testid="transcript-chat-list"]:visible').first();
  await transcript.hover({ timeout: 60_000 });
  await page.mouse.wheel(0, deltaY);
}

function seedMessageText(index: number, runId: string): string {
  const filler = 'scrollable transcript viewport seed content that wraps across many lines on a phone-width layout '.repeat(6);
  return `SEED_MARKER_${index} ${runId} ${filler}`.trim();
}

test.describe('ui e2e: transcript viewport invariants', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('session-transcript-viewport-invariants-suite');
  const cliHomeDir = resolve(join(suiteDir, 'cli-home'));

  let server: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let uiBaseUrl: string | null = null;
  let daemon: StartedDaemon | null = null;
  let accountSecretKeyFormatted: string | null = null;
  let sessionId: string | null = null;

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

  async function readAccountSecretKeyFromSettings(page: Page, baseUrl: string): Promise<string> {
    await page.goto(`${baseUrl}/settings/account`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('settings-account-secret-key-item')).toHaveCount(1, { timeout: 60_000 });
    await page.getByTestId('settings-account-secret-key-item').click();
    await expect(page.getByTestId('settings-account-secret-key-value')).toHaveCount(1, { timeout: 60_000 });
    const value = (await page.getByTestId('settings-account-secret-key-value').innerText()).trim();
    if (!value) throw new Error('settings-account-secret-key-value is empty');
    return value.replace(/\s+/g, ' ');
  }

  async function restoreAccountUsingSecretKey(page: Page, baseUrl: string, secretKeyFormatted: string): Promise<void> {
    await gotoDomContentLoadedWithRetries(page, baseUrl);
    const welcomeRestore = page.getByTestId('welcome-restore');
    if ((await welcomeRestore.count()) > 0) {
      await welcomeRestore.click();
    } else {
      await gotoDomContentLoadedWithRetries(page, `${baseUrl}/restore/manual`);
    }

    const openManual = page.getByTestId('restore-open-manual');
    if ((await openManual.count()) > 0) {
      await openManual.click();
    }

    await page.getByTestId('restore-manual-secret-input').fill(secretKeyFormatted);
    const authOk = page.waitForResponse((resp) => resp.url().endsWith('/v1/auth') && resp.status() === 200, { timeout: 60_000 });
    await page.getByTestId('restore-manual-submit').click();
    await authOk;
    await page.waitForURL((url) => !url.pathname.endsWith('/restore/manual'), { timeout: 60_000 });
  }

  async function openSeededSessionColdAndSettle(page: Page): Promise<ViewportTelemetrySnapshot> {
    if (!uiBaseUrl || !sessionId || !accountSecretKeyFormatted) throw new Error('missing seeded session fixtures');
    await installViewportTelemetryOverride(page);
    await restoreAccountUsingSecretKey(page, uiBaseUrl, accountSecretKeyFormatted);
    // Full-page navigation: a fresh JS context whose telemetry trace starts at app boot — this is
    // the cold-open trace (and also proves the init-script override survives full navigations).
    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/session/${sessionId}`);
    await expect(page.getByTestId('transcript-chat-list')).toHaveCount(1, { timeout: 120_000 });
    await waitForViewportTelemetryReadable(page);
    return await waitForViewportTelemetryQuiescence(page);
  }

  async function sendSeedPromptAndWaitForOk(page: Page, prompt: string, okNumber: number): Promise<void> {
    const composer = page.locator('textarea[data-testid="session-composer-input"]:visible');
    await composer.fill(prompt);
    await composer.press('Enter');
    await expect(page.getByText(`FAKE_CLAUDE_OK_${okNumber}`).first()).toBeVisible({ timeout: 180_000 });
  }

  test.beforeAll(async () => {
    const uiWebEnv = {
      ...process.env,
      EXPO_PUBLIC_DEBUG: '1',
      EXPO_PUBLIC_HAPPY_SERVER_URL: '',
      EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-${run.runId}`,
      // Viewport telemetry (and its debug override) are dev-build-gated.
      HAPPIER_E2E_UI_WEB_MODE: 'metro',
      HAPPIER_E2E_UI_WEB_NO_DEV: '0',
      HAPPIER_E2E_UI_WEB_BASE_URL_TIMEOUT_MS: process.env.HAPPIER_E2E_UI_WEB_BASE_URL_TIMEOUT_MS ?? '480000',
      HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_TIMEOUT_MS: process.env.HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_TIMEOUT_MS ?? '480000',
      // Small message pages so the seed leaves older pages to prepend; immediate older-load
      // spinner so invariant H's loading indicator is observable. The initial-fill budget is
      // tightened because the entry fill loop legitimately pages older content until the list is
      // observed scrollable (web measurement can lag a beat) — with the prepend scenario's 700ms
      // older-response delay, a 1200ms budget bounds entry drain to ≤2 pages, so a 6-message page
      // size (36 seeded messages = 5 older pages) always leaves ≥3 pages for the user-triggered
      // prepend (premise observed drained live 2026-06-11 with pageSize 12 + default 2000ms budget).
      EXPO_PUBLIC_HAPPIER_SYNC_TUNING_JSON: JSON.stringify({
        sessionMessagesPageSize: 6,
        transcriptInitialFillBudgetMs: 1200,
        transcriptBackwardPrefetchThresholdPx: 300,
        transcriptOlderLoadSpinnerDelayMs: 0,
      }),
    };
    test.setTimeout(resolveUiWebBeforeAllTimeoutMs(uiWebEnv));
    await mkdir(cliHomeDir, { recursive: true });

    server = await startServerLight({
      testDir: suiteDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_BUILD_FEATURES_DENY: 'sharing.contentKeys,providers.claude.unifiedTerminal',
        HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
        HAPPIER_PRESENCE_SESSION_TIMEOUT_MS: '60000',
        HAPPIER_PRESENCE_MACHINE_TIMEOUT_MS: '60000',
        HAPPIER_PRESENCE_TIMEOUT_TICK_MS: '1000',
      },
    });

    ui = await startUiWeb({
      testDir: suiteDir,
      env: {
        ...uiWebEnv,
        EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl,
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

  test('runtime guard: requestAnimationFrame ticks within 400ms (plan E10)', async ({ page }) => {
    test.setTimeout(420_000);
    if (!uiBaseUrl) throw new Error('missing ui fixtures');

    await gotoDomContentLoadedWithRetries(page, uiBaseUrl);
    const rafTicked = await page.evaluate(async () => {
      return await new Promise<boolean>((resolvePromise) => {
        const timer = setTimeout(() => resolvePromise(false), 400);
        requestAnimationFrame(() => {
          clearTimeout(timer);
          resolvePromise(true);
        });
      });
    });

    if (!rafTicked) {
      throw new Error([
        'RENDERING-PAUSED TAB TRAP (plan §2 E10): requestAnimationFrame did not tick within 400ms.',
        'This automation tab has rAF throttled/frozen (background/occluded tab). The transcript',
        'initial-fill loop awaits rAF, so EVERY scroll/viewport assertion in this suite would produce',
        'false failures. Fix the runner environment (foreground/headed tab, no throttling) before',
        'trusting web transcript viewport QA. The remaining tests in this serial suite are skipped.',
      ].join('\n'));
    }
  });

  test('seeds a session past the initial-fetch cap and viewport telemetry is readable', async ({ page }) => {
    test.setTimeout(720_000);
    if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

    await installViewportTelemetryOverride(page);

    const testDir = resolve(join(suiteDir, 't1-seed'));
    await mkdir(testDir, { recursive: true });

    const fakeClaudePath = fakeClaudeFixturePath();
    const fakeClaudeLogPath = resolve(join(testDir, 'fake-claude.jsonl'));
    daemon = await authenticateAndStartDaemon({
      page,
      testDir,
      cliHomeDir,
      serverUrl: server.baseUrl,
      uiBaseUrl,
      extraEnv: {
        HOME: cliHomeDir,
        HAPPIER_CLAUDE_PATH: fakeClaudePath,
        HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeClaudeLogPath,
        HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: `fake-claude-session-${run.runId}`,
        HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID: `fake-claude-invocation-${run.runId}`,
      },
    });

    accountSecretKeyFormatted = await readAccountSecretKeyFromSettings(page, uiBaseUrl);

    const machineId = await waitForLatestMachineId({ suiteDir, timeoutMs: 120_000 });
    sessionId = await createSessionFromNewSessionComposer({
      page,
      uiBaseUrl,
      machineId,
      prompt: seedMessageText(0, run.runId),
    });

    await expect(page.getByTestId('transcript-chat-list')).toHaveCount(1, { timeout: 120_000 });
    await expect(page.getByText('FAKE_CLAUDE_OK_1').first()).toBeVisible({ timeout: 180_000 });

    // Each turn persists ~5 messages: 1 + SEED_TURN_COUNT turns => ~180 messages total, exceeding
    // the server's 150-message no-limit initial-fetch cap so older-page prepends stay reachable
    // (see the SEED_TURN_COUNT comment).
    for (let i = 1; i <= SEED_TURN_COUNT; i += 1) {
      await sendSeedPromptAndWaitForOk(page, seedMessageText(i, run.runId), i + 1);
    }

    // Infrastructure strictness: the dev-gated telemetry buffer must be readable and capturing.
    await waitForViewportTelemetryReadable(page);
    const snapshot = await readViewportTelemetrySnapshot(page);
    if (!snapshot) throw new Error('viewport telemetry snapshot unavailable after seeding');
    expect(snapshot.events.length).toBeGreaterThan(0);
  });

  function assertColdOpenWriteBudget(snapshot: ViewportTelemetrySnapshot): void {
    // Post-F refinement: the quiescence-settled trace inevitably extends past the entry phase
    // into steady-state follow. Invariant A governs the ENTRY window: entry-owned writes stay
    // within {initial-open, mount-settle} and the ≤2 budget; zero prepend/explicit writes; any
    // follow writes after entry must keep the viewport pinned at the bottom (invariant F shape —
    // late DOM growth repins are follow-owned and bottom-bound, never an entry re-issue storm).
    const writes = committedScrollWrites(snapshot.events);
    const entryWrites = writes.filter((event) => event.reason === 'initial-open' || event.reason === 'mount-settle');
    if (entryWrites.length > 2) {
      throw new Error(
        `Invariant A violated: cold open issued ${entryWrites.length} entry writes (max 2):\n`
        + formatViewportEvents(entryWrites),
      );
    }
    const disallowed = writes.filter((event) => {
      const owner = VIEWPORT_WRITE_REASON_OWNERS[event.reason ?? ''] ?? null;
      if (event.reason === 'initial-open' || event.reason === 'mount-settle') return false;
      if (owner === 'follow') {
        // Follow repins during cold open must land at (or track) the bottom.
        return event.distanceFromBottom !== undefined && event.distanceFromBottom > PIN_THRESHOLD_PX;
      }
      return true;
    });
    if (disallowed.length > 0) {
      throw new Error(
        'Invariant A violated: cold open issued non-entry writes outside bottom-bound follow repins:\n'
        + formatViewportEvents(disallowed),
      );
    }
  }

  test('cold open: captures telemetry, bounded owner targets, lands at bottom (invariant A infra)', async ({ page }) => {
    test.setTimeout(420_000);

    const snapshot = await openSeededSessionColdAndSettle(page);
    expect(snapshot.droppedCount).toBe(0);
    expect(committedScrollWrites(snapshot.events).length).toBeGreaterThan(0);
    assertTransactionOwnerTargetSpread(snapshot.events, 'cold open');

    // Web emits no scroll-observed telemetry, so confirm the final landing position from the DOM.
    const metrics = await requireTranscriptScrollMetrics(page);
    expect(
      metrics.distanceFromBottom,
      `cold open settled at distanceFromBottom=${metrics.distanceFromBottom} (pin threshold ${PIN_THRESHOLD_PX})`,
    ).toBeLessThanOrEqual(PIN_THRESHOLD_PX);
  });

  test('cold open: bounded entry writes, only bottom-bound follow repins beyond (invariant A strict)', async ({ page }) => {
    test.setTimeout(420_000);

    const snapshot = await openSeededSessionColdAndSettle(page);
    expect(snapshot.droppedCount).toBe(0);
    assertColdOpenWriteBudget(snapshot);
    assertTransactionOwnerTargetSpread(snapshot.events, 'cold open');
  });

  test('manual scroll without pagination produces zero viewport writes (invariant E)', async ({ page }) => {
    test.setTimeout(420_000);
    if (!sessionId) throw new Error('missing seeded session fixtures');

    const olderPageRequests: string[] = [];
    page.on('request', (request) => {
      const url = request.url();
      if (url.includes(`/v1/sessions/${sessionId}/messages?`) && url.includes('beforeSeq=')) {
        olderPageRequests.push(url);
      }
    });

    const settled = await openSeededSessionColdAndSettle(page);
    const baselineCount = settled.events.length;
    // Initial-fill may legitimately page older messages during entry; the premise check below only
    // covers the manual-scroll phase.
    olderPageRequests.length = 0;

    const beforeMetrics = await requireTranscriptScrollMetrics(page);
    // Keep the wheel travel well below the loaded window's top-prefetch threshold so this stays a
    // pure manual scroll (no pagination, invariant E premise).
    const upTravel = Math.min(450, Math.max(120, Math.trunc(beforeMetrics.scrollTop / 3)));
    await wheelOverTranscript(page, -upTravel);
    await page.waitForTimeout(400);
    await wheelOverTranscript(page, Math.trunc(upTravel / 2));
    await page.waitForTimeout(400);
    await wheelOverTranscript(page, -Math.trunc(upTravel / 3));
    const snapshot = await waitForViewportTelemetryQuiescence(page);

    if (olderPageRequests.length > 0) {
      throw new Error(
        'Manual-scroll scenario premise violated: an older-page request fired during the scroll '
        + `(loaded window too short for the configured threshold). Requests:\n  ${olderPageRequests.join('\n  ')}`,
      );
    }

    expect(snapshot.droppedCount).toBe(0);
    const phaseEvents = snapshot.events.slice(baselineCount);
    const writes = committedScrollWrites(phaseEvents);
    if (writes.length > 0) {
      throw new Error(
        `Invariant E violated: manual scroll produced ${writes.length} viewport write(s) (expected 0):\n`
        + formatViewportEvents(writes),
      );
    }
  });

  test('warm reopen restores the anchor with one bounded entry transaction (invariant B)', async ({ page }) => {
    test.setTimeout(420_000);
    if (!uiBaseUrl || !sessionId || !accountSecretKeyFormatted) throw new Error('missing seeded session fixtures');

    await installViewportTelemetryOverride(page);
    await restoreAccountUsingSecretKey(page, uiBaseUrl, accountSecretKeyFormatted);

    // Enter from the session list so the in-app back navigation below has history to return to.
    await gotoDomContentLoadedWithRetries(page, uiBaseUrl);
    const listItem = page.getByTestId(`session-list-item-${sessionId}`);
    await expect(listItem).toBeVisible({ timeout: 120_000 });
    await listItem.click();
    await expect(page.getByTestId('transcript-chat-list')).toHaveCount(1, { timeout: 120_000 });
    await waitForViewportTelemetryReadable(page);
    await waitForViewportTelemetryQuiescence(page);

    // Scroll away from the bottom so the reopen has a remembered mid-transcript anchor, then give
    // the debounced anchor capture time to flush before leaving the session.
    const beforeMetrics = await requireTranscriptScrollMetrics(page);
    await wheelOverTranscript(page, -Math.min(600, Math.max(200, Math.trunc(beforeMetrics.scrollTop / 2))));
    await page.waitForTimeout(2_500);
    const anchorMetrics = await requireTranscriptScrollMetrics(page);
    const anchorProbe = await readTopVisibleMessageAnchor(page);
    if (!anchorProbe) {
      throw new Error(
        'Invariant B premise violated: warm reopen requires a non-null keyed logical-row probe',
      );
    }

    const baseline = await readViewportTelemetrySnapshot(page);
    if (!baseline) throw new Error('viewport telemetry unavailable before reopen');
    const baselineCount = baseline.events.length;

    // A → list → A without a full page load: the telemetry buffer survives, so the slice after
    // `baselineCount` is exactly the reopen entry trace.
    await page.getByTestId('session-header-back').click();
    await expect(page.getByTestId(`session-list-item-${sessionId}`)).toBeVisible({ timeout: 60_000 });
    await page.getByTestId(`session-list-item-${sessionId}`).click();
    await expect(page.getByTestId('transcript-chat-list')).toHaveCount(1, { timeout: 120_000 });
    const snapshot = await waitForViewportTelemetryQuiescence(page);

    expect(snapshot.droppedCount).toBe(0);
    const entryEvents = snapshot.events.slice(baselineCount);
    const writes = committedScrollWrites(entryEvents);

    const prependWrites = writes.filter((event) => VIEWPORT_WRITE_REASON_OWNERS[event.reason ?? ''] === 'prepend');
    if (prependWrites.length > 0) {
      throw new Error(
        'Invariant B violated (E2 regression): prepend writes issued during entry restore:\n'
        + formatViewportEvents(prependWrites),
      );
    }

    const entryWrites = writes.filter((event) => VIEWPORT_WRITE_REASON_OWNERS[event.reason ?? ''] === 'entry');
    const distinctTargets = distinctWriteTargets(entryWrites);
    if (entryWrites.length > 2 || distinctTargets > 2) {
      throw new Error(
        `Invariant B violated (E1 regression): entry transaction wrote ${entryWrites.length} write(s) `
        + `with ${distinctTargets} distinct target(s) (max 2 each — no re-issue storm):\n`
        + formatViewportEvents(entryWrites),
      );
    }
    assertTransactionOwnerTargetSpread(entryEvents, 'warm reopen');
    assertNoSilentBails(entryEvents, 'warm reopen');

    // Final position preserves the exact logical row and its row-relative coordinate. Absolute
    // scrollTop may change as rows above remeasure, but that is never a fallback pass condition.
    const reopenedMetrics = await requireTranscriptScrollMetrics(page);
    const afterTop = await readMessageAnchorTopRelativeToScroller(page, anchorProbe.testId);
    if (afterTop === null) {
      throw new Error(
        `Invariant B violated: the pre-reopen top visible message ${anchorProbe.testId} is not in `
        + 'the DOM after the reopen (anchor content lost)',
      );
    }
    const anchorTopDeltaPx = Math.abs(afterTop - anchorProbe.rowTopRelativeToScroller);
    if (anchorTopDeltaPx > VIEWPORT_MEASUREMENT_ROUNDING_PX) {
      throw new Error(
        `Invariant B violated: reopen shifted keyed row ${anchorProbe.testId} by ${anchorTopDeltaPx}px `
        + `(allowed rounding ${VIEWPORT_MEASUREMENT_ROUNDING_PX}px; row-relative top before=`
        + `${anchorProbe.rowTopRelativeToScroller}, after=${afterTop}; scrollTop before=`
        + `${anchorMetrics.scrollTop}, after=${reopenedMetrics.scrollTop})`,
      );
    }

    // Scenario isolation: leave the stored viewport at the BOTTOM so the next test's cold open
    // does not inherit this test's mid-transcript anchor. A deep remembered anchor makes the next
    // entry restore paginate/materialize older pages during its own entry phase, which can drain
    // the whole seeded backlog and destroy the prepend scenario's premise (observed 2026-06-11:
    // the D/H scenario timed out because nothing was left to load on user scroll).
    const finalMetrics = await requireTranscriptScrollMetrics(page);
    await wheelOverTranscript(page, finalMetrics.scrollHeight);
    await page.waitForTimeout(2_500);
    const bottomMetrics = await requireTranscriptScrollMetrics(page);
    expect(
      bottomMetrics.distanceFromBottom,
      'scenario-isolation tail: failed to return the warm-reopen session to the bottom before exit',
    ).toBeLessThanOrEqual(PIN_THRESHOLD_PX);
  });

  test('exact-top older-page prepend: two successive pages preserve one keyed row exactly (invariants D/H)', async ({ page }) => {
    test.setTimeout(420_000);
    if (!sessionId) throw new Error('missing seeded session fixtures');

    const isOlderPageRequest = (url: string): boolean =>
      url.includes(`/v1/sessions/${sessionId}/messages?`) && url.includes('beforeSeq=');

    // Delay older-page responses so the in-flight window (and the loading overlay) is observable.
    await page.route((url) => isOlderPageRequest(url.href), async (route) => {
      await new Promise((r) => setTimeout(r, 700));
      await route.continue();
    });

    let inFlightOlderRequests = 0;
    let maxConcurrentOlderRequests = 0;
    let olderRequestCount = 0;
    let olderRequestsSettled = 0;
    const startedAtMs = Date.now();
    const messagesRequestLog: string[] = [];
    page.on('request', (request) => {
      const url = request.url();
      if (sessionId && url.includes(`/v1/sessions/${sessionId}/messages`)) {
        messagesRequestLog.push(`+${Date.now() - startedAtMs}ms ${url}`);
      }
      if (!isOlderPageRequest(url)) return;
      olderRequestCount += 1;
      inFlightOlderRequests += 1;
      maxConcurrentOlderRequests = Math.max(maxConcurrentOlderRequests, inFlightOlderRequests);
    });
    const settleOlderRequest = (url: string) => {
      if (!isOlderPageRequest(url)) return;
      inFlightOlderRequests = Math.max(0, inFlightOlderRequests - 1);
      olderRequestsSettled += 1;
    };
    page.on('requestfinished', (request) => settleOlderRequest(request.url()));
    page.on('requestfailed', (request) => settleOlderRequest(request.url()));

    const settled = await openSeededSessionColdAndSettle(page);
    const baselineCount = settled.events.length;
    // Initial-fill may legitimately page older messages during entry; rebase the request counters
    // so the assertions below only cover the user-triggered prepend phase.
    olderRequestCount = 0;
    olderRequestsSettled = 0;
    maxConcurrentOlderRequests = inFlightOlderRequests;
    const beforeMetrics = await requireTranscriptScrollMetrics(page);

    // Scenario premise: at least one older page must still be unloaded, or the wheel below can
    // never trigger a prepend (the 60s request poll would time out with a misleading failure).
    // The oldest seed message being absent from the DOM proves an older page remains.
    const oldestSeedLoaded = await page
      .getByText(`SEED_MARKER_0 ${run.runId}`, { exact: false })
      .count();
    if (oldestSeedLoaded > 0) {
      throw new Error(
        'Prepend scenario premise violated: the OLDEST seeded message is already loaded after the '
        + 'cold open settled, so no older page remains to prepend. The entry phase drained the '
        + 'seeded backlog. Session /messages requests observed since page open:\n  '
        + (messagesRequestLog.length > 0 ? messagesRequestLog.join('\n  ') : '(none — messages arrived outside HTTP /messages)'),
      );
    }

    // Reach the exact physical older edge with trusted wheel input. The delayed response leaves a
    // deterministic window to capture the logical row before either prepend materializes.
    await wheelOverTranscript(page, -(beforeMetrics.scrollTop + beforeMetrics.clientHeight));
    await expect
      .poll(async () => Math.abs((await requireTranscriptScrollMetrics(page)).scrollTop), { timeout: 10_000 })
      .toBeLessThanOrEqual(VIEWPORT_MEASUREMENT_ROUNDING_PX);
    const anchorProbe = await readTopVisibleMessageAnchor(page);
    if (!anchorProbe) {
      throw new Error(
        'Prepend scenario premise violated: exact-top activation requires a non-null keyed logical-row probe',
      );
    }
    await expect
      .poll(() => olderRequestCount, { timeout: 60_000 })
      .toBeGreaterThan(0);

    // Invariant H: a user-triggered older load in flight shows the loading indicator.
    await expect(
      page.getByTestId('transcript-older-load-progress-overlay'),
      'invariant H: older-load progress overlay must be visible while the load is in flight',
    ).toBeVisible({ timeout: 5_000 });

    await expect.poll(() => olderRequestsSettled, { timeout: 60_000 }).toBeGreaterThanOrEqual(1);
    await expect
      .poll(async () => (await requireTranscriptScrollMetrics(page)).scrollHeight, { timeout: 60_000 })
      .toBeGreaterThan(beforeMetrics.scrollHeight);
    const firstPageMetrics = await requireTranscriptScrollMetrics(page);
    const afterFirstPageTop = await readMessageAnchorTopRelativeToScroller(page, anchorProbe.testId);
    if (afterFirstPageTop === null) {
      throw new Error(`prepend anchor probe ${anchorProbe.testId} disappeared after the first prepend`);
    }
    expect(
      Math.abs(afterFirstPageTop - anchorProbe.rowTopRelativeToScroller),
      `first prepend shifted keyed row ${anchorProbe.testId}`,
    ).toBeLessThanOrEqual(VIEWPORT_MEASUREMENT_ROUNDING_PX);

    // One exact-top activation must permit a second sequential materialization without another
    // user movement. This rejects the reproduced "first page looked stable, second page lost the
    // row while scrollTop stayed zero" failure.
    await expect.poll(() => olderRequestCount, { timeout: 60_000 }).toBeGreaterThanOrEqual(2);
    await expect(
      page.getByTestId('transcript-older-load-progress-overlay'),
      'invariant H: progress overlay must remain observable for the second sequential older load',
    ).toBeVisible({ timeout: 5_000 });
    await expect.poll(() => olderRequestsSettled, { timeout: 60_000 }).toBeGreaterThanOrEqual(2);
    await expect
      .poll(async () => (await requireTranscriptScrollMetrics(page)).scrollHeight, { timeout: 60_000 })
      .toBeGreaterThan(firstPageMetrics.scrollHeight);
    const snapshot = await waitForViewportTelemetryQuiescence(page);

    // Invariant H: never more than one user-triggered older page in flight.
    expect(
      maxConcurrentOlderRequests,
      `invariant H: ${maxConcurrentOlderRequests} older-page requests were in flight concurrently (max 1)`,
    ).toBeLessThanOrEqual(1);

    const afterSecondPageTop = await readMessageAnchorTopRelativeToScroller(page, anchorProbe.testId);
    if (afterSecondPageTop === null) {
      throw new Error(`prepend anchor probe ${anchorProbe.testId} disappeared after the second prepend`);
    }
    expect(
      Math.abs(afterSecondPageTop - anchorProbe.rowTopRelativeToScroller),
      `second prepend shifted keyed row ${anchorProbe.testId}`,
    ).toBeLessThanOrEqual(VIEWPORT_MEASUREMENT_ROUNDING_PX);

    expect(snapshot.droppedCount).toBe(0);
    const phaseEvents = snapshot.events.slice(baselineCount);

    // Invariant D on WEB (Lane E2 / FW5 ledger contract): the native prepend transaction does not
    // run on web — the KEEP web prepend system emits restore-decision events ('pending' on capture,
    // closed by a terminal reason). Assert never-silent via no-silent-bails instead of counting
    // native transaction outcomes (scenario-D counting is native-only).
    const pendingPrependDecisions = phaseEvents.filter(
      (event) => event.type === 'restore-decision' && event.reason === 'pending',
    );
    const terminalPrependDecisions = phaseEvents.filter(
      (event) => event.type === 'restore-decision' && event.reason !== undefined
        && TERMINAL_DECISION_REASONS.has(event.reason),
    );
    if (pendingPrependDecisions.length < 2 || terminalPrependDecisions.length < 2) {
      const prependWrites = committedScrollWrites(phaseEvents)
        .filter((event) => VIEWPORT_WRITE_REASON_OWNERS[event.reason ?? ''] === 'prepend');
      throw new Error(
        'Invariant D violated: both completed prepends require pending plus terminal restore decisions. '
        + `Observed ${olderRequestCount} older-page request(s), ${pendingPrependDecisions.length} pending `
        + `decision(s), ${terminalPrependDecisions.length} terminal decision(s), and `
        + `${prependWrites.length} prepend write(s):\n`
        + formatViewportEvents(committedScrollWrites(phaseEvents)),
      );
    }
    assertNoSilentBails(phaseEvents, 'prepend');
    assertWebWregDiagnostics(phaseEvents, 'prepend');
    assertTransactionOwnerTargetSpread(phaseEvents, 'prepend');
  });
});
