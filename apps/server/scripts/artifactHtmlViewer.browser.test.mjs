import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { buildPublicShareViewerBundle } from './buildPublicShareViewer.mjs';

// Playwright is owned by the repository's browser test package. This script
// exercises only the real browser boundary and source-generated viewer bytes.
const requireTests = createRequire(resolve('packages/tests/package.json'));
const { chromium } = requireTests('@playwright/test');
const sourceDir = resolve('apps/server/sources/app/api/routes/share');
await buildPublicShareViewerBundle({ check: true });
const asset = await readFile(resolve(sourceDir, 'publicShareViewerBundle.generated.ts'), 'utf8');
const script = JSON.parse(asset.slice(asset.indexOf(' = ') + 3).trim().replace(/;$/u, ''));
// Import the policy from its actual delivery owner, not a test-local copy.
const owner = await build({ entryPoints: [resolve(sourceDir, 'registerPublicShareViewerRoutes.ts')], bundle: true, write: false,
    platform: 'node', format: 'esm', packages: 'external', plugins: [{ name: 'delivery-only', setup(builder) {
        builder.onResolve({ filter: /^@\// }, args => ({ path: args.path, external: true }));
    } }], });
// The actual response policy is captured through the registration boundary
// without loading DB/Account state; private shell serves no stored data.
const policyMatch = owner.outputFiles[0].text.match(/(?:var|const) ARTIFACT_HTML_SHELL_CSP = (["`])([^"`]*)\1;/u);
assert.ok(policyMatch, 'The delivery policy is present in compiled source');
const policy = policyMatch[2];

test('real HTML bytes render Unicode bundle assets without application authority or data/blob navigation escape', async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    let apiRequests = 0;
    let isolatedApiRequests = 0;
    let externalNavigations = 0;
    let leakedSecret = false;
    const appOrigin = 'https://app.example.test';
    const isolatedOrigin = 'https://artifact.preview.example.test';
    const html = `<h1 id="rendered">HTML works</h1><link rel="stylesheet" href="css/main.css"><img id="asset" src="café image.svg"><script src="js/日本.js"></script><script>
        window.results={};
        try{results.cookie=document.cookie}catch(e){results.cookie='blocked'}
        try{results.storage=localStorage.getItem('app-secret')}catch(e){results.storage='blocked'}
        try{results.parent=parent.document.cookie}catch(e){results.parent='blocked'}
        fetch('${appOrigin}/v1/account').then(()=>results.fetch='allowed',()=>results.fetch='blocked');
        addEventListener('securitypolicyviolation',e=>{if(e.violatedDirective==='connect-src')results.csp=true});
        </script>`;
    const files = {
        'index.html': { mime: 'text/html', contentBase64: Buffer.from(html).toString('base64') },
        'css/main.css': { mime: 'text/css', contentBase64: Buffer.from('@import "nested.css";body{background-image:url("../café image.svg")}').toString('base64') },
        'css/nested.css': { mime: 'text/css', contentBase64: Buffer.from('h1{color:rgb(10,20,30)}').toString('base64') },
        'js/日本.js': { mime: 'application/javascript', contentBase64: Buffer.from('document.getElementById("rendered").dataset.bundle="yes"').toString('base64') },
        'café image.svg': { mime: 'image/svg+xml', contentBase64: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>').toString('base64') },
    };
    const fragment = Buffer.from(JSON.stringify({ v: 1, entrypoint: 'index.html', files })).toString('base64url');
    context.on('request', request => { if (request.url().includes(fragment) || request.headers().cookie?.includes('app-cookie') && request.url().startsWith(isolatedOrigin)) leakedSecret = true; });
    await context.addCookies([{ name: 'app-cookie', value: 'secret', url: appOrigin }]);
    await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin === appOrigin) {
            if (url.pathname === '/v1/account') { apiRequests++; await route.fulfill({ body: 'API reached' }); return; }
            await route.fulfill({ contentType: 'text/html', body: `<script>localStorage.setItem('app-secret','secret')</script><iframe id="preview" src="${isolatedOrigin}/a/artifact#d=${fragment}"></iframe>` });
        } else if (url.origin === isolatedOrigin && url.pathname === '/v1/leak') { isolatedApiRequests++; await route.fulfill({ body: 'API reached' }); }
        else if (url.origin === isolatedOrigin && url.pathname.endsWith('/viewer.js')) await route.fulfill({ contentType: 'application/javascript', body: script });
        else if (url.origin === isolatedOrigin) await route.fulfill({ contentType: 'text/html', headers: { 'content-security-policy': policy }, body: '<main id="public-share-viewer"></main><script src="/a/artifact/viewer.js"></script>' });
        else { externalNavigations++; await route.fulfill({ body: 'External request reached' }); }
    });
    try {
        const page = await context.newPage();
        await page.goto(appOrigin);
        const guest = page.frameLocator('#preview').frameLocator('iframe');
        await Promise.race([
            guest.locator('#rendered[data-bundle="yes"]').waitFor(),
            page.frameLocator('#preview').locator('#public-share-viewer').filter({ hasText: 'could not be opened' }).waitFor().then(() => assert.fail('Valid Unicode bundle failed to render')),
        ]);
        const inner = page.frames().find(frame => frame.url() === 'about:srcdoc');
        assert.ok(inner, 'The document renders inside the inner sandbox');
        await inner.waitForFunction(() => window.results?.fetch === 'blocked');
        assert.deepEqual(await inner.evaluate(() => window.results), { cookie: 'blocked', storage: 'blocked', parent: 'blocked', fetch: 'blocked', csp: true });
        assert.equal(await inner.locator('#rendered').evaluate(element => getComputedStyle(element).color), 'rgb(10, 20, 30)');
        assert.equal(await inner.locator('#asset').evaluate(element => element.complete && element.naturalWidth > 0), true);
        assert.equal(await page.locator('#preview').evaluate(element => element.contentWindow === window), false);
        assert.equal(await page.evaluate(() => localStorage.getItem('app-secret')), 'secret');
        await inner.evaluate(() => { location.href = 'https://external.example.test/escape'; });
        await page.waitForTimeout(100);
        assert.equal(apiRequests, 0);
        assert.equal(externalNavigations, 0);
        assert.equal(leakedSecret, false);
        // Navigated data/blob documents would otherwise regain the outer shell's
        // fetch permission. The actual delivery policy must deny both before load.
        for (const scheme of ['data', 'blob']) {
            const preview = page.frames().find(frame => frame.url().startsWith(isolatedOrigin));
            assert.ok(preview);
            await preview.evaluate(() => { location.reload(); });
            await guest.locator('#rendered[data-bundle="yes"]').waitFor();
            const target = page.frames().find(frame => frame.url() === 'about:srcdoc');
            const shell = page.frames().find(frame => frame.url().startsWith(isolatedOrigin));
            assert.ok(target);
            assert.ok(shell);
            await shell.evaluate(() => addEventListener('securitypolicyviolation', event => { if (event.violatedDirective === 'frame-src') window.blockedNavigation = true; }));
            await target.evaluate(({ origin, scheme }) => {
                const content = `<script>fetch('${origin}/v1/leak').then(()=>window.navigatedFetch='allowed',()=>window.navigatedFetch='blocked')</script>`;
                location.href = scheme === 'data' ? `data:text/html,${encodeURIComponent(content)}` : URL.createObjectURL(new Blob([content], { type: 'text/html' }));
            }, { origin: isolatedOrigin, scheme });
            await shell.waitForFunction(() => window.blockedNavigation === true);
            assert.equal(/^(data|blob):/u.test(target.url()), false);
            assert.equal(isolatedApiRequests, 0);
        }
        const unsupported = { v: 1, entrypoint: 'index.html', files: { 'index.html': { mime: 'text/html',
            contentBase64: Buffer.from('<h1>Unsupported</h1><script type="MODULE">document.body.dataset.executed="yes"</script>').toString('base64') } } };
        const unsupportedFragment = Buffer.from(JSON.stringify(unsupported)).toString('base64url');
        await page.locator('#preview').evaluate((element, value) => { element.src = value; }, `${isolatedOrigin}/a/artifact#d=${unsupportedFragment}`);
        await page.frameLocator('#preview').locator('#public-share-viewer').filter({ hasText: 'could not be opened' }).waitFor();
    } finally { await context.close(); await browser.close(); }
});
