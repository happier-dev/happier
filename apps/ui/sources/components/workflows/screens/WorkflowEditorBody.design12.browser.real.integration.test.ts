import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveChromiumExecutable } from '@/dev/testkit/render/measureWebLayout';
import { buildWorkspaceHistoryBrowser } from '@/dev/testkit/render/buildWorkspaceHistoryBrowser.mjs';
import { createWorkspaceBrowserServer } from '@/dev/testkit/render/workspaceBrowserServer';

let script: string;
let origin: string;
const server = createWorkspaceBrowserServer(() => script);
beforeAll(async () => {
    script = await buildWorkspaceHistoryBrowser({ entryFile: 'sources/dev/testkit/render/workflowEditorDesignBrowserApp.tsx' });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Editor browser harness did not bind');
    origin = `http://127.0.0.1:${address.port}`;
}, 600_000);
afterAll(async () => { if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });

type Harness = { editorHarness: { mount: (phone: boolean, theme: 'light' | 'dark', state: 'wait' | 'lost-copy') => void } };

describe('DESIGN-12 editor truthfulness in the real workspace', () => {
    it.each([false, true])('offers Agent settings only after an Agent step is added (phone=%s)', async phone => {
        const browser = await chromium.launch({ executablePath: resolveChromiumExecutable() });
        try {
            const page = await browser.newPage({ viewport: { width: phone ? 390 : 1440, height: phone ? 844 : 1000 } });
            await page.goto(`${origin}/workflows/new`);
            await page.addScriptTag({ url: `${origin}/bundle.js` });
            await page.evaluate(phone => (window as unknown as Harness).editorHarness.mount(phone, 'light', 'wait'), phone);
            await page.getByTestId('workflow-editor').waitFor();
            expect(await page.getByTestId(phone ? 'workflow-editor-agent-row' : 'workflow-editor-header-engine-agentTarget').count()).toBe(0);
            await page.getByTestId(phone ? 'workflow-editor-phone-add' : 'workflow-editor-add-root').click();
            await page.getByRole('option', { name: /Agent step/ }).click();
            await expect.poll(() => page.getByTestId(phone ? 'workflow-editor-agent-row' : 'workflow-editor-header-engine-agentTarget').count()).toBe(1);
        } finally { await browser.close(); }
    });

    it('keeps an expired unsaved copy unavailable with a safe route back', async () => {
        const browser = await chromium.launch({ executablePath: resolveChromiumExecutable() });
        try {
            const page = await browser.newPage();
            const errors: string[] = [];
            page.on('pageerror', error => errors.push(error.message));
            await page.goto(`${origin}/workflows/new`);
            await page.addScriptTag({ url: `${origin}/bundle.js` });
            await page.evaluate(() => (window as unknown as Harness).editorHarness.mount(false, 'light', 'lost-copy'));
            const state = page.getByTestId('workflow-editor-draft-unavailable');
            try { await state.waitFor(); } catch (error) {
                throw new Error(`Lost-copy fixture did not render: ${String(error)}\n${errors.join('\n')}\n${await page.locator('body').innerText()}`);
            }
            expect(await state.getAttribute('role')).toBe('alert');
            expect(await state.getByRole('button').count()).toBe(1);
            expect(await page.getByTestId('workflow-editor').count()).toBe(0);
            await page.getByTestId('workflow-editor-draft-unavailable-open-collection').click();
            await expect.poll(() => page.evaluate(() => location.pathname)).toBe('/workflows');
        } finally { await browser.close(); }
    });

    it.runIf(Boolean(process.env.FIN_EDITOR_CAPTURE_DIR))('captures editor recovery and Add in both sizes and themes', async () => {
        const repositoryRoot = fileURLToPath(new URL('../../../../../../', import.meta.url));
        const directory = resolve(repositoryRoot, process.env.FIN_EDITOR_CAPTURE_DIR!);
        await mkdir(directory, { recursive: true });
        const browser = await chromium.launch({ executablePath: resolveChromiumExecutable() });
        try {
            for (const phone of [false, true]) for (const theme of ['light', 'dark'] as const) for (const state of ['wait', 'lost-copy'] as const) {
                const page = await browser.newPage({ viewport: { width: phone ? 390 : 1440, height: phone ? 844 : 1000 } });
                await page.goto(`${origin}/workflows/new`);
                await page.addScriptTag({ url: `${origin}/bundle.js` });
                await page.evaluate(({ phone, theme, state }) => (window as unknown as Harness).editorHarness.mount(phone, theme, state), { phone, theme, state });
                await page.getByTestId(state === 'wait' ? 'workflow-editor' : 'workflow-editor-draft-unavailable').waitFor();
                const stem = `editor-${state}-${phone ? '390' : '1440'}-${theme}`;
                await page.screenshot({ path: join(directory, `${stem}.png`) });
                if (state === 'wait') {
                    await page.getByTestId(phone ? 'workflow-editor-phone-add' : 'workflow-editor-add-root').click();
                    const agentOption = page.getByRole('option', { name: /Agent step/ });
                    await agentOption.waitFor();
                    // The real popover fades in; capture its settled surface, not a mid-animation frame.
                    await expect.poll(() => agentOption.evaluate(element => {
                        for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
                            if (getComputedStyle(ancestor).opacity !== '1') return false;
                        }
                        return true;
                    })).toBe(true);
                    await page.screenshot({ path: join(directory, `editor-add-${phone ? '390' : '1440'}-${theme}.png`) });
                }
                await page.close();
            }
        } finally { await browser.close(); }
    });
});
