import { chromium, type Page } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveChromiumExecutable } from '@/dev/testkit/render/measureWebLayout';
import { buildWorkspaceHistoryBrowser } from '@/dev/testkit/render/buildWorkspaceHistoryBrowser.mjs';
import { createWorkspaceBrowserServer } from '@/dev/testkit/render/workspaceBrowserServer';

let script: string;
let origin: string;
const server = createWorkspaceBrowserServer(() => script);
beforeAll(async () => {
    script = await buildWorkspaceHistoryBrowser({ entryFile: 'sources/dev/testkit/render/workflowRunBrowserApp.tsx', lazy: false,
        boundaryFiles: { 'sources/modal/index.ts': 'sources/dev/testkit/render/workflowRunBrowserModalBoundary.ts' },
        boundaryModules: { '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc':
            'sources/dev/testkit/render/workflowRunBrowserMachineRpcBoundary.ts',
            '@/sync/domains/state/browserRecordStorage': 'sources/dev/testkit/render/workflowRunBrowserRecordBoundary.ts' } });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Run browser HTTP boundary did not bind');
    origin = `http://127.0.0.1:${address.port}`;
}, 600_000);
afterAll(async () => { if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });

export type RunBrowserApp = { ready: () => boolean; themeName: () => string | undefined; surfaceColor: () => string;
    open: (href: string) => void; runHref: string; holdId: string;
    diagnostics: () => { selected: { serverId: string; serverUrl: string; generation: number };
        applied: { serverId: string; serverUrl: string; generation: number };
        backend: { state: string; revision: number }; stored: { state: string; revision: number } | null;
        invocations: { holdLifecycle: string | null; historyRevision: number | null; attentionRevision: number | null } | null;
        reads: Array<{ operation: string; state: string; revision: number }> };
    operations: () => string[]; startRunId: () => string | null; settleStart: (refused?: boolean) => void;
    storedRunState: () => string | null; setRunState: (state: string) => void; setCompleted: () => void; setCompletedLeaves: () => void };
