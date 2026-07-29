import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveUiPostinstallTasks } from './resolveUiPostinstallTasks.mjs';

test('UI postinstall installs enriched-markdown web WASM before verifying the patch', () => {
    const tasks = resolveUiPostinstallTasks({ env: { HAPPIER_UI_VENDOR_WEB_ASSETS: '0' } });

    assert.ok(tasks.includes('install-react-native-enriched-markdown-web-wasm'));
    assert.ok(tasks.includes('verify-react-native-enriched-markdown-web-streaming-patch'));
    assert.ok(
        tasks.indexOf('install-react-native-enriched-markdown-web-wasm')
        < tasks.indexOf('verify-react-native-enriched-markdown-web-streaming-patch'),
    );
});

test('UI postinstall verifies the Sentry native replay patch after applying patches', () => {
    const tasks = resolveUiPostinstallTasks({ env: { HAPPIER_UI_VENDOR_WEB_ASSETS: '0' } });

    assert.ok(tasks.includes('patch-package'));
    assert.ok(tasks.includes('verify-sentry-native-replay-postinit-patch'));
    assert.ok(
        tasks.indexOf('patch-package')
        < tasks.indexOf('verify-sentry-native-replay-postinit-patch'),
    );
});

test('UI postinstall vendors the TipTap WebView bundle with other web assets', () => {
    const tasks = resolveUiPostinstallTasks({ env: { HAPPIER_UI_VENDOR_WEB_ASSETS: '1' } });

    assert.ok(tasks.includes('vendor-tiptap-webview-bundle'));
});
