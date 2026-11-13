import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';


import {
  prepareSourceDevSharedDepsForBundledPluginRuntimeLoad,
  prepareSourceDevSharedDepsForHappyCliSpawn,
} from './sourceDevSharedDepsPreflight';

// Observe the OS boundary while retaining the real preparation child and cancellation path.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const tempDirs: string[] = [];

async function writeAdmittedSourceSnapshotFixture(params: Readonly<{
  cliProjectPath: string;
  workspaceName: string;
  outputText?: string;
}>): Promise<{ outputPath: string }> {
  const packageDir = join(
    params.cliProjectPath,
    'node_modules',
    '@happier-dev',
    params.workspaceName,
  );
  const packageJsonPath = join(packageDir, 'package.json');
  const outputPath = join(packageDir, 'dist', 'index.js');
  await mkdir(join(params.cliProjectPath, 'scripts'), { recursive: true });
  await mkdir(join(packageDir, 'dist'), { recursive: true });
  await writeFile(
    join(params.cliProjectPath, 'scripts', 'syncSharedDepsForDev.mjs'),
    'throw new Error("live check must not run for an admitted copy");\n',
    'utf8',
  );
  await writeFile(
    packageJsonPath,
    JSON.stringify({
      name: `@happier-dev/${params.workspaceName}`,
      main: './dist/index.js',
    }),
    'utf8',
  );
  await writeFile(outputPath, params.outputText ?? 'export const admitted = true;\n', 'utf8');

  const packageJsonStat = await stat(packageJsonPath);
  const outputStat = await stat(outputPath);
  await writeFile(
    join(params.cliProjectPath, '.cli-source-snapshot-admission.json'),
    JSON.stringify({
      version: 1,
      packages: {
        [params.workspaceName]: {
          dependencies: [],
          dist: {
            fileCount: 1,
            totalBytes: outputStat.size,
          },
          outputs: [
            {
              path: 'package.json',
              size: packageJsonStat.size,
              mtimeMs: packageJsonStat.mtimeMs,
            },
            {
              path: 'dist/index.js',
              size: outputStat.size,
              mtimeMs: outputStat.mtimeMs,
            },
          ],
        },
      },
    }),
    'utf8',
  );
  return { outputPath };
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe('prepareSourceDevSharedDepsForHappyCliSpawn', () => {
  it('skips source admission for non-source child launches', async () => {
    const result = await prepareSourceDevSharedDepsForHappyCliSpawn({
      args: ['opencode'],
      resolveInvocation: () => ({
        runtime: 'node',
        argv: ['--no-warnings', '/repo/apps/cli/dist/index.mjs', 'opencode'],
      }),
    });

    expect(result).toEqual({
      type: 'ready',
      checked: false,
      reason: 'not-source-entrypoint',
    });
  });

  it('launches a checkout source child without publishing workspace dists it never imports', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-source-dev-source-imports-'));
    tempDirs.push(tempDir);
    const cliProjectPath = join(tempDir, 'apps', 'cli');
    const publicationsPath = join(tempDir, 'publications');
    await mkdir(join(cliProjectPath, 'scripts'), { recursive: true });
    // The live publisher rebuilds every stale workspace dist in the target closure.
    // A source child resolves first-party imports through the workspace source
    // hook, which refuses dist targets, so each publication is work for nobody.
    await writeFile(join(cliProjectPath, 'scripts', 'syncSharedDepsForDev.mjs'), [
      "import { appendFileSync } from 'node:fs';",
      `appendFileSync(${JSON.stringify(publicationsPath)}, 'published\\n');`,
    ].join('\n'));
    const spawnProcess = vi.mocked(spawn);
    spawnProcess.mockClear();
    const launch = () => prepareSourceDevSharedDepsForHappyCliSpawn({
      args: ['claude'],
      cliProjectPath,
      resolveInvocation: () => ({
        runtime: 'node',
        argv: ['--conditions=happier-source', join(cliProjectPath, 'src', 'index.ts'), 'claude'],
      }),
      workspaceNames: ['plugins-claude'],
    });

    const results = [await launch(), await launch()];

    expect(results).toEqual([
      { type: 'ready', checked: true, reason: 'source-imports' },
      { type: 'ready', checked: true, reason: 'source-imports' },
    ]);
    expect(spawnProcess).toHaveBeenCalledTimes(0);
    expect(await readFile(publicationsPath, 'utf8').catch(() => '')).toBe('');
  });

  it('keeps a valid admitted copy local after unrelated live dist and stamp publication', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-source-dev-admitted-copy-'));
    tempDirs.push(tempDir);
    const cliProjectPath = join(tempDir, 'snapshot', 'apps', 'cli');
    await writeAdmittedSourceSnapshotFixture({
      cliProjectPath,
      workspaceName: 'plugins-opencode',
    });
    const liveRepoRoot = join(tempDir, 'live');
    await mkdir(join(liveRepoRoot, 'packages', 'plugins', 'opencode', 'dist'), { recursive: true });
    await mkdir(join(liveRepoRoot, '.project', 'tmp'), { recursive: true });
    await writeFile(
      join(liveRepoRoot, 'packages', 'plugins', 'opencode', 'dist', 'index.js'),
      'export const republished = true;\n',
      'utf8',
    );
    await writeFile(
      join(liveRepoRoot, '.project', 'tmp', 'cli-source-dev-shared-deps-sync.json'),
      '{"version":3,"entries":{}}\n',
      'utf8',
    );

    const result = await prepareSourceDevSharedDepsForHappyCliSpawn({
      args: ['opencode'],
      cliProjectPath,
      resolveInvocation: () => ({
        runtime: 'node',
        argv: [join(cliProjectPath, 'src', 'index.ts'), 'opencode'],
      }),
      workspaceNames: ['plugins-opencode'],
    });

    expect(result).toEqual({
      type: 'ready',
      checked: true,
      reason: 'admitted-copy',
    });
  });

  it.each(['missing', 'corrupt'] as const)(
    'rejects a %s requested copied output before source child spawn',
    async (failureMode) => {
      const tempDir = await mkdtemp(join(tmpdir(), `happier-source-dev-admitted-${failureMode}-`));
      tempDirs.push(tempDir);
      const cliProjectPath = join(tempDir, 'snapshot', 'apps', 'cli');
      const { outputPath } = await writeAdmittedSourceSnapshotFixture({
        cliProjectPath,
        workspaceName: 'plugins-opencode',
      });
      if (failureMode === 'missing') {
        await rm(outputPath, { force: true });
      } else {
        await writeFile(outputPath, 'corrupt copied output\n', 'utf8');
      }

      const result = await prepareSourceDevSharedDepsForHappyCliSpawn({
        args: ['opencode'],
        cliProjectPath,
        resolveInvocation: () => ({
          runtime: 'node',
          argv: [join(cliProjectPath, 'src', 'index.ts'), 'opencode'],
        }),
        workspaceNames: ['plugins-opencode'],
      });

      expect(result.type).toBe('error');
      if (result.type !== 'error') throw new Error('expected preflight error');
      expect(result.errorMessage).toContain('admitted source snapshot');
      expect(result.errorMessage).toContain('plugins-opencode');
    },
  );

  it('validates the transitive copied workspace closure requested by a source child', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-source-dev-admitted-closure-'));
    tempDirs.push(tempDir);
    const cliProjectPath = join(tempDir, 'snapshot', 'apps', 'cli');
    await writeAdmittedSourceSnapshotFixture({
      cliProjectPath,
      workspaceName: 'plugins-opencode',
    });
    const protocolPackageDir = join(cliProjectPath, 'node_modules', '@happier-dev', 'protocol');
    const protocolPackageJsonPath = join(protocolPackageDir, 'package.json');
    const protocolOutputPath = join(protocolPackageDir, 'dist', 'index.js');
    await mkdir(join(protocolPackageDir, 'dist'), { recursive: true });
    await writeFile(
      protocolPackageJsonPath,
      '{"name":"@happier-dev/protocol","main":"./dist/index.js"}\n',
      'utf8',
    );
    await writeFile(protocolOutputPath, 'export const protocol = true;\n', 'utf8');
    const protocolPackageJsonStat = await stat(protocolPackageJsonPath);
    const protocolOutputStat = await stat(protocolOutputPath);
    const admissionPath = join(cliProjectPath, '.cli-source-snapshot-admission.json');
    const admission = JSON.parse(await readFile(admissionPath, 'utf8')) as {
      packages: Record<string, {
        dependencies: string[];
        dist: { fileCount: number; totalBytes: number };
        outputs: Array<{ path: string; size: number; mtimeMs: number }>;
      }>;
    };
    const opencodeAdmission = admission.packages['plugins-opencode'];
    if (!opencodeAdmission) throw new Error('missing fixture package admission');
    opencodeAdmission.dependencies = ['protocol'];
    admission.packages.protocol = {
      dependencies: [],
      dist: {
        fileCount: 1,
        totalBytes: protocolOutputStat.size,
      },
      outputs: [
        {
          path: 'package.json',
          size: protocolPackageJsonStat.size,
          mtimeMs: protocolPackageJsonStat.mtimeMs,
        },
        {
          path: 'dist/index.js',
          size: protocolOutputStat.size,
          mtimeMs: protocolOutputStat.mtimeMs,
        },
      ],
    };
    await writeFile(admissionPath, JSON.stringify(admission), 'utf8');
    await rm(protocolOutputPath, { force: true });

    const result = await prepareSourceDevSharedDepsForHappyCliSpawn({
      args: ['opencode'],
      cliProjectPath,
      resolveInvocation: () => ({
        runtime: 'node',
        argv: [join(cliProjectPath, 'src', 'index.ts'), 'opencode'],
      }),
      workspaceNames: ['plugins-opencode'],
    });

    expect(result.type).toBe('error');
    if (result.type !== 'error') throw new Error('expected preflight error');
    expect(result.errorMessage).toContain('protocol');
  });

  it.each([
    ['dependency workspace', '../outside', 'dependency'],
    ['package workspace', '../outside', 'package'],
    ['Windows output path', 'C:\\outside\\index.js', 'output'],
    ['parent output path', '../../outside/index.js', 'output'],
  ] as const)(
    'rejects an unsafe admitted snapshot %s before local path resolution',
    async (_label, unsafeValue, field) => {
      const tempDir = await mkdtemp(join(tmpdir(), 'happier-source-dev-admitted-containment-'));
      tempDirs.push(tempDir);
      const cliProjectPath = join(tempDir, 'snapshot', 'apps', 'cli');
      await writeAdmittedSourceSnapshotFixture({
        cliProjectPath,
        workspaceName: 'plugins-opencode',
      });
      const admissionPath = join(cliProjectPath, '.cli-source-snapshot-admission.json');
      const admission = JSON.parse(await readFile(admissionPath, 'utf8')) as {
        packages: Record<string, {
          dependencies: string[];
          outputs: Array<{ path: string }>;
        }>;
      };
      const packageAdmission = admission.packages['plugins-opencode'];
      if (!packageAdmission) throw new Error('missing fixture package admission');
      if (field === 'dependency') {
        packageAdmission.dependencies = [unsafeValue];
        admission.packages[unsafeValue] = packageAdmission;
      } else if (field === 'package') {
        admission.packages[unsafeValue] = packageAdmission;
      } else {
        const output = packageAdmission.outputs[0];
        if (!output) throw new Error('missing fixture output admission');
        output.path = unsafeValue;
      }
      await writeFile(admissionPath, JSON.stringify(admission), 'utf8');

      const result = await prepareSourceDevSharedDepsForHappyCliSpawn({
        args: ['opencode'],
        cliProjectPath,
        resolveInvocation: () => ({
          runtime: 'node',
          argv: [join(cliProjectPath, 'src', 'index.ts'), 'opencode'],
        }),
        workspaceNames: ['plugins-opencode'],
      });

      expect(result.type).toBe('error');
    },
  );
});

