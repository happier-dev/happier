import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import ts from 'typescript';
import { expect, it } from 'vitest';

const repositoryRoot = resolve(import.meta.dirname, '../../../../..');

function declarationType(source: string, name: string): string {
  const parsed = ts.createSourceFile('schema.d.ts', source, ts.ScriptTarget.Latest, true);
  for (const statement of parsed.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name && declaration.type) {
        return declaration.type.getText(parsed);
      }
    }
  }
  throw new Error(`Missing declaration type for ${name}`);
}

it('emits availability aliases more compactly than their canonical schema declarations', async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'happier-availability-declarations-'));
  try {
    const result = spawnSync(process.execPath, [
      join(repositoryRoot, 'scripts/workspaces/runTypeScriptCli.mjs'),
      join(repositoryRoot, 'packages/protocol/src/auth/tr46.d.ts'),
      join(repositoryRoot, 'packages/protocol/src/plugins/availability/actions.ts'),
      '--declaration', '--emitDeclarationOnly',
      '--declarationMap', 'false', '--sourceMap', 'false', '--incremental', 'false',
      '--rootDir', join(repositoryRoot, 'packages/protocol/src'),
      '--outDir', outputDirectory,
      '--pretty', 'false', '--module', 'ESNext', '--moduleResolution', 'Bundler',
      '--target', 'ES2022', '--strict', '--skipLibCheck', '--types', 'node',
    ], { cwd: repositoryRoot, encoding: 'utf8' });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const [availability, actions, manifest] = await Promise.all([
      readFile(join(outputDirectory, 'plugins/availability/v1.d.ts'), 'utf8'),
      readFile(join(outputDirectory, 'plugins/availability/actions.d.ts'), 'utf8'),
      readFile(join(outputDirectory, 'plugins/manifest/v2.d.ts'), 'utf8'),
    ]);
    for (const [aliasSource, aliasName, canonicalSource, canonicalName] of [
      [availability, 'PluginPortableReleaseManifestV1Schema', manifest, 'PluginManifestV2Schema'],
      [actions, 'PluginAvailabilityIntentReadActionOutputV1Schema', availability, 'PluginAccountAvailabilityIntentReadResponseV1Schema'],
      [actions, 'PluginAvailabilityReleaseReadActionOutputV1Schema', availability, 'PluginAccountAvailabilityReleaseReadResponseV1Schema'],
    ]) {
      // The same schema object is exported under both names. Its alias must not
      // duplicate the megabyte-scale canonical shape in the shipped authoring types.
      expect.soft(Buffer.byteLength(declarationType(aliasSource, aliasName)), aliasName)
        .toBeLessThan(Buffer.byteLength(declarationType(canonicalSource, canonicalName)));
    }
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
}, 60_000);
