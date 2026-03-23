import path from 'node:path';
import { exec as execCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium, type Page } from '@playwright/test';

import { acknowledgeTerminalConnectSuccessIfPresent } from '../../../../../packages/tests/src/testkit/uiE2e/acknowledgeTerminalConnectSuccessIfPresent';
import { gotoDomContentLoadedWithPathFallback } from '../../../../../packages/tests/src/testkit/uiE2e/pageNavigation';
import { waitForInitialAppUi } from '../../../../../packages/tests/src/testkit/uiE2e/waitForInitialAppUi';

const baseUrl = process.env.HAPPIER_QA_BASE_URL?.trim() || 'http://happier-agent-input-popover-qa.localhost:24573';
const serverUrl = process.env.HAPPIER_QA_SERVER_URL?.trim() || 'http://localhost:24573';
const composerUrl = `${baseUrl}/new?server=${encodeURIComponent(serverUrl)}&happier_hmr=0`;
const profilesSettingsUrl = `${baseUrl}/settings/profiles?server=${encodeURIComponent(serverUrl)}&happier_hmr=0`;
const connectUrl = process.env.HAPPIER_CONNECT_URL?.trim() || null;
const afterConnectCommand = process.env.HAPPIER_QA_AFTER_CONNECT_CMD?.trim() || null;
const screenshotPath = path.resolve('output/playwright/qa-popover-sweep-resume-fix.png');
const failureScreenshotPath = path.resolve('output/playwright/qa-popover-sweep-resume-fix.failure.png');
const enginePickerScreenshotPath = path.resolve('output/playwright/qa-engine-picker-compact.png');
const pathPopoverScreenshotPath = path.resolve('output/playwright/qa-path-popover-latest.png');
const mcpPopoverScreenshotPath = path.resolve('output/playwright/qa-mcp-popover-latest.png');
const profilePopoverScreenshotPath = path.resolve('output/playwright/qa-profile-popover-latest.png');
const automationPopoverScreenshotPath = path.resolve('output/playwright/qa-automation-popover-latest.png');

const mcpContentSelector = [
    '[data-testid="new-session.mcp.loading"]',
    '[data-testid="new-session.mcp.managed-enabled"]',
    '[data-testid="new-session.mcp.empty"]',
    '[data-testid="new-session.mcp.error"]',
    '[data-testid^="new-session.mcp.row."]',
    '[data-testid^="new-session.mcp.detected."]',
].join(', ');
const execAsync = promisify(execCallback);

async function waitForAnyVisible(page: Page, selectors: ReadonlyArray<{ kind: 'testId' | 'placeholder' | 'text'; value: string }>, timeoutMs: number) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        for (const selector of selectors) {
            const locator = selector.kind === 'testId'
                ? page.getByTestId(selector.value).first()
                : selector.kind === 'placeholder'
                    ? page.getByPlaceholder(selector.value).first()
                    : page.getByText(selector.value, { exact: true }).first();
            if (await locator.isVisible().catch(() => false)) {
                return selector;
            }
        }
        await page.waitForTimeout(250);
    }
    throw new Error(`none of the expected selectors became visible within ${timeoutMs}ms: ${JSON.stringify(selectors)}`);
}

const result = {
    url: composerUrl,
    authenticatedComposer: false,
    machinePopover: false,
    pathPopover: false,
    pathSearchVisible: false,
    resumePopover: false,
    mcpChipPresent: false,
    mcpPopover: false,
    mcpTogglesClosedOnSecondClick: false,
    mcpClosesWhenAgentOpens: false,
    profileChipPresent: false,
    profilePopover: false,
    profilePopoverTitleRemoved: false,
    automationChipPresent: false,
    automationPopover: false,
    enginePicker: false,
    engineOptionCount: 0,
    notes: [] as string[],
};

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
    } catch (error) {
        await page.screenshot({ path: failureScreenshotPath, fullPage: true });
        const visibleSignals = {
            url: page.url(),
            connectMachine: await page.getByTestId('session-getting-started-kind-connect_machine').count(),
            welcomeCreateAccount: await page.getByTestId('welcome-create-account').count(),
            welcomeSignupProvider: await page.getByTestId('welcome-signup-provider').count(),
            welcomeRestore: await page.getByTestId('welcome-restore').count(),
            welcomeMtlsLogin: await page.getByTestId('welcome-mtls-login').count(),
            composerInput: await page.getByTestId('session-composer-input').count(),
            automationChip: await page.getByTestId('new-session-automation-chip').count(),
            machineChip: await page.getByTestId('agent-input-machine-chip').count(),
            failureScreenshotPath,
        };
        console.error(JSON.stringify(visibleSignals, null, 2));
        throw error;
    }
}

