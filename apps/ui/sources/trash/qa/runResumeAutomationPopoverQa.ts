import path from 'node:path';
import { exec as execCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from '@playwright/test';

import { acknowledgeTerminalConnectSuccessIfPresent } from '../../../../../packages/tests/src/testkit/uiE2e/acknowledgeTerminalConnectSuccessIfPresent';
import { gotoDomContentLoadedWithPathFallback } from '../../../../../packages/tests/src/testkit/uiE2e/pageNavigation';
import { waitForInitialAppUi } from '../../../../../packages/tests/src/testkit/uiE2e/waitForInitialAppUi';

const baseUrl = process.env.HAPPIER_QA_BASE_URL?.trim() || 'http://happier-agent-input-popover-qa.localhost:24573';
const serverUrl = process.env.HAPPIER_QA_SERVER_URL?.trim() || 'http://localhost:24573';
const composerUrl = `${baseUrl}/new?server=${encodeURIComponent(serverUrl)}&happier_hmr=0`;
const connectUrl = process.env.HAPPIER_CONNECT_URL?.trim() || null;
const afterConnectCommand = process.env.HAPPIER_QA_AFTER_CONNECT_CMD?.trim() || null;
const resumeScreenshotPath = path.resolve('output/playwright/qa-resume-popover-latest.png');
const automationScreenshotPath = path.resolve('output/playwright/qa-automation-popover-latest.png');
const execAsync = promisify(execCallback);

async function waitForComposer(page: import('@playwright/test').Page) {
    await gotoDomContentLoadedWithPathFallback(page, composerUrl, '/new', 120_000);
    await waitForInitialAppUi({
        page,
        timeoutMs: 120_000,
        reloadOnFailure: true,
        browserDiagnostics: () => `url=${page.url()}`,
    });
    await acknowledgeTerminalConnectSuccessIfPresent(page);
    await page.getByTestId('agent-input-agent-chip').first().waitFor({
        state: 'visible',
        timeout: 20_000,
    });
}

async function waitForTerminalConnectSettle(page: import('@playwright/test').Page) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 60_000) {
        const pathname = new URL(page.url()).pathname;
        const hasComposer = (await page.getByTestId('session-composer-input').count()) > 0;
        const hasConnectMachine = (await page.getByTestId('session-getting-started-kind-connect_machine').count()) > 0;
        const hasOk = (await page.getByRole('button', { name: 'OK' }).count()) > 0;
        if (hasComposer || hasConnectMachine || hasOk || pathname !== '/terminal/connect') {
            return;
        }
        await page.waitForTimeout(500);
    }
    throw new Error(`terminal connect did not settle | url=${page.url()}`);
}

async function ensureResumeCapableAgent(page: import('@playwright/test').Page) {
    const resumeChip = page.getByTestId('agent-input-resume-chip');
    if (await resumeChip.count()) {
        return;
    }

    await page.getByTestId('agent-input-agent-chip').first().click();
    await page.getByTestId('agent-input-chip-picker').waitFor({
        state: 'visible',
        timeout: 15_000,
    });

    for (const candidateId of ['agent:claude', 'agent:opencode', 'agent:gemini']) {
        const option = page.getByTestId(`agent-input-chip-picker.option:${candidateId}`).first();
        if (!(await option.count())) continue;
        await option.click();
        await page.getByTestId('agent-input-agent-chip').first().click();
        await page.waitForTimeout(300);
        if (await resumeChip.count()) {
            return;
        }
    }

    throw new Error('resume chip not visible after selecting resume-capable agent candidates');
}

async function main() {
    const browser = await chromium.launch({ headless: true, ignoreHTTPSErrors: true });
    const context = await browser.newContext({
        viewport: { width: 1440, height: 1100 },
        ignoreHTTPSErrors: true,
    });

    try {
        const page = context.pages()[0] ?? await context.newPage();

        if (connectUrl) {
            await gotoDomContentLoadedWithPathFallback(page, connectUrl, '/terminal/connect', 120_000);
            await waitForInitialAppUi({
                page,
                timeoutMs: 120_000,
                reloadOnFailure: true,
                browserDiagnostics: () => `url=${page.url()}`,
            });

            const createAccount = page.getByTestId('welcome-create-account');
            if (await createAccount.count()) {
                await createAccount.first().click();
            }
            const acceptConnection = page.getByRole('button', { name: 'Accept Connection' });
            if (await acceptConnection.count()) {
                await acceptConnection.first().click();
            }

            await waitForTerminalConnectSettle(page);
            await acknowledgeTerminalConnectSuccessIfPresent(page);
            if (afterConnectCommand) {
                await execAsync(afterConnectCommand, {
                    cwd: process.cwd(),
                    env: process.env,
                });
                await page.waitForTimeout(3_000);
            }
        }

        await waitForComposer(page);
        await ensureResumeCapableAgent(page);

        const resumeChip = page.getByTestId('agent-input-resume-chip').first();
        await resumeChip.click();
        await page.getByText('Paste', { exact: true }).first().waitFor({
            state: 'visible',
            timeout: 15_000,
        });
        await page.getByText('Save', { exact: true }).first().waitFor({
            state: 'visible',
            timeout: 15_000,
        });
        await page.screenshot({ path: resumeScreenshotPath, fullPage: true });
        await resumeChip.click();
        await page.waitForTimeout(300);

        const automationChip = page.getByTestId('new-session-automation-chip').first();
        await automationChip.waitFor({ state: 'visible', timeout: 15_000 });
        await automationChip.click();
        await page.getByTestId('agent-input-content-popover').waitFor({
            state: 'visible',
            timeout: 15_000,
        });
        await page.screenshot({ path: automationScreenshotPath, fullPage: true });

        console.log(JSON.stringify({
            resumeScreenshotPath,
            automationScreenshotPath,
            url: page.url(),
        }, null, 2));
    } finally {
        await context.close();
        await browser.close();
    }
}

void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