describe('prepareSourceDevSharedDepsForBundledPluginRuntimeLoad', () => {
  it('leaves a bundled plugin load without an admitted copy to its source loader', async () => {
    const result = await prepareSourceDevSharedDepsForBundledPluginRuntimeLoad({
      packageName: '@happier-dev/plugins-scm-git',
      cliProjectPath: '/repo/apps/cli',
    });

    expect(result).toEqual({
      type: 'ready',
      checked: false,
      reason: 'not-source-dev',
    });
  });

  it('uses the admitted local copy for bundled plugin runtime loads', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-source-dev-admitted-plugin-'));
    tempDirs.push(tempDir);
    const cliProjectPath = join(tempDir, 'snapshot', 'apps', 'cli');
    await writeAdmittedSourceSnapshotFixture({
      cliProjectPath,
      workspaceName: 'plugins-opencode',
    });

    const result = await prepareSourceDevSharedDepsForBundledPluginRuntimeLoad({
      packageName: '@happier-dev/plugins-opencode',
      cliProjectPath,
    });

    expect(result).toEqual({
      type: 'ready',
      checked: true,
      reason: 'admitted-copy',
    });
  });

  it('rejects a corrupt admitted local copy before a bundled plugin load', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-source-dev-corrupt-admitted-plugin-'));
    tempDirs.push(tempDir);
    const cliProjectPath = join(tempDir, 'snapshot', 'apps', 'cli');
    const { outputPath } = await writeAdmittedSourceSnapshotFixture({
      cliProjectPath,
      workspaceName: 'plugins-opencode',
    });
    await writeFile(outputPath, 'export const admitted = false;\n', 'utf8');

    const result = await prepareSourceDevSharedDepsForBundledPluginRuntimeLoad({
      packageName: '@happier-dev/plugins-opencode',
      cliProjectPath,
    });

    expect(result.type).toBe('error');
    if (result.type !== 'error') throw new Error('expected preflight error');
    expect(result.errorMessage).toContain('admitted source snapshot');
  });

});
