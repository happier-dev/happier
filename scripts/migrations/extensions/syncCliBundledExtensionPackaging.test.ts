import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import { main as syncCliBundledExtensionPackaging } from './syncCliBundledExtensionPackaging.ts';

function writeJson(path: string, value: unknown): void {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

test('syncCliBundledExtensionPackaging adds extension workspaces to apps/cli bundledDependencies', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-sync-'));
  mkdirSync(resolve(repoRoot, 'apps/cli'), { recursive: true });

  writeJson(resolve(repoRoot, 'packages/extensions/claude/package.json'), { name: '@happier-dev/extensions-claude' });
  writeJson(resolve(repoRoot, 'packages/extensions/codex/package.json'), { name: '@happier-dev/extensions-codex' });

  writeJson(resolve(repoRoot, 'apps/cli/package.json'), {
    name: '@happier-dev/cli',
    bundledDependencies: ['@happier-dev/protocol'],
  });

  await syncCliBundledExtensionPackaging(['--root', repoRoot, '--mode', 'write']);

  const updated = JSON.parse(readFileSync(resolve(repoRoot, 'apps/cli/package.json'), 'utf8')) as {
    bundledDependencies?: unknown;
  };
  const bundled = Array.isArray(updated.bundledDependencies) ? updated.bundledDependencies.map(String) : [];

  assert.ok(bundled.includes('@happier-dev/protocol'));
  assert.ok(bundled.includes('@happier-dev/extensions-claude'));
  assert.ok(bundled.includes('@happier-dev/extensions-codex'));
  assert.ok(
    bundled.indexOf('@happier-dev/extensions-claude') < bundled.indexOf('@happier-dev/extensions-codex'),
    'expected lexical order for extension package names',
  );
});
