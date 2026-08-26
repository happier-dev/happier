import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';

import { createSpawnHappyCliEnvScope } from '@/testkit/process/spawnHappyCliHarness';
import { withTempDir } from '@/testkit/fs/tempDir';
import cliDistBuildManifest from '@happier-dev/cli-common/cliDistBuildManifest';
import { CLI_RUNTIME_SIDECAR_ENTRIES } from '@happier-dev/cli-common/componentArtifacts/cliRuntimeSidecars';
import { readCliNodeWorkspaceRuntimeIdentity } from '@happier-dev/cli-common/componentArtifacts/copyCliNodeRuntimePayload';

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
    HAPPIER_HOME_DIR: undefined,
    HAPPIER_STACK_STACK: 'qa-agent-1',
    HAPPIER_STACK_REPO_DIR: undefined,
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

function writeDistBuildManifest(
  entrypoint: string,
  options: Readonly<{
    recordRuntimeAsset?: boolean;
    workspaceRuntimeIdentity?: string;
    workspaceRuntimePackages?: readonly string[];
  }> = {},
): string {
  const written = cliDistBuildManifest.writeCliDistBuildManifest(entrypoint, {
    outputDir: dirname(entrypoint),
    builtAt: '2026-07-09T00:00:00.000Z',
    ...(options.workspaceRuntimeIdentity
      ? { workspaceRuntimeIdentity: options.workspaceRuntimeIdentity }
      : {}),
    ...(options.workspaceRuntimePackages
      ? { workspaceRuntimePackages: options.workspaceRuntimePackages }
      : {}),
  });
  const runtimeRoot = dirname(dirname(entrypoint));
  if (
    options.recordRuntimeAsset !== false
    && existsSync(join(
      runtimeRoot,
      'tools',
      'unpacked',
      'happier-cliproxyapi-managed',
    ))
  ) {
    recordManagedRuntimeAsset(entrypoint, runtimeRoot);
  }
  return written.manifest.fingerprint;
}

function writeTinyRuntimeAssets(
  root: string,
  {
    includeDevCommandWrapper = true,
    includeManagedProviderRuntime = true,
  }: Readonly<{
    includeDevCommandWrapper?: boolean;
    includeManagedProviderRuntime?: boolean;
  }> = {},
): void {
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
  if (includeManagedProviderRuntime) {
    writeFileSync(
      join(toolsDir, 'happier-cliproxyapi-managed'),
      'managed-runtime-A',
      'utf8',
    );
  }
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
  writeFileSync(
    join(toolsDir, 'happier-cliproxyapi-managed'),
    'managed-runtime-A',
    'utf8',
  );
  return entrypoint;
}

