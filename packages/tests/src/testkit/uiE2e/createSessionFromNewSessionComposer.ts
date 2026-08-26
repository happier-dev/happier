import { expect, type Page } from '@playwright/test';

import { gotoDomContentLoadedWithPathFallback, gotoDomContentLoadedWithRetries } from './pageNavigation';

export type CreateSessionFromNewSessionComposerReadiness = 'route' | 'first-turn-reload-safe';

export type CreatedSessionFromNewSessionComposer = Readonly<{
  sessionId: string;
  sessionHref: string;
}>;

type CreateSessionFromNewSessionComposerParams = Readonly<{
  page: Page;
  uiBaseUrl: string;
  machineId: string;
  prompt: string;
  readiness?: CreateSessionFromNewSessionComposerReadiness;
}>;

type MachineSelectionOpenResult = 'picker_open' | 'returned_to_new';

const COMMITTED_TRANSCRIPT_MESSAGE_SELECTOR = '[data-testid^="transcript-message-"]:not([data-testid*=":"])';

function normalizePathname(input: string): string {
  try {
    const pathname = new URL(input).pathname.replace(/\/+$/, '');
    return pathname || '/';
  } catch {
    return '/';
  }
}

async function waitForCount(
  page: Page,
  locator: { count: () => Promise<number> },
  expectedCount: number,
  timeoutMs: number,
  pollIntervalMs = 250,
): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if ((await locator.count()) === expectedCount) {
      return true;
    }
    await page.waitForTimeout(pollIntervalMs);
  }
  return (await locator.count()) === expectedCount;
}

function machineOptionLocator(page: Page) {
  return page.locator('[data-testid^="new-session-machine:"]:visible, [data-testid^="new-session-machine-option:"]:visible');
}

type MachineClickResult = 'clicked' | 'absent' | 'present_not_actionable';

async function clickFirstMachineMatch(page: Page, machineId: string): Promise<MachineClickResult> {
  const exact = page.locator(
    `[data-testid="new-session-machine:${machineId}"]:visible, [data-testid="new-session-machine-option:${machineId}"]:visible`,
  );
  if ((await exact.count()) === 0) {
    return 'absent';
  }

  const clickTarget =
    typeof (exact as { first?: () => { click: (options?: { timeout?: number; force?: boolean }) => Promise<void> } }).first === 'function'
      ? (exact as { first: () => { click: (options?: { timeout?: number; force?: boolean }) => Promise<void> } }).first()
      : (exact as { click: (options?: { timeout?: number; force?: boolean }) => Promise<void> });

  try {
    await clickTarget.click({ timeout: 5_000 });
    return 'clicked';
  } catch {
    try {
      await clickTarget.click({ timeout: 5_000, force: true });
      return 'clicked';
    } catch {
      return 'present_not_actionable';
    }
  }
}

export async function selectCurrentPathCheckoutIfPresent(page: Page): Promise<void> {
  let checkoutChip: ReturnType<Page['getByTestId']>;
  try {
    checkoutChip = page.getByTestId('new-session-checkout-chip');
  } catch {
    return;
  }

  if ((await checkoutChip.count()) === 0) return;
  try {
    await checkoutChip.click({ timeout: 5_000 });
  } catch {
    return;
  }

  const currentPathOption = page.getByTestId('selection-list:worktree-root:option:current_path');
  if (await waitForCount(page, currentPathOption, 1, 5_000)) {
    await currentPathOption.click({ timeout: 5_000 });
  }
}

export async function openNewSessionMachineSelection(
  params: Readonly<{
    page: Page;
    uiBaseUrl: string;
    popoverWaitMs?: number;
    routeFallbackWaitMs?: number;
  }>,
): Promise<MachineSelectionOpenResult> {
  const popoverWaitMs = params.popoverWaitMs ?? 3_000;
  const routeFallbackWaitMs = params.routeFallbackWaitMs ?? 60_000;
  const machineChip = params.page.getByTestId('agent-input-machine-chip');
  const machineOptions = machineOptionLocator(params.page).first();
  const machineChipCount = await machineChip.count();

  if (machineChipCount > 0) {
    try {
      await machineChip.click({ timeout: 5_000 });
      if (await waitForCount(params.page, machineOptions, 1, popoverWaitMs)) {
        return 'picker_open';
      }
    } catch {
      // The route picker is the canonical fallback when the inline composer chip
      // is temporarily covered by an animation or overlay.
    }

  }

  await gotoDomContentLoadedWithPathFallback(
    params.page,
    `${params.uiBaseUrl}/new/pick/machine`,
    '/new/pick/machine',
    routeFallbackWaitMs,
  );

  const startedAt = Date.now();
  while (Date.now() - startedAt < routeFallbackWaitMs) {
    if ((await machineOptions.count()) === 1) {
      return 'picker_open';
    }

    if (normalizePathname(params.page.url()) === '/new') {
      return 'returned_to_new';
    }

    await params.page.waitForTimeout(250);
  }

  await expect(machineOptions).toHaveCount(1, { timeout: 1 });
  return 'picker_open';
}

