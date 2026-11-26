import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { expect, it } from 'vitest';

import { repoRootDir } from '../paths';
import { startTestDaemon } from '../daemon/daemon';
import { resolveCliTestLaunchSpec } from './cliLaunchSpec';
import { withWorkspaceSourceRuntime } from './tsxImportHook';

it.each(['inherited', 'installed'] as const)('runs the workspace source CLI with the %s source loader without a dist snapshot prerequisite', async (loader) => {
  const testDir = await mkdtemp(join(tmpdir(), 'happier-cli-workspace-source-'));
  const rootDir = repoRootDir();
  const snapshotDir = join(testDir, 'unused-snapshot');
  const sourceEnv = {
    ...process.env,
    NODE_OPTIONS: '',
    HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
  };
  const env = loader === 'inherited' ? withWorkspaceSourceRuntime(sourceEnv) : sourceEnv;
  try {
    const spec = await resolveCliTestLaunchSpec({ testDir, env }, { snapshotDir });
    expect(spec.args.at(-1)).toBe(resolve(rootDir, 'apps/cli/src/index.ts'));
    expect(existsSync(snapshotDir)).toBe(false);
    const result = await new Promise<{ code: number | null; output: string }>((resolveResult, reject) => {
      const child = spawn(spec.command, [...spec.args, '--version'], {
        cwd: spec.cwd, env: { ...process.env, NODE_OPTIONS: undefined, ...spec.env }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
      child.stderr.on('data', (data: Buffer) => { output += data.toString(); });
      child.once('error', reject);
      child.once('close', (code) => resolveResult({ code, output }));
    });
    expect(result.code, result.output).toBe(0);
    expect(result.output.trim()).not.toBe('');
  } finally {
    await rm(testDir, { recursive: true, force: true });
  }
});

it('prepares a source daemon without copying workspace dependencies into a snapshot', async () => {
  const testDir = await mkdtemp(join(tmpdir(), 'happier-daemon-workspace-source-'));
  const snapshotDir = join(testDir, 'unused-snapshot');
  const boundaryReached = new Error('Reached the native daemon spawn boundary');
  let reachedSpawnBoundary = false;
  try {
    const error: unknown = await startTestDaemon({
      testDir,
      happyHomeDir: join(testDir, 'home'),
      snapshotDir,
      env: {
        ...process.env,
        NODE_OPTIONS: '',
        HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
        HAPPIER_E2E_CLI_SNAPSHOT_NODE_MODULES_MODE: undefined,
        HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
      },
      // The launch owner, environment isolation and startup lifecycle are real;
      // stop at the existing OS boundary before creating a persistent daemon.
      __beforeSpawn: async () => { reachedSpawnBoundary = true; throw boundaryReached; },
    }).then(() => undefined, (error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(reachedSpawnBoundary, error instanceof Error ? error.message : String(error)).toBe(true);
    expect(existsSync(snapshotDir)).toBe(false);
  } finally {
    await rm(testDir, { recursive: true, force: true });
  }
});
