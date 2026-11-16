import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const cliRoot = fileURLToPath(new URL('../..', import.meta.url));
const owner = new URL('./compileCache.ts', import.meta.url).href;

type CompileCacheRun = Readonly<{ dir: string | null; stderr: string }>;

// Runs the owner in a fresh Node process: the compile cache is per process and cannot be undone.
function runCompileCacheOwner(args: readonly string[], prepare: (paths: { temp: string; home: string }) => void = () => {}): CompileCacheRun {
  const code = `const { enableShortLivedCliCompileCache } = await import(${JSON.stringify(owner)});
    enableShortLivedCliCompileCache(${JSON.stringify(args)});
    const { getCompileCacheDir } = await import('node:module');
    console.log(JSON.stringify(getCompileCacheDir() ?? null));`;
  // Node's default cache directory lives under the OS temp directory; a private one keeps the
  // result independent of whatever another user left in the shared one.
  const temp = mkdtempSync(join(tmpdir(), 'happier-compile-cache-test-'));
  const home = join(temp, 'happier-home');
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: temp, TEMP: temp, TMP: temp, HAPPIER_HOME_DIR: home };
  delete env.NODE_COMPILE_CACHE;
  delete env.NODE_DISABLE_COMPILE_CACHE;
  try {
    prepare({ temp, home });
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
      cwd: cliRoot, env, encoding: 'utf8',
    });
    expect(child.status).toBe(0);
    return { dir: JSON.parse(child.stdout.trim().split('\n').pop()!), stderr: child.stderr };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function readCompileCacheDirAfter(args: readonly string[]): string | null {
  return runCompileCacheOwner(args).dir;
}

describe('CLI compile cache', () => {
  // Measured on Node 24 (`happier daemon status`, bundled graph, n=4): user CPU 4.24–4.57 → 3.24–3.55 s,
  // peak RSS +15 MiB. Daemon-hosted roles gain no start CPU and keep ~25–30 MiB more resident.
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
    const run = runCompileCacheOwner(['daemon', 'status'], ({ home }) => {
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, 'cache'), 'not a directory');
    });
    expect(run.dir).toBeNull();
    expect(run.stderr).toContain('HAPPIER_COMPILE_CACHE_UNAVAILABLE');
  });

  it.each([
    ['daemon', 'start-sync'],
    ['daemon', 'background-service-worker'],
    ['codex', '--started-by', 'daemon'],
  ])('leaves daemon-hosted long-lived roles uncached (%s %s)', (...args) => {
    expect(readCompileCacheDirAfter(args)).toBeNull();
  });
});
