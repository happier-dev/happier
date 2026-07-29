import { afterEach, describe, expect, it, vi } from 'vitest';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';

import { createSpawnHappyCliEnvScope } from '@/testkit/process/spawnHappyCliHarness';
import { withTempDir } from '@/testkit/fs/tempDir';
import cliDistBuildManifest from '@happier-dev/cli-common/cliDistBuildManifest';
import { CLI_RUNTIME_SIDECAR_ENTRIES } from '@happier-dev/cli-common/componentArtifacts/cliRuntimeSidecars';

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

function writeDistBuildManifest(entrypoint: string): string {
  return cliDistBuildManifest.writeCliDistBuildManifest(entrypoint, {
    outputDir: dirname(entrypoint),
    builtAt: '2026-07-09T00:00:00.000Z',
  }).manifest.fingerprint;
}

function writeTinyRuntimeAssets(root: string, { includeDevCommandWrapper = true } = {}): void {
  const scriptsDir = join(root, 'scripts');
  const toolsDir = join(root, 'tools', 'unpacked');
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(toolsDir, { recursive: true });
  for (const relativePath of CLI_RUNTIME_SIDECAR_ENTRIES) {
    const targetPath = join(scriptsDir, ...relativePath);
    if (relativePath[0] === 'runtime' || relativePath[0] === 'shims') {
      mkdirSync(targetPath, { recursive: true });
      continue;
    }
    writeFileSync(
      targetPath,
      `module.exports = ${JSON.stringify(relativePath.at(-1))};\n`,
      'utf8',
    );
  }
  if (includeDevCommandWrapper) {
    writeFileSync(join(scriptsDir, 'env-wrapper.cjs'), 'module.exports = "env-wrapper.cjs";\n', 'utf8');
  }
  writeFileSync(join(toolsDir, 'rg'), '#!/bin/sh\nexit 0\n', 'utf8');
}

function writeCanonicalRunnerClosureFixture(root: string): string {
  const entrypoint = writeTinyDist(root);
  const packagedVoiceRuntimePath = join(
    dirname(entrypoint),
    'daemon',
    'voiceInference',
    'runtime',
    'packagedVoiceInferenceRuntime.mjs',
  );
  mkdirSync(dirname(packagedVoiceRuntimePath), { recursive: true });
  writeFileSync(packagedVoiceRuntimePath, 'export const voiceRuntime = "packaged";\n', 'utf8');

  const scriptsDir = join(root, 'scripts');
  mkdirSync(join(scriptsDir, 'runtime'), { recursive: true });
  mkdirSync(join(scriptsDir, 'shims'), { recursive: true });
  for (const relativePath of CLI_RUNTIME_SIDECAR_ENTRIES) {
    if (relativePath[0] === 'runtime' || relativePath[0] === 'shims') continue;
    writeFileSync(
      join(scriptsDir, ...relativePath),
      `module.exports = ${JSON.stringify(relativePath.at(-1))};\n`,
      'utf8',
    );
  }
  writeFileSync(
    join(scriptsDir, 'runtime', 'loadVoiceInferenceRuntime.mjs'),
    'export * from "../../package-dist/daemon/voiceInference/runtime/packagedVoiceInferenceRuntime.mjs";\n',
    'utf8',
  );
  writeFileSync(join(scriptsDir, 'shims', 'rg'), '#!/bin/sh\nexit 0\n', 'utf8');

  // These development-only scripts must not become part of an immutable runner payload.
  writeFileSync(join(scriptsDir, 'build-only.mjs'), 'export {};\n', 'utf8');
  writeFileSync(join(scriptsDir, 'env-wrapper.cjs'), 'module.exports = {};\n', 'utf8');

  const toolsDir = join(root, 'tools', 'unpacked');
  mkdirSync(toolsDir, { recursive: true });
  writeFileSync(join(toolsDir, 'rg'), '#!/bin/sh\nexit 0\n', 'utf8');
  return entrypoint;
}

