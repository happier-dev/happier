import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

test('apps/stack package.json exposes a tauri launcher alias for stack-local cwd usage', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir);

  const raw = await readFile(join(packageRoot, 'package.json'), 'utf-8');
  const pkg = JSON.parse(raw);
  const scripts = pkg?.scripts ?? {};

  assert.equal(scripts['ui:tauri'], 'node ./scripts/tauri_dev.mjs');
  assert.equal(scripts['tauri:dev'], 'node ./scripts/tauri_dev.mjs');
});
