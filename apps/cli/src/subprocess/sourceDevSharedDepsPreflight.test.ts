import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HappyCliSubprocessInvocation } from '@/utils/spawnHappyCLI';

import {
  prepareSourceDevSharedDepsForBundledPluginRuntimeLoad,
  prepareSourceDevSharedDepsForHappyCliSpawn,
} from './sourceDevSharedDepsPreflight';

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
  it('skips shared-deps sync for non-source child launches', async () => {
    const runSyncProcess = vi.fn();

    const result = await prepareSourceDevSharedDepsForHappyCliSpawn({
      args: ['opencode'],
      resolveInvocation: () => ({
        runtime: 'node',
        argv: ['--no-warnings', '/repo/apps/cli/dist/index.mjs', 'opencode'],
      }),
      runSyncProcess,
    });

    expect(result).toEqual({
      type: 'ready',
      checked: false,
      reason: 'not-source-entrypoint',
    });
    expect(runSyncProcess).not.toHaveBeenCalled();
  });

  it('checks source-dev shared-deps read-only before source child launches', async () => {
    const runSyncProcess = vi.fn(async () => undefined);

    const result = await prepareSourceDevSharedDepsForHappyCliSpawn({
      args: ['opencode'],
      cliProjectPath: '/repo/apps/cli',
      existsSync: () => true,
      resolveInvocation: () => ({
        runtime: 'node',
        argv: ['--import', '/repo/node_modules/tsx/dist/esm/index.mjs', '/repo/apps/cli/src/index.ts', 'opencode'],
      }),
      runSyncProcess,
    });

    expect(result).toEqual({
      type: 'ready',
      checked: true,
      reason: 'current',
    });
    expect(runSyncProcess).toHaveBeenCalledWith({
      scriptPath: '/repo/apps/cli/scripts/syncSharedDepsForDev.mjs',
      checkOnly: true,
      timeoutMs: 300_000,
      lockTimeoutMs: 240_000,
      workspaceBuildTimeoutMs: 60_000,
      progressIntervalMs: 15_000,
      processEnv: process.env,
      onProgress: expect.any(Function),
    });
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
    const runSyncProcess = vi.fn(async () => undefined);

    const result = await prepareSourceDevSharedDepsForHappyCliSpawn({
      args: ['opencode'],
      cliProjectPath,
      resolveInvocation: () => ({
        runtime: 'node',
        argv: [join(cliProjectPath, 'src', 'index.ts'), 'opencode'],
      }),
      workspaceNames: ['plugins-opencode'],
      runSyncProcess,
    });

    expect(result).toEqual({
      type: 'ready',
      checked: true,
      reason: 'admitted-copy',
    });
    expect(runSyncProcess).not.toHaveBeenCalled();
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
      const runSyncProcess = vi.fn(async () => undefined);

      const result = await prepareSourceDevSharedDepsForHappyCliSpawn({
        args: ['opencode'],
        cliProjectPath,
        resolveInvocation: () => ({
          runtime: 'node',
          argv: [join(cliProjectPath, 'src', 'index.ts'), 'opencode'],
        }),
        workspaceNames: ['plugins-opencode'],
        runSyncProcess,
      });

      expect(result.type).toBe('error');
      if (result.type !== 'error') throw new Error('expected preflight error');
      expect(result.errorMessage).toContain('admitted source snapshot');
      expect(result.errorMessage).toContain('plugins-opencode');
      expect(runSyncProcess).not.toHaveBeenCalled();
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
    const runSyncProcess = vi.fn(async () => undefined);

    const result = await prepareSourceDevSharedDepsForHappyCliSpawn({
      args: ['opencode'],
      cliProjectPath,
      resolveInvocation: () => ({
        runtime: 'node',
        argv: [join(cliProjectPath, 'src', 'index.ts'), 'opencode'],
      }),
      workspaceNames: ['plugins-opencode'],
      runSyncProcess,
    });

    expect(result.type).toBe('error');
    if (result.type !== 'error') throw new Error('expected preflight error');
    expect(result.errorMessage).toContain('protocol');
    expect(runSyncProcess).not.toHaveBeenCalled();
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
      const runSyncProcess = vi.fn(async () => undefined);

      const result = await prepareSourceDevSharedDepsForHappyCliSpawn({
        args: ['opencode'],
        cliProjectPath,
        resolveInvocation: () => ({
          runtime: 'node',
          argv: [join(cliProjectPath, 'src', 'index.ts'), 'opencode'],
        }),
        workspaceNames: ['plugins-opencode'],
        runSyncProcess,
      });

      expect(result.type).toBe('error');
      expect(runSyncProcess).not.toHaveBeenCalled();
    },
  );

  it('passes targeted workspace names through for source child launches', async () => {
    const runSyncProcess = vi.fn(async () => undefined);

    const result = await prepareSourceDevSharedDepsForHappyCliSpawn({
      args: ['opencode'],
      cliProjectPath: '/repo/apps/cli',
      existsSync: () => true,
      resolveInvocation: () => ({
        runtime: 'node',
        argv: ['--import', '/repo/node_modules/tsx/dist/esm/index.mjs', '/repo/apps/cli/src/index.ts', 'opencode'],
      }),
      runSyncProcess,
      workspaceNames: ['plugins-opencode'],
    });

    expect(result).toEqual({
      type: 'ready',
      checked: true,
      reason: 'current',
    });
    expect(runSyncProcess).toHaveBeenCalledWith(expect.objectContaining({
      workspaceNames: ['plugins-opencode'],
    }));
  });

  it('logs bounded progress diagnostics while source-dev shared-deps sync is pending', async () => {
    vi.useFakeTimers();

    let releaseSyncProcess!: () => void;
    const logDebug = vi.fn();
    const runSyncProcess = vi.fn(async (input: {
      onProgress?: (progress: {
        stage: string;
        event?: string;
        workspaceName?: string;
        detail?: string;
      }) => void;
    }) => {
      input.onProgress?.({
        stage: 'workspace-build',
        event: 'start',
        workspaceName: 'plugins-copilot',
        detail: 'Compiling source-dev workspace dist',
      });
      await new Promise<void>((resolve) => {
        releaseSyncProcess = resolve;
      });
    });

    const resultPromise = prepareSourceDevSharedDepsForHappyCliSpawn({
      args: ['opencode'],
      cliProjectPath: '/repo/apps/cli',
      existsSync: () => true,
      resolveInvocation: () => ({
        runtime: 'node',
        argv: ['/repo/apps/cli/src/index.ts', 'opencode'],
      }),
      runSyncProcess,
      logDebug,
      progressIntervalMs: 1_000,
    });

    await Promise.resolve();
    expect(runSyncProcess).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);

    expect(logDebug).toHaveBeenCalledWith(
      '[DAEMON RUN] Source-dev CLI shared deps preflight progress',
      expect.objectContaining({
        stage: 'workspace-build',
        event: 'start',
        workspaceName: 'plugins-copilot',
      }),
    );
    expect(logDebug).toHaveBeenCalledWith(
      '[DAEMON RUN] Source-dev CLI shared deps preflight still running',
      expect.objectContaining({
        elapsedMs: expect.any(Number),
        timeoutMs: 300_000,
        lastProgress: expect.objectContaining({
          stage: 'workspace-build',
          workspaceName: 'plugins-copilot',
        }),
      }),
    );

    releaseSyncProcess();
    await expect(resultPromise).resolves.toEqual({
      type: 'ready',
      checked: true,
      reason: 'current',
    });
  });

  it('adds last helper progress to source-dev shared-deps sync failures', async () => {
    const sourceInvocation: HappyCliSubprocessInvocation = {
      runtime: 'node',
      argv: ['/repo/apps/cli/src/index.ts', 'opencode'],
    };

    const result = await prepareSourceDevSharedDepsForHappyCliSpawn({
      args: ['opencode'],
      cliProjectPath: '/repo/apps/cli',
      existsSync: () => true,
      resolveInvocation: () => sourceInvocation,
      runSyncProcess: async (input: {
        onProgress?: (progress: {
          stage: string;
          event?: string;
          workspaceName?: string;
        }) => void;
      }) => {
        input.onProgress?.({
          stage: 'workspace-build',
          event: 'start',
          workspaceName: 'plugins-copilot',
        });
        throw new Error('timed out after 50ms');
      },
    });

    expect(result.type).toBe('error');
    if (result.type !== 'error') throw new Error('expected preflight error');
    expect(result.errorMessage).toContain('timed out after 50ms');
    expect(result.errorMessage).toContain('last progress: workspace-build start plugins-copilot');
  });

  it('times out with the last helper stage when the child never completes', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-source-dev-preflight-stage-timeout-'));
    tempDirs.push(tempDir);

    const cliProjectPath = join(tempDir, 'apps', 'cli');
    const scriptsDir = join(cliProjectPath, 'scripts');
    await mkdir(scriptsDir, { recursive: true });
    await writeFile(
      join(scriptsDir, 'syncSharedDepsForDev.mjs'),
      [
        "import { writeSync } from 'node:fs';",
        "writeSync(2, '[happier-source-dev-shared-deps-progress] {\"stage\":\"workspace-build\",\"event\":\"start\",\"workspaceName\":\"plugins-copilot\"}\\n');",
        'setInterval(() => undefined, 1_000);',
      ].join('\n'),
      'utf8',
    );

    const result = await prepareSourceDevSharedDepsForHappyCliSpawn({
      args: ['opencode'],
      cliProjectPath,
      resolveInvocation: () => ({
        runtime: 'node',
        argv: [join(cliProjectPath, 'src', 'index.ts'), 'opencode'],
      }),
      timeoutMs: 1_000,
      progressIntervalMs: 0,
    });

    expect(result.type).toBe('error');
    if (result.type !== 'error') throw new Error('expected preflight error');
    expect(result.errorMessage).toContain('timed out after 1000ms');
    expect(result.errorMessage).toContain('last progress: workspace-build start plugins-copilot');
  });

  it('lets a silent synchronous projection stage run until the hard process timeout', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-source-dev-preflight-synchronous-stage-'));
    tempDirs.push(tempDir);

    const cliProjectPath = join(tempDir, 'apps', 'cli');
    const scriptsDir = join(cliProjectPath, 'scripts');
    await mkdir(scriptsDir, { recursive: true });
    await writeFile(
      join(scriptsDir, 'syncSharedDepsForDev.mjs'),
      [
        "import { writeSync } from 'node:fs';",
        "writeSync(2, '[happier-source-dev-shared-deps-progress] {\"stage\":\"bundled-dist-sync\",\"event\":\"start\"}\\n');",
        "setTimeout(() => { writeSync(2, '[happier-source-dev-shared-deps-progress] {\"stage\":\"bundled-dist-sync\",\"event\":\"done\"}\\n'); process.exit(0); }, 1_600);",
      ].join('\n'),
      'utf8',
    );

    const result = await prepareSourceDevSharedDepsForHappyCliSpawn({
      args: ['opencode'],
      cliProjectPath,
      resolveInvocation: () => ({
        runtime: 'node',
        argv: [join(cliProjectPath, 'src', 'index.ts'), 'opencode'],
      }),
      timeoutMs: 10_000,
      progressIntervalMs: 0,
    });

    expect(result).toEqual({ type: 'ready', checked: true, reason: 'current' });
  });

  it('lets workspace-lock waits fail with the helper lock diagnostic before the hard process timeout', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-source-dev-preflight-lock-timeout-'));
    tempDirs.push(tempDir);

    const cliProjectPath = join(tempDir, 'apps', 'cli');
    const scriptsDir = join(cliProjectPath, 'scripts');
    await mkdir(scriptsDir, { recursive: true });
    await writeFile(
      join(scriptsDir, 'syncSharedDepsForDev.mjs'),
      [
        "import { writeSync } from 'node:fs';",
        "writeSync(2, '[happier-source-dev-shared-deps-progress] {\"stage\":\"workspace-lock\",\"event\":\"waiting\",\"lockTimeoutMs\":500}\\n');",
        "setTimeout(() => { console.error('Timed out waiting for workspace bundle lock: /tmp/lock (pid=1234, createdAtMs=5678)'); process.exit(1); }, 750);",
      ].join('\n'),
      'utf8',
    );

    const result = await prepareSourceDevSharedDepsForHappyCliSpawn({
      args: ['opencode'],
      cliProjectPath,
      resolveInvocation: () => ({
        runtime: 'node',
        argv: [join(cliProjectPath, 'src', 'index.ts'), 'opencode'],
      }),
      timeoutMs: 10_000,
      lockTimeoutMs: 500,
      progressIntervalMs: 0,
    });

    expect(result.type).toBe('error');
    if (result.type !== 'error') throw new Error('expected preflight error');
    expect(result.errorMessage).toContain('Timed out waiting for workspace bundle lock');
    expect(result.errorMessage).toContain('pid=1234');
  });

  it('keeps the daemon event loop responsive while source-dev shared-deps sync is pending', async () => {
    let releaseSyncProcess!: () => void;
    const runSyncProcess = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        releaseSyncProcess = resolve;
      });
    });

    type OptionsWithRunner = Parameters<typeof prepareSourceDevSharedDepsForHappyCliSpawn>[0] & {
      runSyncProcess: typeof runSyncProcess;
    };

    const resultPromise = prepareSourceDevSharedDepsForHappyCliSpawn({
      args: ['opencode'],
      cliProjectPath: '/repo/apps/cli',
      existsSync: () => true,
      resolveInvocation: () => ({
        runtime: 'node',
        argv: ['/repo/apps/cli/src/index.ts', 'opencode'],
      }),
      runSyncProcess,
    } satisfies OptionsWithRunner);

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(runSyncProcess).toHaveBeenCalledTimes(1);

    releaseSyncProcess();
    await expect(resultPromise).resolves.toEqual({
      type: 'ready',
      checked: true,
      reason: 'current',
    });
  });

  it('returns an explicit diagnostic when source child shared-deps sync fails', async () => {
    const sourceInvocation: HappyCliSubprocessInvocation = {
      runtime: 'node',
      argv: ['/repo/apps/cli/src/index.ts', 'opencode'],
    };

    const result = await prepareSourceDevSharedDepsForHappyCliSpawn({
      args: ['opencode'],
      cliProjectPath: '/repo/apps/cli',
      existsSync: () => true,
      resolveInvocation: () => sourceInvocation,
      runSyncProcess: async () => {
        throw new Error('workspace dist is stale');
      },
    });

    expect(result.type).toBe('error');
    if (result.type !== 'error') throw new Error('expected preflight error');
    expect(result.errorMessage).toContain('Source-dev CLI shared dependency admission failed before spawn');
    expect(result.errorMessage).toContain('workspace dist is stale');
  });
});

