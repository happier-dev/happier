import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
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

it('emits declarations that remain valid for an external NodeNext consumer', async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'happier-protocol-declaration-portability-'));
  try {
    const result = spawnSync(process.execPath, [
      typeScriptCliPath,
      join(repositoryRoot, 'packages/protocol/src/auth/tr46.d.ts'),
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
    expect(declaration).toContain('export declare const DeclarationPortableSessionDraftAuthoringFieldsSchema');

    await symlink(
      join(repositoryRoot, 'packages/protocol/node_modules'),
      join(outputDirectory, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const consumerResult = spawnSync(process.execPath, [
      typeScriptCliPath,
      join(outputDirectory, 'fixtures/jsonSchemaValidation.declarationPortability.d.ts'),
      '--noEmit',
      '--pretty', 'false',
      '--module', 'NodeNext',
      '--moduleResolution', 'NodeNext',
      '--target', 'ES2022',
      '--strict',
      '--skipLibCheck', 'false',
      '--types', 'node',
    ], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    });
    expect(consumerResult.status, `${consumerResult.stdout}\n${consumerResult.stderr}`).toBe(0);
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
}, 60_000);
