import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { expect, it } from 'vitest';

import { repoRootDir } from '../paths';
import { resolveCliTestLaunchSpec } from './cliLaunchSpec';
import { withWorkspaceSourceRuntime } from './tsxImportHook';

it('runs the workspace source CLI through its installed source loader without a dist snapshot prerequisite', async () => {
  const testDir = await mkdtemp(join(tmpdir(), 'happier-cli-workspace-source-'));
  const rootDir = repoRootDir();
  const snapshotDir = join(testDir, 'unused-snapshot');
  const env = withWorkspaceSourceRuntime({
    ...process.env,
    HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
    HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
  });
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
