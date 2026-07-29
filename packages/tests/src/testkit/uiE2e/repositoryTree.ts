import { expect, type Locator, type Page } from '@playwright/test';

import { toTestIdSafeValue } from './testIdSafeValue';

function repositoryTreePathVariants(path: string): readonly [string, string] {
    const trimmed = path.trim();
    if (!trimmed) {
        return [trimmed, trimmed];
    }
    return trimmed.endsWith('/') ? [trimmed, trimmed.slice(0, -1)] : [trimmed, `${trimmed}/`];
}

function repositoryTreeRowTextFallbackLocator(scope: Locator, path: string): Locator {
    return scope
        .getByText(path, { exact: true })
        .first();
}

export function repositoryTreeRowLocator(scope: Locator, path: string): Locator {
    const [primary, alternate] = repositoryTreePathVariants(path);
    return scope
        .locator(`[data-testid="repository-tree-row-${toTestIdSafeValue(primary)}"]:visible`)
        .or(scope.locator(`[data-testid="repository-tree-row-${toTestIdSafeValue(alternate)}"]:visible`))
        .or(repositoryTreeRowTextFallbackLocator(scope, primary))
        .or(repositoryTreeRowTextFallbackLocator(scope, alternate))
        .first();
}

export function repositoryTreeRowMenuLocator(scope: Locator, path: string): Locator {
    const [primary, alternate] = repositoryTreePathVariants(path);
    return scope
        .locator(`[data-testid="repository-tree-row-menu-${toTestIdSafeValue(primary)}"]:visible`)
        .or(scope.locator(`[data-testid="repository-tree-row-menu-${toTestIdSafeValue(alternate)}"]:visible`));
}

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function resolveDropdownFallbackLabel(itemId: string): string | null {
    switch (itemId) {
        case 'repository-tree-menuitem-rename':
            return 'Rename';
        case 'repository-tree-menuitem-delete':
            return 'Delete';
        case 'repository-tree-menuitem-download':
            return 'Download';
        case 'repository-tree-menuitem-zip':
            return 'Download as zip';
        case 'repository-tree-menuitem-copy-path':
            return 'Copy path';
        default:
            return null;
    }
}

function resolveRepositoryTreeMenuTitle(path: string): string {
    const trimmed = path.trim().replace(/\/+$/g, '');
    if (!trimmed) {
        return path.trim();
    }
    const parts = trimmed.split('/').filter(Boolean);
    return parts.at(-1) ?? trimmed;
}

async function clickRepositoryTreeMenuItemByText(params: Readonly<{
    page: Page;
    path: string;
    itemId: string;
    timeoutMs: number;
}>): Promise<void> {
    const fallbackLabel = resolveDropdownFallbackLabel(params.itemId);
    if (!fallbackLabel) {
        throw new Error(`No repository tree fallback label for ${params.itemId}`);
    }

    const menuTitle = resolveRepositoryTreeMenuTitle(params.path);
    const menuRoot = params.page
        .locator(`text=/^${escapeRegex(menuTitle)}$/`)
        .last()
        .locator('xpath=ancestor::*[.//*[normalize-space(.)="Copy path"]][1]');
    const target = menuRoot.locator(`text=/^${escapeRegex(fallbackLabel)}$/`).first();
    await expect(target).toHaveCount(1, { timeout: params.timeoutMs });
    await target.click();
}

export async function openRepositoryTreeRowMenu(scope: Locator, path: string): Promise<void> {
    const menu = repositoryTreeRowMenuLocator(scope, path);
    if ((await menu.count()) > 0) {
        await menu.first().click();
        return;
    }

    // Fallback for web builds where some RNW host components may not surface `data-testid` reliably.
    const row = scope.locator('button', { hasText: new RegExp(escapeRegex(path)) }).first();
    await expect(row).toHaveCount(1, { timeout: 120_000 });

    const titleButton = row.getByTitle('More actions').first();
    if ((await titleButton.count()) > 0) {
        await titleButton.click();
        return;
    }

    await row.getByRole('button', { name: /more actions/i }).first().click();
}

export async function clickDropdownOptionByItemId(
    page: Page,
    itemId: string,
    options?: Readonly<{ timeoutMs?: number }>,
): Promise<void> {
    const timeoutMs = options?.timeoutMs ?? 60_000;
    const dropdownOption = page.locator(`[data-testid="dropdown-option-${toTestIdSafeValue(itemId)}"]:visible`).first();
    const directOption = page.locator(`[data-testid="${itemId}"]:visible`).first();

    if ((await dropdownOption.count()) > 0) {
        await dropdownOption.click();
        return;
    }
    if ((await directOption.count()) > 0) {
        await directOption.click();
        return;
    }

    await expect(directOption).toHaveCount(1, { timeout: timeoutMs });
    await directOption.click();
}

export async function openRepositoryTreeRowMenuAndSelectItem(params: Readonly<{
    page: Page;
    scope: Locator;
    path: string;
    itemId: string;
    timeoutMs?: number;
}>): Promise<void> {
    const deadline = Date.now() + (params.timeoutMs ?? 60_000);
    let lastError: unknown = null;

    // A transfer may finish on disk before its refreshed row has committed in the web tree.
    // Wait at the row boundary so an initial missing menu does not permanently choose the
    // host-component fallback while the real row and its test-id menu are still rendering.
    await expect(repositoryTreeRowLocator(params.scope, params.path)).toHaveCount(1, {
        timeout: Math.max(1_000, deadline - Date.now()),
    });

    while (Date.now() < deadline) {
        await openRepositoryTreeRowMenu(params.scope, params.path);
        try {
            await clickDropdownOptionByItemId(params.page, params.itemId, {
                timeoutMs: Math.max(1_000, Math.min(5_000, deadline - Date.now())),
            });
            return;
        } catch (error) {
            lastError = error;
        }

        try {
            await clickRepositoryTreeMenuItemByText({
                page: params.page,
                path: params.path,
                itemId: params.itemId,
                timeoutMs: Math.max(1_000, Math.min(5_000, deadline - Date.now())),
            });
            return;
        } catch (error) {
            lastError = error;
        }

        await params.page.keyboard.press('Escape').catch(() => {});
        await params.page.waitForTimeout(500);
    }

    throw lastError ?? new Error(`Failed to select repository tree menu item ${params.itemId} for ${params.path}`);
}
