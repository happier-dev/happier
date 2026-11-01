import { chromium } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { buildWorkspaceHistoryBrowser } from '@/dev/testkit/render/buildWorkspaceHistoryBrowser.mjs';
import { resolveChromiumExecutable } from '@/dev/testkit/render/measureWebLayout';
import { createWorkspaceBrowserServer } from '@/dev/testkit/render/workspaceBrowserServer';

let script: string;
const server = createWorkspaceBrowserServer(() => script);
let origin: string;
beforeAll(async () => {
    script = await buildWorkspaceHistoryBrowser({
        entryFile: 'sources/dev/testkit/render/phoneEditorChatBrowser.tsx',
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing browser test listener');
    origin = `http://127.0.0.1:${address.port}`;
}, 600_000);
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

it('returns from phone Files Edit to Chat when a frozen plugin badge resolves, retaining the draft', async () => {
    const browser = await chromium.launch({ executablePath: resolveChromiumExecutable() });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(`${error.name}: ${error.message}`));
    try {
        await page.goto(origin);
        await page.addScriptTag({ url: `${origin}/bundle.js` });
        await page.evaluate(() => {
            const harness = Reflect.get(globalThis, 'phoneEditorChatBrowser') as { mount(): void };
            harness.mount();
        });
        await page.getByTestId('pending-badge').waitFor();
        await page.getByTestId('chat-draft').fill('Keep my draft');
        await page.getByTestId('edit').click();
        await page.getByTestId('files-editor').waitFor();
        await page.getByTestId('resolve-badge').click();
        await page.getByTestId('chat').click();
        // Let the thaw's commit and layout effects finish before checking page errors.
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        expect(errors).toEqual([]);
        await page.getByTestId('pending-badge').waitFor({ state: 'detached' });
        expect(await page.getByTestId('chat-draft').inputValue()).toBe('Keep my draft');
    } finally {
        await browser.close();
    }
});