export type RunBrowserHarness = { runHarness: { mount: (phone: boolean, theme: 'light' | 'dark', state?: string, defaultWaitName?: boolean, requiredAnswer?: boolean, seams?: boolean) => Promise<RunBrowserApp> }; app: RunBrowserApp };
function reportFailureModules(errors: readonly string[]) {
    const bundleLines = script.split('\n');
    const failureFrames = [...(errors[0] ?? '').matchAll(/bundle\.js:(\d+):\d+/g)].slice(0, 4).map(match => Number(match[1]));
    for (const frameLine of failureFrames) {
        let moduleStart = -1;
        for (let index = frameLine - 1; index >= 0; index--) {
            if (bundleLines[index]?.startsWith('__d(')) { moduleStart = index; break; }
        }
        const moduleEndOffset = bundleLines.slice(frameLine - 1).findIndex(line => /^\},\s*\d+,/.test(line));
        process.stdout.write(`RUN_BROWSER_FAILURE_MODULE=${JSON.stringify({ frameLine,
            excerpt: bundleLines.slice(frameLine - 3, frameLine + 2),
            wrapperStart: bundleLines[moduleStart],
            wrapperEnd: moduleEndOffset < 0 ? null : bundleLines[frameLine - 1 + moduleEndOffset] })}\n`);
    }
}
export async function openRunBrowser(page: Page, phone: boolean, theme: 'light' | 'dark', state?: string, defaultWaitName = false, requiredAnswer = false, seams = false) {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.stack ?? error.message));
    await page.goto(origin);
    await page.addScriptTag({ url: `${origin}/bundle.js` });
    await page.evaluate(async ({ phone, theme, state, defaultWaitName, requiredAnswer, seams }) => {
        const h = window as unknown as RunBrowserHarness;
        h.app = await h.runHarness.mount(phone, theme, state, defaultWaitName, requiredAnswer, seams);
    }, { phone, theme, state, defaultWaitName, requiredAnswer, seams });
    try {
        await expect.poll(() => page.evaluate(() => (window as unknown as RunBrowserHarness).app.ready())).toBe(true);
        await page.evaluate(() => { const h = window as unknown as RunBrowserHarness; h.app.open(h.app.runHref); });
        await page.getByTestId('workflow-run-outcome').waitFor();
    }
    catch (cause) {
        await captureRunBrowser(page, `setup-failure-${phone ? 'phone' : 'desktop'}-${theme}`);
        const operations = await page.evaluate(() => (window as unknown as RunBrowserHarness).app.operations());
        const themeName = await page.evaluate(() => (window as unknown as RunBrowserHarness).app.themeName());
        reportFailureModules(errors);
        throw new Error(`Run browser failed to load: ${JSON.stringify({ errors, themeName, operations, body: await page.locator('body').innerText() })}`, { cause });
    }
    return errors;
}
const output = process.env.HAPPIER_RUN_BROWSER_CAPTURE_DIR ?? fileURLToPath(new URL('../../../../../../.project/tmp/fin-design12-fix/', import.meta.url));
export async function captureRunBrowser(page: Page, name: string, prefix: 'hold' | 'run' = 'hold') {
    if (!process.env.HAPPIER_RUN_BROWSER_CAPTURE_PHASE) return;
    // Capture the real modal after its existing entry motion settles, not a faded transition frame.
    await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('[role="dialog"]')].every(dialog => {
        // BaseModal's motion frame is inside the dialog shell, above this real card boundary.
        const card = dialog.querySelector('[data-happy-modal-card-boundary="true"]');
        if (card === null) return false;
        for (let element: Element | null = card; element !== null; element = element.parentElement) {
            if (getComputedStyle(element).opacity !== '1') return false;
        }
        return true;
    }))).toBe(true);
    await mkdir(output, { recursive: true });
    await page.screenshot({ path: path.join(output, `${prefix}-${process.env.HAPPIER_RUN_BROWSER_CAPTURE_PHASE}-${name}.png`), fullPage: false });
    const styles = await page.evaluate(() => {
        const primary = document.querySelector('[data-testid="workflow-review-use"]');
        const nodes = {
            title: document.querySelector('[data-testid="workflow-run-header"] [role="heading"]'),
            outcome: document.querySelector('[data-testid="workflow-run-outcome"]'),
            primary,
            primaryLabel: primary ? [...primary.querySelectorAll('*')].find(element => element.childElementCount === 0 && element.textContent?.trim()) : null,
        };
        return Object.fromEntries(Object.entries(nodes).map(([id, element]) => {
        if (!element) return [id, null];
        const style = getComputedStyle(element);
        return [id, { fontSize: style.fontSize, display: style.display, flexDirection: style.flexDirection,
            backgroundColor: style.backgroundColor, borderRadius: style.borderRadius, width: element.getBoundingClientRect().width }];
        }));
    });
    process.stdout.write(`RUN_BROWSER_STYLES=${JSON.stringify({ name, styles })}\n`);
}

