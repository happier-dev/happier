import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';
import { deriveUiTypecheckProjects } from '../../apps/ui/scripts/deriveTypecheckProjects.mjs';
import { deriveCliTypecheckProjects } from '../../apps/cli/scripts/deriveTypecheckProjects.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
let preparedProjects;
function projects() {
  return preparedProjects ??= Promise.all([
    deriveUiTypecheckProjects(resolve(repoRoot, 'apps/ui')),
    deriveCliTypecheckProjects(resolve(repoRoot, 'apps/cli')),
  ]);
}

test('first-party declaration emission shares Protocol identity with the real SDK declarations', async t => {
  const scratchParent = resolve(repoRoot, '.happier/qa');
  await mkdir(scratchParent, { recursive: true });
  const scratch = await mkdtemp(resolve(scratchParent, 'declaration-identity-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const entry = resolve(scratch, 'entry.ts');
  await writeFile(entry, [
    'export { definePlugin } from "@happier-dev/plugin-sdk";',
    'export { ApiEphemeralUpdateSchema } from "../../../apps/ui/sources/sync/api/types/apiTypes";',
  ].join('\n'));
  const project = resolve(scratch, 'tsconfig.json');
  const [ui] = await projects();
  await writeFile(project, JSON.stringify({
    extends: ui.find(project => project.project === 'source').configPath,
    compilerOptions: { noEmit: false, declaration: true, emitDeclarationOnly: true,
      noCheck: false, composite: false, incremental: false, rootDir: repoRoot, outDir: resolve(scratch, 'out') },
    files: [entry, resolve(repoRoot, 'apps/ui/sources/sync/api/types/apiTypes.ts')],
    include: [], exclude: [],
  }));
  const result = spawnSync(process.execPath, [resolve(repoRoot, 'scripts/workspaces/runTypeScriptCli.mjs'), '-p', project], {
    cwd: repoRoot, encoding: 'utf8', env: { ...process.env, HAPPIER_TYPESCRIPT_COMPILER: 'microsoft' },
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const emitted = await readFile(resolve(scratch, 'out/apps/ui/sources/sync/api/types/apiTypes.d.ts'), 'utf8');
  assert.ok(emitted.includes('ApiEphemeralUpdateSchema'));
  assert.ok(!emitted.includes('node_modules/@happier-dev/protocol'));
});

test('CLI and UI resolve SDK Protocol imports through the canonical workspace declarations', async () => {
  const [ui, cli] = await projects();
  for (const [name, inventory] of [['cli', cli], ['ui', ui]]) {
    const project = inventory.find(project => project.project === 'source').configPath;
    const parsed = ts.getParsedCommandLineOfConfigFile(project, {}, {
      ...ts.sys, readDirectory: () => [], onUnRecoverableConfigFileDiagnostic: diagnostic => {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
      },
    });
    const sdkDeclaration = resolve(repoRoot, 'packages/plugin-sdk/dist/identity.d.ts');
    for (const [specifier, target] of [
      ['@happier-dev/protocol', 'packages/protocol/dist/index.d.ts'],
      ['@happier-dev/protocol/updates', 'packages/protocol/dist/updates/index.d.ts'],
      ['@happier-dev/protocol/plugins/actions/protocol-composable-schema', 'packages/protocol/dist/plugins/actions/protocolComposableSchema.d.ts'],
      ['@happier-dev/agents', 'packages/agents/dist/index.d.ts'],
    ]) {
      const actual = ts.resolveModuleName(specifier, sdkDeclaration, parsed.options, ts.sys).resolvedModule;
      assert.equal(actual?.resolvedFileName, resolve(repoRoot, target), `${name}: ${specifier}`);
    }
  }
});
