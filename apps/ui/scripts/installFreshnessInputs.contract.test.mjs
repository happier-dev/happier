import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import test from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveUiPostinstallTasks } from '../tools/resolveUiPostinstallTasks.mjs';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test('UI manifest declares every local postinstall input through the canonical install freshness owner', async () => {
  const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  const declaredInputs = packageJson?.happier?.installFreshnessInputs;
  const tasks = resolveUiPostinstallTasks({ env: { HAPPIER_UI_VENDOR_WEB_ASSETS: '1' } });
  const localInputsByTask = new Map([
    ['patch-package', ['patches']],
    ['verify-native-patch-compilation', ['patches', 'app.config.js']],
    ['verify-expo-router-web-modal-patch', ['patches']],
    ['verify-sentry-native-replay-postinit-patch', ['patches']],
    ['install-react-native-enriched-markdown-web-wasm', ['tools/react-native-enriched-markdown']],
    ['verify-react-native-enriched-markdown-web-streaming-patch', ['patches', 'tools/react-native-enriched-markdown']],
    ['setup-skia-web', []],
    ['vendor-monaco', []],
    ['vendor-pierre-diffs-worker', ['tools/diffs']],
    ['vendor-codemirror-webview-bundle', ['tools/codemirror']],
    ['vendor-xterm-webview-bundle', ['tools/xterm']],
    [
      'vendor-tiptap-webview-bundle',
      [
        'tools/tiptap',
        'sources/components/ui/markdown/editor/bridge/tiptapWebViewEntry.ts',
      ],
    ],
    [
      'vendor-mermaid-webview-bundle',
      [
        'tools/mermaid',
        'sources/components/markdown/mermaidWebViewEntry.ts',
      ],
    ],
  ]);

  assert.deepEqual(
    [...localInputsByTask.keys()].sort(),
    [...tasks].sort(),
    'every resolved postinstall task must declare its local source inputs in this contract',
  );

  const expectedInputs = [...new Set([
    'tools/postinstall.mjs',
    'tools/resolveUiPostinstallTasks.mjs',
    'tools/ensureNohoistPeerLinks.mjs',
    'tools/postinstall',
    ...[...localInputsByTask.values()].flat(),
  ])].sort();
  assert.ok(Array.isArray(declaredInputs));
  assert.deepEqual([...declaredInputs].sort(), expectedInputs);
  for (const relativePath of declaredInputs) {
    await assert.doesNotReject(
      () => stat(join(packageRoot, relativePath)),
      `install freshness input must exist: ${relativePath}`,
    );
  }
});
