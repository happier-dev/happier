import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { expect, it } from 'vitest';

const repositoryRoot = resolve(import.meta.dirname, '../../../../..');
const fixturePath = join(
  repositoryRoot,
  'packages/protocol/fixtures/jsonSchemaValidation.declarationPortability.ts',
);
const typeScriptCliPath = join(repositoryRoot, 'scripts/workspaces/runTypeScriptCli.mjs');

it('emits portable declarations for inferred composable Protocol schemas', async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'happier-protocol-declaration-portability-'));
  try {
    const result = spawnSync(process.execPath, [
      typeScriptCliPath,
      fixturePath,
      '--declaration',
      '--emitDeclarationOnly',
      '--declarationMap', 'false',
      '--sourceMap', 'false',
      '--incremental', 'false',
      '--outDir', outputDirectory,
      '--pretty', 'false',
      '--module', 'ESNext',
      '--moduleResolution', 'Bundler',
      '--target', 'ES2022',
      '--strict',
      '--skipLibCheck',
      '--types', 'node',
    ], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const declaration = await readFile(
      join(outputDirectory, 'fixtures/jsonSchemaValidation.declarationPortability.d.ts'),
      'utf8',
    );
    expect(declaration).toContain('export declare const DeclarationPortableStringSchema');
    expect(declaration).toContain('export declare const DeclarationPortableNestedSchema');
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
}, 15_000);
