import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import { main as bootstrapExtensionPackage } from './bootstrapExtensionPackage.ts';

test('bootstrapExtensionPackage scaffolds a new extension package from the template', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04a-bootstrap-'));

  mkdirSync(resolve(repoRoot, 'packages/agents/src'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/agents/src/types.ts'),
    "export const CANONICAL_AGENT_IDS = Object.freeze(['codex'] as const);\n",
    'utf8',
  );

  mkdirSync(resolve(repoRoot, 'packages/plugins/_template/src/ui'), { recursive: true });
  mkdirSync(resolve(repoRoot, 'packages/plugins/_template/src/agent'), { recursive: true });

  // Minimal template inputs required by the bootstrapper.
  mkdirSync(resolve(repoRoot, 'packages/plugins/_template'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/_template/package.json'),
    JSON.stringify({ name: '@happier-dev/plugins-__extensionId__', private: true, type: 'module' }, null, 2) + '\n',
    'utf8',
  );
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/_template/tsconfig.json'),
    JSON.stringify({ compilerOptions: { rootDir: 'src', outDir: 'dist' }, include: ['src/**/*.ts'] }, null, 2) + '\n',
    'utf8',
  );
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/_template/src/agent/definition.ts'),
    'export const AGENT_DEFINITION = Object.freeze({ id: \"__extensionId__\" });\n',
    'utf8',
  );
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/_template/src/manifest.ts'),
    'export const EXTENSION_MANIFEST = Object.freeze({ schemaVersion: 2, id: \"__extensionId__\" });\n',
    'utf8',
  );
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/_template/src/activate.ts'),
    'export function activate(): void {}\n',
    'utf8',
  );
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/_template/src/cli.ts'),
    'export const cli = {};\n',
    'utf8',
  );
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/_template/src/ui/index.ts'),
    'export const ui = {};\n',
    'utf8',
  );

  await bootstrapExtensionPackage(['codex', '--root', repoRoot]);

  const pkgJson = JSON.parse(readFileSync(resolve(repoRoot, 'packages/plugins/codex/package.json'), 'utf8')) as { name: string };
  assert.equal(pkgJson.name, '@happier-dev/plugins-codex');

  const definition = readFileSync(resolve(repoRoot, 'packages/plugins/codex/src/agent/definition.ts'), 'utf8');
  assert.match(definition, /export const AGENT_DEFINITION/);
  assert.match(definition, /"codex"/);

  const manifest = readFileSync(resolve(repoRoot, 'packages/plugins/codex/src/manifest.ts'), 'utf8');
  assert.ok(!manifest.includes('__extensionId__'), 'expected bootstrapper to replace placeholders in template files');
});
