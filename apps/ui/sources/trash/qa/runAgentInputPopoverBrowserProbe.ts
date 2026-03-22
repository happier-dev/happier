import path from 'node:path';

import { chromium, type Locator, type Page } from '@playwright/test';

import { acknowledgeTerminalConnectSuccessIfPresent } from '../../../../../packages/tests/src/testkit/uiE2e/acknowledgeTerminalConnectSuccessIfPresent';
import { gotoDomContentLoadedWithPathFallback } from '../../../../../packages/tests/src/testkit/uiE2e/pageNavigation';
import { waitForInitialAppUi } from '../../../../../packages/tests/src/testkit/uiE2e/waitForInitialAppUi';

const baseUrl = process.env.HAPPIER_QA_BASE_URL?.trim() || 'http://happier-agent-input-popover-qa.localhost:24573';
const serverUrl = process.env.HAPPIER_QA_SERVER_URL?.trim() || 'http://localhost:24573';
const connectUrl = process.env.HAPPIER_CONNECT_URL?.trim() || null;
const composerUrl = `${baseUrl}/new?server=${encodeURIComponent(serverUrl)}&happier_hmr=0`;

const engineScreenshotPath = path.resolve('output/playwright/qa-engine-popover-probe.png');
const mcpScreenshotPath = path.resolve('output/playwright/qa-mcp-popover-probe.png');
const pathScreenshotPath = path.resolve('output/playwright/qa-path-popover-probe.png');
const resumeScreenshotPath = path.resolve('output/playwright/qa-resume-popover-probe.png');
const automationScreenshotPath = path.resolve('output/playwright/qa-automation-popover-probe.png');
const failureScreenshotPath = path.resolve('output/playwright/qa-agent-input-probe.failure.png');

async function waitForComposer(page: Page) {
    await gotoDomContentLoadedWithPathFallback(page, composerUrl, '/new', 120_000);
    await waitForInitialAppUi({
        page,
        timeoutMs: 120_000,
        reloadOnFailure: true,
        browserDiagnostics: () => `url=${page.url()}`,
    });
    await acknowledgeTerminalConnectSuccessIfPresent(page);
    try {
        await page.getByTestId('agent-input-agent-chip').first().waitFor({
            state: 'visible',
            timeout: 20_000,
        });
        return;
    } catch {
        const startNewSessionCandidates = [
            page.getByTestId('main-header-start-new-session').first(),
            page.getByTestId('home-header-start-new-session').first(),
            page.getByTestId('session-getting-started-start-new-session').first(),
        ];

        for (const candidate of startNewSessionCandidates) {
            if (!(await candidate.count())) {
                continue;
            }
            await candidate.click();
            try {
                await page.getByTestId('agent-input-agent-chip').first().waitFor({
                    state: 'visible',
                    timeout: 20_000,
                });
                return;
            } catch {
                // Try the next visible route to the composer.
            }
        }

        await page.getByTestId('agent-input-agent-chip').first().waitFor({
            state: 'visible',
            timeout: 20_000,
        });
    }
}

