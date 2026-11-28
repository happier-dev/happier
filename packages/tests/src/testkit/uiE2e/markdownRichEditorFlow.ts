import { expect, type Locator, type Page } from '@playwright/test';

import { toTestIdSafeValue } from './testIdSafeValue';
import { gotoDomContentLoadedWithPathFallback } from './pageNavigation';

export { collectBrowserDiagnostics } from './browserDiagnostics';

export function rightPaneLocator(page: Page): Locator {
  return page.getByTestId('multi-pane-right-docked').or(page.getByTestId('multi-pane-right-overlay'));
}

export function detailsPaneLocator(page: Page): Locator {
  return page.getByTestId('multi-pane-details-docked').or(page.getByTestId('multi-pane-details-overlay'));
}

export function visibleDetailsByTestId(page: Page, testId: string): Locator {
  return detailsPaneLocator(page).locator(`[data-testid="${testId}"]:visible`);
}

export function firstVisibleDetailsByTestId(page: Page, testId: string): Locator {
  return visibleDetailsByTestId(page, testId).first();
}

export function fileDetailsSaveButton(page: Page): Locator {
  return firstVisibleDetailsByTestId(page, 'file-details-save');
}

export async function saveOpenFileDetails(page: Page): Promise<void> {
  const saveButton = fileDetailsSaveButton(page);
  await expect(saveButton).toBeVisible({ timeout: 60_000 });
  await expect(saveButton).not.toHaveAttribute('aria-disabled', 'true', { timeout: 60_000 });
  await saveButton.click();
  // The write can reach disk before refresh finishes and the editor exits.
  // Reopening while the old editor is still visible races its pending unmount.
  await expect(saveButton).toBeHidden({ timeout: 60_000 });
}

export async function visibleBoundingBox(locator: Locator, label: string): Promise<Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>> {
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error(`Expected ${label} to have a visible bounding box`);
  }
  return box;
}

export async function readCurrentSelectionRect(page: Page): Promise<Readonly<{
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}>> {
  return await page.evaluate(() => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      throw new Error('Expected the editor to expose a DOM selection');
    }

    const range = selection.getRangeAt(0);
    const directRect = range.getBoundingClientRect();
    const rect = directRect.width > 0 || directRect.height > 0
      ? directRect
      : (range.getClientRects()[0] ?? directRect);

    if (rect.top === 0 && rect.bottom === 0) {
      throw new Error('Expected the editor selection to expose a visible rect');
    }

    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
    };
  });
}

export async function expectSurfaceNearSelection(params: Readonly<{
  page: Page;
  surface: Locator;
  label: string;
  maxVerticalDistance?: number;
  maxHorizontalDistance?: number;
}>): Promise<void> {
  const selectionRect = await readCurrentSelectionRect(params.page);
  const surfaceBox = await visibleBoundingBox(params.surface, params.label);
  const surfaceVerticalEdges = [
    surfaceBox.y,
    surfaceBox.y + surfaceBox.height,
  ];
  const selectionVerticalEdges = [
    selectionRect.top,
    selectionRect.bottom,
  ];
  const minVerticalDistance = Math.min(
    ...surfaceVerticalEdges.flatMap((surfaceEdge) =>
      selectionVerticalEdges.map((selectionEdge) => Math.abs(surfaceEdge - selectionEdge)),
    ),
  );
  const minHorizontalDistance = Math.min(
    Math.abs(surfaceBox.x - selectionRect.left),
    Math.abs(surfaceBox.x - selectionRect.right),
    Math.abs((surfaceBox.x + surfaceBox.width) - selectionRect.left),
    Math.abs((surfaceBox.x + surfaceBox.width) - selectionRect.right),
  );

  expect(minVerticalDistance).toBeLessThanOrEqual(params.maxVerticalDistance ?? 96);
  expect(minHorizontalDistance).toBeLessThanOrEqual(params.maxHorizontalDistance ?? 220);
}

async function ensureSwitchEnabled(toggle: Locator): Promise<void> {
  await expect(toggle).toHaveCount(1, { timeout: 60_000 });
  await expect(toggle).toBeVisible({ timeout: 60_000 });
  const input = toggle.locator('input[type="checkbox"]').first();
  if ((await input.count()) > 0) {
    if (!(await input.isChecked())) {
      await toggle.click();
    }
    await expect(input).toBeChecked({ timeout: 60_000 });
    return;
  }

  const ariaChecked = await toggle.getAttribute('aria-checked').catch(() => null);
  if (ariaChecked !== 'true') {
    await toggle.click();
  }
  await expect(toggle).toHaveAttribute('aria-checked', 'true', { timeout: 60_000 });
}

