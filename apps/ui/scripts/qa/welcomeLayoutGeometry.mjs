import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';

import '../../../../packages/cli-common/registerSourceRuntime.mjs';

const { createRootLayoutFeaturesResponse } = await import('../../sources/dev/testkit/fixtures/featureFixtures.ts');
const [origin, output, ...sizes] = process.argv.slice(2);
assert.ok(origin && output, 'Pass the signed-out web export origin and the capture directory');
const home = new URL(origin);
assert.ok(['localhost', '127.0.0.1'].includes(home.hostname), 'Use a loopback fixture origin');

const features = createRootLayoutFeaturesResponse({
    capabilities: {
        auth: { methods: [{ id: 'key_challenge', actions: [
            { id: 'login', enabled: true, mode: 'keyed' },
            { id: 'provision', enabled: true, mode: 'keyed' },
        ] }] },
    },
});
const retention = {
    version: 2, enabled: true, complete: true,
    domains: ['sessions', 'session_messages', 'automations', 'terminal', 'activity', 'account_events'].map(id => ({
        id, policy: { mode: 'delete_older_than', days: 30 },
    })),
};

function observeWelcomeGeometry() {
    const read = node => {
        if (!node) return null;
        const { x, y, width, height } = node.getBoundingClientRect();
        return { x, y, width, height };
    };
    const byId = (root, id) => root.querySelector('[data-testid="' + id + '"]');
    const probe = {
        active: false,
        frames: [],
        read: () => {
            const pane = byId(document, 'unauth-shell-workflow-pane');
            const column = pane && byId(pane, 'welcome-decision-panel');
            if (!column) return null;
            const note = byId(pane, 'welcome-retention');
            return {
                heading: [...column.querySelectorAll('[role="heading"], h1, h2')].map(read),
                column: read(column),
                doors: read(byId(column, 'welcome-doors')),
                footer: read(byId(pane, 'unauth-shell-welcome-footer')),
                wordmark: read(byId(pane, 'welcome-mobile-wordmark')),
                homeCorner: read(byId(pane, 'unauth-shell-corner')),
                notice: read(byId(column, 'welcome-notice-slot')),
                note: read(note),
            };
        },
    };
    let last = '';
    const sample = () => {
        if (!probe.active) return;
        const layout = probe.read();
        const key = JSON.stringify(layout);
        if (key !== last) probe.frames.push({ time: performance.now(), layout });
        last = key;
        requestAnimationFrame(sample);
    };
    probe.start = () => {
        probe.active = true;
        sample();
    };
    window.welcomeGeometry = probe;
}

await mkdir(output, { recursive: true });
const browser = process.env.FO22_CDP
    ? await chromium.connectOverCDP(process.env.FO22_CDP)
    : await chromium.launch({ headless: true });
const failures = [];
try {
    for (const size of sizes.length ? sizes : ['1440-900-light', '1440-900-dark', '390-844-light', '390-844-dark']) {
        const [width, height, colorScheme, scenario] = size.split('-');
        const discovery = scenario === 'discovery';
        const context = await browser.newContext({
            viewport: { width: Number(width), height: Number(height) },
            colorScheme,
            reducedMotion: discovery ? 'reduce' : 'no-preference',
        });
        const gate = Promise.withResolvers();
        try {
            const page = await context.newPage();
            await page.addInitScript(observeWelcomeGeometry);
            const heldRequest = Promise.withResolvers();
            await page.route('**/*', route => new URL(route.request().url()).origin === home.origin
                ? route.continue() : route.abort());
            if (!discovery) {
                await page.route('**/health', route => route.fulfill({ json: { status: 'ok', service: 'happier-server' } }));
                await page.route(/\/v1\/features(?:\?.*)?$/, route => route.fulfill({ json: features }));
            }
            await page.route('**/v1/auth/entry', async route => {
                if (discovery) {
                    heldRequest.resolve();
                    await gate.promise;
                    await route.continue();
                    return;
                }
                await route.fulfill({ status: 404 });
            });
            await page.route('**/v2/retention-policy', async route => {
                if (!discovery) {
                    heldRequest.resolve();
                    await gate.promise;
                }
                await route.fulfill({ json: discovery ? { ...retention, enabled: false } : retention });
            });
            page.on('response', response => {
                if (/index-[a-f0-9]+\.js$/.test(response.url())) console.log(size, response.url());
            });
            const url = new URL('/', home);
            url.searchParams.set('server', home.origin);
            await page.goto(url.href, { waitUntil: 'commit' });
            const ready = page.getByTestId('welcome-doors').last();
            const target = page.getByTestId(discovery ? 'welcome-notice-slot' : 'welcome-retention').last();
            if (discovery) {
                const keepAddress = page.getByRole('button', { name: 'Keep', exact: true });
                await ready.or(keepAddress).first().waitFor();
                if (await keepAddress.isVisible()) await keepAddress.click();
            }
            await ready.waitFor();
            await page.getByTestId('launch-curtain').waitFor({ state: 'detached' });
            await page.getByTestId('first-open.scene').waitFor({ state: 'detached' });
            await page.evaluate(() => document.fonts.ready.then(() => undefined));
            assert.ok(await Promise.race([heldRequest.promise.then(() => true), page.waitForTimeout(20000).then(() => false)]),
                'the fixture intercepted the request');
            if (discovery) await target.waitFor();
            const before = await page.evaluate(() => {
                window.welcomeGeometry.start();
                return window.welcomeGeometry.read();
            });
            assert.ok(before.heading.length > 0 && before.doors.height > 0);
            assert.equal(before.note, null);
            await page.screenshot({ path: join(output, size + '-before.png') });
            const start = Date.now();
            await page.waitForTimeout(2000);
            await page.screenshot({ path: join(output, size + '-held.png') });
            const holdMs = Date.now() - start;
            gate.resolve();
            await target.waitFor({ state: discovery ? 'detached' : 'visible' });
            await page.waitForTimeout(300);
            const { after, frames } = await page.evaluate(() => {
                const probe = window.welcomeGeometry;
                probe.active = false;
                return { after: probe.read(), frames: probe.frames };
            });
            const result = { size, holdMs, before, after, frames };
            await page.screenshot({ path: join(output, size + '-arrived.png') });
            await writeFile(join(output, size + '.json'), JSON.stringify(result, null, 2));
            console.log(JSON.stringify({ size, holdMs, before, after, sampledLayouts: frames.length }));
            for (const sample of [...frames.map(frame => frame.layout), after]) {
                for (const key of ['heading', 'doors', 'footer', 'wordmark', 'homeCorner', ...(discovery ? [] : ['column'])]) {
                    assert.deepEqual(sample[key], before[key], size + ' ' + key + ' moved');
                }
            }
            if (!discovery) {
                assert.ok(after.note.y >= after.column.y + after.column.height, 'retention clears the main column');
                if (after.note.y + after.note.height > Number(height)) {
                    await target.scrollIntoViewIfNeeded();
                    const reachable = await target.boundingBox();
                    assert.ok(reachable && reachable.y >= 0 && reachable.y + reachable.height <= Number(height),
                        'the entire retention disclosure is reachable by scrolling');
                    await page.screenshot({ path: join(output, size + '-scrolled.png') });
                }
            }
        } catch (error) {
            failures.push(error);
            console.error(error);
            const [page] = context.pages();
            if (page) await page.screenshot({ path: join(output, size + '-failure.png') }).catch(() => {});
        } finally {
            gate.resolve();
            await context.close();
        }
    }
} finally {
    await browser.close();
}
assert.equal(failures.length, 0);
