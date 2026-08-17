import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import { main as bootstrapExtensionPackage } from './bootstrapExtensionPackage.ts';

test('bootstrapExtensionPackage boots the canonical definePlugin authoring template', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04a-bootstrap-'));
  mkdirSync(resolve(repoRoot, 'packages/agents/src'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/agents/src/types.ts'),
    "export const CANONICAL_AGENT_IDS = Object.freeze(['codex'] as const);\n",
    'utf8',
  );

  const templateRoot = resolve(repoRoot, 'packages/plugins/_template');
  cpSync(resolve(import.meta.dirname, '../../../packages/plugins/_template'), templateRoot, { recursive: true });
  writeFileSync(resolve(templateRoot, 'src/manifest.ts'), 'export const manifest = {}\n', 'utf8');
  await assert.rejects(
    bootstrapExtensionPackage(['codex', '--root', repoRoot]),
    /Retired template file 'src\/manifest\.ts' must not be scaffolded/,
  );
  rmSync(resolve(templateRoot, 'src/manifest.ts'));

  await bootstrapExtensionPackage(['codex', '--root', repoRoot]);

  const outputRoot = resolve(repoRoot, 'packages/plugins/codex');
  const pkgJson = JSON.parse(readFileSync(resolve(outputRoot, 'package.json'), 'utf8')) as { name: string };
  assert.equal(pkgJson.name, '@happier-dev/plugins-codex');

  const source = readFileSync(resolve(outputRoot, 'src/index.ts'), 'utf8');
  assert.ok(!source.includes('__pluginId__'));
  assert.ok(!source.includes('__pluginDisplayName__'));
  assert.match(source, /happier\.agent\.codex/);
  assert.match(source, /definePlugin\(/);
  assert.match(source, /export const \{ manifest, activate \} = definePlugin\(/);
  assert.match(source, /actions:\s*\{/);
  assert.match(source, /hooks:\s*\{/);
  assert.match(source, /tools:\s*\{/);
  assert.match(source, /commands:\s*\{/);
  assert.match(source, /settings:\s*\{/);
  assert.ok(!existsSync(resolve(outputRoot, 'src/agent/definition.ts')));
  assert.ok(!existsSync(resolve(outputRoot, 'src/cli.ts')));
  assert.ok(!existsSync(resolve(outputRoot, 'src/ui/index.ts')));
  assert.ok(!existsSync(resolve(outputRoot, 'src/manifest.ts')));
  assert.ok(!existsSync(resolve(outputRoot, 'src/activate.ts')));
  assert.doesNotMatch(source, /AGENT_DEFINITION|PluginApi|PluginContext|registerAction|registerTool|onDispose|contributes\s*:/);
});
