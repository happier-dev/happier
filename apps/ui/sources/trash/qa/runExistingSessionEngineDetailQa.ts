import path from 'node:path';
import fs from 'node:fs';

import { chromium } from '@playwright/test';

import { acknowledgeTerminalConnectSuccessIfPresent } from '../../../../../packages/tests/src/testkit/uiE2e/acknowledgeTerminalConnectSuccessIfPresent';
import { createSessionFromNewSessionComposer } from '../../../../../packages/tests/src/testkit/uiE2e/createSessionFromNewSessionComposer';
import { gotoDomContentLoadedWithPathFallback } from '../../../../../packages/tests/src/testkit/uiE2e/pageNavigation';

const baseUrl = process.env.HAPPIER_QA_BASE_URL?.trim() || 'http://happier-agent-input-popover-qa.localhost:24573';
const serverUrl = process.env.HAPPIER_QA_SERVER_URL?.trim() || 'http://localhost:24573';
const storageStatePath = process.env.HAPPIER_QA_STORAGE_STATE_IN?.trim();
const prompt = process.env.HAPPIER_QA_SESSION_PROMPT?.trim() || `engine-rail-qa ${Date.now()}`;

if (!storageStatePath) {
    throw new Error('HAPPIER_QA_STORAGE_STATE_IN is required');
}

function readSelectedMachineId(): string {
    const parsed = JSON.parse(fs.readFileSync(storageStatePath, 'utf8')) as {
        origins?: Array<{ localStorage?: Array<{ name: string; value: string }> }>;
    };
    const localStorageEntries = parsed.origins?.flatMap((origin) => origin.localStorage ?? []) ?? [];
    const draftEntry = localStorageEntries.find((entry) => entry.name === 'mmkv.default\\new-session-draft-v1');
    if (!draftEntry) {
        throw new Error('new-session draft storage entry is missing from QA storage state');
    }
    const draft = JSON.parse(draftEntry.value) as { selectedMachineId?: string | null };
    if (typeof draft.selectedMachineId !== 'string' || draft.selectedMachineId.length === 0) {
        throw new Error('selectedMachineId is missing from QA storage state draft');
    }
    return draft.selectedMachineId;
}

async function waitForQaReady(page: import('@playwright/test').Page) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 60_000) {
        if ((await page.getByTestId('new-session-composer-input').count()) > 0) return;
        if ((await page.getByTestId('agent-input-agent-chip').count()) > 0) return;
        await page.waitForTimeout(500);
    }
    throw new Error(`qa page did not reach a usable state | url=${page.url()}`);
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
        const machineId = readSelectedMachineId();
        console.error('qa:open-new');
        await gotoDomContentLoadedWithPathFallback(
            page,
            `${baseUrl}/new?server=${encodeURIComponent(serverUrl)}&happier_hmr=0`,
            '/new',
            120_000,
        );
        console.error('qa:wait-ready');
        await waitForQaReady(page);
        console.error('qa:ack-connect');
        await acknowledgeTerminalConnectSuccessIfPresent(page);
        console.error('qa:create-session');
        await createSessionFromNewSessionComposer({
            page,
            uiBaseUrl: baseUrl,
            machineId,
            prompt,
        });

        const agentChip = page.getByTestId('agent-input-agent-chip').first();
        console.error('qa:open-agent-chip');
        await agentChip.click();
        const picker = page.getByTestId('agent-input-chip-picker-popover').first();
        await picker.waitFor({ state: 'visible', timeout: 15_000 });

        const railOptions = page.locator('[data-testid^="agent-input-chip-picker.option:"]');
        const modelOptions = page.locator('[data-testid^="model-picker-overlay-option:"]');
        console.error('qa:wait-model-options');
        await modelOptions.first().waitFor({ state: 'visible', timeout: 15_000 });

        const result = {
            url: page.url(),
            railOptionCount: await railOptions.count(),
            modelOptionCount: await modelOptions.count(),
            popoverText: await picker.innerText(),
        };

        await page.screenshot({
            path: path.resolve('output/playwright/existing-session-engine-detail-only.png'),
            fullPage: true,
        });
        console.error('qa:done');

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
