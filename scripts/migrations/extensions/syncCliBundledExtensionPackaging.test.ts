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

test('syncCliBundledExtensionPackaging adds plugin workspaces to both CLI shipping declarations', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-sync-'));
  mkdirSync(resolve(repoRoot, 'apps/cli'), { recursive: true });

  writeJson(resolve(repoRoot, 'packages/plugins/claude/package.json'), { name: '@happier-dev/plugins-claude' });
  writeJson(resolve(repoRoot, 'packages/plugins/codex/package.json'), { name: '@happier-dev/plugins-codex' });
  mkdirSync(resolve(repoRoot, 'packages/plugins/claude/src'), { recursive: true });
  mkdirSync(resolve(repoRoot, 'packages/plugins/codex/src'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/claude/src/manifest.ts'),
    'export const PLUGIN_MANIFEST = Object.freeze({ id: "claude", runtime: { apiVersion: 1 }, contributes: {} });\n',
    'utf8',
  );
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/codex/src/manifest.ts'),
    'export const PLUGIN_MANIFEST = Object.freeze({ id: "codex", runtime: { apiVersion: 1 }, contributes: {} });\n',
    'utf8',
  );
  mkdirSync(resolve(repoRoot, 'packages/plugins/claude/src/agent'), { recursive: true });
  mkdirSync(resolve(repoRoot, 'packages/plugins/codex/src/agent'), { recursive: true });
  writeFileSync(resolve(repoRoot, 'packages/plugins/claude/src/agent/definition.ts'), 'export const AGENT_DEFINITION = Object.freeze({ id: "claude" });\n', 'utf8');
  writeFileSync(resolve(repoRoot, 'packages/plugins/codex/src/agent/definition.ts'), 'export const AGENT_DEFINITION = Object.freeze({ id: "codex" });\n', 'utf8');

  writeJson(resolve(repoRoot, 'apps/cli/package.json'), {
    name: '@happier-dev/cli',
    bundledDependencies: ['@happier-dev/protocol', 'tweetnacl'],
    dependencies: {
      '@happier-dev/protocol': '0.0.0',
      tweetnacl: '^1.0.3',
    },
  });

  await syncCliBundledExtensionPackaging(['--root', repoRoot, '--mode', 'write']);

  const updated = JSON.parse(readFileSync(resolve(repoRoot, 'apps/cli/package.json'), 'utf8')) as {
    bundledDependencies?: unknown;
    dependencies?: Record<string, string>;
  };
  const bundled = Array.isArray(updated.bundledDependencies) ? updated.bundledDependencies.map(String) : [];

  assert.ok(bundled.includes('@happier-dev/protocol'));
  assert.ok(bundled.includes('@happier-dev/plugins-claude'));
  assert.ok(bundled.includes('@happier-dev/plugins-codex'));
  assert.ok(
    bundled.indexOf('@happier-dev/plugins-codex') < bundled.indexOf('tweetnacl'),
    'expected bundled plugin workspaces before external bundled dependencies',
  );
  assert.ok(
    bundled.indexOf('@happier-dev/plugins-claude') < bundled.indexOf('@happier-dev/plugins-codex'),
    'expected lexical order for plugin package names',
  );
  assert.equal(updated.dependencies?.['@happier-dev/plugins-claude'], '0.0.0');
  assert.equal(updated.dependencies?.['@happier-dev/plugins-codex'], '0.0.0');
});

test('syncCliBundledExtensionPackaging check mode rejects a bundled plugin missing from dependencies', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-sync-check-dependencies-'));
  mkdirSync(resolve(repoRoot, 'apps/cli'), { recursive: true });

  writeJson(resolve(repoRoot, 'packages/plugins/grok/package.json'), {
    name: '@happier-dev/plugins-grok',
  });
  mkdirSync(resolve(repoRoot, 'packages/plugins/grok/src'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/grok/src/manifest.ts'),
    'export const PLUGIN_MANIFEST = Object.freeze({ id: "grok", runtime: { apiVersion: 1 }, contributes: {} });\n',
    'utf8',
  );
  writeJson(resolve(repoRoot, 'apps/cli/package.json'), {
    name: '@happier-dev/cli',
    bundledDependencies: ['@happier-dev/plugins-grok'],
    dependencies: {},
  });

  await assert.rejects(
    () => syncCliBundledExtensionPackaging(['--root', repoRoot, '--mode', 'check']),
    /dependencies are out of sync/u,
  );
});

