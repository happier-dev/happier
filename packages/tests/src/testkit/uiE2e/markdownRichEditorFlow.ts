import { expect, type Locator, type Page } from '@playwright/test';
import { basename } from 'node:path';

import { gotoDomContentLoadedWithPathFallback } from './pageNavigation';
import { toTestIdSafeValue } from './testIdSafeValue';

export function collectBrowserDiagnostics(params: Readonly<{ page: Page }>): () => string {
    const pageConsole: string[] = [];
    const pageErrors: string[] = [];
    const requestFailures: string[] = [];
    const responseErrors: string[] = [];

    params.page.on('console', (message) => pageConsole.push(`[${message.type()}] ${message.text()}`));
    params.page.on('pageerror', (error) => pageErrors.push(String(error)));
    params.page.on('requestfailed', (request) => {
        const failure = request.failure();
        requestFailures.push(`${request.method()} ${request.url()} ${failure ? `-> ${failure.errorText}` : ''}`.trim());
    });
    params.page.on('response', (response) => {
        const status = response.status();
        if (status >= 400) responseErrors.push(`${status} ${response.request().method()} ${response.url()}`);
    });

    return () =>
        `# Browser diagnostics\n\n`
        + `## Console\n\n${pageConsole.length ? pageConsole.join('\n') : '(none)'}\n\n`
        + `## Page errors\n\n${pageErrors.length ? pageErrors.join('\n') : '(none)'}\n\n`
        + `## Request failures\n\n${requestFailures.length ? requestFailures.join('\n') : '(none)'}\n\n`
        + `## Response errors\n\n${responseErrors.length ? responseErrors.join('\n') : '(none)'}\n`;
}

export function workspaceDetailsPaneLocator(page: Page): Locator {
    return page.getByTestId('workspace-details-panel-root');
}

export function workspaceFileDetailsByTestId(page: Page, testId: string): Locator {
    return workspaceDetailsPaneLocator(page).getByTestId(testId).first();
}

export function fileDetailsSaveButton(page: Page): Locator {
    return workspaceFileDetailsByTestId(page, 'file-details-save');
}

export async function saveOpenFileDetails(page: Page): Promise<void> {
    const saveButton = fileDetailsSaveButton(page);
    await expect(saveButton).toBeVisible({ timeout: 60_000 });
    await expect(saveButton).not.toHaveAttribute('aria-disabled', 'true', { timeout: 60_000 });
    await saveButton.click();
}