export async function selectFirstAvailableMachineForNewSession(
  params: Readonly<{
    page: Page;
    uiBaseUrl: string;
    popoverWaitMs?: number;
    routeFallbackWaitMs?: number;
  }>,
): Promise<void> {
  const result = await openNewSessionMachineSelection(params);
  if (result === 'returned_to_new') return;

  const firstMachine = machineOptionLocator(params.page).first();
  await expect(firstMachine).toHaveCount(1, { timeout: 120_000 });
  await firstMachine.click();
}

export async function openNewSessionPathSelection(
  params: Readonly<{
    page: Page;
    uiBaseUrl: string;
    popoverWaitMs?: number;
    routeFallbackWaitMs?: number;
  }>,
): Promise<void> {
  const popoverWaitMs = params.popoverWaitMs ?? 3_000;
  const routeFallbackWaitMs = params.routeFallbackWaitMs ?? 60_000;
  // Phase 11 SelectionList migration: the path picker is backed by the
  // SelectionList primitive; the input mounts under
  // `path-selection-list:header:input`. The legacy `path-selector-input`
  // testID was deleted with `PathSelector.tsx` so we no longer accept it.
  const pathInput = params.page.locator(
      '[data-testid="path-selection-list:header:input"]',
  );

  await params.page.getByTestId('agent-input-path-chip').click();
  if (await waitForCount(params.page, pathInput, 1, popoverWaitMs)) {
    return;
  }

  await gotoDomContentLoadedWithPathFallback(
    params.page,
    `${params.uiBaseUrl}/new/pick/path`,
    '/new/pick/path',
    routeFallbackWaitMs,
  );
  await expect(pathInput).toHaveCount(1, { timeout: routeFallbackWaitMs });
}

export async function createSessionFromNewSessionComposer(
  params: CreateSessionFromNewSessionComposerParams,
): Promise<CreatedSessionFromNewSessionComposer> {
  const { page, uiBaseUrl, machineId, prompt } = params;

  await gotoDomContentLoadedWithPathFallback(page, `${uiBaseUrl}/new`, '/new');
  const machineSelectionResult = await openNewSessionMachineSelection({ page, uiBaseUrl });
  const pickDeadlineMs = Date.now() + 120_000;
  while (true) {
    const clickResult = await clickFirstMachineMatch(page, machineId);
    if (clickResult === 'clicked') {
      break;
    }

    if (machineSelectionResult === 'returned_to_new' && clickResult === 'absent') {
      break;
    }

    if (Date.now() > pickDeadlineMs) {
      if (clickResult === 'present_not_actionable') {
        throw new Error(`Machine selector was present but not actionable for machine ${machineId} within 120000ms.`);
      }
      await expect(
        page.locator(
          `[data-testid="new-session-machine:${machineId}"], [data-testid="new-session-machine-option:${machineId}"]`,
        ),
      ).toHaveCount(1, { timeout: 1 });
    }

    await page.waitForTimeout(250);
  }

  await page.waitForURL((url) => url.pathname.endsWith('/new'), { timeout: 60_000 });
  await expect(page.getByTestId('new-session-composer-input')).toHaveCount(1, { timeout: 60_000 });
  await selectCurrentPathCheckoutIfPresent(page);

  await page.getByTestId('new-session-composer-input').fill(prompt);
  await expect(page.getByTestId('new-session-composer-send')).toHaveCount(1, { timeout: 60_000 });
  await page.getByTestId('new-session-composer-send').click();

  const sessionComposerTextarea = page.locator('textarea[data-testid="session-composer-input"]:visible');
  const sessionComposer = page.getByTestId('session-composer-input');
  const composerDeadlineMs = Date.now() + 180_000;
  while (Date.now() < composerDeadlineMs) {
    if ((await sessionComposerTextarea.count()) > 0) break;
    if ((await sessionComposer.count()) > 0) break;
    await page.waitForTimeout(250);
  }

  if ((await sessionComposerTextarea.count()) === 0 && (await sessionComposer.count()) === 0) {
    await expect(sessionComposerTextarea).toHaveCount(1, { timeout: 1 });
  }

  const sessionHref = page.url();
  const pathname = new URL(sessionHref).pathname;
  const parts = pathname.split('/').filter(Boolean);
  const sessionId = parts[0] === 'session' ? parts[1] : null;
  if (!sessionId) {
    throw new Error(`failed to parse session id from url: ${sessionHref}`);
  }

  if (params.readiness === 'first-turn-reload-safe') {
    const committedPrompt = page.locator(COMMITTED_TRANSCRIPT_MESSAGE_SELECTOR).filter({ hasText: prompt });
    if (!(await waitForCount(page, committedPrompt, 1, 180_000))) {
      await expect(committedPrompt).toHaveCount(1, { timeout: 1 });
    }
  }

  return { sessionId, sessionHref };
}

export async function reloadCreatedSessionFromNewSessionComposer(params: Readonly<{
  page: Page;
  session: CreatedSessionFromNewSessionComposer;
  timeoutMs?: number;
}>): Promise<void> {
  const timeoutMs = params.timeoutMs ?? 120_000;
  await gotoDomContentLoadedWithRetries(params.page, params.session.sessionHref, timeoutMs);
  await expect(params.page.getByTestId('transcript-chat-list')).toHaveCount(1, {
    timeout: timeoutMs,
  });
}
