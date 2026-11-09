import { expect, type Page } from '@playwright/test';
import { sessionListRowTestId } from './sessionListRowTestId';

export async function openSessionListRowMenu(page: Page, address: Readonly<{ serverId: string; sessionId: string }>): Promise<void> {
    const row = page.getByTestId(sessionListRowTestId(address.serverId, address.sessionId));
    await expect(row).toHaveCount(1, { timeout: 60_000 });
    await row.hover();

    // CollectionRowContent keeps trailing controls beside navigation. Bind to
    // their nearest common row, refusing an ancestor containing another Session.
    const collectionRow = row.locator('xpath=ancestor::*[count(.//*[@role="button" and @data-testid and starts-with(@data-testid, "session-list-item-")]) = 1 and count(.//*[@data-testid="session-item-more-menu"]) = 1][1]');
    const trigger = collectionRow.getByTestId('session-item-more-menu');
    // Hover actions commit asynchronously; the SDK waits for this row's trigger.
    await trigger.waitFor({ state: 'visible' });
    await trigger.click({ force: true });
}

export async function selectSessionListRowMenuItem(page: Page, itemId: string): Promise<void> {
    const option = page.getByTestId(`dropdown-option-${itemId}`);
    await expect(option).toHaveCount(1, { timeout: 60_000 });
    await option.click({ force: true });
}

export async function openSessionListRowMenuAndSelectItem(params: Readonly<{
    page: Page;
    serverId: string;
    sessionId: string;
    itemId: string;
}>): Promise<void> {
    await openSessionListRowMenu(params.page, params);
    await selectSessionListRowMenuItem(params.page, params.itemId);
}
