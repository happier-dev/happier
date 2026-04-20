import { expect, type Page } from '@playwright/test';

export async function openSessionListRowMenu(page: Page, sessionId: string): Promise<void> {
    const row = page.getByTestId(`session-list-item-${sessionId}`);
    await expect(row).toHaveCount(1, { timeout: 60_000 });
    await row.hover();

    const trigger = row.getByTestId('session-item-more-menu');
    if (await trigger.count()) {
        await trigger.click({ force: true });
        return;
    }

    await row.getByRole('button', { name: /more actions/i }).click({ force: true });
}

export async function selectSessionListRowMenuItem(page: Page, itemId: string): Promise<void> {
    const option = page.getByTestId(`dropdown-option-${itemId}`);
    await expect(option).toHaveCount(1, { timeout: 60_000 });
    await option.click({ force: true });
}

export async function openSessionListRowMenuAndSelectItem(params: Readonly<{
    page: Page;
    sessionId: string;
    itemId: string;
}>): Promise<void> {
    await openSessionListRowMenu(params.page, params.sessionId);
    await selectSessionListRowMenuItem(params.page, params.itemId);
}