async function waitForTerminalConnectSettle(page: Page) {
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

async function connectIfNeeded(page: Page) {
    if (!connectUrl) {
        return;
    }

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
}

async function clickChip(page: Page, testId: string) {
    await page.getByTestId(testId).first().waitFor({ state: 'visible', timeout: 15_000 });
    await page.getByTestId(testId).first().click();
    await page.getByTestId('agent-input-content-popover').waitFor({
        state: 'visible',
        timeout: 15_000,
    });
}

function popoverScope(page: Page): Locator {
    return page.getByTestId('agent-input-content-popover').first();
}

async function ensureResumeCapableAgent(page: Page) {
    const resumeChip = page.getByTestId('agent-input-resume-chip');
    if (await resumeChip.count()) return;

    await page.getByTestId('agent-input-agent-chip').first().click();
    await page.getByTestId('agent-input-chip-picker').waitFor({
        state: 'visible',
        timeout: 15_000,
    });

    for (const candidateId of ['agent:claude', 'agent:opencode', 'agent:gemini']) {
        const option = page.getByTestId(`agent-input-chip-picker.option:${candidateId}`).first();
        if (!(await option.count())) continue;
        await option.click();
        await page.waitForTimeout(400);
        if (await resumeChip.count()) {
            return;
        }
        await page.getByTestId('agent-input-agent-chip').first().click();
    }
}

async function collectTopPositions(locator: Locator): Promise<number[]> {
    return await locator.evaluateAll((nodes) => nodes.map((node) => Math.round((node as HTMLElement).getBoundingClientRect().top)));
}

async function describeHitTarget(page: Page, locator: Locator) {
    return await locator.evaluate((node) => {
        const element = node as HTMLElement;
        const rect = element.getBoundingClientRect();
        const x = rect.left + (rect.width / 2);
        const y = rect.top + (rect.height / 2);
        const hit = document.elementFromPoint(x, y) as HTMLElement | null;
        return {
            targetTag: hit?.tagName ?? null,
            targetTestId: hit?.getAttribute('data-testid') ?? null,
            targetRole: hit?.getAttribute('role') ?? null,
            targetClassName: hit?.className ?? null,
            targetOuter: hit?.outerHTML?.slice(0, 280) ?? null,
            x,
            y,
        };
    });
}

async function describeFocusability(locator: Locator) {
    return await locator.evaluate(async (node) => {
        const element = node as HTMLElement;
        const lineage: Array<{
            tag: string;
            testId: string | null;
            role: string | null;
            inert: boolean;
            ariaHidden: string | null;
            tabIndex: string | null;
            className: string;
        } | null> = [];
        let current: HTMLElement | null = element;
        for (let depth = 0; depth < 8 && current; depth += 1) {
            lineage.push({
                tag: current.tagName,
                testId: current.getAttribute('data-testid'),
                role: current.getAttribute('role'),
                inert: current.hasAttribute('inert'),
                ariaHidden: current.getAttribute('aria-hidden'),
                tabIndex: current.getAttribute('tabindex'),
                className: current.className,
            });
            current = current.parentElement;
        }

        try {
            element.focus();
        } catch {
            // Best-effort browser probe only.
        }
        await new Promise((resolve) => window.setTimeout(resolve, 30));

        const activeElement = document.activeElement as HTMLElement | null;
        const inertAncestor = element.closest('[inert]') as HTMLElement | null;
        const ariaHiddenAncestor = element.closest('[aria-hidden="true"]') as HTMLElement | null;

        return {
            tag: element.tagName,
            disabled: 'disabled' in element ? Boolean((element as HTMLInputElement).disabled) : null,
            readOnly: 'readOnly' in element ? Boolean((element as HTMLInputElement).readOnly) : null,
            tabIndex: element.getAttribute('tabindex'),
            pointerEvents: window.getComputedStyle(element).pointerEvents,
            closestChipTestId: element.closest('[data-testid$="-chip"]')?.getAttribute('data-testid') ?? null,
            closestPopoverTestId: element.closest('[data-testid="agent-input-content-popover"]')?.getAttribute('data-testid') ?? null,
            closestInertAncestor: inertAncestor
                ? {
                    tag: inertAncestor.tagName,
                    testId: inertAncestor.getAttribute('data-testid'),
                    role: inertAncestor.getAttribute('role'),
                    inert: inertAncestor.hasAttribute('inert'),
                    ariaHidden: inertAncestor.getAttribute('aria-hidden'),
                    tabIndex: inertAncestor.getAttribute('tabindex'),
                    className: inertAncestor.className,
                }
                : null,
            closestAriaHiddenAncestor: ariaHiddenAncestor
                ? {
                    tag: ariaHiddenAncestor.tagName,
                    testId: ariaHiddenAncestor.getAttribute('data-testid'),
                    role: ariaHiddenAncestor.getAttribute('role'),
                    inert: ariaHiddenAncestor.hasAttribute('inert'),
                    ariaHidden: ariaHiddenAncestor.getAttribute('aria-hidden'),
                    tabIndex: ariaHiddenAncestor.getAttribute('tabindex'),
                    className: ariaHiddenAncestor.className,
                }
                : null,
            activeElementTag: activeElement?.tagName ?? null,
            activeElementTestId: activeElement?.getAttribute('data-testid') ?? null,
            activeElementOuter: activeElement?.outerHTML?.slice(0, 280) ?? null,
            lineage,
        };
    });
}

async function main() {
    const browser = await chromium.launch({ headless: true, ignoreHTTPSErrors: true });
    const context = await browser.newContext({
        viewport: { width: 1440, height: 1100 },
        ignoreHTTPSErrors: true,
    });

    const results: Record<string, unknown> = {
        url: composerUrl,
    };

    try {
        const page = context.pages()[0] ?? await context.newPage();
        const consoleMessages: string[] = [];
        page.on('console', (message) => {
            consoleMessages.push(`[${message.type()}] ${message.text()}`);
        });

        await connectIfNeeded(page);
        await waitForComposer(page);

        await page.getByTestId('agent-input-agent-chip').first().click();
        await page.getByTestId('agent-input-chip-picker').waitFor({ state: 'visible', timeout: 15_000 });
        const modelTiles = page.locator('[data-testid^="model-picker-overlay-option:"]');
        await modelTiles.first().waitFor({ state: 'visible', timeout: 15_000 });
        const tileTopPositions = await collectTopPositions(modelTiles);
        const tileLayout = await modelTiles.first().evaluate((node) => {
            const rect = (node as HTMLElement).getBoundingClientRect();
            const parent = (node as HTMLElement).parentElement as HTMLElement | null;
            const parentRect = parent?.getBoundingClientRect?.() ?? null;
            const grandParent = parent?.parentElement as HTMLElement | null;
            const grandParentRect = grandParent?.getBoundingClientRect?.() ?? null;
            return {
                tileWidth: Math.round(rect.width),
                parentWidth: parentRect ? Math.round(parentRect.width) : null,
                grandParentWidth: grandParentRect ? Math.round(grandParentRect.width) : null,
            };
        });
        results.engineTileCount = tileTopPositions.length;
        results.engineUniqueRows = [...new Set(tileTopPositions)].length;
        results.engineTwoColumn = [...new Set(tileTopPositions)].length < tileTopPositions.length;
        results.engineTileLayout = tileLayout;
        await page.screenshot({ path: engineScreenshotPath, fullPage: true });
        await page.getByTestId('agent-input-agent-chip').first().click();

        await clickChip(page, 'agent-input-path-chip');
        const pathInput = popoverScope(page).getByPlaceholder('Enter a path...').first();
        await pathInput.click();
        await pathInput.fill('/tmp/happier-path-probe');
        results.pathInputTag = await pathInput.evaluate((node) => node.tagName);
        results.pathHitTarget = await describeHitTarget(page, pathInput);
        results.pathFocusability = await describeFocusability(pathInput);
        results.pathValue = await pathInput.inputValue();
        results.pathActiveElementTag = await page.evaluate(() => document.activeElement?.tagName ?? null);
        results.pathActiveElementOuter = await page.evaluate(() => document.activeElement?.outerHTML?.slice(0, 280) ?? null);
        await page.screenshot({ path: pathScreenshotPath, fullPage: true });
        await page.getByTestId('agent-input-path-chip').first().click();

        await ensureResumeCapableAgent(page);
        await clickChip(page, 'agent-input-resume-chip');
        const resumeInput = popoverScope(page).getByPlaceholder(/Paste .* session ID/i).first();
        const fallbackResumeInput = popoverScope(page).locator('textarea, input').first();
        const resolvedResumeInput = (await resumeInput.count()) > 0 ? resumeInput : fallbackResumeInput;
        await resolvedResumeInput.click();
        await resolvedResumeInput.fill('session-probe-id');
        results.resumeInputTag = await resolvedResumeInput.evaluate((node) => node.tagName);
        results.resumeHitTarget = await describeHitTarget(page, resolvedResumeInput);
        results.resumeFocusability = await describeFocusability(resolvedResumeInput);
        results.resumeValue = await resolvedResumeInput.inputValue();
        results.resumeActiveElementTag = await page.evaluate(() => document.activeElement?.tagName ?? null);
        results.resumeActiveElementOuter = await page.evaluate(() => document.activeElement?.outerHTML?.slice(0, 280) ?? null);
        await page.screenshot({ path: resumeScreenshotPath, fullPage: true });
        await page.getByTestId('agent-input-resume-chip').first().click();

        await clickChip(page, 'new-session-mcp-chip');
        const mcpSignals = [
            page.getByTestId('new-session.mcp.loading'),
            page.getByTestId('new-session.mcp.empty'),
            page.getByTestId('new-session.mcp.error'),
            page.locator('[data-testid^="new-session.mcp.row."]').first(),
            page.locator('[data-testid^="new-session.mcp.detected."]').first(),
        ];
        for (const signal of mcpSignals) {
            if (await signal.count()) {
                await signal.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => undefined);
                break;
            }
        }
        results.mcpVisibleText = await page.getByTestId('agent-input-content-popover').innerText();
        await page.screenshot({ path: mcpScreenshotPath, fullPage: true });
        await page.getByTestId('new-session-mcp-chip').first().click();

        const automationChip = page.getByTestId('new-session-automation-chip').first();
        results.automationChipVisible = await automationChip.isVisible().catch(() => false);
        if (results.automationChipVisible) {
            await automationChip.click();
            await page.getByTestId('agent-input-content-popover').waitFor({ state: 'visible', timeout: 15_000 });
            const scheduleTrigger = popoverScope(page).getByText('Schedule', { exact: true }).first();
            await scheduleTrigger.click();
            const dropdown = page.getByText('Interval', { exact: true }).first();
            await dropdown.waitFor({ state: 'visible', timeout: 15_000 });
            const triggerBox = await scheduleTrigger.boundingBox();
            const dropdownBox = await dropdown.boundingBox();
            results.automationScheduleTriggerY = triggerBox?.y ?? null;
            results.automationScheduleDropdownY = dropdownBox?.y ?? null;
            results.automationScheduleAnchoredBelow =
                typeof triggerBox?.y === 'number' &&
                typeof dropdownBox?.y === 'number' &&
                dropdownBox.y >= triggerBox.y;
            await page.screenshot({ path: automationScreenshotPath, fullPage: true });
        }

        results.consoleMessages = consoleMessages;
        console.log(JSON.stringify(results, null, 2));
    } catch (error) {
        const page = context.pages()[0];
        if (page) {
            await page.screenshot({ path: failureScreenshotPath, fullPage: true }).catch(() => undefined);
        }
        throw error;
    } finally {
        await context.close();
        await browser.close();
    }
}

void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
