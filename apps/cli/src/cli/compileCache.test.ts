import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const cliRoot = fileURLToPath(new URL('../..', import.meta.url));
const owner = new URL('./compileCache.ts', import.meta.url).href;

type CompileCacheRun = Readonly<{ dir: string | null; mode: number | null; stderr: string }>;

// Runs the owner in a fresh Node process: the compile cache is per process and cannot be undone.
function runCompileCacheOwner(
  args: readonly string[],
  prepare: (paths: { temp: string; home: string; env: NodeJS.ProcessEnv }) => void = () => {},
): CompileCacheRun {
  const code = `const { enableCliCompileCache } = await import(${JSON.stringify(owner)});
    enableCliCompileCache();
    const { getCompileCacheDir } = await import('node:module');
    const { statSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    const directory = getCompileCacheDir();
    console.log(JSON.stringify({ dir: directory ?? null, mode: directory ? statSync(dirname(directory)).mode & 0o777 : null }));`;
  // Node's default cache directory lives under the OS temp directory; a private one keeps the
  // result independent of whatever another user left in the shared one.
  const temp = mkdtempSync(join(tmpdir(), 'happier-compile-cache-test-'));
  const home = join(temp, 'happier-home');
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: temp, TEMP: temp, TMP: temp, HAPPIER_HOME_DIR: home };
  delete env.NODE_COMPILE_CACHE;
  delete env.NODE_DISABLE_COMPILE_CACHE;
  delete env.HAPPIER_STACK_QA_CLI_COMPILE_CACHE_DIR;
  try {
    prepare({ temp, home, env });
    const child = spawnSync(process.execPath, ['--no-warnings', '--import', 'tsx', '--input-type=module', '-e', code, '--', ...args], {
      cwd: cliRoot, env, encoding: 'utf8',
    });
    expect(child.status).toBe(0);
    return { ...JSON.parse(child.stdout.trim().split('\n').pop()!), stderr: child.stderr };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function readCompileCacheDirAfter(args: readonly string[]): string | null {
  return runCompileCacheOwner(args).dir;
}

describe('CLI compile cache', () => {
  it('reuses V8 code for short-lived commands on Node', () => {
    expect(readCompileCacheDirAfter(['daemon', 'status'])).toEqual(expect.any(String));
  });

  // A shared OS-temp cache directory created by another user (root-owned /tmp/node-compile-cache on
  // the controller) made Node's default silently fail for every process. The cache is per user.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'keeps the cache in the per-user Happier home even when the shared temp cache is unusable', () => {
      const run = runCompileCacheOwner(['daemon', 'status'], ({ temp }) => {
        mkdirSync(join(temp, 'node-compile-cache'));
        chmodSync(join(temp, 'node-compile-cache'), 0o500);
      });
      expect(run.dir).toMatch(/happier-home[\\/]cache[\\/]node-compile-cache/);
    });

  it('reports an unusable cache directory instead of swallowing it', () => {
    const run = runCompileCacheOwner(['daemon', 'start-sync'], ({ home }) => {
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, 'cache'), 'not a directory');
    });
    expect(run.dir).toBeNull();
    expect(run.stderr).toContain('HAPPIER_COMPILE_CACHE_UNAVAILABLE');
  });

  it.skipIf(process.platform === 'win32')('uses the identity cache when the shared directory is not private', () => {
    const run = runCompileCacheOwner(['daemon', 'status'], ({ temp, env }) => {
      const directory = join(temp, 'shared');
      mkdirSync(directory);
      chmodSync(directory, 0o755);
      env.HAPPIER_STACK_QA_CLI_COMPILE_CACHE_DIR = directory;
    });
    expect(run.dir).toMatch(/happier-home[\\/]cache[\\/]node-compile-cache/);
    expect(run.stderr).toContain('HAPPIER_COMPILE_CACHE_UNAVAILABLE');
  });

  it.each([
    ['daemon', 'start-sync'],
    ['daemon', 'background-service-worker'],
    ['codex', '--started-by', 'daemon'],
    ['session-host'],
  ])('uses the private identity cache by default (%s)', (...args) => {
    const run = runCompileCacheOwner(args);
    expect(run.dir).toMatch(/happier-home[\\/]cache[\\/]node-compile-cache/);
    if (process.platform !== 'win32') expect(run.mode).toBe(0o700);
  });

  it('keeps the Node cache override and opt-out for daemon startup', () => {
    const args = ['daemon', 'start-sync'];
    const override = ({ temp, env }: { temp: string; env: NodeJS.ProcessEnv }) => {
      env.NODE_COMPILE_CACHE = join(temp, 'operator-cache');
    };
    expect(runCompileCacheOwner(args, override).dir).toMatch(/operator-cache/);
    const disabled = runCompileCacheOwner(args, (paths) => {
      override(paths);
      paths.env.NODE_DISABLE_COMPILE_CACHE = '1';
    });
    expect(disabled.dir).toBeNull();
    expect(disabled.stderr).not.toContain('HAPPIER_COMPILE_CACHE_UNAVAILABLE');
  });
});