test('syncCliBundledExtensionPackaging skips reservation-only plugin packages', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-sync-skip-'));
  mkdirSync(resolve(repoRoot, 'apps/cli'), { recursive: true });

  writeJson(resolve(repoRoot, 'packages/plugins/claude/package.json'), { name: '@happier-dev/plugins-claude' });
  writeJson(resolve(repoRoot, 'packages/plugins/placeholder/package.json'), {
    name: '@happier-dev/plugins-placeholder',
    happier: {
      extensionScaffold: {
        shipping: 'reservation_only',
        plannedStage: 'E.99',
      },
    },
  });
  mkdirSync(resolve(repoRoot, 'packages/plugins/claude/src'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/claude/src/manifest.ts'),
    'export const PLUGIN_MANIFEST = Object.freeze({ id: "claude", runtime: { apiVersion: 1 }, contributes: {} });\n',
    'utf8',
  );
  mkdirSync(resolve(repoRoot, 'packages/plugins/claude/src/agent'), { recursive: true });
  writeFileSync(resolve(repoRoot, 'packages/plugins/claude/src/agent/definition.ts'), 'export const AGENT_DEFINITION = Object.freeze({ id: "claude" });\n', 'utf8');

  writeJson(resolve(repoRoot, 'apps/cli/package.json'), {
    name: '@happier-dev/cli',
    bundledDependencies: ['@happier-dev/protocol'],
  });

  await syncCliBundledExtensionPackaging(['--root', repoRoot, '--mode', 'write']);

  const updated = JSON.parse(readFileSync(resolve(repoRoot, 'apps/cli/package.json'), 'utf8')) as {
    bundledDependencies?: unknown;
  };
  const bundled = Array.isArray(updated.bundledDependencies) ? updated.bundledDependencies.map(String) : [];

  assert.ok(bundled.includes('@happier-dev/plugins-claude'));
  assert.ok(!bundled.includes('@happier-dev/plugins-placeholder'));
});

test('syncCliBundledExtensionPackaging includes non-agent plugin packages without agent definitions', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-sync-non-agent-'));
  mkdirSync(resolve(repoRoot, 'apps/cli'), { recursive: true });

  writeJson(resolve(repoRoot, 'packages/plugins/scm-github/package.json'), { name: '@happier-dev/plugins-scm-github' });
  mkdirSync(resolve(repoRoot, 'packages/plugins/scm-github/src'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/scm-github/src/manifest.ts'),
    'export const PLUGIN_MANIFEST = Object.freeze({ id: "scm-github", runtime: { apiVersion: 1 } });\n',
    'utf8',
  );
  writeJson(resolve(repoRoot, 'apps/cli/package.json'), {
    name: '@happier-dev/cli',
    bundledDependencies: ['@happier-dev/protocol'],
  });

  await syncCliBundledExtensionPackaging(['--root', repoRoot, '--mode', 'write']);

  const updated = JSON.parse(readFileSync(resolve(repoRoot, 'apps/cli/package.json'), 'utf8')) as {
    bundledDependencies?: unknown;
  };
  const bundled = Array.isArray(updated.bundledDependencies) ? updated.bundledDependencies.map(String) : [];

  assert.ok(bundled.includes('@happier-dev/plugins-scm-github'));
});

test('syncCliBundledExtensionPackaging fails for unmarked plugin packages without manifests', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-sync-missing-definition-'));
  mkdirSync(resolve(repoRoot, 'apps/cli'), { recursive: true });

  writeJson(resolve(repoRoot, 'packages/plugins/placeholder/package.json'), { name: '@happier-dev/plugins-placeholder' });
  writeJson(resolve(repoRoot, 'apps/cli/package.json'), {
    name: '@happier-dev/cli',
    bundledDependencies: ['@happier-dev/protocol'],
  });

  await assert.rejects(
    () => syncCliBundledExtensionPackaging(['--root', repoRoot, '--mode', 'write']),
    /Missing required plugin manifest/,
  );
});

test('syncCliBundledExtensionPackaging fails when the CLI package manifest is missing', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-sync-missing-cli-package-'));

  writeJson(resolve(repoRoot, 'packages/plugins/scm-github/package.json'), { name: '@happier-dev/plugins-scm-github' });
  mkdirSync(resolve(repoRoot, 'packages/plugins/scm-github/src'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/scm-github/src/manifest.ts'),
    'export const PLUGIN_MANIFEST = Object.freeze({ id: "scm-github", runtime: { apiVersion: 1 } });\n',
    'utf8',
  );

  await assert.rejects(
    () => syncCliBundledExtensionPackaging(['--root', repoRoot, '--mode', 'write']),
    /Missing CLI package\.json/,
  );
});
