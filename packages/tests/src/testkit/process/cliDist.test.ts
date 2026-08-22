import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { existsSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync } from 'node:fs';

import { withWorkspaceBundleLock } from '@happier-dev/cli-common/workspaceBundleLock';

import {
  __cliDistTestHooks,
  ensureCliDistBuilt,
  ensureCliDistSnapshotEntrypoint,
  ensureCliSharedDepsBuilt,
  ensureCliSourceDevSharedDepsCurrent,
  withCliDistBuildLock,
} from './cliDist';
import { CLI_SHARED_DEP_TEST_FIXTURE_PACKAGE_NAMES } from './workspacePackageResolution';
import { sleep } from '../timing';

const createdDirs: string[] = [];

async function createRepoRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'happier-cli-dist-test-'));
  createdDirs.push(root);
  await mkdir(join(root, '.project', 'tmp'), { recursive: true });
  await mkdir(join(root, 'apps', 'cli', 'src'), { recursive: true });
  await mkdir(join(root, 'apps', 'cli', 'dist'), { recursive: true });
  await mkdir(join(root, 'apps', 'cli', 'node_modules', '@happier-dev'), { recursive: true });
  for (const pkgName of CLI_SHARED_DEP_TEST_FIXTURE_PACKAGE_NAMES) {
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
  await writeFile(
    join(root, 'apps', 'cli', 'package.json'),
    JSON.stringify({
      name: '@happier-dev/cli',
      bundledDependencies: CLI_SHARED_DEP_TEST_FIXTURE_PACKAGE_NAMES.map(
        (packageName) => `@happier-dev/${packageName}`,
      ),
    }),
    'utf8',
  );
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

function resolveCliSharedDepBundleIndexPaths(repoRoot: string): string[] {
  return CLI_SHARED_DEP_TEST_FIXTURE_PACKAGE_NAMES.map((pkgName) =>
    join(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', pkgName, 'dist', 'index.js'),
  );
}

function touchTree(path: string, time: Date): void {
  try {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      touchTree(join(path, entry.name), time);
    }
  } catch {
    // File path; touch below.
  }
  utimesSync(path, time, time);
}

describe('ensureCliDistBuilt', () => {
  afterEach(() => {
    for (const dir of createdDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses the canonical source-dev read-only check without starting a local build', async () => {
    const repoRoot = await createRepoRoot();
    const invocations: Array<{
      command: string;
      args: string[];
      cwd: string;
    }> = [];

    await expect(
      ensureCliSourceDevSharedDepsCurrent(
        {
          testDir: join(repoRoot, '.project'),
          env: {
            ...process.env,
            HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
            HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: 'held-lock',
          },
        },
        {
          repoRoot,
          runCommand: async (invocation) => {
            invocations.push(invocation);
            throw new Error('Source-dev CLI shared dependencies are not current');
          },
        },
      ),
    ).rejects.toThrow(/source-dev CLI shared dependencies are not current/i);

    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toMatchObject({
      command: process.execPath,
      args: [join(repoRoot, 'apps', 'cli', 'scripts', 'syncSharedDepsForDev.mjs'), '--check'],
      cwd: join(repoRoot, 'apps', 'cli'),
    });
    expect(invocations[0]?.args).not.toContain('build:shared');
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

  it('passes the canonical owner lease into the nested CLI build', async () => {
    const repoRoot = await createRepoRoot();
    const lockPath = join(repoRoot, '.project', 'tmp', 'cli-dist-build.lock');
    const sourcePath = join(repoRoot, 'apps', 'cli', 'src', 'index.ts');
    const distEntryPath = join(repoRoot, 'apps', 'cli', 'dist', 'index.mjs');
    const older = new Date('2030-03-09T01:00:00.000Z');
    const newer = new Date('2030-03-09T01:05:00.000Z');
    utimesSync(distEntryPath, older, older);
    utimesSync(sourcePath, newer, newer);

    let nestedInherited = false;
    await ensureCliDistBuilt(
      { testDir: join(repoRoot, '.project'), env: process.env },
      {
        repoRoot,
        lockPath,
        runCommand: async (invocation) => {
          await withWorkspaceBundleLock(
            async ({ inherited }) => {
              nestedInherited = inherited;
            },
            {
              lockPath,
              heldLockValue: invocation.env?.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD,
              timeoutMs: 50,
              pollIntervalMs: 5,
              staleAfterMs: 1_000,
            },
          );
          utimesSync(distEntryPath, newer, newer);
        },
      },
    );

    expect(nestedInherited).toBe(true);
  });

  it('creates a replacement snapshot instead of mutating a stale ready shared snapshot', async () => {
    const repoRoot = await createRepoRoot();
    const snapshotDir = join(repoRoot, '.project', 'tmp', 'cli-dist-snapshot');
    const snapshotDistDir = join(snapshotDir, 'dist');
    const snapshotEntrypoint = join(snapshotDistDir, 'index.mjs');
    const canonicalEntrypoint = join(repoRoot, 'apps', 'cli', 'dist', 'index.mjs');
    const snapshotSentinelPath = join(snapshotDir, 'node_modules', '.snapshot-sentinel');

    await mkdir(snapshotDistDir, { recursive: true });
    await mkdir(join(snapshotDir, 'node_modules'), { recursive: true });
    await writeFile(snapshotEntrypoint, 'export const snapshot = "stale";\n', 'utf8');
    await writeFile(join(snapshotDir, '.cli-dist-snapshot.ready.json'), JSON.stringify({ v: 1 }), 'utf8');
    await writeFile(snapshotSentinelPath, 'keep-me\n', 'utf8');
    await writeFile(canonicalEntrypoint, 'export const canonical = "fresh";\n', 'utf8');

    const snapshotTime = new Date('2026-03-09T01:00:00.000Z');
    const canonicalTime = new Date('2026-03-09T01:05:00.000Z');
    utimesSync(snapshotDistDir, snapshotTime, snapshotTime);
    utimesSync(snapshotEntrypoint, snapshotTime, snapshotTime);
    utimesSync(canonicalEntrypoint, canonicalTime, canonicalTime);

    let rebuildCalls = 0;
    const entrypoint = await ensureCliDistSnapshotEntrypoint(
      {
        testDir: join(repoRoot, '.project'),
        env: {
          ...process.env,
          HAPPIER_E2E_CLI_SNAPSHOT_NODE_MODULES_MODE: 'symlink',
        },
      },
      {
        repoRoot,
        snapshotDir,
        runCommand: async () => {
          rebuildCalls += 1;
        },
      },
    );

    expect(rebuildCalls).toBe(0);
    expect(entrypoint).not.toBe(snapshotEntrypoint);
    expect(entrypoint).toContain('cli-dist-snapshot-');
    expect(readFileSync(snapshotEntrypoint, 'utf8')).toContain('snapshot = "stale"');
    expect(readFileSync(entrypoint, 'utf8')).toContain('canonical = "fresh"');
    expect(readFileSync(snapshotSentinelPath, 'utf8')).toContain('keep-me');
  });

  it('rebuilds before reusing a ready shared snapshot when canonical dist directory is missing', async () => {
    const repoRoot = await createRepoRoot();
    const snapshotDir = join(repoRoot, '.project', 'tmp', 'cli-dist-snapshot');
    const snapshotDistDir = join(snapshotDir, 'dist');
    const snapshotEntrypoint = join(snapshotDistDir, 'index.mjs');
    const canonicalDistDir = join(repoRoot, 'apps', 'cli', 'dist');
    const canonicalEntrypoint = join(canonicalDistDir, 'index.mjs');
    const snapshotSentinelPath = join(snapshotDir, 'node_modules', '.snapshot-sentinel');

    await mkdir(snapshotDistDir, { recursive: true });
    await mkdir(join(snapshotDir, 'node_modules'), { recursive: true });
    await writeFile(snapshotEntrypoint, 'export const snapshot = "stale";\n', 'utf8');
    await writeFile(join(snapshotDir, '.cli-dist-snapshot.ready.json'), JSON.stringify({ v: 1 }), 'utf8');
    await writeFile(snapshotSentinelPath, 'keep-me\n', 'utf8');
    rmSync(canonicalDistDir, { recursive: true, force: true });

    const snapshotTime = new Date('2026-03-09T01:00:00.000Z');
    const rebuiltTime = new Date('2026-03-09T01:05:00.000Z');
    utimesSync(snapshotDistDir, snapshotTime, snapshotTime);
    utimesSync(snapshotEntrypoint, snapshotTime, snapshotTime);

    let rebuildCalls = 0;
    const entrypoint = await ensureCliDistSnapshotEntrypoint(
      { testDir: join(repoRoot, '.project'), env: process.env },
      {
        repoRoot,
        snapshotDir,
        runCommand: async () => {
          rebuildCalls += 1;
          await mkdir(canonicalDistDir, { recursive: true });
          await writeFile(canonicalEntrypoint, 'export const canonical = "rebuilt";\n', 'utf8');
          utimesSync(canonicalDistDir, rebuiltTime, rebuiltTime);
          utimesSync(canonicalEntrypoint, rebuiltTime, rebuiltTime);
        },
      },
    );

    expect(rebuildCalls).toBe(1);
    expect(entrypoint).not.toBe(snapshotEntrypoint);
    expect(entrypoint).toContain('cli-dist-snapshot-');
    expect(readFileSync(snapshotEntrypoint, 'utf8')).toContain('snapshot = "stale"');
    expect(readFileSync(entrypoint, 'utf8')).toContain('canonical = "rebuilt"');
    expect(readFileSync(snapshotSentinelPath, 'utf8')).toContain('keep-me');
  });

  it('reuses a fresh ready replacement snapshot when the canonical shared snapshot is stale', async () => {
    const repoRoot = await createRepoRoot();
    const snapshotDir = join(repoRoot, '.project', 'tmp', 'cli-dist-snapshot');
    const snapshotDistDir = join(snapshotDir, 'dist');
    const snapshotEntrypoint = join(snapshotDistDir, 'index.mjs');
    const replacementSnapshotDir = join(repoRoot, '.project', 'tmp', 'cli-dist-snapshot-123-456-1');
    const replacementEntrypoint = join(replacementSnapshotDir, 'dist', 'index.mjs');
    const canonicalEntrypoint = join(repoRoot, 'apps', 'cli', 'dist', 'index.mjs');

    await mkdir(snapshotDistDir, { recursive: true });
    await mkdir(join(snapshotDir, 'node_modules'), { recursive: true });
    await writeFile(snapshotEntrypoint, 'export const snapshot = "stale";\n', 'utf8');
    await writeFile(join(snapshotDir, '.cli-dist-snapshot.ready.json'), JSON.stringify({ v: 1 }), 'utf8');

    await mkdir(join(replacementSnapshotDir, 'dist'), { recursive: true });
    await writeFile(replacementEntrypoint, 'export const replacement = "fresh";\n', 'utf8');
    await writeFile(join(replacementSnapshotDir, '.cli-dist-snapshot.ready.json'), JSON.stringify({ v: 1 }), 'utf8');
    await cp(join(repoRoot, 'apps', 'cli', 'node_modules'), join(replacementSnapshotDir, 'node_modules'), { recursive: true });

    await writeFile(canonicalEntrypoint, 'export const canonical = "fresh";\n', 'utf8');

    const staleTime = new Date('2026-03-09T01:00:00.000Z');
    const freshTime = new Date('2026-03-09T01:05:00.000Z');
    const replacementNodeModulesFreshTime = new Date('2031-03-09T01:05:00.000Z');
    utimesSync(snapshotDistDir, staleTime, staleTime);
    utimesSync(snapshotEntrypoint, staleTime, staleTime);
    utimesSync(canonicalEntrypoint, freshTime, freshTime);
    utimesSync(join(replacementSnapshotDir, 'dist'), freshTime, freshTime);
    utimesSync(replacementEntrypoint, freshTime, freshTime);
    for (const pkgName of CLI_SHARED_DEP_TEST_FIXTURE_PACKAGE_NAMES) {
      utimesSync(
        join(replacementSnapshotDir, 'node_modules', '@happier-dev', pkgName, 'dist', 'index.js'),
        replacementNodeModulesFreshTime,
        replacementNodeModulesFreshTime,
      );
    }

    const entrypoint = await ensureCliDistSnapshotEntrypoint(
      { testDir: join(repoRoot, '.project'), env: process.env },
      {
        repoRoot,
        snapshotDir,
        runCommand: async () => {
          throw new Error('fresh replacement snapshot should be reused');
        },
      },
    );

    expect(entrypoint).toBe(replacementEntrypoint);
    expect(readFileSync(entrypoint, 'utf8')).toContain('replacement = "fresh"');
    expect(
      readdirSync(join(repoRoot, '.project', 'tmp')).filter((entry) => entry.startsWith('cli-dist-snapshot-')),
    ).toEqual(['cli-dist-snapshot-123-456-1']);
  });

  it('creates a replacement snapshot when bundled shared dependency outputs are newer than the ready snapshot copy', async () => {
    const repoRoot = await createRepoRoot();
    const snapshotDir = join(repoRoot, '.project', 'tmp', 'cli-dist-snapshot');
    const snapshotDistDir = join(snapshotDir, 'dist');
    const snapshotEntrypoint = join(snapshotDistDir, 'index.mjs');
    const canonicalEntrypoint = join(repoRoot, 'apps', 'cli', 'dist', 'index.mjs');
    const canonicalBundledProtocolIndexPath = join(
      repoRoot,
      'apps',
      'cli',
      'node_modules',
      '@happier-dev',
      'protocol',
      'dist',
      'index.js',
    );
    const snapshotBundledProtocolIndexPath = join(
      snapshotDir,
      'node_modules',
      '@happier-dev',
      'protocol',
      'dist',
      'index.js',
    );

    await mkdir(snapshotDistDir, { recursive: true });
    await writeFile(snapshotEntrypoint, 'export const snapshot = "ready";\n', 'utf8');
    await writeFile(canonicalEntrypoint, 'export const canonical = "ready";\n', 'utf8');
    await cp(join(repoRoot, 'apps', 'cli', 'node_modules'), join(snapshotDir, 'node_modules'), { recursive: true });
    await writeFile(snapshotBundledProtocolIndexPath, 'export const protocolSnapshot = "stale";\n', 'utf8');
    await writeFile(canonicalBundledProtocolIndexPath, 'export const protocolCanonical = "fresh";\n', 'utf8');
    await writeFile(join(snapshotDir, '.cli-dist-snapshot.ready.json'), JSON.stringify({ v: 1 }), 'utf8');

    const baselineTime = new Date('2030-03-09T01:00:00.000Z');
    const freshTime = new Date('2030-03-09T01:05:00.000Z');
    utimesSync(snapshotDistDir, baselineTime, baselineTime);
    utimesSync(snapshotEntrypoint, baselineTime, baselineTime);
    utimesSync(canonicalEntrypoint, baselineTime, baselineTime);
    utimesSync(snapshotBundledProtocolIndexPath, baselineTime, baselineTime);
    utimesSync(canonicalBundledProtocolIndexPath, freshTime, freshTime);

    let rebuildCalls = 0;
    const entrypoint = await ensureCliDistSnapshotEntrypoint(
      { testDir: join(repoRoot, '.project'), env: process.env },
      {
        repoRoot,
        snapshotDir,
        runCommand: async () => {
          rebuildCalls += 1;
        },
      },
    );

    expect(rebuildCalls).toBe(0);
    expect(entrypoint).not.toBe(snapshotEntrypoint);
    expect(entrypoint).toContain('cli-dist-snapshot-');
    expect(readFileSync(snapshotBundledProtocolIndexPath, 'utf8')).toContain('protocolSnapshot = "stale"');
    expect(
      readFileSync(join(entrypoint, '..', '..', 'node_modules', '@happier-dev', 'protocol', 'dist', 'index.js'), 'utf8'),
    ).not.toContain('protocolSnapshot = "stale"');
  });

  it('creates a replacement snapshot when ready snapshot protocol exports are invalid', async () => {
    const repoRoot = await createRepoRoot();
    const snapshotDir = join(repoRoot, '.project', 'tmp', 'cli-dist-snapshot');
    const snapshotDistDir = join(snapshotDir, 'dist');
    const snapshotEntrypoint = join(snapshotDistDir, 'index.mjs');
    const canonicalEntrypoint = join(repoRoot, 'apps', 'cli', 'dist', 'index.mjs');
    const snapshotBundledProtocolIndexPath = join(
      snapshotDir,
      'node_modules',
      '@happier-dev',
      'protocol',
      'dist',
      'index.js',
    );

    await mkdir(snapshotDistDir, { recursive: true });
    await writeFile(
      snapshotEntrypoint,
      [
        "import { DuplicateNamedExportFixtureSchema } from '@happier-dev/protocol';",
        'export const snapshot = DuplicateNamedExportFixtureSchema;',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(canonicalEntrypoint, 'export const canonical = "ready";\n', 'utf8');
    await cp(join(repoRoot, 'apps', 'cli', 'node_modules'), join(snapshotDir, 'node_modules'), { recursive: true });
    await writeFile(
      snapshotBundledProtocolIndexPath,
      [
        'export const DuplicateNamedExportFixtureSchema = {};',
        'export { DuplicateNamedExportFixtureSchema };',
        'export { DuplicateNamedExportFixtureSchema };',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(join(snapshotDir, '.cli-dist-snapshot.ready.json'), JSON.stringify({ v: 1 }), 'utf8');

    const canonicalTime = new Date('2030-03-09T01:15:00.000Z');
    const freshSnapshotTime = new Date('2031-03-09T01:15:00.000Z');
    utimesSync(snapshotDistDir, freshSnapshotTime, freshSnapshotTime);
    utimesSync(snapshotEntrypoint, freshSnapshotTime, freshSnapshotTime);
    utimesSync(canonicalEntrypoint, canonicalTime, canonicalTime);
    touchTree(join(snapshotDir, 'node_modules'), freshSnapshotTime);

    const entrypoint = await ensureCliDistSnapshotEntrypoint(
      { testDir: join(repoRoot, '.project'), env: process.env },
      {
        repoRoot,
        snapshotDir,
        runCommand: async () => {
          throw new Error('invalid ready snapshot repair should not need a live CLI rebuild');
        },
      },
    );

    expect(entrypoint).not.toBe(snapshotEntrypoint);
    expect(entrypoint).toContain('cli-dist-snapshot-');
    expect(readFileSync(snapshotBundledProtocolIndexPath, 'utf8')).toContain('DuplicateNamedExportFixtureSchema');
    expect(
      readFileSync(join(entrypoint, '..', '..', 'node_modules', '@happier-dev', 'protocol', 'dist', 'index.js'), 'utf8'),
    ).not.toContain('DuplicateNamedExportFixtureSchema');
  });

  it('creates a replacement snapshot when ready snapshot CLI chunks import removed protocol root exports', async () => {
    const repoRoot = await createRepoRoot();
    const snapshotDir = join(repoRoot, '.project', 'tmp', 'cli-dist-snapshot');
    const snapshotDistDir = join(snapshotDir, 'dist');
    const snapshotEntrypoint = join(snapshotDistDir, 'index.mjs');
    const canonicalEntrypoint = join(repoRoot, 'apps', 'cli', 'dist', 'index.mjs');
    const snapshotBundledProtocolIndexPath = join(
      snapshotDir,
      'node_modules',
      '@happier-dev',
      'protocol',
      'dist',
      'index.js',
    );

    await mkdir(snapshotDistDir, { recursive: true });
    await writeFile(
      snapshotEntrypoint,
      [
        "import { AgentRuntimeDescriptorV1Schema } from '@happier-dev/protocol';",
        'export const snapshot = AgentRuntimeDescriptorV1Schema;',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(canonicalEntrypoint, 'export const canonical = "ready";\n', 'utf8');
    await cp(join(repoRoot, 'apps', 'cli', 'node_modules'), join(snapshotDir, 'node_modules'), { recursive: true });
    await writeFile(snapshotBundledProtocolIndexPath, 'export const RuntimeDescriptorV1Schema = {};\n', 'utf8');
    await writeFile(join(snapshotDir, '.cli-dist-snapshot.ready.json'), JSON.stringify({ v: 1 }), 'utf8');

    const canonicalTime = new Date('2030-03-09T01:15:00.000Z');
    const freshSnapshotTime = new Date('2031-03-09T01:15:00.000Z');
    utimesSync(snapshotDistDir, freshSnapshotTime, freshSnapshotTime);
    utimesSync(snapshotEntrypoint, freshSnapshotTime, freshSnapshotTime);
    utimesSync(canonicalEntrypoint, canonicalTime, canonicalTime);
    touchTree(join(snapshotDir, 'node_modules'), freshSnapshotTime);

    const entrypoint = await ensureCliDistSnapshotEntrypoint(
      { testDir: join(repoRoot, '.project'), env: process.env },
      {
        repoRoot,
        snapshotDir,
        runCommand: async () => {
          throw new Error('protocol import compatibility repair should not need a live CLI rebuild');
        },
      },
    );

    expect(entrypoint).not.toBe(snapshotEntrypoint);
    expect(entrypoint).toContain('cli-dist-snapshot-');
    expect(readFileSync(entrypoint, 'utf8')).toContain('canonical = "ready"');
  });

  it('accepts valid async, namespace, and star-reexported first-party named exports', async () => {
    const repoRoot = await createRepoRoot();
    const distDir = join(repoRoot, 'dist');
    const packageDir = join(
      repoRoot,
      'node_modules',
      '@happier-dev',
      'valid-exports',
    );
    await mkdir(distDir, { recursive: true });
    await mkdir(join(packageDir, 'dist'), { recursive: true });
    await writeFile(
      join(distDir, 'catalog.mjs'),
      [
        "import { asyncExport, namespaceExport, reexportedAsync } from '@happier-dev/valid-exports';",
        'export const selected = [asyncExport, namespaceExport, reexportedAsync];',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(packageDir, 'package.json'),
      JSON.stringify({
        name: '@happier-dev/valid-exports',
        type: 'module',
        exports: './dist/index.js',
      }),
      'utf8',
    );
    await writeFile(
      join(packageDir, 'dist', 'index.js'),
      [
        'export const existing = true;',
        'export async function asyncExport() {}',
        "export * as namespaceExport from './namespace.js';",
        "export * from './manager.js';",
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(packageDir, 'dist', 'namespace.js'),
      'export const nested = true;\n',
      'utf8',
    );
    await writeFile(
      join(packageDir, 'dist', 'manager.js'),
      'export async function reexportedAsync() {}\n',
      'utf8',
    );

    expect(__cliDistTestHooks.listCliDistFirstPartyNamedImportCompatibilityErrors({
      distDir,
      nodeModulesDir: join(repoRoot, 'node_modules'),
    })).toEqual([]);
  });

  it('materializes a replacement snapshot with property-chain protocol identifiers', async () => {
    const repoRoot = await createRepoRoot();
    const snapshotDir = join(repoRoot, '.project', 'tmp', 'cli-dist-snapshot');
    const snapshotDistDir = join(snapshotDir, 'dist');
    const snapshotEntrypoint = join(snapshotDistDir, 'index.mjs');
    const canonicalDistDir = join(repoRoot, 'apps', 'cli', 'dist');
    const canonicalEntrypoint = join(canonicalDistDir, 'index.mjs');
    const bundledProtocolIndexPath = join(
      repoRoot,
      'apps',
      'cli',
      'node_modules',
      '@happier-dev',
      'protocol',
      'dist',
      'index.js',
    );

    await mkdir(snapshotDistDir, { recursive: true });
    await writeFile(
      snapshotEntrypoint,
      [
        "import { RemovedProtocolExport } from '@happier-dev/protocol';",
        'export const snapshot = RemovedProtocolExport;',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(canonicalEntrypoint, 'export const canonical = "ready";\n', 'utf8');
    await writeFile(
      join(canonicalDistDir, 'catalog.cjs'),
      [
        "var protocol = require('@happier-dev/protocol');",
        'const cache = protocol.AsyncTtlCache;',
        'function requireJsonRpcClientSpec(spec) {',
        '  return spec.protocol.kind;',
        '}',
        'exports.cache = cache;',
        'exports.requireJsonRpcClientSpec = requireJsonRpcClientSpec;',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(bundledProtocolIndexPath, 'export const AsyncTtlCache = {};\n', 'utf8');
    await cp(join(repoRoot, 'apps', 'cli', 'node_modules'), join(snapshotDir, 'node_modules'), { recursive: true });
    await writeFile(join(snapshotDir, '.cli-dist-snapshot.ready.json'), JSON.stringify({ v: 1 }), 'utf8');

    const canonicalTime = new Date('2030-03-09T01:15:00.000Z');
    const freshSnapshotTime = new Date('2031-03-09T01:15:00.000Z');
    utimesSync(snapshotDistDir, freshSnapshotTime, freshSnapshotTime);
    utimesSync(snapshotEntrypoint, freshSnapshotTime, freshSnapshotTime);
    utimesSync(canonicalDistDir, canonicalTime, canonicalTime);
    utimesSync(canonicalEntrypoint, canonicalTime, canonicalTime);
    utimesSync(join(canonicalDistDir, 'catalog.cjs'), canonicalTime, canonicalTime);
    touchTree(join(snapshotDir, 'node_modules'), freshSnapshotTime);

    const entrypoint = await ensureCliDistSnapshotEntrypoint(
      { testDir: join(repoRoot, '.project'), env: process.env },
      {
        repoRoot,
        snapshotDir,
        runCommand: async () => {
          throw new Error('property-chain namespace compatibility repair should not need a live CLI rebuild');
        },
      },
    );

    expect(entrypoint).not.toBe(snapshotEntrypoint);
    expect(readFileSync(join(dirname(entrypoint), 'catalog.cjs'), 'utf8')).toContain('spec.protocol.kind');
  });

  it('prefers the newest ready replacement snapshot over the canonical shared snapshot when freshness checks are skipped', async () => {
    const repoRoot = await createRepoRoot();
    const snapshotDir = join(repoRoot, '.project', 'tmp', 'cli-dist-snapshot');
    const snapshotDistDir = join(snapshotDir, 'dist');
    const snapshotEntrypoint = join(snapshotDistDir, 'index.mjs');
    const oldReplacementDir = join(repoRoot, '.project', 'tmp', 'cli-dist-snapshot-111-222-1');
    const oldReplacementEntrypoint = join(oldReplacementDir, 'dist', 'index.mjs');
    const newReplacementDir = join(repoRoot, '.project', 'tmp', 'cli-dist-snapshot-333-444-1');
    const newReplacementEntrypoint = join(newReplacementDir, 'dist', 'index.mjs');
    const canonicalEntrypoint = join(repoRoot, 'apps', 'cli', 'dist', 'index.mjs');

    await mkdir(snapshotDistDir, { recursive: true });
    await mkdir(join(snapshotDir, 'node_modules'), { recursive: true });
    await writeFile(snapshotEntrypoint, 'export const snapshot = "canonical";\n', 'utf8');
    await writeFile(join(snapshotDir, '.cli-dist-snapshot.ready.json'), JSON.stringify({ v: 1 }), 'utf8');

    for (const [dir, entrypoint, contents] of [
      [oldReplacementDir, oldReplacementEntrypoint, 'export const replacement = "old";\n'],
      [newReplacementDir, newReplacementEntrypoint, 'export const replacement = "new";\n'],
    ] as const) {
      await mkdir(join(dir, 'dist'), { recursive: true });
      await mkdir(join(dir, 'node_modules'), { recursive: true });
      await writeFile(entrypoint, contents, 'utf8');
      await writeFile(join(dir, '.cli-dist-snapshot.ready.json'), JSON.stringify({ v: 1 }), 'utf8');
    }

    await writeFile(canonicalEntrypoint, 'export const canonical = "fresh";\n', 'utf8');

    const canonicalTime = new Date('2026-03-09T01:00:00.000Z');
    const oldReplacementTime = new Date('2026-03-09T01:05:00.000Z');
    const newReplacementTime = new Date('2026-03-09T01:10:00.000Z');
    utimesSync(snapshotDistDir, canonicalTime, canonicalTime);
    utimesSync(snapshotEntrypoint, canonicalTime, canonicalTime);
    utimesSync(canonicalEntrypoint, newReplacementTime, newReplacementTime);
    utimesSync(join(oldReplacementDir, 'dist'), oldReplacementTime, oldReplacementTime);
    utimesSync(oldReplacementEntrypoint, oldReplacementTime, oldReplacementTime);
    utimesSync(join(oldReplacementDir, '.cli-dist-snapshot.ready.json'), oldReplacementTime, oldReplacementTime);
    utimesSync(join(newReplacementDir, 'dist'), newReplacementTime, newReplacementTime);
    utimesSync(newReplacementEntrypoint, newReplacementTime, newReplacementTime);
    utimesSync(join(newReplacementDir, '.cli-dist-snapshot.ready.json'), newReplacementTime, newReplacementTime);

    const entrypoint = await ensureCliDistSnapshotEntrypoint(
      { testDir: join(repoRoot, '.project'), env: process.env },
      {
        repoRoot,
        snapshotDir,
        skipSourceFreshnessCheck: true,
        runCommand: async () => {
          throw new Error('ready replacement snapshot should be reused');
        },
      },
    );

    expect(entrypoint).toBe(newReplacementEntrypoint);
    expect(readFileSync(entrypoint, 'utf8')).toContain('replacement = "new"');
  });

  it('rejects a ready symlink snapshot whose first-party named re-exports no longer match the live bundled package', async () => {
    const repoRoot = await createRepoRoot();
    const snapshotDir = join(repoRoot, '.project', 'tmp', 'cli-dist-snapshot');
    const staleReplacementDir = join(repoRoot, '.project', 'tmp', 'cli-dist-snapshot-123-456-1');
    const staleReplacementEntrypoint = join(staleReplacementDir, 'dist', 'index.mjs');
    const canonicalEntrypoint = join(repoRoot, 'apps', 'cli', 'dist', 'index.mjs');
    const inspectorPackageDir = join(
      repoRoot,
      'apps',
      'cli',
      'node_modules',
      '@happier-dev',
      'plugins-inspector',
    );

    await mkdir(join(staleReplacementDir, 'dist'), { recursive: true });
    await mkdir(join(inspectorPackageDir, 'dist'), { recursive: true });
    await writeFile(
      join(inspectorPackageDir, 'package.json'),
      JSON.stringify({
        name: '@happier-dev/plugins-inspector',
        type: 'module',
        exports: {
          './manifest': './dist/manifest.js',
        },
      }),
      'utf8',
    );
    await writeFile(
      join(inspectorPackageDir, 'dist', 'manifest.js'),
      'export const CurrentInspectorExport = "current";\n',
      'utf8',
    );
    await writeFile(
      staleReplacementEntrypoint,
      [
        "export { RemovedInspectorExport as selected } from '@happier-dev/plugins-inspector/manifest';",
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      canonicalEntrypoint,
      [
        "export { CurrentInspectorExport as selected } from '@happier-dev/plugins-inspector/manifest';",
        '',
      ].join('\n'),
      'utf8',
    );
    symlinkSync(
      join(repoRoot, 'apps', 'cli', 'node_modules'),
      join(staleReplacementDir, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await writeFile(
      join(staleReplacementDir, '.cli-dist-snapshot.ready.json'),
      JSON.stringify({ v: 1 }),
      'utf8',
    );

    const entrypoint = await ensureCliDistSnapshotEntrypoint(
      {
        testDir: join(repoRoot, '.project'),
        env: {
          ...process.env,
          HAPPIER_E2E_CLI_SNAPSHOT_NODE_MODULES_MODE: 'symlink',
        },
      },
      {
        repoRoot,
        snapshotDir,
        skipSourceFreshnessCheck: true,
        runCommand: async () => {
          throw new Error('compatible canonical dist should not need a rebuild');
        },
      },
    );

    expect(entrypoint).not.toBe(staleReplacementEntrypoint);
    const importResult = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        [
          "import { pathToFileURL } from 'node:url';",
          'const selectedModule = await import(`${pathToFileURL(process.argv[1]).href}?test=${Date.now()}`);',
          'process.stdout.write(JSON.stringify({ selected: selectedModule.selected }));',
        ].join('\n'),
        entrypoint,
      ],
      { encoding: 'utf8' },
    );
    expect(importResult.status, importResult.stderr).toBe(0);
    expect(JSON.parse(importResult.stdout)).toMatchObject({ selected: 'current' });
  });

  it('reuses a ready shared snapshot when source freshness checks are explicitly skipped', async () => {
    const repoRoot = await createRepoRoot();
    const snapshotDir = join(repoRoot, '.project', 'tmp', 'cli-dist-snapshot');
    const snapshotDistDir = join(snapshotDir, 'dist');
    const snapshotEntrypoint = join(snapshotDistDir, 'index.mjs');
    const canonicalEntrypoint = join(repoRoot, 'apps', 'cli', 'dist', 'index.mjs');
    const snapshotSentinelPath = join(snapshotDir, 'node_modules', '.snapshot-sentinel');

    await mkdir(snapshotDistDir, { recursive: true });
    await mkdir(join(snapshotDir, 'node_modules'), { recursive: true });
    await writeFile(snapshotEntrypoint, 'export const snapshot = "stale";\n', 'utf8');
    await writeFile(join(snapshotDir, '.cli-dist-snapshot.ready.json'), JSON.stringify({ v: 1 }), 'utf8');
    await writeFile(snapshotSentinelPath, 'keep-me\n', 'utf8');
    await writeFile(canonicalEntrypoint, 'export const canonical = "fresh";\n', 'utf8');

    const snapshotTime = new Date('2026-03-09T01:00:00.000Z');
    const canonicalTime = new Date('2026-03-09T01:05:00.000Z');
    utimesSync(snapshotDistDir, snapshotTime, snapshotTime);
    utimesSync(snapshotEntrypoint, snapshotTime, snapshotTime);
    utimesSync(canonicalEntrypoint, canonicalTime, canonicalTime);

    let rebuildCalls = 0;
    const entrypoint = await ensureCliDistSnapshotEntrypoint(
      { testDir: join(repoRoot, '.project'), env: process.env },
      {
        repoRoot,
        snapshotDir,
        skipSourceFreshnessCheck: true,
        runCommand: async () => {
          rebuildCalls += 1;
        },
      },
    );

    expect(rebuildCalls).toBe(0);
    expect(entrypoint).toBe(snapshotEntrypoint);
    expect(readFileSync(snapshotEntrypoint, 'utf8')).toContain('snapshot = "stale"');
    expect(readFileSync(snapshotSentinelPath, 'utf8')).toContain('keep-me');
    expect(
      readdirSync(join(repoRoot, '.project', 'tmp')).filter((entry) => entry.startsWith('cli-dist-snapshot-')),
    ).toEqual([]);
  });

  it('reuses a ready shared snapshot before attempting a live CLI rebuild when freshness checks are skipped', async () => {
    const repoRoot = await createRepoRoot();
    const snapshotDir = join(repoRoot, '.project', 'tmp', 'cli-dist-snapshot');
    const snapshotDistDir = join(snapshotDir, 'dist');
    const snapshotEntrypoint = join(snapshotDistDir, 'index.mjs');
    const canonicalEntrypoint = join(repoRoot, 'apps', 'cli', 'dist', 'index.mjs');

    await mkdir(snapshotDistDir, { recursive: true });
    await mkdir(join(snapshotDir, 'node_modules'), { recursive: true });
    await writeFile(snapshotEntrypoint, 'export const snapshot = "ready";\n', 'utf8');
    await writeFile(join(snapshotDir, '.cli-dist-snapshot.ready.json'), JSON.stringify({ v: 1 }), 'utf8');
    rmSync(canonicalEntrypoint, { force: true });

    const entrypoint = await ensureCliDistSnapshotEntrypoint(
      { testDir: join(repoRoot, '.project'), env: process.env },
      {
        repoRoot,
        snapshotDir,
        skipSourceFreshnessCheck: true,
        runCommand: async () => {
          throw new Error('live CLI build should not run while a ready snapshot is reusable');
        },
      },
    );

    expect(entrypoint).toBe(snapshotEntrypoint);
    expect(readFileSync(snapshotEntrypoint, 'utf8')).toContain('snapshot = "ready"');
  });

  it('rebuilds the live bundle before repairing a ready snapshot with a missing internal file', async () => {
    const repoRoot = await createRepoRoot();
    const snapshotDir = join(repoRoot, '.project', 'tmp', 'cli-dist-snapshot');
    const snapshotDistDir = join(snapshotDir, 'dist');
    const snapshotEntrypoint = join(snapshotDistDir, 'index.mjs');
    const canonicalEntrypoint = join(repoRoot, 'apps', 'cli', 'dist', 'index.mjs');
    const workspaceProtocolInternalPath = join(
      repoRoot,
      'packages',
      'protocol',
      'dist',
      'machineTransfer',
      'transferStream.js',
    );
    const snapshotProtocolInternalPath = join(
      snapshotDir,
      'node_modules',
      '@happier-dev',
      'protocol',
      'dist',
      'machineTransfer',
      'transferStream.js',
    );

    await mkdir(join(workspaceProtocolInternalPath, '..'), { recursive: true });
    await writeFile(workspaceProtocolInternalPath, "export const marker = 'workspace-transfer-stream';\n", 'utf8');
    await writeFile(canonicalEntrypoint, 'export const canonical = "fresh";\n', 'utf8');

    await mkdir(snapshotDistDir, { recursive: true });
    await mkdir(join(snapshotDir, 'node_modules', '@happier-dev', 'protocol', 'dist'), { recursive: true });
    await writeFile(snapshotEntrypoint, 'export const snapshot = "ready-but-incomplete";\n', 'utf8');
    await writeFile(
      join(snapshotDir, 'node_modules', '@happier-dev', 'protocol', 'dist', 'index.js'),
      'exports.ok = true;\n',
      'utf8',
    );
    await writeFile(join(snapshotDir, '.cli-dist-snapshot.ready.json'), JSON.stringify({ v: 1 }), 'utf8');

    const entrypoint = await ensureCliDistSnapshotEntrypoint(
      { testDir: join(repoRoot, '.project'), env: process.env },
      {
        repoRoot,
        snapshotDir,
        skipSourceFreshnessCheck: true,
        runCommand: async () => {
          await cp(
            join(repoRoot, 'packages', 'protocol', 'dist'),
            join(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'protocol', 'dist'),
            { recursive: true, force: true },
          );
        },
      },
    );

    expect(entrypoint).toBe(snapshotEntrypoint);
    expect(readFileSync(snapshotEntrypoint, 'utf8')).toContain('snapshot = "ready-but-incomplete"');
    expect(readFileSync(snapshotProtocolInternalPath, 'utf8')).toContain('workspace-transfer-stream');
  });

  it('repairs missing runtime dependency files before returning a reusable ready shared snapshot', async () => {
    const repoRoot = await createRepoRoot();
    const snapshotDir = join(repoRoot, '.project', 'tmp', 'cli-dist-snapshot');
    const snapshotDistDir = join(snapshotDir, 'dist');
    const snapshotEntrypoint = join(snapshotDistDir, 'index.mjs');
    const bundledAgentsPackageJsonPath = join(
      repoRoot,
      'apps',
      'cli',
      'node_modules',
      '@happier-dev',
      'agents',
      'package.json',
    );
    const workspaceAgentsPackageJsonPath = join(repoRoot, 'packages', 'agents', 'package.json');
    const bundledAgentsZodDir = join(
      repoRoot,
      'apps',
      'cli',
      'node_modules',
      '@happier-dev',
      'agents',
      'node_modules',
      'zod',
    );
    const snapshotRuntimeClosureFilePath = join(
      snapshotDir,
      'node_modules',
      '@happier-dev',
      'agents',
      'node_modules',
      'zod',
      'v4',
      'locales',
      'ru.js',
    );

    const agentsPackageJson = JSON.stringify(
      {
        name: '@happier-dev/agents',
        dependencies: {
          zod: '4.3.6',
        },
      },
      null,
      2,
    );
    await writeFile(workspaceAgentsPackageJsonPath, agentsPackageJson, 'utf8');
    await writeFile(bundledAgentsPackageJsonPath, agentsPackageJson, 'utf8');
    await mkdir(join(bundledAgentsZodDir, 'v4', 'locales'), { recursive: true });
    await writeFile(
      join(bundledAgentsZodDir, 'package.json'),
      JSON.stringify(
        {
          name: 'zod',
          version: '4.3.6',
          main: 'index.js',
          exports: {
            '.': './index.js',
            './v4': './v4/index.js',
          },
        },
        null,
        2,
      ),
      'utf8',
    );
    await writeFile(join(bundledAgentsZodDir, 'index.js'), 'export const z = true;\n', 'utf8');
    await writeFile(join(bundledAgentsZodDir, 'v4', 'index.js'), 'export const v4 = true;\n', 'utf8');
    await writeFile(join(bundledAgentsZodDir, 'v4', 'locales', 'ru.js'), 'export const locale = "ru";\n', 'utf8');

    await mkdir(snapshotDistDir, { recursive: true });
    await writeFile(snapshotEntrypoint, 'export const snapshot = "ready";\n', 'utf8');
    await cp(join(repoRoot, 'apps', 'cli', 'node_modules'), join(snapshotDir, 'node_modules'), { recursive: true });
    rmSync(snapshotRuntimeClosureFilePath, { force: true });
    await writeFile(join(snapshotDir, '.cli-dist-snapshot.ready.json'), JSON.stringify({ v: 1 }), 'utf8');

    const freshSnapshotTime = new Date('2031-03-09T01:05:00.000Z');
    touchTree(snapshotDistDir, freshSnapshotTime);
    touchTree(join(snapshotDir, 'node_modules'), freshSnapshotTime);

    await withCliDistBuildLock(
      async () => {
        const entrypoint = await ensureCliDistSnapshotEntrypoint(
          { testDir: join(repoRoot, '.project'), env: process.env },
          {
            repoRoot,
            snapshotDir,
            timeoutMs: 250,
            runCommand: async () => {
              throw new Error('reusable ready snapshot repair should not need a live CLI rebuild');
            },
          },
        );

        expect(entrypoint).toBe(snapshotEntrypoint);
      },
      {
        lockPath: `${snapshotDir}.lock`,
        timeoutMs: 10_000,
        staleAfterMs: 10_000,
      },
    );

    expect(readFileSync(snapshotRuntimeClosureFilePath, 'utf8')).toContain('locale = "ru"');
  });

  it('preserves the original stale ready snapshot when replacement materialization hits ENOENT', async () => {
    const repoRoot = await createRepoRoot();
    const snapshotDir = join(repoRoot, '.project', 'tmp', 'cli-dist-snapshot');
    const snapshotDistDir = join(snapshotDir, 'dist');
    const snapshotEntrypoint = join(snapshotDistDir, 'index.mjs');
    const canonicalEntrypoint = join(repoRoot, 'apps', 'cli', 'dist', 'index.mjs');
    const snapshotReadyMarkerPath = join(snapshotDir, '.cli-dist-snapshot.ready.json');
    const snapshotSentinelPath = join(snapshotDir, 'node_modules', '.snapshot-sentinel');

    await mkdir(snapshotDistDir, { recursive: true });
    await mkdir(join(snapshotDir, 'node_modules'), { recursive: true });
    await writeFile(snapshotEntrypoint, 'export const snapshot = "stale";\n', 'utf8');
    await writeFile(snapshotReadyMarkerPath, JSON.stringify({ v: 1 }), 'utf8');
    await writeFile(snapshotSentinelPath, 'keep-me\n', 'utf8');
    await writeFile(canonicalEntrypoint, 'export const canonical = "fresh";\n', 'utf8');

    const snapshotTime = new Date('2026-03-09T01:00:00.000Z');
    const canonicalTime = new Date('2026-03-09T01:05:00.000Z');
    utimesSync(snapshotDistDir, snapshotTime, snapshotTime);
    utimesSync(snapshotEntrypoint, snapshotTime, snapshotTime);
    utimesSync(canonicalEntrypoint, canonicalTime, canonicalTime);

    vi.resetModules();
    vi.doMock('node:fs/promises', async () => {
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      return {
        ...actual,
        cp: async () => {
          const error = new Error('simulated replacement materialization ENOENT') as NodeJS.ErrnoException;
          error.code = 'ENOENT';
          throw error;
        },
      };
    });

    try {
      const { ensureCliDistSnapshotEntrypoint: ensureCliDistSnapshotEntrypointWithCopyFailure } = await import(
        './cliDist'
      );

      await expect(
        ensureCliDistSnapshotEntrypointWithCopyFailure(
          { testDir: join(repoRoot, '.project'), env: process.env },
          {
            repoRoot,
            snapshotDir,
            runCommand: async () => {},
          },
        ),
      ).rejects.toThrow('simulated replacement materialization ENOENT');
    } finally {
      vi.doUnmock('node:fs/promises');
      vi.resetModules();
    }

    expect(existsSync(snapshotDir)).toBe(true);
    expect(readFileSync(snapshotEntrypoint, 'utf8')).toContain('snapshot = "stale"');
    expect(readFileSync(snapshotReadyMarkerPath, 'utf8')).toContain('"v":1');
    expect(readFileSync(snapshotSentinelPath, 'utf8')).toContain('keep-me');
    expect(
      readdirSync(join(repoRoot, '.project', 'tmp')).filter((entry) => entry.startsWith('cli-dist-snapshot-')),
    ).toEqual([]);
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

  it('materializes a per-test CLI dist snapshot without waiting for an unrelated held build lock', async () => {
    const repoRoot = await createRepoRoot();
    const lockPath = join(repoRoot, '.project', 'tmp', 'cli-dist-build.lock');
    const snapshotDir = join(repoRoot, '.project', 'tmp', 'cli-dist-snapshot-testdir');

    let rebuildCalls = 0;
    await withCliDistBuildLock(
      async () => {
        const ensurePromise = ensureCliDistSnapshotEntrypoint(
          { testDir: join(repoRoot, '.project'), env: process.env },
          {
            repoRoot,
            snapshotDir,
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
        const entrypoint = await ensurePromise;
        expect(entrypoint).toBe(join(snapshotDir, 'dist', 'index.mjs'));
      },
      {
        lockPath,
        timeoutMs: 10_000,
        staleAfterMs: 10_000,
      },
    );

    expect(rebuildCalls).toBe(0);
    expect(existsSync(join(snapshotDir, 'dist', 'index.mjs'))).toBe(true);
  });

  it('materializes the canonical shared CLI snapshot without retaining the dist publication lock', async () => {
    const repoRoot = await createRepoRoot();
    const lockPath = join(repoRoot, '.project', 'tmp', 'cli-dist-build.lock');
    const snapshotDir = join(repoRoot, '.project', 'tmp', 'cli-dist-snapshot');

    await withCliDistBuildLock(
      async () => {
        const ensurePromise = ensureCliDistSnapshotEntrypoint(
          { testDir: join(repoRoot, '.project'), env: process.env },
          {
            repoRoot,
            snapshotDir,
            timeoutMs: 1_000,
            runCommand: async () => {
              throw new Error('healthy canonical dist should not rebuild');
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

    expect(existsSync(join(snapshotDir, 'dist', 'index.mjs'))).toBe(true);
  });

  it('repairs missing bundled runtime dependency files even when snapshot dist and ready marker already exist', async () => {
    const repoRoot = await createRepoRoot();
    const snapshotDir = join(repoRoot, '.project', 'tmp', 'cli-dist-snapshot');
    const snapshotDistDir = join(snapshotDir, 'dist');
    const snapshotReadyMarkerPath = join(snapshotDir, '.cli-dist-snapshot.ready.json');

    const bundledAgentsPackageJsonPath = join(
      repoRoot,
      'apps',
      'cli',
      'node_modules',
      '@happier-dev',
      'agents',
      'package.json',
    );
    const bundledAgentsZodDir = join(
      repoRoot,
      'apps',
      'cli',
      'node_modules',
      '@happier-dev',
      'agents',
      'node_modules',
      'zod',
    );

    await mkdir(bundledAgentsZodDir, { recursive: true });
    await writeFile(
      bundledAgentsPackageJsonPath,
      JSON.stringify(
        {
          name: '@happier-dev/agents',
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
      join(bundledAgentsZodDir, 'package.json'),
      JSON.stringify({
        name: 'zod',
        version: '4.3.6',
        main: 'index.js',
      }),
      'utf8',
    );
    await writeFile(join(bundledAgentsZodDir, 'index.js'), 'export const live = "source-zod";\n', 'utf8');

    await mkdir(snapshotDistDir, { recursive: true });
    await writeFile(join(snapshotDistDir, 'index.mjs'), 'export const ok = true;\n', 'utf8');
    await mkdir(join(snapshotDir, 'node_modules', '@happier-dev', 'agents', 'node_modules', 'zod'), { recursive: true });
    await writeFile(
      join(snapshotDir, 'node_modules', '@happier-dev', 'agents', 'node_modules', 'zod', 'package.json'),
      JSON.stringify({
        name: 'zod',
        version: '4.3.6',
        main: 'index.js',
      }),
      'utf8',
    );
    await writeFile(snapshotReadyMarkerPath, JSON.stringify({ v: 1 }), 'utf8');

    const snapshotEntrypoint = await ensureCliDistSnapshotEntrypoint(
      { testDir: join(repoRoot, '.project'), env: process.env },
      {
        repoRoot,
        snapshotDir,
        runCommand: async () => {
          throw new Error('unexpected dist rebuild');
        },
      },
    );

    expect(snapshotEntrypoint.endsWith(`${join('dist', 'index.mjs')}`)).toBe(true);
    const resolvedSnapshotDir = dirname(dirname(snapshotEntrypoint));
    const repairedIndexFilePath = join(
      resolvedSnapshotDir,
      'node_modules',
      '@happier-dev',
      'agents',
      'node_modules',
      'zod',
      'index.js',
    );
    expect(existsSync(repairedIndexFilePath)).toBe(true);
    await expect(readFile(repairedIndexFilePath, 'utf8')).resolves.toContain('source-zod');
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

  it('skips shared dependency builds when the E2E skip-build env flag is enabled', async () => {
    const repoRoot = await createRepoRoot();

    let rebuildCalls = 0;
    await ensureCliDistBuilt(
      {
        testDir: join(repoRoot, '.project'),
        env: {
          ...process.env,
          HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
        },
      },
      {
        repoRoot,
        skipSourceFreshnessCheck: true,
        skipDistIntegrityCheck: true,
        runCommand: async () => {
          rebuildCalls += 1;
        },
      },
    );

    expect(rebuildCalls).toBe(0);
  });

  it('fails closed without building when the E2E skip-build flag finds missing runtime prerequisites', async () => {
    const repoRoot = await createRepoRoot();
    const bundledConnectionSupervisorDir = join(
      repoRoot,
      'apps',
      'cli',
      'node_modules',
      '@happier-dev',
      'connection-supervisor',
    );
    rmSync(bundledConnectionSupervisorDir, { recursive: true, force: true });

    let rebuildCalls = 0;
    await expect(
      ensureCliSharedDepsBuilt(
        {
          testDir: join(repoRoot, '.project'),
          env: {
            ...process.env,
            HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
          },
        },
        {
          repoRoot,
          skipSourceFreshnessCheck: true,
          runCommand: async () => {
            rebuildCalls += 1;
          },
        },
      ),
    ).rejects.toThrow(/shared workspace deps runtime prerequisites are missing/i);

    expect(rebuildCalls).toBe(0);
  });

  it('accepts a generated plugin UI artifact matched by a wildcard export when the E2E build is skipped', async () => {
    const repoRoot = await createRepoRoot();
    const cliPackageJsonPath = join(repoRoot, 'apps', 'cli', 'package.json');
    const inspectorWorkspaceDir = join(repoRoot, 'packages', 'plugins', 'inspector');
    const bundledInspectorDir = join(
      repoRoot,
      'apps',
      'cli',
      'node_modules',
      '@happier-dev',
      'plugins-inspector',
    );
    const inspectorPackageJson = {
      name: '@happier-dev/plugins-inspector',
      exports: {
        '.': {
          default: './dist/index.js',
        },
        './happier-plugin-ui/*': './dist/happier-plugin-ui/*',
      },
    };
    const generatedUiArtifactRelativePath = join('dist', 'happier-plugin-ui', 'ui-artifacts.json');

    await writeFile(
      cliPackageJsonPath,
      JSON.stringify({
        name: '@happier-dev/cli',
        bundledDependencies: [
          ...CLI_SHARED_DEP_TEST_FIXTURE_PACKAGE_NAMES.map((packageName) => `@happier-dev/${packageName}`),
          '@happier-dev/plugins-inspector',
        ],
      }),
      'utf8',
    );

    for (const packageDir of [inspectorWorkspaceDir, bundledInspectorDir]) {
      await mkdir(join(packageDir, 'dist', 'happier-plugin-ui'), { recursive: true });
      await writeFile(join(packageDir, 'package.json'), JSON.stringify(inspectorPackageJson), 'utf8');
      await writeFile(join(packageDir, 'dist', 'index.js'), 'export const inspector = true;\n', 'utf8');
      await writeFile(join(packageDir, generatedUiArtifactRelativePath), '{"version":1,"entries":[]}\n', 'utf8');
    }

    const ensureSkippedSharedDeps = () => ensureCliSharedDepsBuilt(
      {
        testDir: join(repoRoot, '.project'),
        env: {
          ...process.env,
          HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
        },
      },
      {
        repoRoot,
        skipSourceFreshnessCheck: true,
        runCommand: async () => {
          throw new Error('skip-build mode must not invoke the canonical publisher');
        },
      },
    );

    await expect(ensureSkippedSharedDeps()).resolves.toBeUndefined();

    for (const packageDir of [inspectorWorkspaceDir, bundledInspectorDir]) {
      rmSync(join(packageDir, generatedUiArtifactRelativePath));
    }

    await expect(ensureSkippedSharedDeps()).rejects.toThrow(
      /shared workspace deps runtime prerequisites are missing/i,
    );
  });

  it('rebuilds when a bundled shared dependency workspace is missing from the CLI node_modules tree', async () => {
    const repoRoot = await createRepoRoot();
    const bundledConnectionSupervisorDir = join(
      repoRoot,
      'apps',
      'cli',
      'node_modules',
      '@happier-dev',
      'connection-supervisor',
    );
    rmSync(
      bundledConnectionSupervisorDir,
      { recursive: true, force: true },
    );

    let rebuildCalls = 0;
    await ensureCliSharedDepsBuilt(
      { testDir: join(repoRoot, '.project'), env: process.env },
      {
        repoRoot,
        skipSourceFreshnessCheck: true,
        runCommand: async () => {
          rebuildCalls += 1;
          await mkdir(join(bundledConnectionSupervisorDir, 'dist'), { recursive: true });
          await writeFile(
            join(bundledConnectionSupervisorDir, 'package.json'),
            JSON.stringify({ name: '@happier-dev/connection-supervisor' }, null, 2),
            'utf8',
          );
          await writeFile(
            join(bundledConnectionSupervisorDir, 'dist', 'index.js'),
            'export const ok = true;\n',
            'utf8',
          );
        },
      },
    );

    expect(rebuildCalls).toBe(1);
  });

  it('rebuilds when manifest-declared Grok and Inspector UI graph outputs are missing', async () => {
    const repoRoot = await createRepoRoot();
    const cliPackageJsonPath = join(repoRoot, 'apps', 'cli', 'package.json');
    const inspectorWorkspaceDir = join(repoRoot, 'packages', 'plugins', 'inspector');
    const grokWorkspaceDir = join(repoRoot, 'packages', 'plugins', 'grok');
    const bundledInspectorDir = join(
      repoRoot,
      'apps',
      'cli',
      'node_modules',
      '@happier-dev',
      'plugins-inspector',
    );
    const bundledGrokDir = join(
      repoRoot,
      'apps',
      'cli',
      'node_modules',
      '@happier-dev',
      'plugins-grok',
    );
    const generatedGraphRelativePath = join('dist', 'happier-plugin-ui', 'ui-artifacts.json');

    await writeFile(
      cliPackageJsonPath,
      JSON.stringify({
        name: '@happier-dev/cli',
        bundledDependencies: [
          ...CLI_SHARED_DEP_TEST_FIXTURE_PACKAGE_NAMES.map((packageName) => `@happier-dev/${packageName}`),
          '@happier-dev/plugins-grok',
          '@happier-dev/plugins-inspector',
        ],
      }),
      'utf8',
    );
    await mkdir(join(inspectorWorkspaceDir, 'src'), { recursive: true });
    await mkdir(join(inspectorWorkspaceDir, 'dist', 'happier-plugin-ui'), { recursive: true });
    await writeFile(
      join(inspectorWorkspaceDir, 'package.json'),
      JSON.stringify({
        name: '@happier-dev/plugins-inspector',
        exports: {
          '.': {
            default: './dist/index.js',
          },
        },
        scripts: {
          'build:ui': 'happier-plugin-build-ui',
        },
      }),
      'utf8',
    );
    await writeFile(join(inspectorWorkspaceDir, 'src', 'index.ts'), 'export const inspector = true;\n', 'utf8');
    await writeFile(join(inspectorWorkspaceDir, 'dist', 'index.js'), 'export const inspector = true;\n', 'utf8');
    await writeFile(
      join(inspectorWorkspaceDir, generatedGraphRelativePath),
      '{"version":1,"entries":[]}\n',
      'utf8',
    );
    await mkdir(join(grokWorkspaceDir, 'src'), { recursive: true });
    await mkdir(join(grokWorkspaceDir, 'dist'), { recursive: true });
    await writeFile(
      join(grokWorkspaceDir, 'package.json'),
      JSON.stringify({
        name: '@happier-dev/plugins-grok',
        dependencies: {
          '@happier-dev/plugin-sdk': '0.0.0',
        },
        exports: {
          '.': {
            default: './dist/index.js',
          },
        },
      }),
      'utf8',
    );
    await writeFile(join(grokWorkspaceDir, 'src', 'index.ts'), 'export const grok = true;\n', 'utf8');
    await writeFile(join(grokWorkspaceDir, 'dist', 'index.js'), 'export const grok = true;\n', 'utf8');

    let rebuildCalls = 0;
    await ensureCliSharedDepsBuilt(
      { testDir: join(repoRoot, '.project'), env: process.env },
      {
        repoRoot,
        skipSourceFreshnessCheck: true,
        runCommand: async () => {
          rebuildCalls += 1;
          await cp(grokWorkspaceDir, bundledGrokDir, { recursive: true });
          await cp(inspectorWorkspaceDir, bundledInspectorDir, { recursive: true });
        },
      },
    );

    expect(rebuildCalls).toBe(1);
    expect(existsSync(join(bundledGrokDir, 'dist', 'index.js'))).toBe(true);
    expect(existsSync(join(bundledInspectorDir, generatedGraphRelativePath))).toBe(true);
  });

  it('rebuilds when a vendored runtime dependency is missing an exported subpath file', async () => {
    const repoRoot = await createRepoRoot();
    const agentsPackageJsonPath = join(repoRoot, 'packages', 'agents', 'package.json');
    const bundledAgentsPackageJsonPath = join(
      repoRoot,
      'apps',
      'cli',
      'node_modules',
      '@happier-dev',
      'agents',
      'package.json',
    );
    const bundledZodDir = join(
      repoRoot,
      'apps',
      'cli',
      'node_modules',
      '@happier-dev',
      'agents',
      'node_modules',
      'zod',
    );

    await writeFile(
      agentsPackageJsonPath,
      JSON.stringify(
        {
          name: '@happier-dev/agents',
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
      bundledAgentsPackageJsonPath,
      JSON.stringify(
        {
          name: '@happier-dev/agents',
          dependencies: {
            zod: '4.3.6',
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    await mkdir(bundledZodDir, { recursive: true });
    await writeFile(
      join(bundledZodDir, 'package.json'),
      JSON.stringify(
        {
          name: 'zod',
          version: '4.3.6',
          exports: {
            '.': './index.js',
            './v4/core': './v4/core/index.js',
            './v4/locales/*': './v4/locales/*',
          },
        },
        null,
        2,
      ),
      'utf8',
    );
    await writeFile(join(bundledZodDir, 'index.js'), 'exports.ok = true;\n', 'utf8');
    await mkdir(join(bundledZodDir, 'v4', 'locales'), { recursive: true });
    await writeFile(join(bundledZodDir, 'v4', 'locales', 'en.js'), 'export const locale = "en";\n', 'utf8');
    rmSync(join(bundledZodDir, 'v4', 'core'), { recursive: true, force: true });

    let rebuildCalls = 0;
    await ensureCliSharedDepsBuilt(
      { testDir: join(repoRoot, '.project'), env: process.env },
      {
        repoRoot,
        skipSourceFreshnessCheck: true,
        runCommand: async () => {
          rebuildCalls += 1;
          await mkdir(join(bundledZodDir, 'v4', 'core'), { recursive: true });
          await writeFile(join(bundledZodDir, 'v4', 'core', 'index.js'), 'export const core = true;\n', 'utf8');
        },
      },
    );

    expect(rebuildCalls).toBe(1);
  });

  it('accepts extensionless main files in bundled runtime dependency trees', async () => {
    const repoRoot = await createRepoRoot();
    const workspaceCliCommonPackageJsonPath = join(repoRoot, 'packages', 'cli-common', 'package.json');
    const bundledCliCommonPackageJsonPath = join(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'cli-common', 'package.json');
    const bundledExtractZipDir = join(
      repoRoot,
      'apps',
      'cli',
      'node_modules',
      '@happier-dev',
      'cli-common',
      'node_modules',
      'extract-zip',
    );
    const bundledDebugDir = join(bundledExtractZipDir, 'node_modules', 'debug');
    const bundledMsDir = join(bundledDebugDir, 'node_modules', 'ms');

    await writeFile(
      workspaceCliCommonPackageJsonPath,
      JSON.stringify(
        {
          name: '@happier-dev/cli-common',
          dependencies: {
            'extract-zip': '^2.0.1',
          },
          exports: {
            '.': {
              default: './dist/index.js',
            },
          },
        },
        null,
        2,
      ),
      'utf8',
    );
    await writeFile(
      bundledCliCommonPackageJsonPath,
      JSON.stringify(
        {
          name: '@happier-dev/cli-common',
          dependencies: {
            'extract-zip': '^2.0.1',
          },
          exports: {
            '.': {
              default: './dist/index.js',
            },
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    await mkdir(join(bundledExtractZipDir, 'dist'), { recursive: true });
    await writeFile(
      join(bundledExtractZipDir, 'package.json'),
      JSON.stringify(
        {
          name: 'extract-zip',
          main: './index.js',
          dependencies: {
            debug: '4.3.7',
          },
        },
        null,
        2,
      ),
      'utf8',
    );
    await writeFile(join(bundledExtractZipDir, 'index.js'), 'exports.ok = true;\n', 'utf8');

    await mkdir(join(bundledDebugDir, 'dist'), { recursive: true });
    await writeFile(
      join(bundledDebugDir, 'package.json'),
      JSON.stringify(
        {
          name: 'debug',
          main: './index.js',
          dependencies: {
            ms: '2.1.3',
          },
        },
        null,
        2,
      ),
      'utf8',
    );
    await writeFile(join(bundledDebugDir, 'index.js'), 'exports.ok = true;\n', 'utf8');

    await mkdir(bundledMsDir, { recursive: true });
    await writeFile(
      join(bundledMsDir, 'package.json'),
      JSON.stringify(
        {
          name: 'ms',
          main: './index',
        },
        null,
        2,
      ),
      'utf8',
    );
    await writeFile(join(bundledMsDir, 'index.js'), 'exports.ok = true;\n', 'utf8');

    vi.resetModules();
    const { ensureCliSharedDepsBuilt } = await import('./cliDist');

    await expect(
      ensureCliSharedDepsBuilt(
        { testDir: join(repoRoot, '.project'), env: process.env },
        {
          repoRoot,
          skipSourceFreshnessCheck: true,
          maxBuildAttempts: 1,
          runCommand: async () => {},
        },
      ),
    ).resolves.toBeUndefined();
  });

  it('rebuilds when bundled workspace exports drift from workspace package.json exports', async () => {
    const repoRoot = await createRepoRoot();
    const workspacePackageJsonPath = join(repoRoot, 'packages', 'cli-common', 'package.json');
    const bundledPackageJsonPath = join(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'cli-common', 'package.json');
    const workspaceSystemTasksDistPath = join(repoRoot, 'packages', 'cli-common', 'dist', 'systemTasks', 'index.js');
    const bundledSystemTasksDistPath = join(
      repoRoot,
      'apps',
      'cli',
      'node_modules',
      '@happier-dev',
      'cli-common',
      'dist',
      'systemTasks',
      'index.js',
    );

    await mkdir(join(workspaceSystemTasksDistPath, '..'), { recursive: true });
    await mkdir(join(bundledSystemTasksDistPath, '..'), { recursive: true });
    await writeFile(workspaceSystemTasksDistPath, 'export const ok = true;\n', 'utf8');
    await writeFile(bundledSystemTasksDistPath, 'export const ok = true;\n', 'utf8');

    const workspacePackageJson = {
      name: '@happier-dev/cli-common',
      exports: {
        '.': { default: './dist/index.js' },
        './systemTasks': { default: './dist/systemTasks/index.js' },
      },
    };
    const staleBundledPackageJson = {
      name: '@happier-dev/cli-common',
      exports: {
        '.': { default: './dist/index.js' },
      },
    };
    await writeFile(workspacePackageJsonPath, JSON.stringify(workspacePackageJson, null, 2), 'utf8');
    await writeFile(bundledPackageJsonPath, JSON.stringify(staleBundledPackageJson, null, 2), 'utf8');

    let rebuildCalls = 0;
    await ensureCliSharedDepsBuilt(
      { testDir: join(repoRoot, '.project'), env: process.env },
      {
        repoRoot,
        skipSourceFreshnessCheck: true,
        runCommand: async () => {
          rebuildCalls += 1;
          await writeFile(bundledPackageJsonPath, JSON.stringify(workspacePackageJson, null, 2), 'utf8');
        },
      },
    );

    expect(rebuildCalls).toBe(1);
  });

  it('rebuilds when bundled protocol dist index contains duplicate explicit named exports', async () => {
    const repoRoot = await createRepoRoot();
    const bundledProtocolDistIndexPath = join(
      repoRoot,
      'apps',
      'cli',
      'node_modules',
      '@happier-dev',
      'protocol',
      'dist',
      'index.js',
    );

    await writeFile(
      bundledProtocolDistIndexPath,
      [
        'export const DuplicateNamedExportFixtureSchema = {};',
        'export { DuplicateNamedExportFixtureSchema };',
        'export { DuplicateNamedExportFixtureSchema };',
        '',
      ].join('\n'),
      'utf8',
    );

    let rebuildCalls = 0;
    await ensureCliSharedDepsBuilt(
      { testDir: join(repoRoot, '.project'), env: process.env },
      {
        repoRoot,
        skipSourceFreshnessCheck: true,
        runCommand: async () => {
          rebuildCalls += 1;
          await writeFile(
            bundledProtocolDistIndexPath,
            ['export const DuplicateNamedExportFixtureSchema = {};', 'export const OtherExport = {};', ''].join('\n'),
            'utf8',
          );
        },
      },
    );

    expect(rebuildCalls).toBe(1);
  });

  it('ignores TypeScript incremental metadata that the canonical bundled-package owner strips', async () => {
    const repoRoot = await createRepoRoot();
    await writeFile(
      join(repoRoot, 'packages', 'protocol', 'dist', '.tsbuildinfo'),
      'compiler cache\n',
      'utf8',
    );

    let rebuildCalls = 0;
    await ensureCliSharedDepsBuilt(
      { testDir: join(repoRoot, '.project'), env: process.env },
      {
        repoRoot,
        skipSourceFreshnessCheck: true,
        maxBuildAttempts: 1,
        runCommand: async () => {
          rebuildCalls += 1;
        },
      },
    );

    expect(rebuildCalls).toBe(0);
  });

  it('rebuilds bundled workspace dist through the canonical publisher when an internal file is missing', async () => {
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
          await cp(
            join(repoRoot, 'packages', 'protocol', 'dist'),
            join(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'protocol', 'dist'),
            { recursive: true, force: true },
          );
        },
      },
    );

    expect(rebuildCalls).toBe(1);
    expect(existsSync(bundledNestedFilePath)).toBe(true);
  });

  it('retries shared dependency builds when sources change during the first build', async () => {
    const repoRoot = await createRepoRoot();
    const sourcePath = join(repoRoot, 'packages', 'agents', 'src', 'index.ts');
    const outputPaths = resolveCliSharedDepBundleIndexPaths(repoRoot);
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

  it('does not accept a build when a non-newest source changes during the build', async () => {
    const repoRoot = await createRepoRoot();
    const newestSourcePath = join(repoRoot, 'packages', 'agents', 'src', 'index.ts');
    const changingSourcePath = join(repoRoot, 'packages', 'agents', 'src', 'secondary.ts');
    await writeFile(changingSourcePath, 'export const secondary = 1;\n', 'utf8');
    const outputPaths = resolveCliSharedDepBundleIndexPaths(repoRoot);
    const olderSourceTime = new Date('2030-03-09T01:10:00.000Z');
    const changedSourceTime = new Date('2030-03-09T01:15:00.000Z');
    const newestSourceTime = new Date('2030-03-09T01:30:00.000Z');
    utimesSync(changingSourcePath, olderSourceTime, olderSourceTime);
    utimesSync(newestSourcePath, newestSourceTime, newestSourceTime);

    vi.resetModules();
    const { ensureCliSharedDepsBuilt } = await import('./cliDist');

    let buildCalls = 0;
    await expect(
      ensureCliSharedDepsBuilt(
        { testDir: join(repoRoot, '.project'), env: process.env },
        {
          repoRoot,
          maxBuildAttempts: 1,
          runCommand: async () => {
            buildCalls += 1;
            for (const outputPath of outputPaths) {
              utimesSync(outputPath, new Date('2030-03-09T01:20:00.000Z'), new Date('2030-03-09T01:20:00.000Z'));
            }
            utimesSync(changingSourcePath, changedSourceTime, changedSourceTime);
          },
        },
      ),
    ).rejects.toThrow(/Shared workspace deps output missing after build/u);

    expect(buildCalls).toBe(1);
  });

  it('does not hold the shared-deps lock while the build command reacquires it', async () => {
    const repoRoot = await createRepoRoot();
    const sourcePath = join(repoRoot, 'packages', 'agents', 'src', 'index.ts');
    const lockPath = join(repoRoot, '.project', 'tmp', 'cli-shared-deps-build.lock');
    const outputPaths = resolveCliSharedDepBundleIndexPaths(repoRoot);

    utimesSync(sourcePath, new Date('2030-03-09T01:18:00.000Z'), new Date('2030-03-09T01:18:00.000Z'));

    vi.resetModules();
    const { ensureCliSharedDepsBuilt } = await import('./cliDist');

    let buildCalls = 0;
    await expect(
      ensureCliSharedDepsBuilt(
        { testDir: join(repoRoot, '.project'), env: process.env },
        {
          repoRoot,
          lockPath,
          timeoutMs: 1_000,
          runCommand: async () => {
            buildCalls += 1;
            await withCliDistBuildLock(
              async () => {
                const outputTime = new Date('2030-03-09T01:20:00.000Z');
                for (const outputPath of outputPaths) {
                  utimesSync(outputPath, outputTime, outputTime);
                }
              },
              {
                lockPath,
                timeoutMs: 100,
                pollIntervalMs: 25,
                staleAfterMs: 1_000,
              },
            );
          },
        },
      ),
    ).resolves.toBeUndefined();

    expect(buildCalls).toBe(1);
  });

  it('accepts fresh bundled shared deps even when workspace dist is stale', async () => {
    const repoRoot = await createRepoRoot();
    const sourcePath = join(repoRoot, 'packages', 'protocol', 'src', 'index.ts');
    const workspaceOutputPath = join(repoRoot, 'packages', 'protocol', 'dist', 'index.js');
    const bundledOutputPaths = resolveCliSharedDepBundleIndexPaths(repoRoot);

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

  it('does not compare source freshness across unrelated bundled packages', async () => {
    const repoRoot = await createRepoRoot();
    const releaseRuntimeSourcePath = join(repoRoot, 'packages', 'release-runtime', 'src', 'index.ts');
    const releaseRuntimeBundledOutputPath = join(
      repoRoot,
      'apps',
      'cli',
      'node_modules',
      '@happier-dev',
      'release-runtime',
      'dist',
      'index.js',
    );
    const protocolSourcePath = join(repoRoot, 'packages', 'protocol', 'src', 'index.ts');
    const protocolBundledOutputPath = join(
      repoRoot,
      'apps',
      'cli',
      'node_modules',
      '@happier-dev',
      'protocol',
      'dist',
      'index.js',
    );

    const olderSourceTime = new Date('2030-03-09T01:00:00.000Z');
    const olderCurrentOutputTime = new Date('2030-03-09T01:05:00.000Z');
    const newerSourceTime = new Date('2030-03-09T01:20:00.000Z');
    const newerCurrentOutputTime = new Date('2030-03-09T01:25:00.000Z');
    utimesSync(releaseRuntimeSourcePath, olderSourceTime, olderSourceTime);
    utimesSync(releaseRuntimeBundledOutputPath, olderCurrentOutputTime, olderCurrentOutputTime);
    utimesSync(protocolSourcePath, newerSourceTime, newerSourceTime);
    utimesSync(protocolBundledOutputPath, newerCurrentOutputTime, newerCurrentOutputTime);

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

  it('does not treat a manifest-only timestamp change as stale compiled output', async () => {
    const repoRoot = await createRepoRoot();
    const workspacePackageJsonPath = join(repoRoot, 'packages', 'release-runtime', 'package.json');
    const bundledOutputPath = join(
      repoRoot,
      'apps',
      'cli',
      'node_modules',
      '@happier-dev',
      'release-runtime',
      'dist',
      'index.js',
    );
    const olderOutputTime = new Date('2030-03-09T01:10:00.000Z');
    const newerManifestTime = new Date('2030-03-09T01:20:00.000Z');
    utimesSync(bundledOutputPath, olderOutputTime, olderOutputTime);
    utimesSync(workspacePackageJsonPath, newerManifestTime, newerManifestTime);

    vi.resetModules();
    const { ensureCliSharedDepsBuilt } = await import('./cliDist');

    let rebuildCalls = 0;
    await expect(
      ensureCliSharedDepsBuilt(
        { testDir: join(repoRoot, '.project'), env: process.env },
        {
          repoRoot,
          maxBuildAttempts: 1,
          runCommand: async () => {
            rebuildCalls += 1;
          },
        },
      ),
    ).resolves.toBeUndefined();

    expect(rebuildCalls).toBe(0);
  });

  it('does not compare updated source against an unrelated unchanged entrypoint in the same package', async () => {
    const repoRoot = await createRepoRoot();
    const sourcePath = join(repoRoot, 'packages', 'plugin-sdk', 'src', 'index.ts');
    const currentOutputPath = join(
      repoRoot,
      'apps',
      'cli',
      'node_modules',
      '@happier-dev',
      'plugin-sdk',
      'dist',
      'index.js',
    );
    const unchangedOutputPath = join(
      repoRoot,
      'apps',
      'cli',
      'node_modules',
      '@happier-dev',
      'plugin-sdk',
      'dist',
      'accountUsage.js',
    );
    const workspaceUnchangedOutputPath = join(
      repoRoot,
      'packages',
      'plugin-sdk',
      'dist',
      'accountUsage.js',
    );
    const packageJson = JSON.stringify({
      name: '@happier-dev/plugin-sdk',
      exports: {
        '.': './dist/index.js',
        './account-usage': './dist/accountUsage.js',
      },
    });
    await writeFile(join(repoRoot, 'packages', 'plugin-sdk', 'package.json'), packageJson, 'utf8');
    await writeFile(
      join(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'plugin-sdk', 'package.json'),
      packageJson,
      'utf8',
    );
    await writeFile(workspaceUnchangedOutputPath, 'exports.usage = true;\n', 'utf8');
    await writeFile(unchangedOutputPath, 'exports.usage = true;\n', 'utf8');
    const olderOutputTime = new Date('2030-03-09T01:10:00.000Z');
    const newerSourceTime = new Date('2030-03-09T01:20:00.000Z');
    const currentOutputTime = new Date('2030-03-09T01:25:00.000Z');
    utimesSync(unchangedOutputPath, olderOutputTime, olderOutputTime);
    utimesSync(workspaceUnchangedOutputPath, olderOutputTime, olderOutputTime);
    utimesSync(sourcePath, newerSourceTime, newerSourceTime);
    utimesSync(currentOutputPath, currentOutputTime, currentOutputTime);

    vi.resetModules();
    const { ensureCliSharedDepsBuilt } = await import('./cliDist');

    let rebuildCalls = 0;
    await expect(
      ensureCliSharedDepsBuilt(
        { testDir: join(repoRoot, '.project'), env: process.env },
        {
          repoRoot,
          maxBuildAttempts: 1,
          runCommand: async () => {
            rebuildCalls += 1;
          },
        },
      ),
    ).resolves.toBeUndefined();

    expect(rebuildCalls).toBe(1);
  });

  it('fails open when workspace package.json is missing (bundled outputs are still considered healthy)', async () => {
    const repoRoot = await createRepoRoot();
    rmSync(join(repoRoot, 'packages', 'cli-common', 'package.json'), { force: true });

    vi.resetModules();
    const { ensureCliSharedDepsBuilt } = await import('./cliDist');

    let buildCalls = 0;
    await expect(
      ensureCliSharedDepsBuilt(
        { testDir: join(repoRoot, '.project'), env: process.env },
        {
          repoRoot,
          skipSourceFreshnessCheck: true,
          maxBuildAttempts: 1,
          runCommand: async () => {
            buildCalls += 1;
          },
        },
      ),
    ).resolves.toBeUndefined();

    expect(buildCalls).toBe(0);
  });

  it('includes a health report when shared deps still fail after rebuilding', async () => {
    const repoRoot = await createRepoRoot();
    const workspacePackageJsonPath = join(repoRoot, 'packages', 'cli-common', 'package.json');
    const bundledPackageJsonPath = join(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'cli-common', 'package.json');

    await writeFile(
      workspacePackageJsonPath,
      JSON.stringify(
        {
          name: '@happier-dev/cli-common',
          exports: {
            '.': {
              default: './dist/index.js',
            },
            './systemTasks': {
              default: './dist/systemTasks/index.js',
            },
          },
        },
        null,
        2,
      ),
      'utf8',
    );
    await writeFile(
      bundledPackageJsonPath,
      JSON.stringify(
        {
          name: '@happier-dev/cli-common',
          exports: {
            '.': {
              default: './dist/index.js',
            },
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    vi.resetModules();
    const { ensureCliSharedDepsBuilt } = await import('./cliDist');

    await expect(
      ensureCliSharedDepsBuilt(
        { testDir: join(repoRoot, '.project'), env: process.env },
        {
          repoRoot,
          skipSourceFreshnessCheck: true,
          maxBuildAttempts: 1,
          runCommand: async () => {},
        },
      ),
    ).rejects.toThrow(/health=/u);
  });

  it('honors skipSourceFreshnessCheck when validating outputs after a rebuild', async () => {
    const repoRoot = await createRepoRoot();
    const sourcePath = join(repoRoot, 'packages', 'cli-common', 'src', 'index.ts');
    const workspaceCliCommonPackageJsonPath = join(repoRoot, 'packages', 'cli-common', 'package.json');
    const bundledCliCommonPackageJsonPath = join(
      repoRoot,
      'apps',
      'cli',
      'node_modules',
      '@happier-dev',
      'cli-common',
      'package.json',
    );

    // Force the freshness check to consider sources newer than outputs.
    const newerSourceTime = new Date('2030-03-09T01:18:00.000Z');
    utimesSync(sourcePath, newerSourceTime, newerSourceTime);
    const olderOutputTime = new Date('2030-03-09T01:10:00.000Z');

    // Break the bundled manifests (not repairable via dist symlinks) so ensureCliSharedDepsBuilt has to rebuild.
    await writeFile(
      workspaceCliCommonPackageJsonPath,
      JSON.stringify({ name: '@happier-dev/cli-common', exports: { '.': { default: './dist/index.js' } } }, null, 2),
      'utf8',
    );
    await writeFile(
      bundledCliCommonPackageJsonPath,
      JSON.stringify({ name: '@happier-dev/cli-common', exports: { '.': './dist/index.js' } }, null, 2),
      'utf8',
    );

    let buildCalls = 0;
    await expect(
      ensureCliSharedDepsBuilt(
        { testDir: join(repoRoot, '.project'), env: process.env },
        {
          repoRoot,
          skipSourceFreshnessCheck: true,
          maxBuildAttempts: 1,
          runCommand: async () => {
            buildCalls += 1;
            await writeFile(
              bundledCliCommonPackageJsonPath,
              JSON.stringify({ name: '@happier-dev/cli-common', exports: { '.': { default: './dist/index.js' } } }, null, 2),
              'utf8',
            );

            // Keep the output older than the source: skipSourceFreshnessCheck must still accept it.
            utimesSync(bundledCliCommonPackageJsonPath, olderOutputTime, olderOutputTime);
          },
        },
      ),
    ).resolves.toBeUndefined();

    expect(buildCalls).toBe(1);
  });

  it('returns healthy shared deps without waiting for an unrelated held shared-deps lock', async () => {
    const repoRoot = await createRepoRoot();
    const lockPath = join(repoRoot, '.project', 'tmp', 'cli-shared-deps-build.lock');

    let rebuildCalls = 0;
    await withCliDistBuildLock(
      async () => {
        const ensurePromise = ensureCliSharedDepsBuilt(
          { testDir: join(repoRoot, '.project'), env: process.env },
          {
            repoRoot,
            lockPath,
            timeoutMs: 1_000,
            skipSourceFreshnessCheck: true,
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
});