async function ensureProfilesEnabled(page: Page): Promise<boolean> {
    console.log('[qa] ensuring profiles are enabled via /settings/profiles');
    await page.goto(profilesSettingsUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await acknowledgeTerminalConnectSuccessIfPresent(page);
    await page.waitForTimeout(1500);

    const checkbox = page.getByRole('checkbox').first();
    if (!(await checkbox.count())) {
        console.log('[qa] no checkbox found on /settings/profiles; assuming profiles are already enabled on this route');
        return true;
    }

    const checked = await checkbox.isChecked().catch(async () => {
        const ariaChecked = await checkbox.getAttribute('aria-checked').catch(() => null);
        return ariaChecked === 'true';
    });

    if (!checked) {
        console.log('[qa] profiles toggle is off; enabling it');
        await checkbox.click();
        await page.waitForTimeout(400);
    } else {
        console.log('[qa] profiles toggle already enabled');
    }

    return true;
}

async function ensureResumeCapableAgent(page: Page): Promise<string | null> {
    const resumeChip = page.getByTestId('agent-input-resume-chip');
    if (await resumeChip.count()) {
        console.log('[qa] resume chip already visible for current agent');
        return null;
    }

    console.log('[qa] resume chip absent; switching to a resume-capable agent');
    await page.getByTestId('agent-input-agent-chip').first().click();
    await page.getByTestId('agent-input-chip-picker').waitFor({
        state: 'visible',
        timeout: 15_000,
    });

    const candidateIds = ['agent:claude', 'agent:opencode', 'agent:gemini'];
    for (const candidateId of candidateIds) {
        const option = page.getByTestId(`agent-input-chip-picker.option:${candidateId}`).first();
        if (!(await option.count())) continue;
        console.log(`[qa] trying candidate agent ${candidateId}`);
        await option.click();
        await page.screenshot({ path: enginePickerScreenshotPath, fullPage: true });
        await page.getByTestId('agent-input-agent-chip').first().click();
        await page.waitForTimeout(500);
        if (await resumeChip.count()) {
            console.log(`[qa] resume chip became visible after selecting ${candidateId}`);
            return candidateId;
        }
    }

    if (await page.getByTestId('agent-input-chip-picker').count()) {
        await page.getByTestId('agent-input-agent-chip').first().click();
        await page.waitForTimeout(300);
    }

    return null;
}

async function main() {
    const browser = await chromium.launch({
        headless: true,
        ignoreHTTPSErrors: true,
    });
    const context = await browser.newContext({
        viewport: { width: 1440, height: 1100 },
        ignoreHTTPSErrors: true,
    });

    try {
        const page = context.pages()[0] ?? await context.newPage();

        if (connectUrl) {
            console.log(`[qa] opening connect URL: ${connectUrl}`);
            await gotoDomContentLoadedWithPathFallback(page, connectUrl, '/terminal/connect', 120_000);
            await waitForInitialAppUi({
                page,
                timeoutMs: 120_000,
                reloadOnFailure: true,
                browserDiagnostics: () => `url=${page.url()}`,
            });
            const createAccount = page.getByTestId('welcome-create-account');
            if (await createAccount.count()) {
                console.log('[qa] create-account visible on terminal connect page; clicking it');
                await createAccount.first().click();
            } else {
                console.log('[qa] create-account not visible on terminal connect page');
            }
            const acceptConnection = page.getByRole('button', { name: 'Accept Connection' });
            if (await acceptConnection.count()) {
                console.log('[qa] accept-connection visible; approving terminal connect');
                await acceptConnection.first().click();
            }
            await waitForTerminalConnectSettle(page);
            console.log(`[qa] terminal connect settled at ${page.url()}`);
            await acknowledgeTerminalConnectSuccessIfPresent(page);
            if (afterConnectCommand) {
                console.log(`[qa] running post-connect command: ${afterConnectCommand}`);
                await execAsync(afterConnectCommand, {
                    cwd: process.cwd(),
                    env: process.env,
                });
                await page.waitForTimeout(3_000);
            }
            result.notes.push(`used connectUrl=${connectUrl}`);
        }

        console.log(`[qa] navigating to composer: ${composerUrl}`);
        await waitForComposer(page);
        console.log(`[qa] composer initial UI ready at ${page.url()}`);

        try {
            await page.getByTestId('agent-input-agent-chip').first().waitFor({
                state: 'visible',
                timeout: 20_000,
            });
        } catch (error) {
            await page.screenshot({ path: failureScreenshotPath, fullPage: true });
            const visibleSignals = {
                url: page.url(),
                connectMachine: await page.getByTestId('session-getting-started-kind-connect_machine').count(),
                welcomeCreateAccount: await page.getByTestId('welcome-create-account').count(),
                welcomeSignupProvider: await page.getByTestId('welcome-signup-provider').count(),
                welcomeRestore: await page.getByTestId('welcome-restore').count(),
                welcomeMtlsLogin: await page.getByTestId('welcome-mtls-login').count(),
                sidebarExpand: await page.getByTestId('sidebar-expand-button').count(),
                composerInput: await page.getByTestId('session-composer-input').count(),
                agentChip: await page.getByTestId('agent-input-agent-chip').count(),
                failureScreenshotPath,
            };
            console.error(JSON.stringify(visibleSignals, null, 2));
            throw error;
        }
        result.authenticatedComposer = true;
        console.log('[qa] composer chip surface is visible');

        console.log('[qa] opening engine picker');
        await page.getByTestId('agent-input-agent-chip').first().click();
        await page.getByTestId('agent-input-chip-picker').waitFor({
            state: 'visible',
            timeout: 15_000,
        });
        result.enginePicker = true;
        result.engineOptionCount = await page.locator('[data-testid^="agent-input-chip-picker.option:"]').count();
        await page.screenshot({ path: enginePickerScreenshotPath, fullPage: true });
        await page.getByTestId('agent-input-agent-chip').first().click();
        await page.waitForTimeout(250);

        console.log('[qa] opening machine popover');
        await page.getByTestId('agent-input-machine-chip').waitFor({ state: 'visible', timeout: 15_000 });
        await page.getByTestId('agent-input-machine-chip').click();
        await page.getByTestId('agent-input-content-popover').waitFor({
            state: 'visible',
            timeout: 15_000,
        });
        result.machinePopover = true;
        const machineSearchVisible = await page.getByPlaceholder('Search machines...').count().then((count) => count > 0);
        result.notes.push(machineSearchVisible ? 'machine search visible' : 'machine search hidden in current stack state');
        await page.getByTestId('agent-input-machine-chip').click();
        await page.waitForTimeout(250);

        console.log('[qa] opening path popover');
        await page.getByTestId('agent-input-path-chip').waitFor({ state: 'visible', timeout: 15_000 });
        await page.getByTestId('agent-input-path-chip').click();
        await waitForAnyVisible(page, [
            { kind: 'placeholder', value: 'Search paths...' },
            { kind: 'testId', value: 'path-selector-input' },
        ], 15_000);
        result.pathPopover = true;
        result.pathSearchVisible = await page.getByPlaceholder('Search paths...').count().then((count) => count > 0);
        await page.screenshot({ path: pathPopoverScreenshotPath, fullPage: true });
        await page.getByTestId('agent-input-path-chip').click();
        await page.waitForTimeout(250);

        const resumeCandidateId = await ensureResumeCapableAgent(page);
        if (resumeCandidateId) {
            result.notes.push(`selected resume-capable agent ${resumeCandidateId}`);
        }

        console.log('[qa] opening resume popover');
        const resumeChip = page.getByTestId('agent-input-resume-chip');
        if (await resumeChip.count()) {
            await resumeChip.waitFor({ state: 'visible', timeout: 15_000 });
            await resumeChip.click();
            await page.getByText('Paste', { exact: true }).first().waitFor({
                state: 'visible',
                timeout: 15_000,
            });
            await page.getByText('Save', { exact: true }).first().waitFor({
                state: 'visible',
                timeout: 15_000,
            });
            result.resumePopover = true;
            await resumeChip.click();
            await page.waitForTimeout(250);
        } else {
            result.notes.push('resume chip not visible in current composer state');
        }

        const mcpChip = page.getByTestId('new-session-mcp-chip');
        if (await mcpChip.count()) {
            console.log('[qa] opening mcp popover');
            result.mcpChipPresent = true;
            await mcpChip.first().click();
            await page.waitForTimeout(500);
            await page.screenshot({ path: mcpPopoverScreenshotPath, fullPage: true });
            const mcpDebugCounts = {
                contentPopover: await page.getByTestId('agent-input-content-popover').count(),
                genericPopover: await page.getByTestId('generic-content-popover').count(),
                mcpLoading: await page.getByTestId('new-session.mcp.loading').count(),
                mcpManaged: await page.getByTestId('new-session.mcp.managed-enabled').count(),
                mcpEmpty: await page.getByTestId('new-session.mcp.empty').count(),
                mcpError: await page.getByTestId('new-session.mcp.error').count(),
            };
            console.log(`[qa] mcp debug counts: ${JSON.stringify(mcpDebugCounts)}`);
            await waitForAnyVisible(page, [
                { kind: 'testId', value: 'agent-input-content-popover' },
                { kind: 'testId', value: 'new-session.mcp.loading' },
                { kind: 'testId', value: 'new-session.mcp.managed-enabled' },
                { kind: 'testId', value: 'new-session.mcp.empty' },
                { kind: 'testId', value: 'new-session.mcp.error' },
                { kind: 'text', value: 'Loading...' },
            ], 15_000);
            result.mcpPopover = true;
            await page.screenshot({ path: mcpPopoverScreenshotPath, fullPage: true });

            await mcpChip.first().click();
            await page.waitForTimeout(250);
            result.mcpTogglesClosedOnSecondClick = !(await page.locator(mcpContentSelector).first().isVisible().catch(() => false));

            if (!result.mcpTogglesClosedOnSecondClick) {
                await mcpChip.first().click();
                await page.locator(mcpContentSelector).first().waitFor({
                    state: 'visible',
                    timeout: 15_000,
                });
            }

            console.log('[qa] opening agent picker to verify MCP closes');
            await page.getByTestId('agent-input-agent-chip').first().click();
            await page.getByTestId('agent-input-chip-picker').waitFor({
                state: 'visible',
                timeout: 15_000,
            });
            const mcpStillVisible = await page.locator(mcpContentSelector).first().isVisible().catch(() => false);
            result.mcpClosesWhenAgentOpens = !mcpStillVisible;
            await page.getByTestId('agent-input-agent-chip').first().click();
            await page.waitForTimeout(300);
        } else {
            result.notes.push('mcp chip not visible in current composer state');
        }

        const profileChip = page.getByTestId('agent-input-profile-chip');
        if (!(await profileChip.count())) {
            const profilesEnabled = await ensureProfilesEnabled(page);
            if (profilesEnabled) {
                result.notes.push('enabled profiles from /settings/profiles');
            } else {
                result.notes.push('could not locate profiles toggle on /settings/profiles');
            }
            await waitForComposer(page);
        }

        if (await profileChip.count()) {
            console.log('[qa] opening profile popover');
            result.profileChipPresent = true;
            await profileChip.first().click();
            await page.locator('text=No profile, text=Default environment, text=Built-in, text=Custom').first().waitFor({
                state: 'visible',
                timeout: 15_000,
            });
            result.profilePopover = true;
            result.profilePopoverTitleRemoved = !(await page.getByText('Select AI Profile', { exact: true }).count());
            await page.screenshot({ path: profilePopoverScreenshotPath, fullPage: true });
        } else {
            result.notes.push('profile chip not visible in current composer state');
        }

        const automationChip = page.getByTestId('new-session-automation-chip');
        if (await automationChip.count()) {
            console.log('[qa] opening automation popover');
            result.automationChipPresent = true;
            await automationChip.first().click();
            await page.getByTestId('new-session.automation.enabled').waitFor({
                state: 'visible',
                timeout: 15_000,
            });
            result.automationPopover = true;
            await page.screenshot({ path: automationPopoverScreenshotPath, fullPage: true });
        } else {
            result.notes.push('automation chip not visible in current composer state');
        }

        await page.screenshot({ path: screenshotPath, fullPage: true });
        result.notes.push(`enginePickerScreenshot=${enginePickerScreenshotPath}`);
        result.notes.push(`pathPopoverScreenshot=${pathPopoverScreenshotPath}`);
        result.notes.push(`mcpPopoverScreenshot=${mcpPopoverScreenshotPath}`);
        result.notes.push(`profilePopoverScreenshot=${profilePopoverScreenshotPath}`);
        result.notes.push(`automationPopoverScreenshot=${automationPopoverScreenshotPath}`);
        result.notes.push(`screenshot=${screenshotPath}`);
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