export function fileDetailsTabTestId(filePath: string): string {
    return `workspace-details-tab-${toTestIdSafeValue(`file:${filePath}`)}`;
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
    const startedAt = Date.now();
    let lastError: unknown = null;

    while (Date.now() - startedAt < 60_000) {
        try {
            await expect(toggle).toHaveCount(1, { timeout: 5_000 });
            await expect(toggle).toBeVisible({ timeout: 5_000 });
            await toggle.scrollIntoViewIfNeeded();

            const input = toggle.locator('input[type="checkbox"]').first();
            if ((await input.count()) > 0) {
                if (!(await input.isChecked())) {
                    await toggle.click({ timeout: 15_000 });
                }
                await expect(input).toBeChecked({ timeout: 5_000 });
                return;
            }

            if ((await toggle.getAttribute('aria-checked').catch(() => null)) !== 'true') {
                await toggle.click({ timeout: 15_000 });
            }
            await expect(toggle).toHaveAttribute('aria-checked', 'true', { timeout: 5_000 });
            return;
        } catch (error) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
    }

    throw lastError instanceof Error
        ? lastError
        : new Error(`Timed out enabling markdown rich editor settings switch: ${String(lastError)}`);
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

            if (await locatorHasCount(markdownToggle, 1, 20_000)) {
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

async function selectWorkspacePathFromPathBrowserModal(page: Page, absolutePath: string): Promise<void> {
    const modal = page.getByTestId('path-browser-modal');
    await expect(modal).toHaveCount(1, { timeout: 60_000 });

    const normalizedPath = absolutePath.replace(/\\/g, '/').replace(/\/+$/g, '');
    const selectedViaSearch = normalizedPath.startsWith('/')
        ? await selectPathBrowserPathUsingScopedSearch(page, normalizedPath)
        : false;

    if (!selectedViaSearch && normalizedPath.startsWith('/')) {
        const segments = normalizedPath.split('/').filter(Boolean);
        const segmentPaths = segments.map((_, index) => `/${segments.slice(0, index + 1).join('/')}`);

        if (segmentPaths.length > 0) {
            await revealPathBrowserChildRow(page, '/', segmentPaths[0]);
        }

        for (let index = 0; index < segmentPaths.length - 1; index += 1) {
            const current = segmentPaths[index]!;
            const next = segmentPaths[index + 1]!;
            await revealPathBrowserChildRow(page, current, next);
        }
    }

    if (!selectedViaSearch) {
        const targetRow = page.getByTestId(`path-browser-row:${normalizedPath}`).first();
        await expect(targetRow).toHaveCount(1, { timeout: 60_000 });
        await targetRow.dispatchEvent('click');
    }

    const confirmButton = page.getByTestId('path-browser-confirm').first();
    await expect(confirmButton).toBeEnabled({ timeout: 30_000 });
    await confirmButton.scrollIntoViewIfNeeded();
    await confirmButton.click({ force: true });

    await expect(page.getByTestId('path-browser-modal')).toHaveCount(0, { timeout: 60_000 });
}

async function selectPathBrowserPathUsingScopedSearch(page: Page, normalizedPath: string): Promise<boolean> {
    const segments = normalizedPath.split('/').filter(Boolean);
    if (segments.length < 2) {
        return false;
    }

    const searchScopeSegments = segments.slice(0, Math.min(2, segments.length - 1));
    const searchScopePaths = searchScopeSegments.map((_, index) => `/${searchScopeSegments.slice(0, index + 1).join('/')}`);

    if (searchScopePaths.length > 0) {
        await revealPathBrowserChildRow(page, '/', searchScopePaths[0]!);
    }
    for (let index = 0; index < searchScopePaths.length - 1; index += 1) {
        await revealPathBrowserChildRow(page, searchScopePaths[index]!, searchScopePaths[index + 1]!);
    }

    const searchScopePath = searchScopePaths[searchScopePaths.length - 1];
    if (!searchScopePath) {
        return false;
    }

    const searchScopeRow = page.getByTestId(`path-browser-row:${searchScopePath}`).first();
    await expect(searchScopeRow).toHaveCount(1, { timeout: 60_000 });
    await searchScopeRow.dispatchEvent('click');

    const searchInput = await pathBrowserSearchInput(page);
    await searchInput.fill('');
    await searchInput.fill(basename(normalizedPath));

    const targetRow = page.getByTestId(`path-browser-row:${normalizedPath}`).first();
    if (await locatorHasCount(targetRow, 1, 60_000)) {
        await targetRow.dispatchEvent('click');
        return true;
    }

    await searchInput.fill('');
    return false;
}

async function pathBrowserSearchInput(page: Page): Promise<Locator> {
    const search = page.getByTestId('path-browser-search').first();
    await expect(search).toHaveCount(1, { timeout: 60_000 });

    const innerInput = search.locator('input, textarea').first();
    if (await locatorHasCount(innerInput, 1, 500)) {
        return innerInput;
    }
    return search;
}

async function revealPathBrowserChildRow(page: Page, parentPath: string, childPath: string): Promise<void> {
    const childRow = page.getByTestId(`path-browser-row:${childPath}`).first();
    if (await locatorHasCount(childRow, 1, 500)) {
        return;
    }

    if (parentPath !== '/') {
        const parentRow = page.getByTestId(`path-browser-row:${parentPath}`).first();
        await expect(parentRow).toHaveCount(1, { timeout: 60_000 });
        await parentRow.scrollIntoViewIfNeeded();
    }

    const parentToggle = page.getByTestId(`path-browser-toggle:${parentPath}`).first();
    if (await locatorHasCount(parentToggle, 1, 2_000)) {
        await parentToggle.dispatchEvent('click');
    }

    try {
        await expect(childRow).toHaveCount(1, { timeout: 60_000 });
    } catch (error) {
        if (parentPath !== '/') {
            const parentRow = page.getByTestId(`path-browser-row:${parentPath}`).first();
            await parentRow.dispatchEvent('click');
            await expect(childRow).toHaveCount(1, { timeout: 60_000 });
            return;
        }
        throw error;
    }
}

async function locatorHasCount(locator: Locator, expectedCount: number, timeoutMs: number): Promise<boolean> {
    try {
        await expect(locator).toHaveCount(expectedCount, { timeout: timeoutMs });
        return true;
    } catch {
        return false;
    }
}

export async function primeWorkspaceProjectFlow(params: Readonly<{
    page: Page;
    baseUrl: string;
}>): Promise<void> {
    await gotoDomContentLoadedWithPathFallback(
        params.page,
        `${params.baseUrl}/new?happier_hmr=0`,
        '/new',
        180_000,
    );
    await expect(params.page.getByTestId('agent-input-machine-chip')).toHaveCount(1, { timeout: 180_000 });
}

export async function openFileInWorkspaceDetails(params: Readonly<{
    page: Page;
    baseUrl: string;
    repoDir: string;
    filePath: string;
}>): Promise<void> {
    const { page, baseUrl, repoDir, filePath } = params;

    await primeWorkspaceProjectFlow({ page, baseUrl });
    await gotoDomContentLoadedWithPathFallback(page, `${baseUrl}/projects?happier_hmr=0`, '/projects', 180_000);
    await expect(page.getByTestId('projects-list')).toHaveCount(1, { timeout: 120_000 });

    await page.locator('[data-testid^="projects-add-first-machine:"]').first().click();
    await selectWorkspacePathFromPathBrowserModal(page, repoDir);

    await expect(page.getByTestId('workspace-details-panel-root')).toHaveCount(1, { timeout: 120_000 });
    await expect(page.getByTestId('project-right-panel-root')).toHaveCount(1, { timeout: 120_000 });

    await page.getByTestId('project-rightpanel-tab:files').click();
    await expect(page.getByTestId('project-rightpanel-surface-files')).toBeVisible({ timeout: 120_000 });

    const row = page.getByTestId(`repository-tree-row-${toTestIdSafeValue(filePath)}`);
    await expect(row).toHaveCount(1, { timeout: 180_000 });
    await row.click();

    await expect(page.getByTestId(fileDetailsTabTestId(filePath))).toHaveCount(1, { timeout: 120_000 });
}

export async function enterMarkdownRichEditorEditMode(page: Page): Promise<Readonly<{
    richEditor: Locator;
    proseMirror: Locator;
}>> {
    const existingRichEditor = workspaceFileDetailsByTestId(page, 'file-details-rich-editor');
    if (!(await existingRichEditor.isVisible().catch(() => false))) {
        await workspaceFileDetailsByTestId(page, 'file-details-edit').click({ force: true });
    }

    const richEditor = workspaceFileDetailsByTestId(page, 'file-details-rich-editor');
    await expect(richEditor).toHaveCount(1, { timeout: 120_000 });
    await expect(richEditor).toBeVisible({ timeout: 120_000 });

    const proseMirror = richEditor.locator('.ProseMirror');
    await expect(proseMirror).toHaveCount(1, { timeout: 60_000 });
    await expect(proseMirror).toBeVisible({ timeout: 60_000 });

    return { richEditor, proseMirror };
}

export async function openMarkdownFileInRichEditor(params: Readonly<{
    page: Page;
    baseUrl: string;
    repoDir: string;
    filePath: string;
}>): Promise<Readonly<{
    richEditor: Locator;
    proseMirror: Locator;
}>> {
    await openFileInWorkspaceDetails(params);
    await expect(workspaceDetailsPaneLocator(params.page).getByTestId('file-details-edit')).toHaveCount(1, {
        timeout: 120_000,
    });
    return await enterMarkdownRichEditorEditMode(params.page);
}
