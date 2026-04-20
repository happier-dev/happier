import { expect, type Page } from '@playwright/test';

import { gotoDomContentLoadedWithPathFallback } from './pageNavigation';

type CreateSessionFromNewSessionComposerParams = Readonly<{
  page: Page;
  uiBaseUrl: string;
  machineId: string;
  prompt: string;
}>;

type MachineSelectionOpenResult = 'picker_open' | 'returned_to_new';

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

async function clickFirstMachineMatch(page: Page, machineId: string): Promise<boolean> {
  const exact = page.getByTestId(`new-session-machine:${machineId}`);
  if ((await exact.count()) === 0) {
    return false;
  }
  await exact.first().click();
  return true;
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
  const machineOptions = params.page.locator('[data-testid^="new-session-machine:"]').first();
  const machineChipCount = await machineChip.count();

  if (machineChipCount > 0) {
    await machineChip.click();
    if (await waitForCount(params.page, machineOptions, 1, popoverWaitMs)) {
      return 'picker_open';
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
  const pathInput = params.page.getByTestId('path-selector-input');

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
): Promise<string> {
  const { page, uiBaseUrl, machineId, prompt } = params;

  await gotoDomContentLoadedWithPathFallback(page, `${uiBaseUrl}/new`, '/new');
  const machineSelectionResult = await openNewSessionMachineSelection({ page, uiBaseUrl });
  const pickDeadlineMs = Date.now() + 120_000;
  while (true) {
    if (await clickFirstMachineMatch(page, machineId)) {
      break;
    }

    if (machineSelectionResult === 'returned_to_new') {
      break;
    }

    if (Date.now() > pickDeadlineMs) {
      await expect(page.getByTestId(`new-session-machine:${machineId}`)).toHaveCount(1, { timeout: 1 });
    }

    await page.waitForTimeout(250);
  }

  await page.waitForURL((url) => url.pathname.endsWith('/new'), { timeout: 60_000 });
  await expect(page.getByTestId('new-session-composer-input')).toHaveCount(1, { timeout: 60_000 });

  await page.getByTestId('new-session-composer-input').fill(prompt);
  await expect(page.getByTestId('new-session-composer-send')).toHaveCount(1, { timeout: 60_000 });
  await page.getByTestId('new-session-composer-send').click();
  await expect(page.locator('textarea[data-testid="session-composer-input"]:visible')).toHaveCount(1, { timeout: 180_000 });

  const pathname = new URL(page.url()).pathname;
  const parts = pathname.split('/').filter(Boolean);
  const sessionId = parts[0] === 'session' ? parts[1] : null;
  if (!sessionId) {
    throw new Error(`failed to parse session id from url: ${page.url()}`);
  }
  return sessionId;
}
