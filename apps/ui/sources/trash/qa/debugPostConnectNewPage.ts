import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';

import { chromium } from '@playwright/test';

import { acknowledgeTerminalConnectSuccessIfPresent } from '../../../../../packages/tests/src/testkit/uiE2e/acknowledgeTerminalConnectSuccessIfPresent';
import { gotoDomContentLoadedWithPathFallback } from '../../../../../packages/tests/src/testkit/uiE2e/pageNavigation';
import { waitForInitialAppUi } from '../../../../../packages/tests/src/testkit/uiE2e/waitForInitialAppUi';

const baseUrl = process.env.HAPPIER_QA_BASE_URL?.trim() || 'http://localhost:24573';
const serverUrl = process.env.HAPPIER_QA_SERVER_URL?.trim() || 'http://127.0.0.1:24573';
const connectUrl = process.env.HAPPIER_CONNECT_URL?.trim();
const postConnectCommand = process.env.HAPPIER_QA_POST_CONNECT_COMMAND?.trim();
const waitForPath = process.env.HAPPIER_QA_WAIT_FOR_PATH?.trim();
const openChipTestId = process.env.HAPPIER_QA_OPEN_CHIP?.trim();
const storageStatePath = process.env.HAPPIER_QA_STORAGE_STATE_PATH?.trim();
const storageStateInPath = process.env.HAPPIER_QA_STORAGE_STATE_IN?.trim();
const fillTestId = process.env.HAPPIER_QA_FILL_TESTID?.trim();
const fillValue = process.env.HAPPIER_QA_FILL_VALUE ?? '';
const expectedPopoverTestId = process.env.HAPPIER_QA_EXPECTED_POPOVER_TESTID?.trim();

if (!connectUrl && !storageStateInPath) {
    throw new Error('HAPPIER_CONNECT_URL is required');
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

async function main() {
    const browser = await chromium.launch({ headless: true, ignoreHTTPSErrors: true });
    const context = await browser.newContext({
        viewport: { width: 1440, height: 1100 },
        ignoreHTTPSErrors: true,
        storageState: storageStateInPath || undefined,
    });

    try {
        const page = await context.newPage();

        if (!storageStateInPath) {
            await gotoDomContentLoadedWithPathFallback(page, connectUrl!, '/terminal/connect', 120_000);
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

            const acceptConnection = page.getByTestId('terminal-connect-approve').first();
            await acceptConnection.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => undefined);
            if (await acceptConnection.count()) {
                await acceptConnection.click();
            }

            await waitForTerminalConnectSettle(page);
            await acknowledgeTerminalConnectSuccessIfPresent(page);

            if (waitForPath) {
                for (let attempt = 0; attempt < 60; attempt += 1) {
                    if (fs.existsSync(waitForPath)) {
                        break;
                    }
                    await page.waitForTimeout(1_000);
                }
            }

            if (postConnectCommand) {
                const child = spawn('sh', ['-lc', `${postConnectCommand} >/tmp/happier-qa-post-connect.log 2>&1`], {
                    cwd: process.cwd(),
                    stdio: 'ignore',
                    env: process.env,
                    detached: true,
                });
                child.unref();

                for (let attempt = 0; attempt < 30; attempt += 1) {
                    try {
                        const response = await fetch(`${serverUrl}/health`);
                        if (response.ok) {
                            break;
                        }
                    } catch {
                        // Wait for the restarted runtime to become healthy.
                    }
                    await page.waitForTimeout(1_000);
                }
            }
        }

        await page.goto(
            `${baseUrl}/new?server=${encodeURIComponent(serverUrl)}&happier_hmr=0`,
            { waitUntil: 'domcontentloaded' },
        );
        await page.waitForTimeout(8_000);

        if (openChipTestId) {
            const chip = page.getByTestId(openChipTestId).first();
            await chip.waitFor({ state: 'visible', timeout: 15_000 });
            await chip.click();
            const expectedPopoverIds = expectedPopoverTestId
                ? [expectedPopoverTestId]
                : ['agent-input-content-popover', 'agent-input-chip-picker-popover'];
            let popoverOpened = false;
            for (const popoverId of expectedPopoverIds) {
                try {
                    await page.getByTestId(popoverId).waitFor({
                        state: 'visible',
                        timeout: 2_500,
                    });
                    popoverOpened = true;
                    break;
                } catch {
                    // Try the next compatible popover surface.
                }
            }
            if (!popoverOpened) {
                throw new Error(`no compatible popover became visible after clicking ${openChipTestId}`);
            }
            await page.waitForTimeout(1_000);
        }

        if (fillTestId) {
            const input = page.getByTestId(fillTestId).first();
            await input.waitFor({ state: 'visible', timeout: 15_000 });
            await input.click();
            await input.fill(fillValue);
            await page.waitForTimeout(500);
        }

        const data = await page.evaluate(() => ({
            url: location.href,
            body: document.body.innerText.slice(0, 4_000),
            cookie: document.cookie,
            testIds: Array.from(document.querySelectorAll('[data-testid]'))
                .map((node) => node.getAttribute('data-testid'))
                .filter((value): value is string => typeof value === 'string')
                .slice(0, 200),
            localStorage: Object.fromEntries(
                Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)]),
            ),
            sessionStorage: Object.fromEntries(
                Object.keys(sessionStorage).map((key) => [key, sessionStorage.getItem(key)]),
            ),
            activeElement: document.activeElement instanceof HTMLElement
                ? {
                    tagName: document.activeElement.tagName,
                    testId: document.activeElement.getAttribute('data-testid'),
                    ariaLabel: document.activeElement.getAttribute('aria-label'),
                    value: 'value' in document.activeElement
                        ? String((document.activeElement as HTMLInputElement | HTMLTextAreaElement).value ?? '')
                        : null,
                }
                : null,
        }));

        console.log(JSON.stringify(data, null, 2));
        if (storageStatePath) {
            await context.storageState({ path: storageStatePath });
        }
        await page.screenshot({
            path: path.resolve('output/playwright/post-connect-new-debug.png'),
            fullPage: true,
        });
    } finally {
        await context.close();
        await browser.close();
    }
}

void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
