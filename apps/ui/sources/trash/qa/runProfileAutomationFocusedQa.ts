import path from 'node:path';

import { chromium } from '@playwright/test';

import { acknowledgeTerminalConnectSuccessIfPresent } from '../../../../../packages/tests/src/testkit/uiE2e/acknowledgeTerminalConnectSuccessIfPresent';
import { gotoDomContentLoadedWithPathFallback } from '../../../../../packages/tests/src/testkit/uiE2e/pageNavigation';

const baseUrl = process.env.HAPPIER_QA_BASE_URL?.trim() || 'http://happier-agent-input-popover-qa.localhost:24573';
const serverUrl = process.env.HAPPIER_QA_SERVER_URL?.trim() || 'http://localhost:24573';
const storageStatePath = process.env.HAPPIER_QA_STORAGE_STATE_IN?.trim();

if (!storageStatePath) {
    throw new Error('HAPPIER_QA_STORAGE_STATE_IN is required');
}

async function waitForComposer(page: import('@playwright/test').Page) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 60_000) {
        if ((await page.getByTestId('agent-input-agent-chip').count()) > 0) {
            return;
        }
        await page.waitForTimeout(500);
    }
    throw new Error(`new-session composer did not become ready | url=${page.url()}`);
}

async function main() {
    const browser = await chromium.launch({ headless: true, ignoreHTTPSErrors: true });
    const context = await browser.newContext({
        viewport: { width: 1440, height: 1100 },
        ignoreHTTPSErrors: true,
        storageState: storageStatePath,
    });

    try {
        const page = await context.newPage();
        await gotoDomContentLoadedWithPathFallback(
            page,
            `${baseUrl}/new?server=${encodeURIComponent(serverUrl)}&happier_hmr=0`,
            '/new',
            120_000,
        );
        await acknowledgeTerminalConnectSuccessIfPresent(page);
        await waitForComposer(page);

        const result: Record<string, unknown> = {
            url: page.url(),
        };

        const profileChip = page.getByTestId('agent-input-profile-chip').first();
        result.profileChipVisible = await profileChip.isVisible().catch(() => false);
        if (result.profileChipVisible) {
            await profileChip.click();
            const profilePopover = page.getByTestId('agent-input-content-popover').first();
            await profilePopover.waitFor({ state: 'visible', timeout: 15_000 });
            result.profilePopoverText = await profilePopover.innerText();
            await page.screenshot({
                path: path.resolve('output/playwright/qa-profile-popover-latest.png'),
                fullPage: true,
            });
            await profileChip.click();
            await page.waitForTimeout(300);
        }

        const automationChip = page.getByTestId('new-session-automation-chip').first();
        result.automationChipVisible = await automationChip.isVisible().catch(() => false);
        if (result.automationChipVisible) {
            await automationChip.click();
            const automationPopover = page.getByTestId('agent-input-content-popover').first();
            await automationPopover.waitFor({ state: 'visible', timeout: 15_000 });

            const fieldsBeforeToggle = await automationPopover.locator('input, textarea').count();
            result.automationFieldCountBeforeToggle = fieldsBeforeToggle;

            const toggle = automationPopover.getByRole('switch').first();
            await toggle.click();
            await page.waitForTimeout(300);

            const fieldsAfterToggle = await automationPopover.locator('input, textarea').count();
            result.automationFieldCountAfterToggle = fieldsAfterToggle;

            const scheduleTrigger = automationPopover.getByText('Schedule', { exact: true }).first();
            await toggle.click();
            await page.waitForTimeout(300);
            await scheduleTrigger.click();
            const dropdown = page.getByText('Interval', { exact: true }).first();
            await dropdown.waitFor({ state: 'visible', timeout: 15_000 });
            const triggerBox = await scheduleTrigger.boundingBox();
            const dropdownBox = await dropdown.boundingBox();
            result.automationScheduleTriggerY = triggerBox?.y ?? null;
            result.automationScheduleDropdownY = dropdownBox?.y ?? null;
            result.automationScheduleAnchoredBelow =
                typeof triggerBox?.y === 'number'
                && typeof dropdownBox?.y === 'number'
                && dropdownBox.y >= triggerBox.y;

            result.automationPopoverText = await automationPopover.innerText();
            await page.screenshot({
                path: path.resolve('output/playwright/qa-automation-popover-latest.png'),
                fullPage: true,
            });
        }

        console.log(JSON.stringify(result, null, 2));
    } finally {
        await context.close();
        await browser.close();
    }
}

void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
