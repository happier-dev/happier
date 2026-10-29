import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveUiPostinstallTasks } from './resolveUiPostinstallTasks.mjs';

test('UI postinstall selects only requested active tasks', () => {
    const env = { HAPPIER_UI_POSTINSTALL_DEPENDENCIES_ONLY: '1',
        HAPPIER_UI_POSTINSTALL_TASKS: JSON.stringify(['vendor-codemirror-webview-bundle']) };
    assert.deepEqual(resolveUiPostinstallTasks({ env }), ['vendor-codemirror-webview-bundle']);
    assert.deepEqual(resolveUiPostinstallTasks({ env: { ...env,
        HAPPIER_UI_POSTINSTALL_TASKS: JSON.stringify(['vendor-password-kdf-worker']) } }), [],
    'task selection cannot activate source compilation excluded by dependency-only mode');
    assert.throws(() => resolveUiPostinstallTasks({ env: { ...env, HAPPIER_UI_POSTINSTALL_TASKS: 'invalid' } }));
});

test('PDF assets are version-vendored and its source bundle is excluded from dependency-only refresh', () => {
    assert.ok(resolveUiPostinstallTasks({ env: {} }).includes('vendor-pdfjs'));
    assert.ok(resolveUiPostinstallTasks({ env: {} }).includes('vendor-pdfjs-webview-bundle'));
    assert.ok(!resolveUiPostinstallTasks({ env: { HAPPIER_UI_VENDOR_WEB_ASSETS: '0' } }).includes('vendor-pdfjs'));
    assert.ok(!resolveUiPostinstallTasks({ env: { HAPPIER_UI_POSTINSTALL_DEPENDENCIES_ONLY: '1' } }).includes('vendor-pdfjs-webview-bundle'));
});

test('dependency-only preparation leaves source artifact compilation to its independent owner', () => {
    const tasks = resolveUiPostinstallTasks({ env: { HAPPIER_UI_POSTINSTALL_DEPENDENCIES_ONLY: '1' } });
    assert.ok(!tasks.includes('patch-package'));
    assert.ok(tasks.includes('verify-patched-dependencies'));
    for (const task of ['vendor-password-kdf-worker', 'vendor-crypto-worker', 'prepare-atmosphere-renderers',
        'vendor-tiptap-webview-bundle', 'vendor-mermaid-webview-bundle']) assert.equal(tasks.includes(task), false);
});

test('UI prepares the native atmosphere closure even without web assets', () => {
    for (const enabled of ['0', '1']) {
        assert.ok(resolveUiPostinstallTasks({ env: { HAPPIER_UI_VENDOR_WEB_ASSETS: enabled } }).includes('prepare-atmosphere-renderers'));
    }
});

test('UI postinstall prepares the password worker for web and desktop assets', () => {
    assert.ok(resolveUiPostinstallTasks({ env: {} }).includes('vendor-password-kdf-worker'));
    assert.ok(!resolveUiPostinstallTasks({ env: { HAPPIER_UI_VENDOR_WEB_ASSETS: '0' } }).includes('vendor-password-kdf-worker'));
});

test('UI prepares the crypto worker for web and desktop assets', () => {
    assert.ok(resolveUiPostinstallTasks({ env: {} }).includes('vendor-crypto-worker'));
    assert.ok(!resolveUiPostinstallTasks({ env: { HAPPIER_UI_VENDOR_WEB_ASSETS: '0' } }).includes('vendor-crypto-worker'));
});

test('UI postinstall installs enriched-markdown web WASM before verifying the patch', () => {
    const tasks = resolveUiPostinstallTasks({ env: { HAPPIER_UI_VENDOR_WEB_ASSETS: '0' } });

    assert.ok(tasks.includes('install-react-native-enriched-markdown-web-wasm'));
    assert.ok(tasks.includes('verify-react-native-enriched-markdown-web-streaming-patch'));
    assert.ok(
        tasks.indexOf('install-react-native-enriched-markdown-web-wasm')
        < tasks.indexOf('verify-react-native-enriched-markdown-web-streaming-patch'),
    );
});

test('UI postinstall verifies pnpm-installed patches without a second patch writer', () => {
    const tasks = resolveUiPostinstallTasks({ env: { HAPPIER_UI_VENDOR_WEB_ASSETS: '0' } });

    assert.ok(!tasks.includes('patch-package'));
    for (const task of ['verify-patched-dependencies', 'verify-sentry-native-replay-postinit-patch',
        'verify-native-patch-compilation', 'verify-vendored-legend-patch', 'verify-vendored-reanimated-patch']) {
        assert.ok(tasks.includes(task));
    }
});

test('UI postinstall vendors the TipTap WebView bundle with other web assets', () => {
    const tasks = resolveUiPostinstallTasks({ env: { HAPPIER_UI_VENDOR_WEB_ASSETS: '1' } });

    assert.ok(tasks.includes('vendor-tiptap-webview-bundle'));
});

test('UI postinstall never packages browser Iroh assets, however it is asked', () => {
    // Lane 06 A8: browser Iroh assets are staged per build target, into the web
    // output that build owns. Install time has no target, so a postinstall step
    // could only write to the shared source `public/` tree — where a later Tauri
    // or native export would inherit ~4.9MB of browser-only wasm. The producer
    // is `tools/iroh/buildBrowserIrohAssets.mjs --output-dir <web output>`, run
    // by the web release build.
    for (const env of [
        { HAPPIER_UI_VENDOR_WEB_ASSETS: '1' },
        { HAPPIER_UI_VENDOR_WEB_ASSETS: '1', HAPPIER_UI_VENDOR_BROWSER_IROH: '1' },
        { HAPPIER_UI_VENDOR_WEB_ASSETS: '0', HAPPIER_UI_VENDOR_BROWSER_IROH: '1' },
    ]) {
        assert.ok(!resolveUiPostinstallTasks({ env }).includes('vendor-browser-iroh-wasm'));
    }
});
