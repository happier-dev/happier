import { expect, type Page } from '@playwright/test';

import { gotoDomContentLoadedWithPathFallback } from './pageNavigation';

type CreateSessionFromNewSessionComposerParams = Readonly<{
    page: Page;
    uiBaseUrl: string;
    machineId: string;
    prompt: string;
}>;

export async function createSessionFromNewSessionComposer(
    params: CreateSessionFromNewSessionComposerParams,
): Promise<string> {
    const { page, uiBaseUrl, machineId, prompt } = params;

    await gotoDomContentLoadedWithPathFallback(page, `${uiBaseUrl}/new`, '/new');
    await expect(page.getByTestId('new-session-composer-input')).toHaveCount(1, { timeout: 60_000 });
    await expect(page.getByTestId('agent-input-machine-chip')).toHaveCount(1, { timeout: 120_000 });
    await page.getByTestId('agent-input-machine-chip').click();
    await page.waitForURL((url) => url.pathname.endsWith('/new/pick/machine'), { timeout: 60_000 });

    const pickDeadlineMs = Date.now() + 120_000;
    while (true) {
        const exact = page.getByTestId(`new-session-machine:${machineId}`);
        if (await exact.count()) {
            await exact.click();
            break;
        }

        const anyMachine = page.locator('[data-testid^="new-session-machine:"]').first();
        if (await anyMachine.count()) {
            await anyMachine.click();
            break;
        }

        if (Date.now() > pickDeadlineMs) {
            await expect(page.getByTestId(`new-session-machine:${machineId}`)).toHaveCount(1, { timeout: 1 });
        }

        await gotoDomContentLoadedWithPathFallback(page, `${uiBaseUrl}/new/pick/machine`, '/new/pick/machine');
        await new Promise((r) => setTimeout(r, 250));
    }

    await page.waitForURL((url) => url.pathname.endsWith('/new'), { timeout: 60_000 });
    await expect(page.getByTestId('new-session-composer-input')).toHaveCount(1, { timeout: 60_000 });

    await page.getByTestId('new-session-composer-input').fill(prompt);
    await page.getByTestId('new-session-composer-input').press('Enter');
    await expect(page.locator('textarea[data-testid="session-composer-input"]:visible')).toHaveCount(1, { timeout: 180_000 });

    const pathname = new URL(page.url()).pathname;
    const parts = pathname.split('/').filter(Boolean);
    const sessionId = parts[0] === 'session' ? parts[1] : null;
    if (!sessionId) {
        throw new Error(`failed to parse session id from url: ${page.url()}`);
    }
    return sessionId;
}
