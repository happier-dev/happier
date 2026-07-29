import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import { main as bootstrapExtensionPackage } from './bootstrapExtensionPackage.ts';

test('bootstrapExtensionPackage copies only the strict public authoring template', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04a-bootstrap-'));
  mkdirSync(resolve(repoRoot, 'packages/agents/src'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/agents/src/types.ts'),
    "export const CANONICAL_AGENT_IDS = Object.freeze(['codex'] as const);\n",
    'utf8',
  );

  const templateRoot = resolve(repoRoot, 'packages/plugins/_template');
  mkdirSync(resolve(templateRoot, 'src'), { recursive: true });
  writeFileSync(
    resolve(templateRoot, 'package.json'),
    `${JSON.stringify({ name: '@happier-dev/plugins-template', private: true, type: 'module' }, null, 2)}\n`,
    'utf8',
  );
  writeFileSync(
    resolve(templateRoot, 'tsconfig.json'),
    `${JSON.stringify({ compilerOptions: { rootDir: 'src', outDir: 'dist' }, include: ['src/**/*.ts'] }, null, 2)}\n`,
    'utf8',
  );
  writeFileSync(
    resolve(templateRoot, 'src/manifest.ts'),
    'export const PLUGIN_MANIFEST = { schemaVersion: 2, id: "__pluginId__", displayName: "__pluginDisplayName__", entrypoints: { daemon: "./dist/index.js" }, hostAccess: { required: [], optional: [] }, contributes: { actions: [{ id: "save-note" }] } };\n',
    'utf8',
  );
  writeFileSync(
    resolve(templateRoot, 'src/activate.ts'),
    'export function activate(api: PluginActivationApi): () => Promise<void> { api.actions.register("save-note", saveNote); return async () => undefined; }\n',
    'utf8',
  );
  writeFileSync(
    resolve(templateRoot, 'src/index.ts'),
    'export * from "./manifest.js"; export * from "./activate.js";\n',
    'utf8',
  );

  await bootstrapExtensionPackage(['codex', '--root', repoRoot]);

  const outputRoot = resolve(repoRoot, 'packages/plugins/codex');
  const pkgJson = JSON.parse(readFileSync(resolve(outputRoot, 'package.json'), 'utf8')) as { name: string };
  assert.equal(pkgJson.name, '@happier-dev/plugins-codex');

  const manifest = readFileSync(resolve(outputRoot, 'src/manifest.ts'), 'utf8');
  const activation = readFileSync(resolve(outputRoot, 'src/activate.ts'), 'utf8');
  assert.ok(!manifest.includes('__pluginId__'));
  assert.ok(!manifest.includes('__pluginDisplayName__'));
  assert.match(manifest, /happier\.agent\.codex/);
  assert.match(manifest, /entrypoints:\s*\{ daemon:/);
  assert.match(manifest, /hostAccess:\s*\{ required: \[\], optional: \[\] \}/);
  assert.match(activation, /api\.actions\.register\("save-note"/);
  assert.match(activation, /return async \(\) => undefined/);
  assert.ok(!existsSync(resolve(outputRoot, 'src/agent/definition.ts')));
  assert.ok(!existsSync(resolve(outputRoot, 'src/cli.ts')));
  assert.ok(!existsSync(resolve(outputRoot, 'src/ui/index.ts')));
  assert.doesNotMatch(`${manifest}\n${activation}`, /AGENT_DEFINITION|PluginApi|PluginContext|registerAction|registerTool|onDispose/);
});
