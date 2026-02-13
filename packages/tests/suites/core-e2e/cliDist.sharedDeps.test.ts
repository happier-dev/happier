import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

type RunLoggedCommand = (params: {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdoutPath: string;
  stderrPath: string;
  timeoutMs?: number;
}) => Promise<void>;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe('core e2e: cli dist build', () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (!dir) return;
    await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('builds shared workspace deps before returning a usable CLI dist entrypoint', async () => {
    dir = await mkdtemp(join(tmpdir(), 'happier-cli-dist-'));
    const repoRoot = dir;

    const cliDistDir = resolve(repoRoot, 'apps', 'cli', 'dist');
    await mkdir(cliDistDir, { recursive: true });
    await writeFile(resolve(cliDistDir, 'index.mjs'), "export {};\n", 'utf8');

    const runCommand = vi.fn<RunLoggedCommand>(async () => {
      // Simulate build:shared producing dist outputs in the workspace packages.
      const outputs = [
        resolve(repoRoot, 'packages', 'agents', 'dist', 'index.js'),
        resolve(repoRoot, 'packages', 'cli-common', 'dist', 'index.js'),
        resolve(repoRoot, 'packages', 'protocol', 'dist', 'index.js'),
      ];
      for (const out of outputs) {
        await mkdir(resolve(out, '..'), { recursive: true });
        await writeFile(out, 'export {};\n', 'utf8');
      }
    });

    vi.resetModules();
    const { ensureCliDistBuilt } = await import('../../src/testkit/process/cliDist');

    const entrypoint = await ensureCliDistBuilt(
      { testDir: repoRoot, env: { ...process.env, CI: '1' } },
      {
        repoRoot,
        runCommand,
        lockPath: resolve(repoRoot, '.project', 'tmp', 'cli-dist-build.lock'),
      },
    );

    expect(entrypoint).toBe(resolve(cliDistDir, 'index.mjs'));
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(await exists(resolve(repoRoot, 'packages', 'protocol', 'dist', 'index.js'))).toBe(true);
  });
});