describe('real Run Hold and leaf navigation in Chromium (DESIGN-12)', () => {
    it.each([true, false])('FF-INTSEAMS opens the held invocation, or the Run for non-hold attention (%s)', async held => {
        const browser = await chromium.launch({ executablePath: resolveChromiumExecutable() });
        try {
            const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
            await page.goto(origin);
            await page.addScriptTag({ url: `${origin}/bundle.js` });
            await page.evaluate(async held => {
                const h = window as unknown as RunBrowserHarness;
                h.app = await h.runHarness.mount(false, 'light', undefined, false, false, true);
                if (!held) { h.app.setCompletedLeaves(); h.app.setRunState('failed'); }
                h.app.open('/inbox');
            }, held);
            const row = page.getByTestId('inbox.run.11111111-1111-4111-8111-111111111111');
            await row.waitFor();
            expect(await page.evaluate(() => (window as unknown as RunBrowserHarness).app.operations()
                .filter(operation => operation === 'invocations.list'))).toEqual([]);
            await row.click();
            if (held) {
                await expect.poll(() => page.url()).toContain('invocationId=33333333-3333-4333-8333-333333333333');
                await page.getByTestId('workflow-review-use').waitFor();
            } else {
                await page.getByTestId('workflow-run-outcome').waitFor();
                expect(page.url()).not.toContain('invocationId=');
            }
        } finally { await browser.close(); }
    }, 600_000);

    it('FF-INTSEAMS repeats the accepted home-relative Where value', async () => {
        const browser = await chromium.launch({ executablePath: resolveChromiumExecutable() });
        try {
            const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
            await openRunBrowser(page, false, 'light', undefined, false, false, true);
            await page.evaluate(() => (window as unknown as RunBrowserHarness).app.setCompleted());
            await page.getByTestId('workflow-run-run-again').click();
            await page.getByTestId('workflow-run-inputs-run').waitFor();
            expect(await page.getByTestId('workflow-start-where-chip').getAttribute('aria-label')).toContain(' / ~');
        } finally { await browser.close(); }
    }, 600_000);

    it.each([false, true])('FF-INTSEAMS retains dismissed admission until its exact receipt or typed refusal (%s)', async refused => {
        const browser = await chromium.launch({ executablePath: resolveChromiumExecutable() });
        try {
            const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
            await openRunBrowser(page, false, 'light', undefined, false, false, true);
            await page.evaluate(() => (window as unknown as RunBrowserHarness).app.setCompleted());
            await page.getByTestId('workflow-run-run-again').click();
            await page.getByTestId('workflow-run-inputs-run').click();
            await expect.poll(() => page.evaluate(() => (window as unknown as RunBrowserHarness).app.startRunId())).not.toBeNull();
            await expect.poll(() => page.getByTestId('workflow-run-inputs-starting').innerText()).toContain('Starting');
            await page.getByTestId('modal-card-close').click();
            await page.getByTestId('workflow-run-again-pending').waitFor();
            const receipt = await page.evaluate(() => (window as unknown as RunBrowserHarness).app.startRunId());
            await page.evaluate(refused => (window as unknown as RunBrowserHarness).app.settleStart(refused), refused);
            if (refused) {
                await page.getByTestId('workflow-run-again-refused').waitFor();
                expect(page.url()).not.toContain(`/workflows/runs/${receipt}`);
                expect(await page.getByTestId('workflow-run-again-pending').count()).toBe(0);
            } else {
                await expect.poll(() => page.url()).toContain(`/workflows/runs/${receipt}`);
                await page.getByTestId('workflow-run-outcome').waitFor();
            }
        } finally { await browser.close(); }
    }, 600_000);

    it.each(['light', 'dark'] as const)('proves FF-INTSEAMS through the real column, Inbox, Run and start controller (%s)', async theme => {
        const browser = await chromium.launch({ executablePath: resolveChromiumExecutable() });
        const after = process.env.HAPPIER_RUN_BROWSER_CAPTURE_PHASE === 'after';
        const failures: string[] = [];
        try {
            for (const phone of [false, true]) {
                const page = await browser.newPage({ viewport: { width: phone ? 390 : 1440, height: phone ? 844 : 1000 } });
                const errors: string[] = [];
                page.on('pageerror', error => errors.push(error.stack ?? error.message));
                try {
                await page.goto(origin);
                await page.addScriptTag({ url: `${origin}/bundle.js` });
                await page.evaluate(async ({ phone, theme }) => {
                    const h = window as unknown as RunBrowserHarness;
                    h.app = await h.runHarness.mount(phone, theme, undefined, false, false, true);
                }, { phone, theme });
                await expect.poll(() => page.evaluate(() => (window as unknown as RunBrowserHarness).app.ready())).toBe(true);
                const frame = `${phone ? 'phone' : 'desktop'}-${theme}`;
                await page.evaluate(() => (window as unknown as RunBrowserHarness).app.open('/workflows/runs'));
                await page.getByTestId('workflows-column:view:runs').click();
                await page.getByText('Release review', { exact: true }).first().waitFor();
                await captureRunBrowser(page, `column-${frame}`, 'run');
                if (after) expect(await page.getByTestId('session-drafts-section').count()).toBe(0);

                await page.evaluate(() => (window as unknown as RunBrowserHarness).app.open('/inbox'));
                const inboxRow = page.getByTestId('inbox.run.11111111-1111-4111-8111-111111111111');
                await inboxRow.waitFor();
                await captureRunBrowser(page, `inbox-${frame}`, 'run');
                await inboxRow.click();
                if (after) await page.getByTestId('workflow-review-use').waitFor();
                else await page.getByTestId('workflow-run-outcome').waitFor();
                await captureRunBrowser(page, `inbox-open-${frame}`, 'run');

                await page.evaluate(() => { const h = window as unknown as RunBrowserHarness; h.app.open(h.app.runHref); });
                await page.getByTestId('workflow-run-outcome').waitFor();
                await page.getByTestId('notify-run-terminal:11111111-1111-4111-8111-111111111111').waitFor();
                await captureRunBrowser(page, `controls-${frame}`, 'run');
                if (after) expect(await page.getByRole('switch').count()).toBe(2);
                await page.evaluate(() => (window as unknown as RunBrowserHarness).app.setCompleted());
                await expect.poll(() => page.getByTestId('workflow-run-outcome').innerText()).toContain('Completed');
                await captureRunBrowser(page, `completed-${frame}`, 'run');
                await page.getByTestId('workflow-run-run-again').click();
                await page.getByTestId('workflow-run-inputs-run').waitFor();
                await captureRunBrowser(page, `composer-${frame}`, 'run');
                if (after) {
                    expect(await page.getByTestId('workflow-run-inputs-targets-chip').getAttribute('aria-label')).toContain('A session');
                    expect(await page.getByTestId('workflow-start-where-chip').getAttribute('aria-label')).toContain(' / ~');
                }
                await page.getByTestId('workflow-run-inputs-run').click();
                await expect.poll(() => page.evaluate(() => (window as unknown as RunBrowserHarness).app.startRunId())).not.toBeNull();
                await captureRunBrowser(page, `starting-${frame}`, 'run');
                if (after) expect(await page.getByTestId('workflow-run-inputs-starting').innerText()).toContain('Starting');
                await page.getByTestId('modal-card-close').click();
                await captureRunBrowser(page, `dismissed-${frame}`, 'run');
                if (after) expect(await page.getByTestId('workflow-run-again-pending').isVisible()).toBe(true);
                const receipt = await page.evaluate(() => (window as unknown as RunBrowserHarness).app.startRunId());
                await page.evaluate(() => (window as unknown as RunBrowserHarness).app.settleStart());
                await expect.poll(() => page.url()).toContain(`/workflows/runs/${receipt}`);
                await page.getByTestId('workflow-run-outcome').waitFor();
                await captureRunBrowser(page, `receipt-${frame}`, 'run');
                expect(errors).toEqual([]);
                } catch (cause) {
                    await captureRunBrowser(page, `failure-${phone ? 'phone' : 'desktop'}-${theme}`, 'run');
                    reportFailureModules(errors);
                    failures.push(JSON.stringify({ phone, theme, cause: String(cause), errors,
                        body: await page.locator('body').innerText(),
                        diagnostics: await page.evaluate(() => (window as unknown as RunBrowserHarness).app.diagnostics()) }));
                } finally { await page.close(); }
            }
            expect(failures).toEqual([]);
        } finally { await browser.close(); }
    }, 600_000);

    it('uses the configured theme in the transformed Workspace shell', async () => {
        const browser = await chromium.launch({ executablePath: resolveChromiumExecutable() });
        try {
            const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
            const errors: string[] = [];
            page.on('pageerror', error => errors.push(error.stack ?? error.message));
            await page.goto(origin);
            await page.addScriptTag({ url: `${origin}/bundle.js` });
            const selectedTheme = await page.evaluate(async () => {
                const harness = window as unknown as RunBrowserHarness;
                harness.app = await harness.runHarness.mount(false, 'light');
                return harness.app.themeName();
            });
            expect(selectedTheme).toBe('light');
            try {
                await expect.poll(() => page.evaluate(() => (window as unknown as RunBrowserHarness).app.ready())).toBe(true);
                const paint = await page.evaluate(() => {
                    // CSS Color 4 and legacy rgb spellings can describe the same paint.
                    const colorPixel = (color: string) => {
                        const canvas = document.createElement('canvas');
                        canvas.width = canvas.height = 1;
                        const context = canvas.getContext('2d')!;
                        context.fillStyle = color;
                        context.fillRect(0, 0, 1, 1);
                        return [...context.getImageData(0, 0, 1, 1).data];
                    };
                    return { expected: colorPixel((window as unknown as RunBrowserHarness).app.surfaceColor()),
                        actual: colorPixel(getComputedStyle(document.getElementById('open-run')!.parentElement!).backgroundColor) };
                });
                expect(paint.actual).toEqual(paint.expected);
                expect(errors).toEqual([]);
            } catch (cause) {
                await captureRunBrowser(page, 'theme-owner-desktop-light');
                reportFailureModules(errors);
                throw new Error(`Configured Workspace shell failed to paint: ${JSON.stringify({ selectedTheme, errors })}`, { cause });
            }
        } finally { await browser.close(); }
    }, 180_000);

    it.each(['light', 'dark'] as const)('shows the authored question, blocked reason and compact phone Hold (%s)', async theme => {
        const browser = await chromium.launch({ executablePath: resolveChromiumExecutable() });
        const failures: string[] = [];
        try {
            for (const phone of [false, true]) {
                const page = await browser.newPage({ viewport: { width: phone ? 390 : 1440, height: phone ? 844 : 1000 } });
                const errors = await openRunBrowser(page, phone, theme, undefined, false, true);
                // The healthy Automations HTTP fixture must settle the real notification read.
                for (const condition of ['terminal', 'needs_attention']) {
                    await expect.poll(() => page.getByTestId(`notify-run-${condition}:11111111-1111-4111-8111-111111111111`).isEnabled()).toBe(true);
                }
                expect(await page.getByRole('button', { name: 'Retry', exact: true }).count()).toBe(0);
                await captureRunBrowser(page, `run-${phone ? 'phone' : 'desktop'}-${theme}`);
                await page.getByTestId('workflow-run-needs-you-33333333-3333-4333-8333-333333333333').click();
                await page.getByTestId('workflow-review-use').waitFor();
                await captureRunBrowser(page, `${phone ? 'phone' : 'desktop'}-${theme}`);
                try {
                const prompt = page.getByTestId('workflow-review-wait-prompt');
                const validation = page.getByTestId('workflow-review-validation');
                const cardText = await page.getByTestId('workflow-review').innerText();
                const reviewSurface = phone ? page.getByRole('dialog') : page.getByTestId('details-pane');
                const reviewHeader = reviewSurface.getByTestId(phone ? 'modal-card-header' : 'details-pane.header');
                const identityLine = 'Attempt 1 · Waiting for you';
                const observedHold = {
                    authoredQuestion: await prompt.count() === 1 && (await prompt.innerText()).includes('release notes'),
                    // Ignore BaseModal's one-pixel accessible-name node; count displayed identities.
                    stepIdentityCount: await reviewSurface.getByText('Check the release', { exact: true }).evaluateAll(elements =>
                        elements.filter(element => element.getBoundingClientRect().width > 1 && element.getBoundingClientRect().height > 1).length),
                    identityLineCount: await reviewSurface.getByText(identityLine, { exact: true }).count(),
                    headerOwnsIdentityLine: await reviewHeader.getByText(identityLine, { exact: true }).count() === 1,
                    waitingConsequence: cardText.includes('This lane waits until you continue.'),
                    blockedReason: await validation.count() === 1 && await validation.isVisible() ? await validation.innerText() : null,
                    initialErrorAlert: await validation.getAttribute('role') === 'alert',
                    useDisabled: await page.getByTestId('workflow-review-use').isDisabled(),
                };
                process.stdout.write(`RUN_BROWSER_HOLD_OBSERVATION=${JSON.stringify({ phone, theme, ...observedHold })}\n`);
                expect(observedHold).toEqual({ authoredQuestion: true, stepIdentityCount: 1, identityLineCount: 1, headerOwnsIdentityLine: true, waitingConsequence: true,
                    blockedReason: 'Fill in the fields.', initialErrorAlert: false, useDisabled: true });
                const initialTone = await validation.evaluate(element => ({ hint: getComputedStyle(element).color,
                    secondary: getComputedStyle([...element.parentElement!.children].find(node => node !== element && node.textContent?.includes('Later steps'))!).color }));
                expect(initialTone.hint).toBe(initialTone.secondary);
                await page.getByTestId('workflow-review-field-summary').fill('Ready to share');
                expect(await page.getByTestId('workflow-review-use').isEnabled()).toBe(true);
                await page.getByTestId('workflow-review-field-summary').fill('');
                await expect.poll(() => validation.getAttribute('role')).toBe('alert');
                expect(await validation.innerText()).toBe('Fix the highlighted field first.');
                expect(await validation.evaluate(element => getComputedStyle(element).color)).not.toBe(initialTone.hint);
                expect(await page.getByTestId('workflow-review-use').isDisabled()).toBe(true);
                await captureRunBrowser(page, `invalid-${phone ? 'phone' : 'desktop'}-${theme}`);
                if (phone) {
                    const question = await page.getByTestId('workflow-review-wait-prompt').boundingBox();
                    const action = await page.getByTestId('workflow-review-use').boundingBox();
                    expect(question).not.toBeNull(); expect(action).not.toBeNull();
                    // The short answer follows its question within the sheet; a flex-filled
                    // empty body would strand the action hundreds of pixels below it.
                    expect(action!.y - (question!.y + question!.height)).toBeLessThan(240);
                }
                expect(errors).toEqual([]);
                } catch (error) { failures.push(`${phone ? 'phone' : 'desktop'}: ${error instanceof Error ? error.message : String(error)}`); }
                await page.close();
            }
            expect(failures).toEqual([]);
        } finally { await browser.close(); }
    }, 180_000);

    it('returns phone Close and header Back from the exact step to its Run and opens Map by default', async () => {
        const browser = await chromium.launch({ executablePath: resolveChromiumExecutable() });
        try {
            const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
            const errors = await openRunBrowser(page, true, 'light');
            const initialMapSelected = await page.getByTestId('workflow-run-view:flow').getAttribute('aria-selected');
            const review = () => page.getByTestId('workflow-run-needs-you-33333333-3333-4333-8333-333333333333').click();
            await review();
            await page.getByTestId('workflow-review-use').waitFor();
            await page.getByTestId('modal-card-close').click();
            await captureRunBrowser(page, 'step-phone-light');
            await page.getByTestId('workflow-run-selected-header.close').click();
            const closeHref = await page.evaluate(() => location.pathname + location.search);
            const closeReturnedToRun = await page.getByTestId('workflow-run-outcome').isVisible();
            // Restore the public Run entry so a failing Close cannot hide the independent Back contract.
            await page.evaluate(() => { const h = window as unknown as RunBrowserHarness; h.app.open(h.app.runHref); });
            await page.getByTestId('workflow-run-outcome').waitFor();
            await review();
            await page.getByTestId('workflow-review-use').waitFor();
            await page.getByTestId('modal-card-close').click();
            await page.getByTestId('workflow-run-back').click();
            const backHref = await page.evaluate(() => location.pathname + location.search);
            const backReturnedToRun = await page.getByTestId('workflow-run-outcome').isVisible();
            const runHref = await page.evaluate(() => (window as unknown as RunBrowserHarness).app.runHref);
            expect({ initialMapSelected, closeHref, closeReturnedToRun, backHref, backReturnedToRun }).toEqual({
                initialMapSelected: 'true', closeHref: runHref, closeReturnedToRun: true, backHref: runHref, backReturnedToRun: true });
            expect(await page.getByRole('tooltip').count()).toBe(0);
            expect(errors).toEqual([]);
        } finally { await browser.close(); }
    }, 180_000);
});

