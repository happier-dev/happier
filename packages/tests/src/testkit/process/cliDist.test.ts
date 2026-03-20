import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, rmSync, utimesSync } from 'node:fs';

import { ensureCliDistBuilt, ensureCliSharedDepsBuilt, withCliDistBuildLock } from './cliDist';
import { sleep } from '../timing';

const createdDirs: string[] = [];

async function createRepoRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'happier-cli-dist-test-'));
  createdDirs.push(root);
  await mkdir(join(root, '.project', 'tmp'), { recursive: true });
  await mkdir(join(root, 'apps', 'cli', 'src'), { recursive: true });
  await mkdir(join(root, 'apps', 'cli', 'dist'), { recursive: true });
  await mkdir(join(root, 'apps', 'cli', 'node_modules', '@happier-dev'), { recursive: true });
  for (const pkgName of ['agents', 'cli-common', 'protocol', 'release-runtime']) {
    await mkdir(join(root, 'packages', pkgName, 'src'), { recursive: true });
    await mkdir(join(root, 'packages', pkgName, 'dist'), { recursive: true });
    await mkdir(join(root, 'apps', 'cli', 'node_modules', '@happier-dev', pkgName, 'dist'), {
      recursive: true,
    });
    await writeFile(join(root, 'packages', pkgName, 'package.json'), `{"name":"@happier-dev/${pkgName}"}`, 'utf8');
    await writeFile(
      join(root, 'apps', 'cli', 'node_modules', '@happier-dev', pkgName, 'package.json'),
      `{"name":"@happier-dev/${pkgName}"}`,
      'utf8',
    );
    await writeFile(join(root, 'packages', pkgName, 'tsconfig.json'), '{}', 'utf8');
    await writeFile(join(root, 'packages', pkgName, 'src', 'index.ts'), 'export const ok = true;\n', 'utf8');
    await writeFile(join(root, 'packages', pkgName, 'dist', 'index.js'), 'exports.ok = true;\n', 'utf8');
    await writeFile(
      join(root, 'apps', 'cli', 'node_modules', '@happier-dev', pkgName, 'dist', 'index.js'),
      'exports.ok = true;\n',
      'utf8',
    );
    const pkgDistPath = join(root, 'packages', pkgName, 'dist', 'index.js');
    const bundledPkgDistPath = join(root, 'apps', 'cli', 'node_modules', '@happier-dev', pkgName, 'dist', 'index.js');
    const pkgOutputTime = new Date('2030-03-09T01:10:00.000Z');
    utimesSync(pkgDistPath, pkgOutputTime, pkgOutputTime);
    utimesSync(bundledPkgDistPath, pkgOutputTime, pkgOutputTime);
  }
  await writeFile(join(root, 'apps', 'cli', 'package.json'), '{"name":"@happier-dev/cli"}', 'utf8');
  await writeFile(join(root, 'apps', 'cli', 'tsconfig.json'), '{}', 'utf8');
  await writeFile(join(root, 'apps', 'cli', 'src', 'index.ts'), 'export const ok = true;\n', 'utf8');
  await writeFile(join(root, 'apps', 'cli', 'src', 'cliDistBehavior.test.ts'), 'export const testOnly = true;\n', 'utf8');
  await writeFile(join(root, 'apps', 'cli', 'dist', 'index.mjs'), 'export const ok = true;\n', 'utf8');
  const baseline = new Date('2026-03-09T00:55:00.000Z');
  for (const target of [
    join(root, 'apps', 'cli', 'package.json'),
    join(root, 'apps', 'cli', 'tsconfig.json'),
    join(root, 'apps', 'cli', 'src'),
    join(root, 'apps', 'cli', 'src', 'index.ts'),
    join(root, 'apps', 'cli', 'src', 'cliDistBehavior.test.ts'),
    join(root, 'apps', 'cli', 'dist'),
    join(root, 'apps', 'cli', 'dist', 'index.mjs'),
  ]) {
    utimesSync(target, baseline, baseline);
  }
  return root;
}