async function hasLocatorCount(locator: Locator, expectedCount: number, timeoutMs: number): Promise<boolean> {
  try {
    await expect(locator).toHaveCount(expectedCount, { timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

export async function enableMarkdownRichEditorInSettings(params: Readonly<{
  baseUrl: string;
  page: Page;
}>): Promise<void> {
  const settingsUrl = `${params.baseUrl}/settings/features?happier_hmr=0`;
  const settingsPathname = '/settings/features';
  const markdownToggle = params.page.getByTestId('settings-feature-toggle-files.markdownRichEditor');
  let lastError: unknown = null;

  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await gotoDomContentLoadedWithPathFallback(
        params.page,
        settingsUrl,
        settingsPathname,
        180_000,
      );
      await ensureSwitchEnabled(params.page.getByTestId('settings-feature-experiments-toggle'));

      if (await hasLocatorCount(markdownToggle, 1, 20_000)) {
        await ensureSwitchEnabled(markdownToggle);
        return;
      }
    } catch (error) {
      lastError = error;
    }

    await params.page.waitForTimeout(1_000);
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Timed out enabling markdown rich editor settings switch');
}

export async function openFileInDetailsPane(params: Readonly<{
  page: Page;
  baseUrl: string;
  sessionId: string;
  filePath: string;
}>): Promise<void> {
  const sessionPath = `/session/${encodeURIComponent(params.sessionId)}`;
  const onCurrentSession = (() => {
    try {
      const pathname = new URL(params.page.url()).pathname.replace(/\/+$/, '');
      return pathname === sessionPath || pathname.startsWith(`${sessionPath}/`);
    } catch {
      return false;
    }
  })();
  const appReady = onCurrentSession && await params.page.getByTestId('session-composer-input').count().catch(() => 0) > 0;
  if (!appReady) {
    await gotoDomContentLoadedWithPathFallback(
      params.page,
      `${params.baseUrl}${sessionPath}?right=files&happier_hmr=0`,
      sessionPath,
      180_000,
    );
  }
  await expect(params.page.getByTestId('session-composer-input')).toHaveCount(1, { timeout: 120_000 });
  await expect(rightPaneLocator(params.page)).toHaveCount(1, { timeout: 120_000 });

  const filesSurface = rightPaneLocator(params.page).getByTestId('session-rightpanel-surface-files');
  if (!(await filesSurface.isVisible().catch(() => false))) {
    await params.page.getByTestId('session-action-rail:files').click();
  }
  await expect(filesSurface).toHaveCount(1, {
    timeout: 120_000,
  });

  const fileRow = rightPaneLocator(params.page).getByTestId(`repository-tree-row-${toTestIdSafeValue(params.filePath)}`);
  await expect(fileRow).toHaveCount(1, { timeout: 120_000 });
  await fileRow.scrollIntoViewIfNeeded();
  await fileRow.click();

  const tab = params.page.getByTestId(`session-details-tab-${toTestIdSafeValue(`file:${params.filePath}`)}`);
  await expect(tab).toHaveCount(1, { timeout: 120_000 });
  await tab.click();

  await expect(detailsPaneLocator(params.page)).toHaveCount(1, { timeout: 120_000 });
  await expect(firstVisibleDetailsByTestId(params.page, 'file-details-edit')).toBeVisible({
    timeout: 120_000,
  });
}

export async function enterMarkdownRichEditorEditMode(page: Page): Promise<Readonly<{
  richEditor: Locator;
  proseMirror: Locator;
}>> {
  const existingRichEditor = firstVisibleDetailsByTestId(page, 'file-details-rich-editor');
  if (!(await existingRichEditor.isVisible().catch(() => false))) {
    await firstVisibleDetailsByTestId(page, 'file-details-edit').click({ force: true });
  }

  const richEditor = firstVisibleDetailsByTestId(page, 'file-details-rich-editor');
  await expect(richEditor).toBeVisible({ timeout: 120_000 });

  const proseMirror = richEditor.locator('.ProseMirror');
  await expect(proseMirror).toHaveCount(1, { timeout: 60_000 });
  await expect(proseMirror).toBeVisible({ timeout: 60_000 });

  return { richEditor, proseMirror };
}

export async function openMarkdownFileInRichEditor(params: Readonly<{
  page: Page;
  baseUrl: string;
  sessionId: string;
  filePath: string;
}>): Promise<Readonly<{
  richEditor: Locator;
  proseMirror: Locator;
}>> {
  await openFileInDetailsPane(params);
  await expect(detailsPaneLocator(params.page).getByTestId('file-markdown-preview')).toHaveCount(1, {
    timeout: 120_000,
  });
  return await enterMarkdownRichEditorEditMode(params.page);
}
