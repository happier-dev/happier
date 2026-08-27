import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { createSpawnHappyCliEnvScope } from '@/testkit/process/spawnHappyCliHarness';
import { withTempDir } from '@/testkit/fs/tempDir';

const envScope = createSpawnHappyCliEnvScope();

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('node:fs');
  envScope.restore();
});

function writeStackRuntimeFingerprint(runtimeStatePath: string, fingerprint: string | null): void {
  writeFileSync(
    runtimeStatePath,
    JSON.stringify({
      version: 1,
      stackName: 'qa-agent-1',
      daemon: fingerprint ? { distClosureFingerprint: fingerprint } : {},
    }) + '\n',
    'utf8',
  );
}

function patchFreshDistEnv(entrypoint: string, runtimeStatePath: string, fingerprint: string): void {
  envScope.patch({
    HAPPIER_CLI_SUBPROCESS_RUNTIME: 'node',
    HAPPIER_VARIANT: 'dev',
    HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK: undefined,
    HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: undefined,
    HAPPIER_CLI_SUBPROCESS_PREFER_TSX: undefined,
    HAPPIER_CLI_SUBPROCESS_DIST_ENTRYPOINT: entrypoint,
    HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT: fingerprint,
    HAPPIER_CLI_SUBPROCESS_STACK_RUNTIME_STATE_PATH: runtimeStatePath,
    HAPPIER_STACK_STACK: 'qa-agent-1',
    TSX_TSCONFIG_PATH: undefined,
  });
}

function writeTinyDist(root: string, chunkSource = 'export const marker = "old";\n'): string {
  const distDir = join(root, 'dist');
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(distDir, 'chunk.mjs'), chunkSource, 'utf8');
  writeFileSync(join(distDir, 'index.mjs'), 'import "./chunk.mjs";\nexport {};\n', 'utf8');
  return join(distDir, 'index.mjs');
}

function writeDistBuildManifest(entrypoint: string, fingerprint: string): void {
  writeFileSync(
    join(dirname(entrypoint), '.build-manifest.json'),
    JSON.stringify({
      fingerprint,
      builtAt: '2026-07-09T00:00:00.000Z',
      fileCount: 2,
      toolVersion: '1',
    }) + '\n',
    'utf8',
  );
}

function writeTinyRuntimeAssets(root: string, { includeDevCommandWrapper = true } = {}): void {
  const scriptsDir = join(root, 'scripts');
  const toolsDir = join(root, 'tools', 'unpacked');
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(toolsDir, { recursive: true });
  for (const scriptName of [
    'terminal_launch_spec_runner.cjs',
    'claude_local_launcher.cjs',
    'claude_remote_launcher.cjs',
    'claude_launcher_runtime.cjs',
    'childProcessOptions.cjs',
    ...(includeDevCommandWrapper ? ['env-wrapper.cjs'] : []),
    'ripgrep_launcher.cjs',
    'node_pty_relay.cjs',
  ]) {
    writeFileSync(join(scriptsDir, scriptName), `module.exports = ${JSON.stringify(scriptName)};\n`, 'utf8');
  }
  writeFileSync(join(toolsDir, 'rg'), '#!/bin/sh\nexit 0\n', 'utf8');
}