describe('real Run headline freshness in Chromium (DESIGN-12 F2)', () => {
    it('does not infer parent completion from a completed leaf', async () => {
        const browser = await chromium.launch({ executablePath: resolveChromiumExecutable() });
        try {
            const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
            const errors = await openRunBrowser(page, true, 'light', 'claimed');
            await page.getByTestId('workflow-run-view:activity').click();
            await page.evaluate(() => (window as unknown as RunBrowserHarness).app.setCompletedLeaves());
            await page.getByText('Completed', { exact: true }).first().waitFor();
            expect(await page.getByTestId('workflow-run-outcome').innerText()).not.toContain('Completed');
            await captureRunBrowser(page, 'parent-claimed-leaf-completed-phone-light', 'run');
            expect(errors).toEqual([]);
        } finally { await browser.close(); }
    }, 180_000);

    it('describes a default-name Wait without echoing the step name as its consequence', async () => {
        const browser = await chromium.launch({ executablePath: resolveChromiumExecutable() });
        const outcomes: string[] = [];
        try {
            for (const phone of [false, true]) {
                const page = await browser.newPage({ viewport: { width: phone ? 390 : 1440, height: phone ? 844 : 1000 } });
                const errors = await openRunBrowser(page, phone, 'light', 'waiting_for_review', true);
                await page.getByTestId('workflow-run-needs-you-33333333-3333-4333-8333-333333333333').waitFor();
                await captureRunBrowser(page, `default-wait-${phone ? 'phone' : 'desktop'}-light`, 'run');
                outcomes.push(await page.getByTestId('workflow-run-outcome').innerText());
                expect(errors).toEqual([]);
                await page.close();
            }
            expect(outcomes).toEqual([
                expect.stringContaining('This lane waits until you continue.'),
                expect.stringContaining('This lane waits until you continue.'),
            ]);
        } finally { await browser.close(); }
    }, 180_000);

    it.each(['light', 'dark'] as const)('follows a held and completed Run through the authoritative summary wake (%s)', async theme => {
        const browser = await chromium.launch({ executablePath: resolveChromiumExecutable() });
        const staleOutcomes: string[] = [];
        try {
            for (const phone of [false, true]) {
                const page = await browser.newPage({ viewport: { width: phone ? 390 : 1440, height: phone ? 844 : 1000 } });
                const errors = await openRunBrowser(page, phone, theme, 'claimed');
                expect(await page.evaluate(() => (window as unknown as RunBrowserHarness).app.storedRunState())).toBe('claimed');
                const initial = await page.evaluate(() => (window as unknown as RunBrowserHarness).app.diagnostics());
                expect(initial.applied).toEqual({ serverId: initial.selected.serverId, serverUrl: initial.selected.serverUrl,
                    generation: initial.selected.generation });
                await captureRunBrowser(page, `claimed-${phone ? 'phone' : 'desktop'}-${theme}`, 'run');
                await page.evaluate(() => (window as unknown as RunBrowserHarness).app.setRunState('waiting_for_review'));
                try {
                    await expect.poll(() => page.evaluate(() => (window as unknown as RunBrowserHarness).app.storedRunState())).toBe('waiting_for_review');
                    expect(await page.getByTestId('workflow-run-outcome').innerText()).toContain('Waiting for you');
                }
                catch { staleOutcomes.push(`held ${phone ? 'phone' : 'desktop'}: ${await page.getByTestId('workflow-run-outcome').innerText()}`); }
                const held = await page.evaluate(() => (window as unknown as RunBrowserHarness).app.diagnostics());
                if (!held.reads.slice(initial.reads.length).some(read => read.operation === 'list'
                    && read.state === held.backend.state && read.revision === held.backend.revision)) {
                    staleOutcomes.push(`missing post-wake held summary read ${phone ? 'phone' : 'desktop'}`);
                }
                await captureRunBrowser(page, `holding-${phone ? 'phone' : 'desktop'}-${theme}`, 'run');
                await page.evaluate(() => (window as unknown as RunBrowserHarness).app.setCompleted());
                try { await expect.poll(() => page.getByTestId('workflow-run-outcome').innerText()).toContain('Completed'); }
                catch { staleOutcomes.push(`completed ${phone ? 'phone' : 'desktop'}: ${await page.getByTestId('workflow-run-outcome').innerText()}`); }
                await expect.poll(async () => {
                    const observation = await page.evaluate(() => (window as unknown as RunBrowserHarness).app.diagnostics());
                    return { holdLifecycle: observation.invocations?.holdLifecycle,
                        historyCurrent: observation.invocations?.historyRevision === observation.backend.revision,
                        attentionCurrent: observation.invocations?.attentionRevision === observation.backend.revision };
                }).toEqual({ holdLifecycle: 'completed', historyCurrent: true, attentionCurrent: true });
                expect(await page.getByTestId('workflow-run-needs-you-33333333-3333-4333-8333-333333333333').count()).toBe(0);
                expect(await page.getByText('Waiting for you', { exact: true }).count()).toBe(0);
                expect(await page.getByTestId('workflow-run-pause').count()).toBe(0);
                expect(await page.getByTestId('workflow-run-cancel').count()).toBe(0);
                await captureRunBrowser(page, `completed-${phone ? 'phone' : 'desktop'}-${theme}`, 'run');
                const completed = await page.evaluate(() => (window as unknown as RunBrowserHarness).app.diagnostics());
                if (!completed.reads.slice(held.reads.length).some(read => read.operation === 'list'
                    && read.state === completed.backend.state && read.revision === completed.backend.revision)) {
                    staleOutcomes.push(`missing post-wake terminal summary read ${phone ? 'phone' : 'desktop'}`);
                }
                expect(completed.stored?.state).toBe('succeeded');
                process.stdout.write(`RUN_BROWSER_FRESHNESS=${JSON.stringify({ phone, theme, initial, held, completed })}\n`);
                expect(errors).toEqual([]);
                await page.close();
            }
            expect(staleOutcomes).toEqual([]);
        } finally { await browser.close(); }
    }, 180_000);
});