describe('spawnHappyCLI fallback invocation', () => {
  it('falls back to tsx source entrypoint in dev mode by default when dist entrypoint is missing', async () => {
    envScope.patch({
      HAPPIER_CLI_SUBPROCESS_RUNTIME: 'node',
      HAPPIER_VARIANT: 'dev',
      HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK: undefined,
      HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: join(tmpdir(), `missing-happier-default-${Date.now()}`, 'index.mjs'),
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

  it('pins the canonical package-dist layout with only runtime sidecars and a valid closure', async () => {
    await withTempDir('happier-canonical-runner-closure-', async (root) => {
      const entrypoint = writeCanonicalRunnerClosureFixture(root);
      const fingerprint = writeDistBuildManifest(entrypoint);
      const runtimeStatePath = join(root, 'stack.runtime.json');
      writeStackRuntimeFingerprint(runtimeStatePath, fingerprint);
      patchFreshDistEnv(entrypoint, runtimeStatePath, fingerprint);

      const mod = (await import('@/utils/spawnHappyCLI')) as typeof import('@/utils/spawnHappyCLI');
      const inv = mod.buildHappyCliSubprocessInvocation(['claude', '--started-by', 'daemon']);
      const pinnedEntrypoint = inv.argv.find((arg) => arg.endsWith('index.mjs'));

      expect(pinnedEntrypoint).toMatch(
        /[\\/]\.runner-snapshots[\\/][a-f0-9]{16}-package-dist-v1[\\/]package-dist[\\/]index\.mjs$/,
      );
      const snapshotRoot = dirname(dirname(pinnedEntrypoint!));
      expect(readdirSync(join(snapshotRoot, 'scripts')).sort()).toEqual(
        CLI_RUNTIME_SIDECAR_ENTRIES.map(([topLevelEntry]) => topLevelEntry).sort(),
      );
      expect(existsSync(join(snapshotRoot, 'scripts', 'build-only.mjs'))).toBe(false);
      expect(existsSync(join(snapshotRoot, 'scripts', 'env-wrapper.cjs'))).toBe(false);
      expect(existsSync(join(snapshotRoot, 'tools', 'unpacked', 'rg'))).toBe(true);
      expect(existsSync(join(
        snapshotRoot,
        'package-dist',
        'daemon',
        'voiceInference',
        'runtime',
        'packagedVoiceInferenceRuntime.mjs',
      ))).toBe(true);

      expect(cliDistBuildManifest.readCliDistBuildManifest(pinnedEntrypoint!)).toMatchObject({
        ok: true,
        fingerprint,
      });
      expect(cliDistBuildManifest.readCliDistClosure(pinnedEntrypoint!, {
        outputDir: snapshotRoot,
      })).toMatchObject({
        ok: true,
        missing: [],
      });
    });
  });

  it('uses a pinned dist closure for stack source-daemon runner spawns when the runtime fingerprint is current', async () => {
    await withTempDir('happier-current-dist-runner-', async (root) => {
      const entrypoint = writeTinyDist(root);
      writeTinyRuntimeAssets(root);
      const fingerprint = writeDistBuildManifest(entrypoint);
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
          expect.stringMatching(
            /[\\/]\.runner-snapshots[\\/][a-f0-9]{16}-package-dist-v1[\\/]package-dist[\\/]index\.mjs$/,
          ),
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
      const snapshotRoot = dirname(dirname(pinnedEntrypoint!));
      for (const relativeAssetPath of [
        ['scripts', 'terminal_launch_spec_runner.cjs'],
        ['scripts', 'claude_local_launcher.cjs'],
        ['scripts', 'ripgrep_launcher.cjs'],
        ['scripts', 'ripgrep_runtime_paths.cjs'],
        ['tools', 'unpacked', 'rg'],
      ]) {
        expect(existsSync(join(snapshotRoot, ...relativeAssetPath))).toBe(true);
      }
      expect(existsSync(join(snapshotRoot, 'scripts', 'env-wrapper.cjs'))).toBe(false);

      const reused = mod.buildHappyCliSubprocessInvocation(['claude', '--started-by', 'daemon']);
      expect(reused.argv).toContain(pinnedEntrypoint);
    });
  });

  it('uses the admitted pinned closure for initial daemon startup before a live daemon fingerprint exists', async () => {
    await withTempDir('happier-admitted-daemon-startup-', async (root) => {
      const entrypoint = writeTinyDist(root);
      writeTinyRuntimeAssets(root);
      const fingerprint = writeDistBuildManifest(entrypoint);
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
        expect.stringMatching(
          /[\\/]\.runner-snapshots[\\/][a-f0-9]{16}-package-dist-v1[\\/]package-dist[\\/]index\.mjs$/,
        ),
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

  it('uses the admitted pinned closure after mutable dist advances to a newer publication', async () => {
    await withTempDir('happier-admitted-daemon-startup-after-dist-advance-', async (root) => {
      const entrypoint = writeTinyDist(root);
      writeTinyRuntimeAssets(root);
      const admittedFingerprint = writeDistBuildManifest(entrypoint);
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
      const successorFingerprint = writeDistBuildManifest(entrypoint);
      expect(successorFingerprint).not.toBe(admittedFingerprint);

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
      const fingerprint = writeDistBuildManifest(entrypoint);
      const runtimeStatePath = join(root, 'stack.runtime.json');
      writeStackRuntimeFingerprint(runtimeStatePath, fingerprint);
      patchFreshDistEnv(entrypoint, runtimeStatePath, fingerprint);
      envScope.patch({ HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED: '1' });

      const mod = (await import('@/utils/spawnHappyCLI')) as typeof import('@/utils/spawnHappyCLI');
      const inv = mod.buildHappyCliSubprocessInvocation(['claude', '--started-by', 'daemon']);

      expect(inv.runtime).toBe('node');
      expect(inv.argv).toEqual(expect.arrayContaining([
        expect.stringMatching(
          /[\\/]\.runner-snapshots[\\/][a-f0-9]{16}-package-dist-v1[\\/]package-dist[\\/]index\.mjs$/,
        ),
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
      const fingerprint = writeDistBuildManifest(entrypoint);
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
      const distFingerprint = writeDistBuildManifest(entrypoint);
      const admittedFingerprint = distFingerprint === '0123456789abcdef'
        ? 'fedcba9876543210'
        : '0123456789abcdef';
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
      const fingerprint = writeDistBuildManifest(entrypoint);
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

      expect(tmux.filePath).toBe(direct.filePath);
      expect(tmux.args.slice(0, runtimeDecision!.argvPrefix.length)).toEqual(runtimeDecision!.argvPrefix);
      expect(direct.args.slice(0, runtimeDecision!.argvPrefix.length)).toEqual(runtimeDecision!.argvPrefix);
      expect(tmux.args.at(-1)).toBe('tmux');
      expect(direct.args.at(-1)).toBe('plain');
    });
  });

  it('keeps runner argv parity with dist launches and pins the copied closure against mid-boot dist swaps', async () => {
    const originalExecArgv = [...process.execArgv];
    try {
      process.execArgv = ['--preserve-symlinks'];
      await withTempDir('happier-pinned-dist-runner-', async (root) => {
        const entrypoint = writeTinyDist(root, 'export const marker = "before-swap";\n');
        writeTinyRuntimeAssets(root);
        const fingerprint = writeDistBuildManifest(entrypoint);
        const runtimeStatePath = join(root, 'stack.runtime.json');
        writeStackRuntimeFingerprint(runtimeStatePath, fingerprint);
        patchFreshDistEnv(entrypoint, runtimeStatePath, fingerprint);

        const mod = (await import('@/utils/spawnHappyCLI')) as typeof import('@/utils/spawnHappyCLI');
        const inv = mod.buildHappyCliSubprocessInvocation(['codex', '--started-by', 'daemon', '--foo=bar']);

        const pinnedEntrypoint = inv.argv.find((arg) => arg.endsWith('index.mjs'));
        expect(pinnedEntrypoint).toMatch(
          /[\\/]\.runner-snapshots[\\/][a-f0-9]{16}-package-dist-v1[\\/]package-dist[\\/]index\.mjs$/,
        );
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

  it('reuses the current source entrypoint for subprocesses when the daemon itself is running from a source snapshot', async () => {
    const originalArgv = [...process.argv];
    const originalExecArgv = [...process.execArgv];
    try {
      await withTempDir('spawn-happy-cli-source-root-', async (sourceRoot) => {
        const sourceEntrypoint = join(sourceRoot, 'src', 'index.ts');
        const sourceTsconfigPath = join(sourceRoot, 'tsconfig.json');
        const inheritedTsxHook = '/external/tsx/dist/esm/index.mjs';
        mkdirSync(join(sourceRoot, 'src'), { recursive: true });
        writeFileSync(sourceEntrypoint, 'export {};\n', 'utf8');
        writeFileSync(sourceTsconfigPath, '{}\n', 'utf8');

        envScope.patch({
          HAPPIER_CLI_SUBPROCESS_RUNTIME: 'node',
          HAPPIER_VARIANT: undefined,
          HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK: undefined,
          HAPPIER_STACK_REPO_DIR: undefined,
          HAPPIER_STACK_CLI_ROOT_DIR: undefined,
          HAPPIER_STACK_STACK: undefined,
          HAPPIER_CLI_SUBPROCESS_PREFER_TSX: undefined,
          HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: undefined,
        });

        process.argv = [process.execPath, sourceEntrypoint, 'daemon', 'start-sync'];
        process.execArgv = ['--import', inheritedTsxHook];

        vi.doMock('node:fs', async () => {
          const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
          return {
            ...actual,
            existsSync: (path: string) => {
              if (path === sourceEntrypoint || path === sourceTsconfigPath) return true;
              if (path === '/Users/tester/.happier/cli-dev/current/package-dist/index.mjs') return true;
              return actual.existsSync(path);
            },
          };
        });

        vi.doMock('@/packagedRuntime/resolvePackagedRuntimeEntrypoint', () => ({
          resolvePackagedRuntimeEntrypoint: () => '/Users/tester/.happier/cli-dev/current/package-dist/index.mjs',
        }));

        const mod = (await import('@/utils/spawnHappyCLI')) as typeof import('@/utils/spawnHappyCLI');
        const inv = mod.buildHappyCliSubprocessInvocation(['claude', '--happy-starting-mode', 'remote']);

        expect(inv.runtime).toBe('node');
        expect(inv.argv).toEqual([
          '--import',
          inheritedTsxHook,
          '--no-warnings',
          '--no-deprecation',
          sourceEntrypoint,
          'claude',
          '--happy-starting-mode',
          'remote',
        ]);
        expect(inv.env).toEqual({
          TSX_TSCONFIG_PATH: sourceTsconfigPath,
        });
        expect(inv.argv).not.toEqual(expect.arrayContaining(['/Users/tester/.happier/cli-dev/current/package-dist/index.mjs']));
      });
    } finally {
      process.argv = originalArgv;
      process.execArgv = originalExecArgv;
    }
  });
});
