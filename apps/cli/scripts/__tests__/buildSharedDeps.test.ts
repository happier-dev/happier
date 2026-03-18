import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import {
  resolveTscBin,
  runTsc,
  syncBundledWorkspaceDist,
  syncCliRuntimeDependencies,
  withBuildSharedDepsLock,
} from '../buildSharedDeps.mjs';

describe('buildSharedDeps', () => {
  it('surfaces which tsconfig failed when compilation throws', () => {
    const execFileSync = vi.fn(() => {
      throw new Error('tsc failed');
    });

    expect(() => runTsc('/repo/packages/protocol/tsconfig.json', { execFileSync })).toThrow(
      /tsconfig\.json/i,
    );
  });

  it('invokes tsc.cmd via cmd.exe on Windows', () => {
    const execFileSync = vi.fn(() => undefined);

    runTsc('C:\\repo\\packages\\protocol\\tsconfig.json', {
      execFileSync,
      tscBin: 'C:\\repo\\node_modules\\.bin\\tsc.cmd',
      platform: 'win32',
    });

    expect(execFileSync).toHaveBeenCalled();
    const cmdCall = execFileSync.mock.calls[0] as unknown as [string, string[], { stdio: string }] | undefined;
    if (!cmdCall) throw new Error('expected execFileSync call');
    const [cmd, args, opts] = cmdCall;
    expect(cmd).toBe('cmd.exe');
    expect(args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(String(args[3])).toContain('tsc.cmd');
    expect(String(args[3])).toContain('-p');
    expect(opts).toHaveProperty('stdio', 'inherit');
  });

  it('prefers the workspace root tsc binary when present', () => {
    const bin = resolveTscBin({
      exists: (candidate: string) =>
        candidate.includes(`${sep}node_modules${sep}typescript${sep}bin${sep}`) &&
        !candidate.includes(`${sep}cli${sep}node_modules${sep}`),
    });

    expect(bin).toMatch(/node_modules/);
    expect(bin).not.toMatch(/cli[\\/]+node_modules/);
  });

  it('executes tsc via node to avoid .bin symlink ENOENT issues', () => {
    const execFileSync = vi.fn(() => undefined);

    runTsc('/repo/packages/protocol/tsconfig.json', {
      execFileSync,
      tscBin: '/repo/node_modules/typescript/bin/tsc',
      platform: 'darwin',
    });

    const nodeCall = execFileSync.mock.calls[0] as unknown as [string, string[]] | undefined;
    if (!nodeCall) throw new Error('expected execFileSync call');
    const [cmd, args] = nodeCall;
    expect(cmd).toBe(process.execPath);
    expect(args).toEqual(['/repo/node_modules/typescript/bin/tsc', '-p', '/repo/packages/protocol/tsconfig.json']);
  });

  it('syncs workspace dist outputs into bundled deps for local bundled hosts when present', () => {
    const cpSync = vi.fn(() => undefined);
    const rmSync = vi.fn(() => undefined);
    const existsSync = vi.fn((p: any) =>
      String(p).endsWith('/packages/protocol/package.json') ||
      String(p).endsWith('/packages/protocol/dist'),
    );
    const mkdirSync = vi.fn(() => undefined);

    syncBundledWorkspaceDist({
      repoRoot: '/repo',
      cpSync,
      existsSync,
      mkdirSync,
      rmSync,
      packages: ['protocol'],
    });

    expect(mkdirSync.mock.calls).toEqual([
      ['/repo/apps/cli/node_modules/@happier-dev/protocol', { recursive: true }],
      ['/repo/apps/cli/node_modules/@happier-dev/protocol', { recursive: true }],
    ]);
    expect(rmSync).toHaveBeenCalled();
    expect(cpSync).toHaveBeenCalledTimes(1);
    const copyCalls = cpSync.mock.calls as unknown[];
    expect(
      copyCalls.some((call) => {
        if (!Array.isArray(call) || call.length < 3) return false;
        const [from, to, options] = call as [unknown, unknown, { recursive?: boolean; force?: boolean }];
        return from === '/repo/packages/protocol/dist'
          && typeof to === 'string'
          && to.includes('/apps/cli/node_modules/@happier-dev/protocol/')
          && options.recursive === true
          && options.force === true;
      }),
    ).toBe(true);
    expect(copyCalls.some((call) => Array.isArray(call) && String(call[1]).includes('/apps/stack/'))).toBe(false);
  });

  it('syncs bundled workspace package.json exports for local bundled hosts', () => {
    const cpSync = vi.fn(() => undefined);
    const existsSync = vi.fn((p: any) =>
      String(p).endsWith('/packages/protocol/package.json') ||
      String(p).includes('/apps/cli/node_modules/@happier-dev/protocol/dist') ||
      String(p).includes('/apps/stack/node_modules/@happier-dev/protocol/dist'),
    );
    const readFileSync = vi.fn(() =>
      JSON.stringify({
        name: '@happier-dev/protocol',
        version: '0.0.0',
        type: 'module',
        exports: { '.': { default: './dist/index.js' }, './installables': { default: './dist/installables.js' } },
        dependencies: { zod: '1.0.0' },
      }),
    );
    const writeFileSync = vi.fn(() => undefined);
    const mkdirSync = vi.fn(() => undefined);

    syncBundledWorkspaceDist({
      repoRoot: '/repo',
      cpSync,
      existsSync,
      mkdirSync,
      readFileSync,
      writeFileSync,
      packages: ['protocol'],
    });

    expect(writeFileSync).toHaveBeenCalledTimes(1);
    const cliWriteCall = writeFileSync.mock.calls[0] as unknown as [string, string] | undefined;
    if (!cliWriteCall) throw new Error('expected cli package.json write');
    const [cliDestPath, cliPayload] = cliWriteCall;
    expect(cliDestPath).toBe('/repo/apps/cli/node_modules/@happier-dev/protocol/package.json');
    const cliParsed = JSON.parse(String(cliPayload));
    expect(cliParsed.exports?.['./installables']).toBeTruthy();
    expect(cliParsed.private).toBe(true);
  });

  it('includes release-runtime in the default bundled workspace sync set', () => {
    const cpSync = vi.fn(() => undefined);
    const existsSync = vi.fn((p: any) => {
      const text = String(p);
      return text.endsWith('/packages/release-runtime/package.json') || text.endsWith('/packages/release-runtime/dist');
    });
    const mkdirSync = vi.fn(() => undefined);
    const rmSync = vi.fn(() => undefined);

    syncBundledWorkspaceDist({
      repoRoot: '/repo',
      cpSync,
      existsSync,
      mkdirSync,
      rmSync,
    });

    const calls = cpSync.mock.calls as unknown[];
    expect(
      calls.some((call) => {
        if (!Array.isArray(call) || call.length < 3) return false;
        const [from, to, options] = call as [unknown, unknown, { recursive?: boolean; force?: boolean }];
        return from === '/repo/packages/release-runtime/dist'
          && typeof to === 'string'
          && to.includes('/apps/cli/node_modules/@happier-dev/release-runtime/')
          && options.recursive === true
          && options.force === true;
      }),
    ).toBe(true);
  });

  it('includes transfers in the default bundled workspace sync set', () => {
    const cpSync = vi.fn(() => undefined);
    const existsSync = vi.fn((p: any) => {
      const text = String(p);
      return text.endsWith('/packages/transfers/package.json') || text.endsWith('/packages/transfers/dist');
    });
    const mkdirSync = vi.fn(() => undefined);
    const rmSync = vi.fn(() => undefined);

    syncBundledWorkspaceDist({
      repoRoot: '/repo',
      cpSync,
      existsSync,
      mkdirSync,
      rmSync,
    });

    const calls = cpSync.mock.calls as unknown[];
    expect(
      calls.some((call) => {
        if (!Array.isArray(call) || call.length < 3) return false;
        const [from, to, options] = call as [unknown, unknown, { recursive?: boolean; force?: boolean }];
        return from === '/repo/packages/transfers/dist'
          && typeof to === 'string'
          && to.includes('/apps/cli/node_modules/@happier-dev/transfers/')
          && options.recursive === true
          && options.force === true;
      }),
    ).toBe(true);
  });

  it('bundles tweetnacl into the CLI publish tree for packaged installs', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'happy-build-shared-runtime-'));
    mkdirSync(resolve(repoRoot, 'node_modules', 'tweetnacl'), { recursive: true });
    mkdirSync(resolve(repoRoot, 'apps', 'cli'), { recursive: true });
    writeFileSync(
      resolve(repoRoot, 'node_modules', 'tweetnacl', 'package.json'),
      JSON.stringify({ name: 'tweetnacl', version: '1.0.3', main: 'nacl-fast.js' }),
      'utf8',
    );
    writeFileSync(resolve(repoRoot, 'node_modules', 'tweetnacl', 'nacl-fast.js'), 'module.exports = {};', 'utf8');
    writeFileSync(
      resolve(repoRoot, 'apps', 'cli', 'package.json'),
      JSON.stringify({
        name: '@happier-dev/cli',
        dependencies: {
          tweetnacl: '^1.0.3',
        },
      }),
      'utf8',
    );
    writeFileSync(resolve(repoRoot, 'yarn.lock'), '# lock\n', 'utf8');
    writeFileSync(resolve(repoRoot, 'package.json'), JSON.stringify({ name: 'repo', private: true }), 'utf8');

    syncCliRuntimeDependencies({ repoRoot });

    expect(existsSync(resolve(repoRoot, 'apps', 'cli', 'node_modules', 'tweetnacl', 'package.json'))).toBe(true);
    expect(existsSync(resolve(repoRoot, 'apps', 'cli', 'node_modules', 'tweetnacl', 'nacl-fast.js'))).toBe(true);
  });

  it('serializes concurrent shared-deps builds through a single lock', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'happy-build-shared-lock-'));
    const lockPath = resolve(rootDir, 'cli-shared-deps-build.lock');
    const events: string[] = [];
    let releaseFirst: (() => void) | null = null;

    const first = withBuildSharedDepsLock(async () => {
      events.push('first:start');
      await new Promise<void>((resolvePromise) => {
        releaseFirst = resolvePromise;
      });
      events.push('first:end');
    }, {
      lockPath,
      timeoutMs: 2_000,
      pollIntervalMs: 10,
      staleAfterMs: 1_000,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(events).toEqual(['first:start']);

    const second = withBuildSharedDepsLock(async () => {
      events.push('second:start');
    }, {
      lockPath,
      timeoutMs: 2_000,
      pollIntervalMs: 10,
      staleAfterMs: 1_000,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(events).toEqual(['first:start']);

    releaseFirst?.();
    await Promise.all([first, second]);

    expect(events).toEqual(['first:start', 'first:end', 'second:start']);
  });
});