describe('spawnHappyCLI fallback invocation', () => {
  it('falls back to tsx source entrypoint in dev mode by default when dist entrypoint is missing', async () => {
    envScope.patch({
      HAPPIER_CLI_SUBPROCESS_RUNTIME: 'node',
      HAPPIER_VARIANT: 'dev',
      HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK: undefined,
      HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: join(tmpdir(), `missing-happier-default-${Date.now()}`, 'index.mjs'),
      TSX_TSCONFIG_PATH: undefined,
    });

    const mod = (await import('@/utils/spawnHappyCLI')) as typeof import('@/utils/spawnHappyCLI');
    const inv = mod.buildHappyCliSubprocessInvocation(['daemon', 'start-sync']);

    expect(inv.runtime).toBe('node');
    expect(inv.argv).toEqual(
      expect.arrayContaining([
        '--import',
        expect.stringMatching(/node_modules[\\/]tsx[\\/]dist[\\/]esm[\\/]index\.mjs$/),
        expect.stringMatching(/src[\\/]index\.ts$/),
        'daemon',
        'start-sync',
      ]),
    );
    expect(inv.env?.TSX_TSCONFIG_PATH).toEqual(expect.stringMatching(/[\\/]apps[\\/]cli[\\/]tsconfig\.json$/));
    expect(process.env.TSX_TSCONFIG_PATH).toBeUndefined();
  });

  it('falls back to tsx source entrypoint in dev mode when dist entrypoint is missing', async () => {
    envScope.patch({
      HAPPIER_CLI_SUBPROCESS_RUNTIME: 'node',
      HAPPIER_VARIANT: 'dev',
      HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK: '1',
      HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: join(tmpdir(), `missing-happier-entry-${Date.now()}`, 'index.mjs'),
      TSX_TSCONFIG_PATH: undefined,
    });

    const mod = (await import('@/utils/spawnHappyCLI')) as typeof import('@/utils/spawnHappyCLI');
    const inv = mod.buildHappyCliSubprocessInvocation(['daemon', 'start-sync']);

    expect(inv.runtime).toBe('node');
    expect(inv.argv).toEqual(
      expect.arrayContaining([
        '--import',
        expect.stringMatching(/node_modules[\\/]tsx[\\/]dist[\\/]esm[\\/]index\.mjs$/),
        expect.stringMatching(/src[\\/]index\.ts$/),
        'daemon',
        'start-sync',
      ]),
    );
    expect(inv.env?.TSX_TSCONFIG_PATH).toEqual(expect.stringMatching(/[\\/]apps[\\/]cli[\\/]tsconfig\.json$/));
    expect(process.env.TSX_TSCONFIG_PATH).toBeUndefined();
  });

  it('falls back to tsx source entrypoint in stack context even when HAPPIER_VARIANT is not set', async () => {
    envScope.patch({
      HAPPIER_CLI_SUBPROCESS_RUNTIME: 'node',
      HAPPIER_VARIANT: undefined,
      HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK: undefined,
      HAPPIER_STACK_STACK: 'qa-agent-1',
      HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: join(tmpdir(), `missing-happier-stack-${Date.now()}`, 'index.mjs'),
      TSX_TSCONFIG_PATH: undefined,
    });

    const mod = (await import('@/utils/spawnHappyCLI')) as typeof import('@/utils/spawnHappyCLI');
    const inv = mod.buildHappyCliSubprocessInvocation(['daemon', 'start-sync']);

    expect(inv.runtime).toBe('node');
    expect(inv.argv).toEqual(
      expect.arrayContaining([
        '--import',
        expect.stringMatching(/node_modules[\\/]tsx[\\/]dist[\\/]esm[\\/]index\.mjs$/),
        expect.stringMatching(/src[\\/]index\.ts$/),
        'daemon',
        'start-sync',
      ]),
    );
    expect(inv.env?.TSX_TSCONFIG_PATH).toEqual(expect.stringMatching(/[\\/]apps[\\/]cli[\\/]tsconfig\.json$/));
    expect(process.env.TSX_TSCONFIG_PATH).toBeUndefined();
  });

  it('prefers the tsx source entrypoint in stack context even when dist exists', async () => {
    envScope.patch({
      HAPPIER_CLI_SUBPROCESS_RUNTIME: 'node',
      HAPPIER_VARIANT: undefined,
      HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK: undefined,
      HAPPIER_STACK_STACK: 'qa-agent-1',
      HAPPIER_CLI_SUBPROCESS_PREFER_TSX: undefined,
      HAPPIER_CLI_SUBPROCESS_DIST_ENTRYPOINT: undefined,
      HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT: undefined,
      HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED: undefined,
      HAPPIER_CLI_SUBPROCESS_STACK_RUNTIME_STATE_PATH: undefined,
      TSX_TSCONFIG_PATH: undefined,
    });

    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...actual,
        existsSync: (path: string) => {
          if (path.endsWith('dist/index.mjs')) return true;
          if (path.endsWith('src/index.ts')) return true;
          return actual.existsSync(path);
        },
      };
    });

    const mod = (await import('@/utils/spawnHappyCLI')) as typeof import('@/utils/spawnHappyCLI');
    const inv = mod.buildHappyCliSubprocessInvocation(['daemon', 'start-sync']);

    expect(inv.runtime).toBe('node');
    expect(inv.argv).toEqual(
      expect.arrayContaining([
        '--import',
        expect.stringMatching(/node_modules[\\/]tsx[\\/]dist[\\/]esm[\\/]index\.mjs$/),
        expect.stringMatching(/src[\\/]index\.ts$/),
        'daemon',
        'start-sync',
      ]),
    );
    expect(inv.argv).not.toEqual(expect.arrayContaining([expect.stringMatching(/dist[\\/]index\.mjs$/)]));
    expect(inv.env?.TSX_TSCONFIG_PATH).toEqual(expect.stringMatching(/[\\/]apps[\\/]cli[\\/]tsconfig\.json$/));
    expect(process.env.TSX_TSCONFIG_PATH).toBeUndefined();
  });

  it('uses a pinned dist closure for stack source-daemon runner spawns when the runtime fingerprint is current', async () => {
    await withTempDir('happier-current-dist-runner-', async (root) => {
      const entrypoint = writeTinyDist(root);
      writeTinyRuntimeAssets(root);
      const fingerprint = 'abc123def4567890';
      writeDistBuildManifest(entrypoint, fingerprint);
      const runtimeStatePath = join(root, 'stack.runtime.json');
      writeStackRuntimeFingerprint(runtimeStatePath, fingerprint);
      patchFreshDistEnv(entrypoint, runtimeStatePath, fingerprint);

      const mod = (await import('@/utils/spawnHappyCLI')) as typeof import('@/utils/spawnHappyCLI');
      const inv = mod.buildHappyCliSubprocessInvocation(['claude', '--started-by', 'daemon']);

      expect(inv.runtime).toBe('node');
      expect(inv.argv).toEqual(
        expect.arrayContaining([
          '--no-warnings',
          '--no-deprecation',
          expect.stringMatching(/[\\/]\.runner-snapshots[\\/][a-f0-9]{16}[\\/]index\.mjs$/),
          'claude',
          '--started-by',
          'daemon',
        ]),
      );
      expect(inv.argv).not.toContain('--import');
      expect(inv.argv).not.toEqual(expect.arrayContaining([entrypoint]));
      expect(inv.env).toBeUndefined();
      const pinnedEntrypoint = inv.argv.find((arg) => arg.endsWith('index.mjs'));
      expect(pinnedEntrypoint).toBeDefined();
      const snapshotRoot = dirname(pinnedEntrypoint!);
      for (const relativeAssetPath of [
        ['scripts', 'terminal_launch_spec_runner.cjs'],
        ['scripts', 'claude_local_launcher.cjs'],
        ['scripts', 'env-wrapper.cjs'],
        ['scripts', 'ripgrep_launcher.cjs'],
        ['tools', 'unpacked', 'rg'],
      ]) {
        expect(existsSync(join(snapshotRoot, ...relativeAssetPath))).toBe(true);
      }
    });
  });

  it('uses the admitted pinned closure for initial daemon startup before a live daemon fingerprint exists', async () => {
    await withTempDir('happier-admitted-daemon-startup-', async (root) => {
      const entrypoint = writeTinyDist(root);
      writeTinyRuntimeAssets(root);
      const fingerprint = 'abc123def4567890';
      writeDistBuildManifest(entrypoint, fingerprint);
      const runtimeStatePath = join(root, 'stack.runtime.json');
      writeStackRuntimeFingerprint(runtimeStatePath, null);
      patchFreshDistEnv(entrypoint, runtimeStatePath, fingerprint);

      const mod = (await import('@/utils/spawnHappyCLI')) as typeof import('@/utils/spawnHappyCLI');
      const startup = mod.buildHappyCliSubprocessInvocation(
        ['daemon', 'start-sync'],
        { allowAdmittedDaemonStartupClosure: true },
      );

      expect(startup.runtime).toBe('node');
      expect(startup.argv).toEqual(expect.arrayContaining([
        expect.stringMatching(/[\\/]\.runner-snapshots[\\/][a-f0-9]{16}[\\/]index\.mjs$/),
        'daemon',
        'start-sync',
      ]));
      expect(startup.argv).not.toContain('--import');

      const ordinaryChild = mod.buildHappyCliSubprocessInvocation(
        ['claude', '--started-by', 'daemon'],
        { allowAdmittedDaemonStartupClosure: true },
      );
      expect(ordinaryChild.argv).toContain('--import');
      expect(ordinaryChild.argv).toEqual(expect.arrayContaining([
        expect.stringMatching(/src[\\/]index\.ts$/),
        'claude',
        '--started-by',
        'daemon',
      ]));
    });
  });

  it('retries a transient Windows directory publication conflict when pinning an admitted daemon closure', async () => {
    await withTempDir('happier-admitted-daemon-runner-rename-retry-', async (root) => {
      const entrypoint = writeTinyDist(root);
      writeTinyRuntimeAssets(root);
      const fingerprint = 'abc123def4567890';
      writeDistBuildManifest(entrypoint, fingerprint);
      const runtimeStatePath = join(root, 'stack.runtime.json');
      writeStackRuntimeFingerprint(runtimeStatePath, null);
      patchFreshDistEnv(entrypoint, runtimeStatePath, fingerprint);

      let renameSyncMock: ReturnType<typeof vi.fn> | null = null;
      vi.doMock('node:fs', async () => {
        const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
        const conflict = new Error('EPERM') as NodeJS.ErrnoException;
        conflict.code = 'EPERM';
        renameSyncMock = vi.fn(actual.renameSync)
          .mockImplementationOnce(() => {
            throw conflict;
          });
        return {
          ...actual,
          renameSync: renameSyncMock,
        };
      });

      const mod = (await import('@/utils/spawnHappyCLI')) as typeof import('@/utils/spawnHappyCLI');
      const invocation = mod.buildHappyCliSubprocessInvocation(
        ['daemon', 'start-sync'],
        { allowAdmittedDaemonStartupClosure: true },
      );

      expect(invocation.runtime).toBe('node');
      expect(invocation.argv).toEqual(expect.arrayContaining([
        expect.stringMatching(/[\\/]\.runner-snapshots[\\/]abc123def4567890[\\/]index\.mjs$/),
        'daemon',
        'start-sync',
      ]));
      expect(renameSyncMock).not.toBeNull();
      expect(renameSyncMock).toHaveBeenCalledTimes(2);
    });
  });

  it('uses the admitted pinned closure after mutable dist advances to a newer publication', async () => {
    await withTempDir('happier-admitted-daemon-startup-after-dist-advance-', async (root) => {
      const entrypoint = writeTinyDist(root);
      writeTinyRuntimeAssets(root);
      const admittedFingerprint = 'abc123def4567890';
      writeDistBuildManifest(entrypoint, admittedFingerprint);
      const runtimeStatePath = join(root, 'stack.runtime.json');
      writeStackRuntimeFingerprint(runtimeStatePath, null);
      patchFreshDistEnv(entrypoint, runtimeStatePath, admittedFingerprint);

      const mod = (await import('@/utils/spawnHappyCLI')) as typeof import('@/utils/spawnHappyCLI');
      const admitted = mod.buildHappyCliSubprocessInvocation(
        ['daemon', 'start-sync'],
        { allowAdmittedDaemonStartupClosure: true },
      );
      const admittedEntrypoint = admitted.argv.find((arg) => arg.endsWith('index.mjs'));
      expect(admittedEntrypoint).toContain(admittedFingerprint);

      writeFileSync(join(dirname(entrypoint), 'chunk.mjs'), 'export const marker = "new";\n', 'utf8');
      writeDistBuildManifest(entrypoint, 'fed456abc1230987');

      const startup = mod.buildHappyCliSubprocessInvocation(
        ['daemon', 'start-sync'],
        { allowAdmittedDaemonStartupClosure: true },
      );

      expect(startup.runtime).toBe('node');
      expect(startup.argv).toContain(admittedEntrypoint);
      expect(startup.argv).not.toContain(entrypoint);
    });
  });

  it('accepts the immutable runtime artifact sidecars without the development-only command wrapper', async () => {
    await withTempDir('happier-runtime-artifact-runner-', async (root) => {
      const entrypoint = writeTinyDist(root);
      writeTinyRuntimeAssets(root, { includeDevCommandWrapper: false });
      const fingerprint = 'abc123def4567890';
      writeDistBuildManifest(entrypoint, fingerprint);
      const runtimeStatePath = join(root, 'stack.runtime.json');
      writeStackRuntimeFingerprint(runtimeStatePath, fingerprint);
      patchFreshDistEnv(entrypoint, runtimeStatePath, fingerprint);
      envScope.patch({ HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED: '1' });

      const mod = (await import('@/utils/spawnHappyCLI')) as typeof import('@/utils/spawnHappyCLI');
      const inv = mod.buildHappyCliSubprocessInvocation(['claude', '--started-by', 'daemon']);

      expect(inv.runtime).toBe('node');
      expect(inv.argv).toEqual(expect.arrayContaining([
        expect.stringMatching(/[\\/]\.runner-snapshots[\\/][a-f0-9]{16}[\\/]index\.mjs$/),
        'claude',
        '--started-by',
        'daemon',
      ]));
      expect(inv.argv).not.toContain('--import');
    });
  });

  it('fails typed and never falls back to TSX when a runtime-backed runner closure cannot be prepared', async () => {
    await withTempDir('happier-runtime-backed-runner-failure-', async (root) => {
      const entrypoint = writeTinyDist(root);
      const fingerprint = 'abc123def4567890';
      writeDistBuildManifest(entrypoint, fingerprint);
      const runtimeStatePath = join(root, 'stack.runtime.json');
      writeStackRuntimeFingerprint(runtimeStatePath, fingerprint);
      patchFreshDistEnv(entrypoint, runtimeStatePath, fingerprint);
      envScope.patch({
        HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED: '1',
        HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK: '1',
      });

      const mod = (await import('@/utils/spawnHappyCLI')) as typeof import('@/utils/spawnHappyCLI');
      expect(() => mod.buildHappyCliSubprocessInvocation(['claude', '--started-by', 'daemon']))
        .toThrow(expect.objectContaining({
          name: 'HappyCliImmutableRuntimeClosureError',
          code: 'EIMMUTABLERUNNERCLOSURE',
        }));
    });
  });

  it('fails typed when the runtime-backed admitted fingerprint does not match the dist closure', async () => {
    await withTempDir('happier-runtime-backed-runner-fingerprint-mismatch-', async (root) => {
      const entrypoint = writeTinyDist(root);
      writeTinyRuntimeAssets(root);
      const distFingerprint = 'abc123def4567890';
      const admittedFingerprint = '0123456789abcdef';
      writeDistBuildManifest(entrypoint, distFingerprint);
      const runtimeStatePath = join(root, 'stack.runtime.json');
      writeStackRuntimeFingerprint(runtimeStatePath, admittedFingerprint);
      patchFreshDistEnv(entrypoint, runtimeStatePath, admittedFingerprint);
      envScope.patch({
        HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED: '1',
        HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK: '1',
      });

      const mod = (await import('@/utils/spawnHappyCLI')) as typeof import('@/utils/spawnHappyCLI');
      expect(() => mod.buildHappyCliSubprocessInvocation(['claude', '--started-by', 'daemon']))
        .toThrow(expect.objectContaining({
          name: 'HappyCliImmutableRuntimeClosureError',
          code: 'EIMMUTABLERUNNERCLOSURE',
        }));
    });
  });

  it('reuses one admitted runtime decision across adapter-specific argument lists', async () => {
    await withTempDir('happier-runtime-backed-runner-decision-', async (root) => {
      const entrypoint = writeTinyDist(root);
      writeTinyRuntimeAssets(root);
      const fingerprint = '0123456789abcdef';
      writeDistBuildManifest(entrypoint, fingerprint);
      const runtimeStatePath = join(root, 'stack.runtime.json');
      writeStackRuntimeFingerprint(runtimeStatePath, fingerprint);
      patchFreshDistEnv(entrypoint, runtimeStatePath, fingerprint);
      envScope.patch({ HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED: '1' });

      const mod = (await import('@/utils/spawnHappyCLI')) as typeof import('@/utils/spawnHappyCLI');
      const runtimeDecision = mod.resolveHappyCliSubprocessRuntimeDecision();
      expect(runtimeDecision).not.toBeNull();

      envScope.patch({ HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT: 'ffffffffffffffff' });
      const tmux = mod.buildHappyCliSubprocessLaunchSpec(['claude', '--happy-terminal-mode', 'tmux'], {
        runtimeDecision: runtimeDecision!,
      });
      const direct = mod.buildHappyCliSubprocessLaunchSpec(['claude', '--happy-terminal-mode', 'plain'], {
        runtimeDecision: runtimeDecision!,
      });
      const windowsConsole = mod.buildHappyCliSubprocessLaunchSpec(
        ['claude', '--happy-terminal-mode', 'windows_console'],
        { runtimeDecision: runtimeDecision! },
      );
      const windowsTerminal = mod.buildHappyCliSubprocessLaunchSpec(
        ['claude', '--happy-terminal-mode', 'windows_terminal'],
        { runtimeDecision: runtimeDecision! },
      );
      const { resolveEntrypointIdentityFromLaunchSpec } = await import(
        '@/daemon/sessionRunnerRuntime/resolveRunnerEntrypointIdentity'
      );

      expect(tmux.filePath).toBe(direct.filePath);
      expect(tmux.args.slice(0, runtimeDecision!.argvPrefix.length)).toEqual(runtimeDecision!.argvPrefix);
      expect(direct.args.slice(0, runtimeDecision!.argvPrefix.length)).toEqual(runtimeDecision!.argvPrefix);
      expect(windowsConsole.args.slice(0, runtimeDecision!.argvPrefix.length)).toEqual(runtimeDecision!.argvPrefix);
      expect(windowsTerminal.args.slice(0, runtimeDecision!.argvPrefix.length)).toEqual(runtimeDecision!.argvPrefix);
      expect(resolveEntrypointIdentityFromLaunchSpec(tmux)).toEqual(expect.objectContaining({
        status: 'known',
        comparableId: `snapshot:${fingerprint}`,
      }));
      expect(tmux.args.at(-1)).toBe('tmux');
      expect(direct.args.at(-1)).toBe('plain');
      expect(windowsConsole.args.at(-1)).toBe('windows_console');
      expect(windowsTerminal.args.at(-1)).toBe('windows_terminal');
    });
  });

  it.each([
    ['missing daemon fingerprint', null, 'fresh'],
    ['missing runtime fingerprint', 'fresh', null],
    ['stale runtime fingerprint', 'fresh', 'stale'],
  ])('falls back to tsx when the dist closure fingerprint is %s', async (_name, daemonFingerprintMode, runtimeFingerprintMode) => {
    await withTempDir('happier-stale-dist-runner-', async (root) => {
      const entrypoint = writeTinyDist(root);
      const fingerprint = 'abc123def4567890';
      const staleFingerprint = '0000000000000000';
      writeDistBuildManifest(entrypoint, fingerprint);
      const runtimeStatePath = join(root, 'stack.runtime.json');
      writeStackRuntimeFingerprint(
        runtimeStatePath,
        runtimeFingerprintMode === 'fresh'
          ? fingerprint
          : runtimeFingerprintMode === 'stale'
            ? staleFingerprint
            : null,
      );
      patchFreshDistEnv(
        entrypoint,
        runtimeStatePath,
        daemonFingerprintMode === 'fresh' ? fingerprint : '',
      );

      const mod = (await import('@/utils/spawnHappyCLI')) as typeof import('@/utils/spawnHappyCLI');
      const inv = mod.buildHappyCliSubprocessInvocation(['claude', '--started-by', 'daemon']);

      expect(inv.runtime).toBe('node');
      expect(inv.argv).toEqual(
        expect.arrayContaining([
          '--import',
          expect.stringMatching(/node_modules[\\/]tsx[\\/]dist[\\/]esm[\\/]index\.mjs$/),
          expect.stringMatching(/src[\\/]index\.ts$/),
          'claude',
          '--started-by',
          'daemon',
        ]),
      );
      expect(inv.env?.TSX_TSCONFIG_PATH).toEqual(expect.stringMatching(/[\\/]apps[\\/]cli[\\/]tsconfig\.json$/));
    });
  });

  it('keeps runner argv parity with dist launches and pins the copied closure against mid-boot dist swaps', async () => {
    const originalExecArgv = [...process.execArgv];
    try {
      process.execArgv = ['--preserve-symlinks'];
      await withTempDir('happier-pinned-dist-runner-', async (root) => {
        const entrypoint = writeTinyDist(root, 'export const marker = "before-swap";\n');
        writeTinyRuntimeAssets(root);
        const fingerprint = 'abc123def4567890';
        writeDistBuildManifest(entrypoint, fingerprint);
        const runtimeStatePath = join(root, 'stack.runtime.json');
        writeStackRuntimeFingerprint(runtimeStatePath, fingerprint);
        patchFreshDistEnv(entrypoint, runtimeStatePath, fingerprint);

        const mod = (await import('@/utils/spawnHappyCLI')) as typeof import('@/utils/spawnHappyCLI');
        const inv = mod.buildHappyCliSubprocessInvocation(['codex', '--started-by', 'daemon', '--foo=bar']);

        const pinnedEntrypoint = inv.argv.find((arg) => arg.endsWith('index.mjs'));
        expect(pinnedEntrypoint).toMatch(/[\\/]\.runner-snapshots[\\/][a-f0-9]{16}[\\/]index\.mjs$/);
        expect(pinnedEntrypoint).not.toContain(`${join('dist', '.runner-snapshots')}`);
        expect(inv.argv).toEqual([
          '--preserve-symlinks',
          '--no-warnings',
          '--no-deprecation',
          pinnedEntrypoint,
          'codex',
          '--started-by',
          'daemon',
          '--foo=bar',
        ]);
        expect(inv.env).toBeUndefined();

        writeFileSync(join(dirname(entrypoint), 'chunk.mjs'), 'export const marker = "after-swap";\n', 'utf8');
        const pinnedChunk = join(dirname(pinnedEntrypoint ?? ''), 'chunk.mjs');
        expect(readFileSync(pinnedChunk, 'utf8')).toContain('before-swap');
      });
    } finally {
      process.execArgv = originalExecArgv;
    }
  });

  it('prunes dead pinned runner snapshots from authoritative daemon startup liveness', async () => {
    await withTempDir('happier-pinned-dist-startup-prune-', async (root) => {
      const entrypoint = writeTinyDist(root);
      const fingerprint = 'abc123def4567890';
      const liveFingerprint = '1111111111111111';
      const runtimeStatePath = join(root, 'stack.runtime.json');
      writeDistBuildManifest(entrypoint, fingerprint);
      writeStackRuntimeFingerprint(runtimeStatePath, fingerprint);
      patchFreshDistEnv(entrypoint, runtimeStatePath, fingerprint);

      const snapshotsDir = join(root, '.runner-snapshots');
      for (const [index, name] of [
        fingerprint,
        liveFingerprint,
        ...Array.from({ length: 10 }, (_, deadIndex) => `dead${String(deadIndex).padStart(12, '0')}`),
      ].entries()) {
        const snapshotDir = join(snapshotsDir, name);
        mkdirSync(snapshotDir, { recursive: true });
        utimesSync(snapshotDir, index + 1, index + 1);
      }

      const mod = (await import('@/utils/spawnHappyCLI')) as typeof import('@/utils/spawnHappyCLI');
      mod.pruneHappyCliRunnerSnapshots({
        reliable: true,
        fingerprints: new Set([liveFingerprint]),
      });

      expect(existsSync(join(snapshotsDir, fingerprint))).toBe(true);
      expect(existsSync(join(snapshotsDir, liveFingerprint))).toBe(true);
      expect(existsSync(join(snapshotsDir, 'dead000000000000'))).toBe(false);
      expect(existsSync(join(snapshotsDir, 'dead000000000001'))).toBe(false);
      expect(existsSync(join(snapshotsDir, 'dead000000000009'))).toBe(true);
    });
  });

  it.each(['maybe', '2', 'enabled', 'yup'])('does not treat unknown HAPPIER_CLI_SUBPROCESS_PREFER_TSX=%s as enabled', async (rawValue) => {
    envScope.patch({
      HAPPIER_CLI_SUBPROCESS_RUNTIME: 'node',
      HAPPIER_VARIANT: undefined,
      HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK: undefined,
      HAPPIER_STACK_REPO_DIR: undefined,
      HAPPIER_STACK_CLI_ROOT_DIR: undefined,
      HAPPIER_STACK_STACK: undefined,
      HAPPIER_CLI_SUBPROCESS_PREFER_TSX: rawValue,
    });

    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...actual,
        existsSync: (path: string) => {
          if (path.endsWith('dist/index.mjs')) return true;
          if (path.endsWith('src/index.ts')) return true;
          return actual.existsSync(path);
        },
      };
    });

    const mod = (await import('@/utils/spawnHappyCLI')) as typeof import('@/utils/spawnHappyCLI');
    const inv = mod.buildHappyCliSubprocessInvocation(['--version']);

    expect(inv.runtime).toBe('node');
    expect(inv.argv).toEqual(expect.arrayContaining([expect.stringMatching(/dist[\\/]index\.mjs$/), '--version']));
    expect(inv.argv).not.toContain('--import');
  });
});