describe('ensureCliDistBuilt', () => {
  afterEach(() => {
    for (const dir of createdDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not rebuild when only src test files are newer than dist', async () => {
    const repoRoot = await createRepoRoot();
    const srcTestPath = join(repoRoot, 'apps', 'cli', 'src', 'cliDistBehavior.test.ts');
    const distEntryPath = join(repoRoot, 'apps', 'cli', 'dist', 'index.mjs');
    const older = new Date('2026-03-09T01:00:00.000Z');
    const newer = new Date('2026-03-09T01:05:00.000Z');
    utimesSync(distEntryPath, older, older);
    utimesSync(srcTestPath, newer, newer);

    let rebuildCalls = 0;
    await ensureCliDistBuilt(
      { testDir: join(repoRoot, '.project'), env: process.env },
      {
        repoRoot,
        runCommand: async () => {
          rebuildCalls += 1;
        },
      },
    );

    expect(rebuildCalls).toBe(0);
  });

  it('reuses dist when a rebuilt chunk is newer than sources even if index.mjs stays older', async () => {
    const repoRoot = await createRepoRoot();
    const srcImplPath = join(repoRoot, 'apps', 'cli', 'src', 'feature.ts');
    const distEntryPath = join(repoRoot, 'apps', 'cli', 'dist', 'index.mjs');
    const distChunkPath = join(repoRoot, 'apps', 'cli', 'dist', 'feature-123.mjs');
    await writeFile(srcImplPath, 'export const feature = true;\n', 'utf8');
    await writeFile(distChunkPath, 'export const feature = true;\n', 'utf8');

    const entryTime = new Date('2026-03-09T01:00:00.000Z');
    const sourceTime = new Date('2026-03-09T01:05:00.000Z');
    const chunkTime = new Date('2026-03-09T01:10:00.000Z');
    utimesSync(distEntryPath, entryTime, entryTime);
    utimesSync(srcImplPath, sourceTime, sourceTime);
    utimesSync(distChunkPath, chunkTime, chunkTime);

    let rebuildCalls = 0;
    await ensureCliDistBuilt(
      { testDir: join(repoRoot, '.project'), env: process.env },
      {
        repoRoot,
        runCommand: async () => {
          rebuildCalls += 1;
        },
      },
    );

    expect(rebuildCalls).toBe(0);
  });

  it('does not rebuild just because package metadata files are newer than dist', async () => {
    const repoRoot = await createRepoRoot();
    const packageJsonPath = join(repoRoot, 'apps', 'cli', 'package.json');
    const tsconfigPath = join(repoRoot, 'apps', 'cli', 'tsconfig.json');
    const distEntryPath = join(repoRoot, 'apps', 'cli', 'dist', 'index.mjs');
    const outputTime = new Date('2026-03-09T01:00:00.000Z');
    const metadataTime = new Date('2026-03-09T01:05:00.000Z');
    utimesSync(distEntryPath, outputTime, outputTime);
    utimesSync(packageJsonPath, metadataTime, metadataTime);
    utimesSync(tsconfigPath, metadataTime, metadataTime);

    let rebuildCalls = 0;
    await ensureCliDistBuilt(
      { testDir: join(repoRoot, '.project'), env: process.env },
      {
        repoRoot,
        runCommand: async () => {
          rebuildCalls += 1;
        },
      },
    );

    expect(rebuildCalls).toBe(0);
  });

  it('returns a healthy CLI dist without waiting for an unrelated held build lock', async () => {
    const repoRoot = await createRepoRoot();
    const lockPath = join(repoRoot, '.project', 'tmp', 'cli-dist-build.lock');

    let rebuildCalls = 0;
    await withCliDistBuildLock(
      async () => {
        const ensurePromise = ensureCliDistBuilt(
          { testDir: join(repoRoot, '.project'), env: process.env },
          {
            repoRoot,
            timeoutMs: 1_000,
            runCommand: async () => {
              rebuildCalls += 1;
            },
          },
        );

        const raced = await Promise.race([
          ensurePromise.then(() => 'resolved'),
          sleep(250).then(() => 'pending'),
        ]);
        expect(raced).toBe('resolved');
        await ensurePromise;
      },
      {
        lockPath,
        timeoutMs: 10_000,
        staleAfterMs: 10_000,
      },
    );

    expect(rebuildCalls).toBe(0);
  });

  it('rebuilds when a vendored runtime dependency is missing from bundled shared deps', async () => {
    const repoRoot = await createRepoRoot();
    const protocolPackageJsonPath = join(repoRoot, 'packages', 'protocol', 'package.json');
    const bundledProtocolPackageJsonPath = join(
      repoRoot,
      'apps',
      'cli',
      'node_modules',
      '@happier-dev',
      'protocol',
      'package.json',
    );
    const bundledProtocolNodeModulesDir = join(
      repoRoot,
      'apps',
      'cli',
      'node_modules',
      '@happier-dev',
      'protocol',
      'node_modules',
    );
    const rootZodDir = join(repoRoot, 'node_modules', 'zod');

    await mkdir(rootZodDir, { recursive: true });
    await writeFile(
      protocolPackageJsonPath,
      JSON.stringify(
        {
          name: '@happier-dev/protocol',
          dependencies: {
            zod: '4.3.6',
          },
        },
        null,
        2,
      ),
      'utf8',
    );
    await writeFile(
      bundledProtocolPackageJsonPath,
      JSON.stringify(
        {
          name: '@happier-dev/protocol',
          dependencies: {
            zod: '4.3.6',
          },
        },
        null,
        2,
      ),
      'utf8',
    );
    await writeFile(join(rootZodDir, 'package.json'), '{"name":"zod","version":"4.3.6","main":"index.js"}', 'utf8');
    await writeFile(join(rootZodDir, 'index.js'), 'exports.ok = true;\n', 'utf8');
    rmSync(bundledProtocolNodeModulesDir, { recursive: true, force: true });

    let rebuildCalls = 0;
    await ensureCliDistBuilt(
      { testDir: join(repoRoot, '.project'), env: process.env },
      {
        repoRoot,
        skipSourceFreshnessCheck: true,
        skipDistIntegrityCheck: true,
        runCommand: async () => {
          rebuildCalls += 1;
          await mkdir(join(bundledProtocolNodeModulesDir, 'zod'), { recursive: true });
          await writeFile(
            join(bundledProtocolNodeModulesDir, 'zod', 'package.json'),
            '{"name":"zod","version":"4.3.6","main":"index.js"}',
            'utf8',
          );
          await writeFile(join(bundledProtocolNodeModulesDir, 'zod', 'index.js'), 'exports.ok = true;\n', 'utf8');
        },
      },
    );

    expect(rebuildCalls).toBe(1);
  });

  it('repairs bundled workspace dist when an internal file is missing even though the entrypoint exists', async () => {
    const repoRoot = await createRepoRoot();
    const workspaceNestedFilePath = join(
      repoRoot,
      'packages',
      'protocol',
      'dist',
      'account',
      'settings',
      'accountSettings.js',
    );
    const bundledNestedFilePath = join(
      repoRoot,
      'apps',
      'cli',
      'node_modules',
      '@happier-dev',
      'protocol',
      'dist',
      'account',
      'settings',
      'accountSettings.js',
    );

    await mkdir(join(workspaceNestedFilePath, '..'), { recursive: true });
    await writeFile(workspaceNestedFilePath, "export const marker = 'workspace-protocol';\n", 'utf8');
    await mkdir(join(bundledNestedFilePath, '..'), { recursive: true });

    let rebuildCalls = 0;
    await ensureCliSharedDepsBuilt(
      { testDir: join(repoRoot, '.project'), env: process.env },
      {
        repoRoot,
        runCommand: async () => {
          rebuildCalls += 1;
        },
      },
    );

    expect(rebuildCalls).toBe(0);
    expect(existsSync(bundledNestedFilePath)).toBe(true);
  });

  it('retries shared dependency builds when sources change during the first build', async () => {
    const repoRoot = await createRepoRoot();
    const sourcePath = join(repoRoot, 'packages', 'agents', 'src', 'index.ts');
    const outputPaths = [
      join(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'agents', 'dist', 'index.js'),
      join(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'cli-common', 'dist', 'index.js'),
      join(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'protocol', 'dist', 'index.js'),
      join(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'release-runtime', 'dist', 'index.js'),
    ];
    const initialSourceTime = new Date('2030-03-09T01:18:00.000Z');
    utimesSync(sourcePath, initialSourceTime, initialSourceTime);

    vi.resetModules();
    const { ensureCliSharedDepsBuilt } = await import('./cliDist');

    let buildCalls = 0;
    await expect(
      ensureCliSharedDepsBuilt(
        { testDir: join(repoRoot, '.project'), env: process.env },
        {
          repoRoot,
          lockPath: join(repoRoot, '.project', 'tmp', 'cli-shared-deps-build.lock'),
          runCommand: async () => {
            buildCalls += 1;
            const outputTime = buildCalls === 1
              ? new Date('2030-03-09T01:11:00.000Z')
              : new Date('2030-03-09T01:20:00.000Z');
            for (const outputPath of outputPaths) {
              utimesSync(outputPath, outputTime, outputTime);
            }

            if (buildCalls === 1) {
              const newerSourceTime = new Date('2030-03-09T01:19:00.000Z');
              utimesSync(sourcePath, newerSourceTime, newerSourceTime);
            }
          },
        },
      ),
    ).resolves.toBeUndefined();

    expect(buildCalls).toBe(2);
  });

  it('accepts fresh bundled shared deps even when workspace dist is stale', async () => {
    const repoRoot = await createRepoRoot();
    const sourcePath = join(repoRoot, 'packages', 'protocol', 'src', 'index.ts');
    const workspaceOutputPath = join(repoRoot, 'packages', 'protocol', 'dist', 'index.js');
    const bundledOutputPaths = [
      join(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'agents', 'dist', 'index.js'),
      join(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'cli-common', 'dist', 'index.js'),
      join(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'protocol', 'dist', 'index.js'),
      join(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'release-runtime', 'dist', 'index.js'),
    ];

    utimesSync(sourcePath, new Date('2030-03-09T01:12:00.000Z'), new Date('2030-03-09T01:12:00.000Z'));
    utimesSync(workspaceOutputPath, new Date('2030-03-09T01:10:00.000Z'), new Date('2030-03-09T01:10:00.000Z'));
    for (const bundledOutputPath of bundledOutputPaths) {
      utimesSync(bundledOutputPath, new Date('2030-03-09T01:20:00.000Z'), new Date('2030-03-09T01:20:00.000Z'));
    }

    vi.resetModules();
    const { ensureCliSharedDepsBuilt } = await import('./cliDist');

    let rebuildCalls = 0;
    await ensureCliSharedDepsBuilt(
      { testDir: join(repoRoot, '.project'), env: process.env },
      {
        repoRoot,
        lockPath: join(repoRoot, '.project', 'tmp', 'cli-shared-deps-build.lock'),
        runCommand: async () => {
          rebuildCalls += 1;
        },
      },
    );

    expect(rebuildCalls).toBe(0);
  });
});
