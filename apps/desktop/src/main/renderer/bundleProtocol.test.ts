import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
    BUNDLE_ORIGIN,
    BUNDLE_SCHEME_PRIVILEGES,
    createBundleResponder,
    resolveContentType,
    resolveRequestPath,
} from './bundleProtocol';

test('the bundle origin is not an http(s) origin, so the app cannot mistake it for a relay', () => {
    assert.equal(new URL(BUNDLE_ORIGIN).protocol, 'happier:');
    assert.notEqual(new URL(BUNDLE_ORIGIN).protocol, 'http:');
    assert.notEqual(new URL(BUNDLE_ORIGIN).protocol, 'https:');
});

test('the scheme is a secure standard origin so storage and crypto.subtle work', () => {
    assert.equal(BUNDLE_SCHEME_PRIVILEGES.standard, true);
    assert.equal(BUNDLE_SCHEME_PRIVILEGES.secure, true);
});

test('a request path always resolves inside the served bundle directory', () => {
    const root = '/srv/dist';
    for (const requestPath of [
        '/../../etc/passwd',
        '/%2e%2e/%2e%2e/etc/passwd',
        '/../dist-other/index.html',
        '//etc/passwd',
        '/assets/../../../../etc/passwd',
    ]) {
        const resolved = resolveRequestPath(root, requestPath);
        assert.ok(
            resolved === null || resolved === root || resolved.startsWith(`${root}/`),
            `${requestPath} resolved outside the bundle directory: ${resolved}`,
        );
    }
});

test('a malformed percent-encoded path is rejected outright', () => {
    assert.equal(resolveRequestPath('/srv/dist', '/%E0%A4%A'), null);
});

test('an ordinary asset path maps onto the bundle file, ignoring query and fragment', () => {
    assert.equal(resolveRequestPath('/srv/dist', '/_expo/static/js/web/index.js'), '/srv/dist/_expo/static/js/web/index.js');
    assert.equal(resolveRequestPath('/srv/dist', '/index.html?v=1#frag'), '/srv/dist/index.html');
});

test('bundle asset types the app depends on are served with their real content type', () => {
    assert.equal(resolveContentType('/dist/_expo/static/js/web/index.js'), 'text/javascript; charset=utf-8');
    assert.equal(resolveContentType('/dist/canvaskit.wasm'), 'application/wasm');
    assert.equal(resolveContentType('/dist/assets/font.ttf'), 'font/ttf');
    assert.equal(resolveContentType('/dist/unknown.bin'), 'application/octet-stream');
});

test('assets are served verbatim and unknown routes fall back to the app shell', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-desktop-dist-'));
    await writeFile(join(root, 'index.html'), '<html>app</html>', 'utf8');
    await mkdir(join(root, '_expo'), { recursive: true });
    await writeFile(join(root, '_expo', 'bundle.js'), 'console.log(1)', 'utf8');
    const respond = createBundleResponder(root);

    const asset = await respond(`${BUNDLE_ORIGIN}/_expo/bundle.js`);
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal(await asset.text(), 'console.log(1)');

    const route = await respond(`${BUNDLE_ORIGIN}/terminal/connect`);
    assert.equal(route.status, 200);
    assert.equal(await route.text(), '<html>app</html>');
});

test('a traversal request serves the app shell rather than a file outside the bundle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-desktop-dist-'));
    await writeFile(join(root, 'index.html'), '<html>app</html>', 'utf8');
    const respond = createBundleResponder(root);

    const escaped = await respond(`${BUNDLE_ORIGIN}/%2e%2e/%2e%2e/etc/hosts`);
    assert.equal(await escaped.text(), '<html>app</html>');
});
