import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

import { createTempDirSync, removeTempDirSync } from '../../src/testkit/fs/tempDir';
import { resolveBundledWorkspaceDependencyBuildOrder } from '../../../../scripts/workspaces/resolveWorkspaceDependencyBuildOrder.mjs';
import {
  execYarn,
  resolveTscBin,
  resolveBundledWorkspaceTsconfigPath,
  resolveYarnInvocation,
  runTsc,
  syncBundledWorkspaceDist,
  syncCliRuntimeDependencies,
  withBuildSharedDepsLock,
} from '../buildSharedDeps.mjs';
import {
  createPackageLayoutSandbox,
  writeCliBundledHostPackage,
  writeRuntimeDependencyStub,
} from './testkit/packageLayoutSandbox';

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
    expect(args[3]).toBe(
      '"C:\\repo\\node_modules\\.bin\\tsc.cmd ^"-p^" ^"C:\\repo\\packages\\protocol\\tsconfig.json^""',
    );
    expect(opts).toEqual({
      stdio: 'inherit',
      windowsVerbatimArguments: true,
    });
  });

  it('prefers the workspace root tsc.js entrypoint when the typescript package is resolvable', () => {
    const bin = resolveTscBin({
      requireResolve: (specifier: string) => {
        if (specifier === 'typescript/lib/tsc.js') {
          return '/repo/node_modules/typescript/lib/tsc.js';
        }
        throw new Error(`unexpected specifier: ${specifier}`);
      },
      exists: (candidate: string) =>
        candidate.includes(`${sep}node_modules${sep}typescript${sep}lib${sep}`) &&
        !candidate.includes(`${sep}cli${sep}node_modules${sep}`),
    });

    expect(bin).toBe('/repo/node_modules/typescript/lib/tsc.js');
  });

  it('falls back to yarn on PATH when npm_execpath points at npm-cli.js', () => {
    const invocation = resolveYarnInvocation('/somewhere/lib/node_modules/npm/bin/npm-cli.js');

    expect(invocation).toEqual({
      command: process.platform === 'win32' ? 'yarn.cmd' : 'yarn',
      args: [],
    });
  });

  it('uses node + npm_execpath when npm_execpath points at a Yarn entrypoint', () => {
    const invocation = resolveYarnInvocation('/somewhere/lib/node_modules/yarn/bin/yarn.js');

    expect(invocation).toEqual({
      command: process.execPath,
      args: ['/somewhere/lib/node_modules/yarn/bin/yarn.js'],
    });
  });

  it('resolves extension workspace tsconfig paths from packages/extensions/<extensionId>', () => {
    expect(resolveBundledWorkspaceTsconfigPath({ repoRoot: '/repo', workspaceName: 'extensions-acme' })).toBe(
      '/repo/packages/extensions/acme/tsconfig.json',
    );
  });

  it('orders bundled workspace builds so internal workspace dependencies compile first', () => {
    const repoRoot = createTempDirSync('happier-cli-build-shared-order-');
    try {
      mkdirSync(resolve(repoRoot, 'apps', 'cli'), { recursive: true });
      writeFileSync(
        resolve(repoRoot, 'apps', 'cli', 'package.json'),
        JSON.stringify(
          {
            bundledDependencies: [
              '@happier-dev/cli-common',
              '@happier-dev/release-runtime',
              '@happier-dev/agents',
              '@happier-dev/protocol',
            ],
          },
          null,
          2,
        ),
        'utf8',
      );

      const packageJsonByWorkspace: Record<string, Record<string, unknown>> = {
        protocol: {
          name: '@happier-dev/protocol',
        },
        agents: {
          name: '@happier-dev/agents',
          dependencies: {
            '@happier-dev/protocol': '0.0.0',
          },
        },
        'release-runtime': {
          name: '@happier-dev/release-runtime',
        },
        'cli-common': {
          name: '@happier-dev/cli-common',
          dependencies: {
            '@happier-dev/agents': '0.0.0',
            '@happier-dev/release-runtime': '0.0.0',
          },
        },
      };

      for (const [workspaceName, packageJson] of Object.entries(packageJsonByWorkspace)) {
        mkdirSync(resolve(repoRoot, 'packages', workspaceName), { recursive: true });
        writeFileSync(
          resolve(repoRoot, 'packages', workspaceName, 'package.json'),
          JSON.stringify(packageJson, null, 2),
          'utf8',
        );
        writeFileSync(resolve(repoRoot, 'packages', workspaceName, 'tsconfig.json'), '{}\n', 'utf8');
      }

      const ordered = resolveBundledWorkspaceDependencyBuildOrder({
        repoRoot,
        hostPackageDir: resolve(repoRoot, 'apps', 'cli'),
      });

      expect(ordered.indexOf('protocol')).toBeLessThan(ordered.indexOf('agents'));
      expect(ordered.indexOf('agents')).toBeLessThan(ordered.indexOf('cli-common'));
      expect(ordered.indexOf('release-runtime')).toBeLessThan(ordered.indexOf('cli-common'));
    } finally {
      removeTempDirSync(repoRoot);
    }
  });

  it('runs yarn.cmd through cmd.exe on Windows to avoid spawn EINVAL', () => {
    const execFileSync = vi.fn(() => undefined);

    execYarn(['-s', 'workspace', '@happier-dev/cli-common', 'build'], {
      execFileSync,
      npmExecPath: '/somewhere/lib/node_modules/npm/bin/npm-cli.js',
      platform: 'win32',
      cwd: 'C:\\repo',
      stdio: 'inherit',
    });

    const cmdCall = execFileSync.mock.calls[0] as
      | [string, string[], { cwd: string; stdio: string; windowsVerbatimArguments?: boolean }]
      | undefined;
    if (!cmdCall) throw new Error('expected execFileSync call');
    const [cmd, args, options] = cmdCall;
    expect(cmd).toBe('cmd.exe');
    expect(args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(String(args[3])).toContain('yarn.cmd');
    expect(String(args[3])).toContain('@happier-dev/cli-common');
    expect(options.cwd).toBe('C:\\repo');
    expect(options.stdio).toBe('inherit');
    expect(options.windowsVerbatimArguments).toBe(true);
  });

  it('executes the resolved tsc.js entrypoint via node', () => {
    const execFileSync = vi.fn(() => undefined);

    runTsc('/repo/packages/protocol/tsconfig.json', {
      execFileSync,
      tscBin: '/repo/node_modules/typescript/lib/tsc.js',
      platform: 'darwin',
    });

    const nodeCall = execFileSync.mock.calls[0] as unknown as [string, string[]] | undefined;
    if (!nodeCall) throw new Error('expected execFileSync call');
    const [cmd, args] = nodeCall;
    expect(cmd).toBe(process.execPath);
    expect(args).toEqual(['/repo/node_modules/typescript/lib/tsc.js', '-p', '/repo/packages/protocol/tsconfig.json']);
  });

  it('syncs workspace dist outputs into bundled deps for local bundled hosts when present', () => {
    const cpSync = vi.fn(() => undefined);
    const rmSync = vi.fn(() => undefined);
    const existsSync = vi.fn((p: any) =>
      String(p).endsWith('/apps/cli/package.json') ||
      String(p).endsWith('/packages/protocol/package.json') ||
      String(p).endsWith('/packages/protocol/dist') ||
      String(p).includes('/apps/cli/node_modules/@happier-dev/protocol/'),
    );
    const mkdirSync = vi.fn(() => undefined);
    const readFileSync = vi.fn((p: any) => {
      const text = String(p);
      if (text.endsWith('/apps/cli/package.json')) {
        return JSON.stringify({
          bundledDependencies: ['@happier-dev/protocol'],
        });
      }
      if (text.endsWith('/packages/protocol/package.json')) {
        return JSON.stringify({
          name: '@happier-dev/protocol',
          version: '0.0.0',
          type: 'module',
          exports: { '.': { default: './dist/index.js' } },
        });
      }
      throw new Error(`unexpected read: ${text}`);
    });

    syncBundledWorkspaceDist({
      repoRoot: '/repo',
      cpSync,
      existsSync,
      mkdirSync,
      rmSync,
      readFileSync,
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
      String(p).endsWith('/apps/cli/package.json') ||
      String(p).endsWith('/packages/protocol/package.json') ||
      String(p).includes('/apps/cli/node_modules/@happier-dev/protocol/dist') ||
      String(p).includes('/apps/stack/node_modules/@happier-dev/protocol/dist'),
    );
    const readFileSync = vi.fn((p: any) => {
      const text = String(p);
      if (text.endsWith('/apps/cli/package.json')) {
        return JSON.stringify({
          bundledDependencies: ['@happier-dev/protocol'],
        });
      }

      return JSON.stringify({
        name: '@happier-dev/protocol',
        version: '0.0.0',
        type: 'module',
        exports: { '.': { default: './dist/index.js' }, './installables': { default: './dist/installables.js' } },
        dependencies: { zod: '1.0.0' },
      });
    });
    const writeFileSync = vi.fn(() => undefined);
    const mkdirSync = vi.fn(() => undefined);

    syncBundledWorkspaceDist({
      repoRoot: '/repo',
      cpSync,
      existsSync,
      mkdirSync,
      readFileSync,
      writeFileSync,
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

  it('derives the default bundled workspace sync set from the CLI manifest', () => {
    const cpSync = vi.fn(() => undefined);
    const existsSync = vi.fn((p: any) => {
      const text = String(p);
      return (
        text.endsWith('/apps/cli/package.json') ||
        text.endsWith('/packages/custom-bundle/package.json') ||
        text.endsWith('/packages/custom-bundle/dist') ||
        text.endsWith('/apps/cli/node_modules/@happier-dev/custom-bundle/package.json') ||
        text.endsWith('/apps/cli/node_modules/@happier-dev/custom-bundle/dist')
      );
    });
    const mkdirSync = vi.fn(() => undefined);
    const rmSync = vi.fn(() => undefined);
    const readFileSync = vi.fn((p: any) => {
      const text = String(p);
      if (text.endsWith('/apps/cli/package.json')) {
        return JSON.stringify({
          bundledDependencies: ['@happier-dev/custom-bundle', 'tweetnacl'],
        });
      }
      if (text.endsWith('/packages/custom-bundle/package.json')) {
        return JSON.stringify({
          name: '@happier-dev/custom-bundle',
          version: '0.0.0',
          type: 'module',
          exports: { '.': { default: './dist/index.js' } },
        });
      }
      throw new Error(`unexpected read: ${text}`);
    });
    const writeFileSync = vi.fn(() => undefined);

    syncBundledWorkspaceDist({
      repoRoot: '/repo',
      cpSync,
      existsSync,
      mkdirSync,
      rmSync,
      readFileSync,
      writeFileSync,
    });

    const calls = cpSync.mock.calls as unknown[];
    expect(
      calls.some((call) => {
        if (!Array.isArray(call) || call.length < 3) return false;
        const [from, to, options] = call as [unknown, unknown, { recursive?: boolean; force?: boolean }];
        return from === '/repo/packages/custom-bundle/dist'
          && typeof to === 'string'
          && to.includes('/apps/cli/node_modules/@happier-dev/custom-bundle/')
          && options.recursive === true
          && options.force === true;
      }),
    ).toBe(true);
  });

  it('bundles tweetnacl into the CLI publish tree for packaged installs', () => {
    const { repoRoot, happyCliDir, cleanup } = createPackageLayoutSandbox('happy-build-shared-runtime-');

    try {
      writeRuntimeDependencyStub({
        repoRoot,
        packageName: 'tweetnacl',
        manifestOverrides: {
          version: '1.0.3',
          main: 'nacl-fast.js',
        },
        files: {
          'nacl-fast.js': 'module.exports = {};\n',
        },
      });
      writeCliBundledHostPackage({
        happyCliDir,
        dependencies: {
          tweetnacl: '^1.0.3',
        },
      });

      syncCliRuntimeDependencies({ repoRoot });

      expect(existsSync(resolve(repoRoot, 'apps', 'cli', 'node_modules', 'tweetnacl', 'package.json'))).toBe(true);
      expect(existsSync(resolve(repoRoot, 'apps', 'cli', 'node_modules', 'tweetnacl', 'nacl-fast.js'))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('serializes concurrent shared-deps builds through a single lock', async () => {
    const rootDir = createTempDirSync('happy-build-shared-lock-');
    try {
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
    } finally {
      removeTempDirSync(rootDir);
    }
  });
});