function recordManagedRuntimeAsset(entrypoint: string, root: string): void {
  const manifestPath = join(dirname(entrypoint), '.build-manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<
    string,
    unknown
  >;
  const relativePath = 'tools/unpacked/happier-cliproxyapi-managed';
  const bytes = readFileSync(join(root, ...relativePath.split('/')));
  manifest.runtimeAsset = {
    relativePath,
    byteLength: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
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
      recordManagedRuntimeAsset(entrypoint, root);
      const runtimeStatePath = join(root, 'stack.runtime.json');
      writeStackRuntimeFingerprint(runtimeStatePath, fingerprint);
      patchFreshDistEnv(entrypoint, runtimeStatePath, fingerprint);

      const mod = (await import('@/utils/spawnHappyCLI')) as typeof import('@/utils/spawnHappyCLI');
      const inv = mod.buildHappyCliSubprocessInvocation(['claude', '--started-by', 'daemon']);
      const pinnedEntrypoint = inv.argv.find((arg) => arg.endsWith('index.mjs'));

      expect(pinnedEntrypoint).toMatch(
        /[\\/]\.runner-snapshots[\\/][a-f0-9]{16}-[a-f0-9]{64}-[a-f0-9]{64}-package-dist-v5[\\/]package-dist[\\/]index\.mjs$/,
      );
      const snapshotRoot = dirname(dirname(pinnedEntrypoint!));
      expect(readdirSync(join(snapshotRoot, 'scripts')).sort()).toEqual(
        CLI_RUNTIME_SIDECAR_ENTRIES.map(([topLevelEntry]) => topLevelEntry).sort(),
      );
      expect(existsSync(join(snapshotRoot, 'scripts', 'build-only.mjs'))).toBe(false);
      expect(existsSync(join(snapshotRoot, 'scripts', 'env-wrapper.cjs'))).toBe(false);
      expect(existsSync(join(snapshotRoot, 'tools', 'unpacked', 'rg'))).toBe(true);
      expect(readFileSync(
        join(
          snapshotRoot,
          'tools',
          'unpacked',
          'happier-cliproxyapi-managed',
        ),
        'utf8',
      )).toBe('managed-runtime-A');
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
        manifest: {
          runtimeAsset: {
            relativePath: 'tools/unpacked/happier-cliproxyapi-managed',
            byteLength: Buffer.byteLength('managed-runtime-A'),
            sha256: createHash('sha256')
              .update('managed-runtime-A')
              .digest('hex'),
          },
        },
      });
      expect(cliDistBuildManifest.readCliDistClosure(pinnedEntrypoint!, {
        outputDir: dirname(pinnedEntrypoint!),
      })).toMatchObject({
        ok: true,
        missing: [],
      });
    });
  });

  it('keeps runtime-backed pinned runners in mutable stack state instead of the shared runtime snapshot', async () => {
    await withTempDir('happier-runtime-backed-runner-store-', async (root) => {
      const runtimeRoot = join(root, 'runtime', 'builds', 'snapshot-a', 'cli');
      const stackCliHome = join(root, 'stack', 'cli');
      const entrypoint = writeTinyDist(runtimeRoot);
      writeTinyRuntimeAssets(runtimeRoot);
      const fingerprint = writeDistBuildManifest(entrypoint);
      const runtimeStatePath = join(root, 'stack', 'stack.runtime.json');
      mkdirSync(dirname(runtimeStatePath), { recursive: true });
      writeStackRuntimeFingerprint(runtimeStatePath, fingerprint);
      patchFreshDistEnv(entrypoint, runtimeStatePath, fingerprint);
      envScope.patch({
        HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED: '1',
        HAPPIER_HOME_DIR: stackCliHome,
      });

      const mod = (await import('@/utils/spawnHappyCLI')) as typeof import('@/utils/spawnHappyCLI');
      const invocation = mod.buildHappyCliSubprocessInvocation(['codex', '--started-by', 'daemon']);
      const pinnedEntrypoint = invocation.argv.find((arg) => arg.endsWith('index.mjs'));

      expect(pinnedEntrypoint).toContain(join(stackCliHome, '.runner-snapshots'));
      expect(existsSync(join(runtimeRoot, '.runner-snapshots'))).toBe(false);
    });
  });

  it('requests copy-on-write cloning while pinning a runtime-backed daemon closure', async () => {
    await withTempDir('happier-runtime-backed-runner-clone-', async (root) => {
      const runtimeRoot = join(root, 'runtime', 'builds', 'snapshot-a', 'cli');
      const stackCliHome = join(root, 'stack', 'cli');
      const entrypoint = writeTinyDist(runtimeRoot);
      writeTinyRuntimeAssets(runtimeRoot);
      const fingerprint = writeDistBuildManifest(entrypoint);
      const runtimeStatePath = join(root, 'stack', 'stack.runtime.json');
      mkdirSync(dirname(runtimeStatePath), { recursive: true });
      writeStackRuntimeFingerprint(runtimeStatePath, fingerprint);
      patchFreshDistEnv(entrypoint, runtimeStatePath, fingerprint);
      envScope.patch({
        HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED: '1',
        HAPPIER_HOME_DIR: stackCliHome,
      });

      const copyModes: Array<number | undefined> = [];
      vi.doMock('node:fs', async () => {
        const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
        return {
          ...actual,
          copyFileSync: (...args: Parameters<typeof actual.copyFileSync>) => {
            copyModes.push(args[2]);
            return actual.copyFileSync(...args);
          },
        };
      });

      const mod = (await import('@/utils/spawnHappyCLI')) as typeof import('@/utils/spawnHappyCLI');
      const invocation = mod.buildHappyCliSubprocessInvocation(
        ['daemon', 'start-sync'],
        { allowAdmittedDaemonStartupClosure: true },
      );

      expect(invocation.argv).toEqual(expect.arrayContaining([
        expect.stringContaining(join(stackCliHome, '.runner-snapshots')),
      ]));
      expect(copyModes.length).toBeGreaterThan(0);
      expect(copyModes.every((mode) => mode === constants.COPYFILE_FICLONE)).toBe(true);
    });
  });

  it('keeps a complete pinned dist ready when a runtime dependency has package-local optional imports', async () => {
    await withTempDir('happier-runner-dependency-closure-', async (root) => {
      const entrypoint = writeTinyDist(root);
      writeTinyRuntimeAssets(root);
      const fingerprint = writeDistBuildManifest(entrypoint);
      const runtimeStatePath = join(root, 'stack.runtime.json');
      writeStackRuntimeFingerprint(runtimeStatePath, fingerprint);
      patchFreshDistEnv(entrypoint, runtimeStatePath, fingerprint);

      const mod = (await import('@/utils/spawnHappyCLI')) as typeof import('@/utils/spawnHappyCLI');
      const first = mod.buildHappyCliSubprocessInvocation(['claude', '--started-by', 'daemon']);
      const pinnedEntrypoint = first.argv.find((arg) => arg.endsWith('index.mjs'));
      expect(pinnedEntrypoint).toBeDefined();

      const dependencyDir = join(dirname(dirname(pinnedEntrypoint!)), 'node_modules', 'optional-runtime-dependency');
      mkdirSync(dependencyDir, { recursive: true });
      writeFileSync(join(dependencyDir, 'index.js'), 'import "./platform-optional.js";\n', 'utf8');

      const reused = mod.buildHappyCliSubprocessInvocation(['claude', '--started-by', 'daemon']);
      expect(reused.argv).toContain(pinnedEntrypoint);
    });
  });

  it('does not reuse a pre-integrity snapshot with the same dist fingerprint', async () => {
    await withTempDir('happier-pre-integrity-runner-closure-', async (root) => {
      const entrypoint = writeCanonicalRunnerClosureFixture(root);
      const fingerprint = writeDistBuildManifest(entrypoint);
      recordManagedRuntimeAsset(entrypoint, root);
      const runtimeStatePath = join(root, 'stack.runtime.json');
      writeStackRuntimeFingerprint(runtimeStatePath, fingerprint);
      patchFreshDistEnv(entrypoint, runtimeStatePath, fingerprint);

      const preIntegrityRoot = join(
        root,
        '.runner-snapshots',
        `${fingerprint}-package-dist-v1`,
      );
      const stagedEntrypoint = writeCanonicalRunnerClosureFixture(preIntegrityRoot);
      renameSync(dirname(stagedEntrypoint), join(preIntegrityRoot, 'package-dist'));
      const preIntegrityEntrypoint = join(
        preIntegrityRoot,
        'package-dist',
        'index.mjs',
      );
      expect(writeDistBuildManifest(preIntegrityEntrypoint, {
        recordRuntimeAsset: false,
      })).toBe(fingerprint);
      writeFileSync(join(preIntegrityRoot, '.fingerprint'), `${fingerprint}\n`, 'utf8');

      const mod = (await import('@/utils/spawnHappyCLI')) as typeof import('@/utils/spawnHappyCLI');
      const invocation = mod.buildHappyCliSubprocessInvocation([
        'claude',
        '--started-by',
        'daemon',
      ]);
      const pinnedEntrypoint = invocation.argv.find((arg) => arg.endsWith('index.mjs'));

      expect(pinnedEntrypoint).toBeDefined();
      expect(pinnedEntrypoint).not.toBe(preIntegrityEntrypoint);
      expect(cliDistBuildManifest.readCliRuntimeAssetIntegrity({
        runtimeRoot: dirname(dirname(pinnedEntrypoint!)),
        relativePath: 'tools/unpacked/happier-cliproxyapi-managed',
      })).toMatchObject({ ok: true });
    });
  });

  it('selects new wrapper bytes when only the recorded runtime asset changes', async () => {
    await withTempDir('happier-wrapper-only-runner-advance-', async (root) => {
      const entrypoint = writeCanonicalRunnerClosureFixture(root);
      const fingerprint = writeDistBuildManifest(entrypoint);
      const runtimeStatePath = join(root, 'stack.runtime.json');
      writeStackRuntimeFingerprint(runtimeStatePath, fingerprint);
      patchFreshDistEnv(entrypoint, runtimeStatePath, fingerprint);

      const mod = (await import('@/utils/spawnHappyCLI')) as typeof import('@/utils/spawnHappyCLI');
      const wrapperA = mod.buildHappyCliSubprocessInvocation([
        'claude',
        '--started-by',
        'daemon',
      ]);
      const wrapperAEntrypoint = wrapperA.argv.find((arg) => arg.endsWith('index.mjs'));
      expect(wrapperAEntrypoint).toBeDefined();

      writeFileSync(
        join(root, 'tools', 'unpacked', 'happier-cliproxyapi-managed'),
        'managed-runtime-B',
        'utf8',
      );
      recordManagedRuntimeAsset(entrypoint, root);

      const wrapperB = mod.buildHappyCliSubprocessInvocation([
        'claude',
        '--started-by',
        'daemon',
      ]);
      const wrapperBEntrypoint = wrapperB.argv.find((arg) => arg.endsWith('index.mjs'));
      expect(wrapperBEntrypoint).toBeDefined();
      expect(wrapperBEntrypoint).not.toBe(wrapperAEntrypoint);
      const wrapperBSnapshotRoot = dirname(dirname(wrapperBEntrypoint!));
      expect(readFileSync(join(
        wrapperBSnapshotRoot,
        'tools',
        'unpacked',
        'happier-cliproxyapi-managed',
      ), 'utf8')).toBe('managed-runtime-B');
      expect(cliDistBuildManifest.readCliRuntimeAssetIntegrity({
        runtimeRoot: wrapperBSnapshotRoot,
        relativePath: 'tools/unpacked/happier-cliproxyapi-managed',
      })).toMatchObject({ ok: true });
      expect(existsSync(dirname(dirname(wrapperAEntrypoint!)))).toBe(true);
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
            /[\\/]\.runner-snapshots[\\/][a-f0-9]{16}-[a-f0-9]{64}-[a-f0-9]{64}-package-dist-v5[\\/]package-dist[\\/]index\.mjs$/,
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
          /[\\/]\.runner-snapshots[\\/][a-f0-9]{16}-[a-f0-9]{64}-[a-f0-9]{64}-package-dist-v5[\\/]package-dist[\\/]index\.mjs$/,
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

  it('uses an admitted source-development closure without a packaged managed provider runtime', async () => {
    await withTempDir('happier-source-dev-daemon-startup-', async (root) => {
      const entrypoint = writeTinyDist(root);
      writeTinyRuntimeAssets(root, { includeManagedProviderRuntime: false });
      const fingerprint = writeDistBuildManifest(entrypoint, { recordRuntimeAsset: false });
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
          /[\\/]\.runner-snapshots[\\/][a-f0-9]{16}-[a-f0-9]{64}-[a-f0-9]{64}-package-dist-v5[\\/]package-dist[\\/]index\.mjs$/,
        ),
        'daemon',
        'start-sync',
      ]));
      const pinnedEntrypoint = startup.argv.find((arg) => arg.endsWith('index.mjs'));
      expect(pinnedEntrypoint).toBeDefined();
      expect(existsSync(join(
        dirname(dirname(pinnedEntrypoint!)),
        'tools',
        'unpacked',
        'happier-cliproxyapi-managed',
      ))).toBe(false);
    });
  });

  it('pins bundled workspace dependencies with the admitted source-development closure', async () => {
    await withTempDir('happier-source-dev-workspace-closure-', async (repoRoot) => {
      writeFileSync(join(repoRoot, 'package.json'), '{}\n', 'utf8');
      writeFileSync(join(repoRoot, 'yarn.lock'), '', 'utf8');

      const cliRoot = join(repoRoot, 'apps', 'cli');
      mkdirSync(cliRoot, { recursive: true });
      writeFileSync(join(cliRoot, 'package.json'), JSON.stringify({
        name: '@happier-dev/cli',
        dependencies: {
          '@happier-dev/protocol': 'workspace:*',
          'example-runtime': '1.0.0',
        },
        bundledDependencies: ['@happier-dev/protocol'],
      }), 'utf8');

      const externalRuntimeRoot = join(repoRoot, 'node_modules', 'example-runtime');
      mkdirSync(externalRuntimeRoot, { recursive: true });
      writeFileSync(join(externalRuntimeRoot, 'package.json'), JSON.stringify({
        name: 'example-runtime',
        version: '1.0.0',
        main: 'index.js',
      }), 'utf8');
      writeFileSync(join(externalRuntimeRoot, 'index.js'), 'module.exports = "installed";\n', 'utf8');

      const protocolRoot = join(repoRoot, 'packages', 'protocol');
      mkdirSync(join(protocolRoot, 'dist'), { recursive: true });
      writeFileSync(join(protocolRoot, 'package.json'), JSON.stringify({
        name: '@happier-dev/protocol',
        type: 'module',
        exports: { '.': './dist/index.js' },
      }), 'utf8');
      writeFileSync(
        join(protocolRoot, 'dist', 'index.js'),
        'export const generation = "admitted";\n',
        'utf8',
      );
      const installedProtocolRoot = join(
        cliRoot,
        'node_modules',
        '@happier-dev',
        'protocol',
      );
      mkdirSync(join(installedProtocolRoot, 'dist'), { recursive: true });
      writeFileSync(
        join(installedProtocolRoot, 'package.json'),
        readFileSync(join(protocolRoot, 'package.json'), 'utf8'),
        'utf8',
      );
      writeFileSync(
        join(installedProtocolRoot, 'dist', 'index.js'),
        readFileSync(join(protocolRoot, 'dist', 'index.js'), 'utf8'),
        'utf8',
      );

      const entrypoint = writeTinyDist(cliRoot);
      writeFileSync(
        entrypoint,
        'import { generation } from "@happier-dev/protocol";\nexport { generation };\n',
        'utf8',
      );
      writeTinyRuntimeAssets(cliRoot, { includeManagedProviderRuntime: false });
      const workspaceRuntimeIdentity = readCliNodeWorkspaceRuntimeIdentity({
        repoRoot,
      }).fingerprint;
      const fingerprint = writeDistBuildManifest(entrypoint, {
        recordRuntimeAsset: false,
        workspaceRuntimeIdentity,
      });
      const runtimeStatePath = join(repoRoot, 'stack.runtime.json');
      writeStackRuntimeFingerprint(runtimeStatePath, null);
      patchFreshDistEnv(entrypoint, runtimeStatePath, fingerprint);
      envScope.patch({ HAPPIER_STACK_REPO_DIR: repoRoot });

      const mod = (await import('@/utils/spawnHappyCLI')) as typeof import('@/utils/spawnHappyCLI');
      const startup = mod.buildHappyCliSubprocessInvocation(
        ['daemon', 'start-sync'],
        { allowAdmittedDaemonStartupClosure: true },
      );
      const pinnedEntrypoint = startup.argv.find((arg) => arg.endsWith('index.mjs'));
      expect(pinnedEntrypoint).toBeDefined();
      const pinnedProtocolEntrypoint = join(
        dirname(dirname(pinnedEntrypoint!)),
        'node_modules',
        '@happier-dev',
        'protocol',
        'dist',
        'index.js',
      );

      expect(readFileSync(pinnedProtocolEntrypoint, 'utf8')).toContain('"admitted"');
      expect(existsSync(join(
        dirname(dirname(pinnedEntrypoint!)),
        'node_modules',
        'example-runtime',
      ))).toBe(false);
      writeFileSync(
        join(protocolRoot, 'dist', 'index.js'),
        'export const generation = "successor";\n',
        'utf8',
      );
      expect(readFileSync(pinnedProtocolEntrypoint, 'utf8')).toContain('"admitted"');
    });
  });

  it('pins runtime-backed workspace dependencies from the admitted artifact instead of the live checkout', async () => {
    await withTempDir('happier-runtime-backed-workspace-closure-', async (repoRoot) => {
      const workspacePackageName = '@happier-dev/protocol';
      const workspacePackageJson = `${JSON.stringify({
        name: workspacePackageName,
        private: true,
        type: 'module',
        exports: { '.': './dist/index.js' },
      }, null, 2)}\n`;
      const workspacePackageSource = 'export const generation = "admitted";\n';
      const sourcePackageRoot = join(repoRoot, 'packages', 'protocol');
      mkdirSync(join(sourcePackageRoot, 'dist'), { recursive: true });
      writeFileSync(join(sourcePackageRoot, 'package.json'), workspacePackageJson, 'utf8');
      writeFileSync(join(sourcePackageRoot, 'dist', 'index.js'), workspacePackageSource, 'utf8');

      const buildHostRoot = join(repoRoot, 'artifact-build-host');
      mkdirSync(buildHostRoot, { recursive: true });
      writeFileSync(join(buildHostRoot, 'package.json'), JSON.stringify({
        name: '@happier-dev/cli',
        dependencies: { [workspacePackageName]: 'workspace:*' },
        bundledDependencies: [workspacePackageName],
      }), 'utf8');
      const buildHostProtocolRoot = join(
        buildHostRoot,
        'node_modules',
        '@happier-dev',
        'protocol',
      );
      mkdirSync(join(buildHostProtocolRoot, 'dist'), { recursive: true });
      writeFileSync(join(buildHostProtocolRoot, 'package.json'), workspacePackageJson, 'utf8');
      writeFileSync(join(buildHostProtocolRoot, 'dist', 'index.js'), workspacePackageSource, 'utf8');
      const workspaceRuntimeIdentity = readCliNodeWorkspaceRuntimeIdentity({
        repoRoot,
        hostPackageDir: buildHostRoot,
      }).fingerprint;

      const runtimeRoot = join(repoRoot, 'runtime-artifact');
      const runtimeProtocolRoot = join(
        runtimeRoot,
        'node_modules',
        '@happier-dev',
        'protocol',
      );
      mkdirSync(join(runtimeProtocolRoot, 'dist'), { recursive: true });
      writeFileSync(join(runtimeProtocolRoot, 'package.json'), workspacePackageJson, 'utf8');
      writeFileSync(join(runtimeProtocolRoot, 'dist', 'index.js'), workspacePackageSource, 'utf8');
      const entrypoint = writeTinyDist(runtimeRoot);
      writeTinyRuntimeAssets(runtimeRoot);
      const fingerprint = writeDistBuildManifest(entrypoint, {
        workspaceRuntimeIdentity,
        workspaceRuntimePackages: [workspacePackageName],
      });

      const liveRepoRoot = join(repoRoot, 'live-checkout');
      const liveCliRoot = join(liveRepoRoot, 'apps', 'cli');
      mkdirSync(liveCliRoot, { recursive: true });
      writeFileSync(join(liveRepoRoot, 'package.json'), '{}\n', 'utf8');
      writeFileSync(join(liveRepoRoot, 'yarn.lock'), '', 'utf8');
      writeFileSync(join(liveCliRoot, 'package.json'), JSON.stringify({
        name: '@happier-dev/cli',
        dependencies: { [workspacePackageName]: 'workspace:*' },
        bundledDependencies: [workspacePackageName],
      }), 'utf8');
      const liveProtocolSourceRoot = join(liveRepoRoot, 'packages', 'protocol');
      mkdirSync(join(liveProtocolSourceRoot, 'dist'), { recursive: true });
      writeFileSync(join(liveProtocolSourceRoot, 'package.json'), workspacePackageJson, 'utf8');
      writeFileSync(
        join(liveProtocolSourceRoot, 'dist', 'index.js'),
        'export const generation = "successor";\n',
        'utf8',
      );

      const runtimeStatePath = join(repoRoot, 'stack.runtime.json');
      writeStackRuntimeFingerprint(runtimeStatePath, fingerprint);
      patchFreshDistEnv(entrypoint, runtimeStatePath, fingerprint);
      envScope.patch({
        HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED: '1',
        HAPPIER_STACK_REPO_DIR: liveRepoRoot,
      });

      const mod = (await import('@/utils/spawnHappyCLI')) as typeof import('@/utils/spawnHappyCLI');
      const startup = mod.buildHappyCliSubprocessInvocation(
        ['daemon', 'start-sync'],
        { allowAdmittedDaemonStartupClosure: true },
      );
      const pinnedEntrypoint = startup.argv.find((arg) => arg.endsWith('index.mjs'));
      expect(pinnedEntrypoint).toBeDefined();
      expect(readFileSync(join(
        dirname(dirname(pinnedEntrypoint!)),
        'node_modules',
        '@happier-dev',
        'protocol',
        'dist',
        'index.js',
      ), 'utf8')).toContain('"admitted"');
    });
  }, 60_000);

  it('pins last-green CLI code with the current coherent source workspace runtime', async () => {
    await withTempDir('happier-source-dev-workspace-mismatch-', async (repoRoot) => {
      writeFileSync(join(repoRoot, 'package.json'), '{}\n', 'utf8');
      writeFileSync(join(repoRoot, 'yarn.lock'), '', 'utf8');

      const cliRoot = join(repoRoot, 'apps', 'cli');
      mkdirSync(cliRoot, { recursive: true });
      writeFileSync(join(cliRoot, 'package.json'), JSON.stringify({
        name: '@happier-dev/cli',
        dependencies: { '@happier-dev/protocol': 'workspace:*' },
        bundledDependencies: ['@happier-dev/protocol'],
      }), 'utf8');

      const protocolRoot = join(repoRoot, 'packages', 'protocol');
      mkdirSync(join(protocolRoot, 'dist'), { recursive: true });
      writeFileSync(join(protocolRoot, 'package.json'), JSON.stringify({
        name: '@happier-dev/protocol',
        type: 'module',
        exports: { '.': './dist/index.js' },
      }), 'utf8');
      writeFileSync(
        join(protocolRoot, 'dist', 'index.js'),
        'export const generation = "successor";\n',
        'utf8',
      );
      const installedProtocolRoot = join(
        cliRoot,
        'node_modules',
        '@happier-dev',
        'protocol',
      );
      mkdirSync(join(installedProtocolRoot, 'dist'), { recursive: true });
      writeFileSync(
        join(installedProtocolRoot, 'package.json'),
        readFileSync(join(protocolRoot, 'package.json'), 'utf8'),
        'utf8',
      );
      writeFileSync(
        join(installedProtocolRoot, 'dist', 'index.js'),
        readFileSync(join(protocolRoot, 'dist', 'index.js'), 'utf8'),
        'utf8',
      );
      const currentWorkspaceRuntime = readCliNodeWorkspaceRuntimeIdentity({ repoRoot });

      const entrypoint = writeTinyDist(cliRoot);
      writeTinyRuntimeAssets(cliRoot, { includeManagedProviderRuntime: false });
      const fingerprint = writeDistBuildManifest(entrypoint, {
        recordRuntimeAsset: false,
        workspaceRuntimeIdentity: 'a'.repeat(64),
        workspaceRuntimePackages: ['@happier-dev/protocol'],
      });
      const runtimeStatePath = join(repoRoot, 'stack.runtime.json');
      writeStackRuntimeFingerprint(runtimeStatePath, null);
      patchFreshDistEnv(entrypoint, runtimeStatePath, fingerprint);
      envScope.patch({ HAPPIER_STACK_REPO_DIR: repoRoot });

      const mod = (await import('@/utils/spawnHappyCLI')) as typeof import('@/utils/spawnHappyCLI');
      const invocation = mod.buildHappyCliSubprocessInvocation(
        ['daemon', 'start-sync'],
        { allowAdmittedDaemonStartupClosure: true },
      );
      const pinnedEntrypoint = invocation.argv.find((arg) => arg.endsWith('index.mjs'));
      expect(pinnedEntrypoint).toBeDefined();
      expect(pinnedEntrypoint).not.toBe(entrypoint);
      expect(readFileSync(join(
        dirname(dirname(pinnedEntrypoint!)),
        'node_modules',
        '@happier-dev',
        'protocol',
        'dist',
        'index.js',
      ), 'utf8')).toContain('"successor"');
      expect(cliDistBuildManifest.readCliDistBuildManifest(pinnedEntrypoint!)).toMatchObject({
        ok: true,
        manifest: {
          workspaceRuntimeIdentity: currentWorkspaceRuntime.fingerprint,
          workspaceRuntimePackages: currentWorkspaceRuntime.packageNames,
        },
      });
      expect(cliDistBuildManifest.readCliDistBuildManifest(entrypoint)).toMatchObject({
        ok: true,
        manifest: { workspaceRuntimeIdentity: 'a'.repeat(64) },
      });
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

  it('starts the daemon from the newest ready pinned closure when a synced successor cannot be reconstructed', async () => {
    await withTempDir('happier-daemon-startup-last-green-closure-', async (root) => {
      const entrypoint = writeTinyDist(root, 'export const marker = "last-green";\n');
      writeTinyRuntimeAssets(root);
      const lastGreenFingerprint = writeDistBuildManifest(entrypoint);
      const runtimeStatePath = join(root, 'stack.runtime.json');
      writeStackRuntimeFingerprint(runtimeStatePath, null);
      patchFreshDistEnv(entrypoint, runtimeStatePath, lastGreenFingerprint);

      const mod = (await import('@/utils/spawnHappyCLI')) as typeof import('@/utils/spawnHappyCLI');
      const lastGreen = mod.buildHappyCliSubprocessInvocation(
        ['daemon', 'start-sync'],
        { allowAdmittedDaemonStartupClosure: true },
      );
      const lastGreenEntrypoint = lastGreen.argv.find((arg) => arg.endsWith('index.mjs'));
      expect(lastGreenEntrypoint).toBeDefined();

      writeFileSync(join(dirname(entrypoint), 'chunk.mjs'), 'export const marker = "synced-successor";\n', 'utf8');
      const successorFingerprint = writeDistBuildManifest(entrypoint, {
        workspaceRuntimeIdentity: 'a'.repeat(64),
        workspaceRuntimePackages: ['@happier-dev/protocol'],
      });
      expect(successorFingerprint).not.toBe(lastGreenFingerprint);
      patchFreshDistEnv(entrypoint, runtimeStatePath, successorFingerprint);
      envScope.patch({ HAPPIER_STACK_REPO_DIR: root });

      const startup = mod.buildHappyCliSubprocessInvocation(
        ['daemon', 'start-sync'],
        { allowAdmittedDaemonStartupClosure: true },
      );

      expect(startup.argv).toContain(lastGreenEntrypoint);
      expect(startup.argv).not.toContain(entrypoint);
      expect(startup.env).toMatchObject({
        HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT: lastGreenFingerprint,
      });
    });
  });

  it('refuses an arbitrary last-green closure while Stack holds the exact publication lease', async () => {
    await withTempDir('happier-daemon-startup-exact-publication-lease-', async (root) => {
      const entrypoint = writeTinyDist(root, 'export const marker = "last-green";\n');
      writeTinyRuntimeAssets(root);
      const lastGreenFingerprint = writeDistBuildManifest(entrypoint);
      const runtimeStatePath = join(root, 'stack.runtime.json');
      writeStackRuntimeFingerprint(runtimeStatePath, null);
      patchFreshDistEnv(entrypoint, runtimeStatePath, lastGreenFingerprint);

      const mod = (await import('@/utils/spawnHappyCLI')) as typeof import('@/utils/spawnHappyCLI');
      const lastGreen = mod.buildHappyCliSubprocessInvocation(
        ['daemon', 'start-sync'],
        { allowAdmittedDaemonStartupClosure: true },
      );
      const lastGreenEntrypoint = lastGreen.argv.find((arg) => arg.endsWith('index.mjs'));
      expect(lastGreenEntrypoint).toBeDefined();

      writeFileSync(join(dirname(entrypoint), 'chunk.mjs'), 'export const marker = "synced-successor";\n', 'utf8');
      const successorFingerprint = writeDistBuildManifest(entrypoint, {
        workspaceRuntimeIdentity: 'a'.repeat(64),
        workspaceRuntimePackages: ['@happier-dev/protocol'],
      });
      expect(successorFingerprint).not.toBe(lastGreenFingerprint);
      patchFreshDistEnv(entrypoint, runtimeStatePath, successorFingerprint);
      envScope.patch({
        HAPPIER_STACK_REPO_DIR: root,
        HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: '{"path":"exact-publication-lease","token":"fixture"}',
      });

      expect(() => mod.buildHappyCliSubprocessInvocation(
        ['daemon', 'start-sync'],
        { allowAdmittedDaemonStartupClosure: true },
      )).toThrow(expect.objectContaining({
        name: 'HappyCliImmutableRuntimeClosureError',
        code: 'EIMMUTABLERUNNERCLOSURE',
      }));
      expect(existsSync(lastGreenEntrypoint!)).toBe(true);
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
          /[\\/]\.runner-snapshots[\\/][a-f0-9]{16}-[a-f0-9]{64}-[a-f0-9]{64}-package-dist-v5[\\/]package-dist[\\/]index\.mjs$/,
        ),
        'claude',
        '--started-by',
        'daemon',
      ]));
      expect(inv.argv).not.toContain('--import');
    });
  });

  it('uses an admitted Node snapshot for a runtime-backed Bun daemon and passes that snapshot provenance to its child', async () => {
    await withTempDir('happier-runtime-backed-bun-runner-', async (root) => {
      const entrypoint = writeTinyDist(root);
      writeTinyRuntimeAssets(root, { includeDevCommandWrapper: false });
      const fingerprint = writeDistBuildManifest(entrypoint);
      const runtimeStatePath = join(root, 'stack.runtime.json');
      writeStackRuntimeFingerprint(runtimeStatePath, fingerprint);
      patchFreshDistEnv(entrypoint, runtimeStatePath, fingerprint);
      envScope.patch({
        HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED: '1',
        HAPPIER_CLI_SUBPROCESS_RUNTIME: 'bun',
      });

      const mod = (await import('@/utils/spawnHappyCLI')) as typeof import('@/utils/spawnHappyCLI');
      const runtimeDecision = mod.resolveHappyCliSubprocessRuntimeDecision();

      expect(runtimeDecision).not.toBeNull();
      expect(runtimeDecision?.runtime).toBe('node');
      const pinnedEntrypoint = runtimeDecision?.argvPrefix.find((arg) => arg.endsWith('index.mjs'));
      expect(pinnedEntrypoint).toMatch(
        /[\\/]\.runner-snapshots[\\/][a-f0-9]{16}-[a-f0-9]{64}-[a-f0-9]{64}-package-dist-v5[\\/]package-dist[\\/]index\.mjs$/,
      );
      expect(runtimeDecision?.env).toEqual({
        HAPPIER_CLI_SUBPROCESS_DIST_ENTRYPOINT: pinnedEntrypoint,
        HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT: fingerprint,
      });
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
      expect(readdirSync(join(root, 'cli', '.runner-snapshots'))
        .filter((name) => !name.startsWith('.'))).toEqual([]);
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

  it('fails typed without interpreting a malformed admitted fingerprint as a pattern', async () => {
    await withTempDir('happier-runtime-backed-runner-malformed-fingerprint-', async (root) => {
      const entrypoint = writeTinyDist(root);
      writeTinyRuntimeAssets(root);
      writeDistBuildManifest(entrypoint);
      const runtimeStatePath = join(root, 'stack.runtime.json');
      writeStackRuntimeFingerprint(runtimeStatePath, '(');
      patchFreshDistEnv(entrypoint, runtimeStatePath, '(');
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
          /[\\/]\.runner-snapshots[\\/][a-f0-9]{16}-[a-f0-9]{64}-[a-f0-9]{64}-package-dist-v5[\\/]package-dist[\\/]index\.mjs$/,
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

  it('prunes dead pinned runner snapshots from authoritative daemon startup liveness', async () => {
    await withTempDir('happier-pinned-dist-startup-prune-', async (root) => {
      const entrypoint = writeTinyDist(root);
      writeTinyRuntimeAssets(root);
      const fingerprint = writeDistBuildManifest(entrypoint);
      const runtimeStatePath = join(root, 'stack.runtime.json');
      writeStackRuntimeFingerprint(runtimeStatePath, fingerprint);
      patchFreshDistEnv(entrypoint, runtimeStatePath, fingerprint);

      const mod = (await import('@/utils/spawnHappyCLI')) as typeof import('@/utils/spawnHappyCLI');
      const invocation = mod.buildHappyCliSubprocessInvocation([
        'daemon',
        'start-sync',
      ]);
      const pinnedEntrypoint = invocation.argv.find((arg) => arg.endsWith('index.mjs'));
      expect(pinnedEntrypoint).toBeDefined();
      const snapshotIdentity = basename(dirname(dirname(pinnedEntrypoint!)));
      const liveIdentity = `1111111111111111-${'1'.repeat(64)}-${'2'.repeat(64)}-package-dist-v5`;
      const snapshotsDir = join(root, '.runner-snapshots');
      for (const [index, name] of [
        snapshotIdentity,
        liveIdentity,
        ...Array.from({ length: 10 }, (_, deadIndex) => `dead${String(deadIndex).padStart(12, '0')}`),
      ].entries()) {
        const snapshotDir = join(snapshotsDir, name);
        mkdirSync(snapshotDir, { recursive: true });
        utimesSync(snapshotDir, index + 1, index + 1);
      }

      mod.pruneHappyCliRunnerSnapshots({
        reliable: true,
        fingerprints: new Set([liveIdentity]),
      });

      expect(existsSync(join(snapshotsDir, snapshotIdentity))).toBe(true);
      expect(existsSync(join(snapshotsDir, liveIdentity))).toBe(true);
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

/**
 * F-STACK-2b: every daemon artifact built on 2026-08-23 shipped five plugin manifests declaring
 * seven resource files the payload did not contain. `isPinnedRunnerSnapshotReady` refused —
 * correctly — but the operator saw only `HappyCliImmutableRuntimeClosureError`, identical to the
 * ~8 other causes that return null here, with nothing naming a file. Root-causing it needed the
 * whole decision replicated offline. The refusal must name what is missing.
 */
describe('immutable runner closure refusal diagnosability', () => {
  it('names the plugin resources missing from the artifact when it refuses the admitted closure', async () => {
    await withTempDir('happier-runner-closure-refusal-reason-', async (repoRoot) => {
      const workspacePackageName = '@happier-dev/plugins-example';
      const workspacePackageJson = `${JSON.stringify({
        name: workspacePackageName,
        private: true,
        type: 'module',
        exports: { '.': './dist/index.js' },
      })}\n`;
      const pluginManifest = `${JSON.stringify({
        id: 'happier.example',
        contributes: {
          resources: [
            { id: 'brand', path: 'assets/brand.png' },
            { id: 'prompt', path: './resources/review-prompt.md' },
          ],
        },
      })}\n`;

      // The exact artifact shape: the manifest ships, the bytes it declares do not.
      const writeBundledPluginTree = (packageRoot: string): void => {
        mkdirSync(join(packageRoot, 'dist'), { recursive: true });
        writeFileSync(join(packageRoot, 'package.json'), workspacePackageJson, 'utf8');
        writeFileSync(join(packageRoot, 'dist', 'index.js'), 'export const generation = "admitted";\n', 'utf8');
        mkdirSync(join(packageRoot, '.happier-plugin'), { recursive: true });
        writeFileSync(join(packageRoot, '.happier-plugin', 'plugin.json'), pluginManifest, 'utf8');
        mkdirSync(join(packageRoot, 'resources'), { recursive: true });
        writeFileSync(join(packageRoot, 'resources', 'review-prompt.md'), '# Prompt\n', 'utf8');
      };

      mkdirSync(join(repoRoot, 'packages', 'plugins', 'example', 'dist'), { recursive: true });
      writeFileSync(
        join(repoRoot, 'packages', 'plugins', 'example', 'package.json'),
        workspacePackageJson,
        'utf8',
      );
      writeFileSync(
        join(repoRoot, 'packages', 'plugins', 'example', 'dist', 'index.js'),
        'export const generation = "source";\n',
        'utf8',
      );

      const buildHostRoot = join(repoRoot, 'artifact-build-host');
      mkdirSync(buildHostRoot, { recursive: true });
      writeFileSync(join(buildHostRoot, 'package.json'), JSON.stringify({
        name: '@happier-dev/cli',
        dependencies: { [workspacePackageName]: 'workspace:*' },
        bundledDependencies: [workspacePackageName],
      }), 'utf8');
      writeBundledPluginTree(join(buildHostRoot, 'node_modules', '@happier-dev', 'plugins-example'));
      const workspaceRuntimeIdentity = readCliNodeWorkspaceRuntimeIdentity({
        repoRoot,
        hostPackageDir: buildHostRoot,
      }).fingerprint;

      const runtimeRoot = join(repoRoot, 'runtime-artifact');
      writeBundledPluginTree(join(runtimeRoot, 'node_modules', '@happier-dev', 'plugins-example'));
      const entrypoint = writeTinyDist(runtimeRoot);
      writeTinyRuntimeAssets(runtimeRoot);
      const fingerprint = writeDistBuildManifest(entrypoint, {
        workspaceRuntimeIdentity,
        workspaceRuntimePackages: [workspacePackageName],
      });

      const runtimeStatePath = join(repoRoot, 'stack.runtime.json');
      writeStackRuntimeFingerprint(runtimeStatePath, fingerprint);
      patchFreshDistEnv(entrypoint, runtimeStatePath, fingerprint);
      envScope.patch({ HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED: '1' });

      const mod = (await import('@/utils/spawnHappyCLI')) as typeof import('@/utils/spawnHappyCLI');
      let thrown: unknown;
      try {
        mod.buildHappyCliSubprocessInvocation(
          ['daemon', 'start-sync'],
          { allowAdmittedDaemonStartupClosure: true },
        );
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toMatchObject({ name: 'HappyCliImmutableRuntimeClosureError' });
      const message = String((thrown as { message?: unknown })?.message ?? '');
      expect(message).toContain('assets/brand.png');
      expect(message).toContain('@happier-dev/plugins-example');
      // The resource the artifact *can* serve must not be reported as a cause.
      expect(message).not.toContain('review-prompt.md');
    });
  }, 60_000);
});
