import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ensureCliDistBuilt, ensureCliSharedDepsBuilt, resolveCliDistBuildInvocation, withCliDistBuildLock } from '../../src/testkit/process/cliDist';
import { sleep } from '../../src/testkit/timing';

describe('providers: CLI dist build invocation', () => {
  it('prefers local pkgroll binary over yarn workspace build', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'happier-cli-dist-cmd-'));
    const pkgrollBin = resolve(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'pkgroll.cmd' : 'pkgroll');
    mkdirSync(dirname(pkgrollBin), { recursive: true });
    writeFileSync(pkgrollBin, '#!/bin/sh\n', 'utf8');

    const invocation = resolveCliDistBuildInvocation({ repoRoot });
    expect(invocation.command).toBe(pkgrollBin);
    expect(invocation.args).toEqual([]);
    expect(invocation.cwd).toBe(resolve(repoRoot, 'apps', 'cli'));
  });

  it('falls back to npx pkgroll when local binary is missing', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'happier-cli-dist-cmd-'));
    const invocation = resolveCliDistBuildInvocation({ repoRoot });

    expect(invocation.command).toBe('npx');
    expect(invocation.args).toEqual(['pkgroll']);
    expect(invocation.cwd).toBe(resolve(repoRoot, 'apps', 'cli'));
  });
});

describe('providers: shared deps build lock', () => {
  it('runs shared deps build once for concurrent callers', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'happier-cli-shared-deps-'));
    const testDir = resolve(repoRoot, 'logs');
    mkdirSync(testDir, { recursive: true });
    const lockPath = resolve(repoRoot, 'cli-shared-deps.lock');

    let buildCalls = 0;
    const outputs = [
      resolve(repoRoot, 'packages', 'agents', 'dist', 'index.js'),
      resolve(repoRoot, 'packages', 'cli-common', 'dist', 'index.js'),
      resolve(repoRoot, 'packages', 'protocol', 'dist', 'index.js'),
    ];

    const runCommand = async () => {
      buildCalls += 1;
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      for (const output of outputs) {
        mkdirSync(dirname(output), { recursive: true });
        writeFileSync(output, 'export {};\n', 'utf8');
      }
    };

    await Promise.all([
      ensureCliSharedDepsBuilt(
        { testDir, env: {} },
        { repoRoot, lockPath, runCommand },
      ),
      ensureCliSharedDepsBuilt(
        { testDir, env: {} },
        { repoRoot, lockPath, runCommand },
      ),
    ]);

    expect(buildCalls).toBe(1);
  });
});

describe('providers: CLI dist build lock discipline', () => {
  it('waits for build lock even when dist entrypoint already exists', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'happier-cli-dist-lock-wait-'));
    const lockPath = resolve(repoRoot, '.project', 'tmp', 'cli-dist-build.lock');
    const testDir = resolve(repoRoot, 'logs');
    const entrypoint = resolve(repoRoot, 'apps', 'cli', 'dist', 'index.mjs');

    mkdirSync(dirname(entrypoint), { recursive: true });
    writeFileSync(entrypoint, 'export {};\n', 'utf8');
    mkdirSync(testDir, { recursive: true });

    const holdLock = withCliDistBuildLock(
      async () => {
        await sleep(150);
        return 'held';
      },
      { lockPath, timeoutMs: 5_000, pollIntervalMs: 20 },
    );

    // Let the lock holder acquire first.
    await sleep(20);

    const startedAt = Date.now();
    const resolved = await ensureCliDistBuilt(
      { testDir, env: {} },
      { repoRoot, lockPath },
    );
    const elapsedMs = Date.now() - startedAt;
    await holdLock;

    expect(resolved).toBe(entrypoint);
    expect(elapsedMs).toBeGreaterThanOrEqual(100);
  });

  it('fails without rebuilding when rebuilds are disabled and dist remains invalid', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'happier-cli-dist-no-rebuild-'));
    const lockPath = resolve(repoRoot, '.project', 'tmp', 'cli-dist-build.lock');
    const testDir = resolve(repoRoot, 'logs');
    const distDir = resolve(repoRoot, 'apps', 'cli', 'dist');
    const entrypoint = resolve(distDir, 'index.mjs');
    const apiChunk = resolve(distDir, 'api-abc.mjs');

    mkdirSync(distDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
    writeFileSync(entrypoint, 'export {};\n', 'utf8');
    writeFileSync(apiChunk, "export const x = () => import('./capability-missing.mjs');\n", 'utf8');

    let buildCalls = 0;
    await expect(
      ensureCliDistBuilt(
        { testDir, env: {} },
        {
          repoRoot,
          lockPath,
          allowRebuild: false,
          waitForAvailabilityMs: 1,
          runCommand: async () => {
            buildCalls += 1;
          },
        },
      ),
    ).rejects.toThrow(/missing chunk imports/i);

    expect(buildCalls).toBe(0);
  });

  it('waits for dist entrypoint to reappear when rebuilds are disabled', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'happier-cli-dist-no-rebuild-wait-'));
    const lockPath = resolve(repoRoot, '.project', 'tmp', 'cli-dist-build.lock');
    const testDir = resolve(repoRoot, 'logs');
    const distDir = resolve(repoRoot, 'apps', 'cli', 'dist');
    const entrypoint = resolve(distDir, 'index.mjs');

    mkdirSync(distDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });

    let buildCalls = 0;
    setTimeout(() => {
      writeFileSync(entrypoint, 'export {};\n', 'utf8');
    }, 60);

    const resolved = await ensureCliDistBuilt(
      { testDir, env: {} },
      {
        repoRoot,
        lockPath,
        allowRebuild: false,
        waitForAvailabilityMs: 2_000,
        runCommand: async () => {
          buildCalls += 1;
        },
      },
    );

    expect(resolved).toBe(entrypoint);
    expect(buildCalls).toBe(0);
  });

  it('retries dist build when entrypoint is transiently missing after first build attempt', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'happier-cli-dist-retry-'));
    const lockPath = resolve(repoRoot, '.project', 'tmp', 'cli-dist-build.lock');
    const testDir = resolve(repoRoot, 'logs');
    const distDir = resolve(repoRoot, 'apps', 'cli', 'dist');
    const entrypoint = resolve(distDir, 'index.mjs');

    mkdirSync(distDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });

    let buildCalls = 0;
    const resolved = await ensureCliDistBuilt(
      { testDir, env: {} },
      {
        repoRoot,
        lockPath,
        runCommand: async () => {
          buildCalls += 1;
          if (buildCalls < 2) {
            return;
          }
          writeFileSync(entrypoint, 'export {};\n', 'utf8');
        },
      },
    );

    expect(resolved).toBe(entrypoint);
    expect(buildCalls).toBe(2);
  });
});