describe('prepareSourceDevSharedDepsForBundledPluginRuntimeLoad', () => {
  it('skips shared-deps sync during test processes', async () => {
    const runSyncProcess = vi.fn();

    const result = await prepareSourceDevSharedDepsForBundledPluginRuntimeLoad({
      packageName: '@happier-dev/plugins-scm-git',
      cliProjectPath: '/repo/apps/cli',
      existsSync: () => true,
      runSyncProcess,
      processEnv: { VITEST: 'true' },
    });

    expect(result).toEqual({
      type: 'ready',
      checked: false,
      reason: 'not-source-dev',
    });
    expect(runSyncProcess).not.toHaveBeenCalled();
  });

  it('keeps a flat-copy admission-only probe from falling through to the live helper', async () => {
    const runSyncProcess = vi.fn();

    const result = await prepareSourceDevSharedDepsForBundledPluginRuntimeLoad({
      packageName: '@happier-dev/plugins-scm-git',
      admittedCopyOnly: true,
      cliProjectPath: '/repo/apps/cli',
      existsSync: () => true,
      runSyncProcess,
      processEnv: {},
    });

    expect(result).toEqual({
      type: 'ready',
      checked: false,
      reason: 'not-source-dev',
    });
    expect(runSyncProcess).not.toHaveBeenCalled();
  });

  it('uses the admitted local copy before the test-process shortcut for bundled plugin runtime loads', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-source-dev-admitted-plugin-'));
    tempDirs.push(tempDir);
    const cliProjectPath = join(tempDir, 'snapshot', 'apps', 'cli');
    await writeAdmittedSourceSnapshotFixture({
      cliProjectPath,
      workspaceName: 'plugins-opencode',
    });
    const runSyncProcess = vi.fn(async () => undefined);

    const result = await prepareSourceDevSharedDepsForBundledPluginRuntimeLoad({
      packageName: '@happier-dev/plugins-opencode',
      cliProjectPath,
      processEnv: {
        VITEST: 'true',
        NODE_ENV: 'test',
      },
      runSyncProcess,
    });

    expect(result).toEqual({
      type: 'ready',
      checked: true,
      reason: 'admitted-copy',
    });
    expect(runSyncProcess).not.toHaveBeenCalled();
  });

  it('rejects a corrupt admitted local copy before the test-process shortcut', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-source-dev-corrupt-admitted-plugin-'));
    tempDirs.push(tempDir);
    const cliProjectPath = join(tempDir, 'snapshot', 'apps', 'cli');
    const { outputPath } = await writeAdmittedSourceSnapshotFixture({
      cliProjectPath,
      workspaceName: 'plugins-opencode',
    });
    await writeFile(outputPath, 'export const admitted = false;\n', 'utf8');
    const runSyncProcess = vi.fn(async () => undefined);

    const result = await prepareSourceDevSharedDepsForBundledPluginRuntimeLoad({
      packageName: '@happier-dev/plugins-opencode',
      cliProjectPath,
      processEnv: {
        VITEST: 'true',
        NODE_ENV: 'test',
      },
      runSyncProcess,
    });

    expect(result.type).toBe('error');
    if (result.type !== 'error') throw new Error('expected preflight error');
    expect(result.errorMessage).toContain('admitted source snapshot');
    expect(runSyncProcess).not.toHaveBeenCalled();
  });

  it('runs source-dev shared-deps sync out-of-process for bundled plugin runtime loads', async () => {
    const runSyncProcess = vi.fn(async () => undefined);

    const result = await prepareSourceDevSharedDepsForBundledPluginRuntimeLoad({
      packageName: '@happier-dev/plugins-scm-git',
      cliProjectPath: '/repo/apps/cli',
      existsSync: () => true,
      runSyncProcess,
      processEnv: {},
    });

    expect(result).toEqual({
      type: 'ready',
      checked: true,
      reason: 'synced',
    });
    expect(runSyncProcess).toHaveBeenCalledWith({
      scriptPath: '/repo/apps/cli/scripts/syncSharedDepsForDev.mjs',
      timeoutMs: 300_000,
      lockTimeoutMs: 240_000,
      workspaceBuildTimeoutMs: 60_000,
      progressIntervalMs: 15_000,
      workspaceNames: ['plugins-scm-git'],
      processEnv: {},
      onProgress: expect.any(Function),
    });
  });

  it('targets only the requested bundled plugin workspace for source-dev runtime loads', async () => {
    const runSyncProcess = vi.fn(async () => undefined);

    await prepareSourceDevSharedDepsForBundledPluginRuntimeLoad({
      packageName: '@happier-dev/plugins-opencode',
      cliProjectPath: '/repo/apps/cli',
      existsSync: () => true,
      runSyncProcess,
      processEnv: {},
    });

    expect(runSyncProcess).toHaveBeenCalledWith(expect.objectContaining({
      workspaceNames: ['plugins-opencode'],
    }));
  });
});
