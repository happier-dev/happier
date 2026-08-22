import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it, vi } from 'vitest';

import { createPluginManifestV2Fixture } from '../testkit/manifestV2Fixture';
import { ensureManagedJavaScriptRuntimeCommand } from '@/packagedRuntime/js/managedJavaScriptRuntime';
import { PluginAuthorBundlerUnavailableError } from './bundleDaemonRuntime';
import {
  assertPluginAuthorPrepublicationRuntimeDeclarations,
  cleanupPluginAuthorGeneratedArtifacts,
  resolvePluginAuthorToolchainSpawnInvocation,
  resolveNativeTypeScriptBin,
  resolvePluginUiBuildBin,
  runPluginAuthorToolchain,
  type PluginAuthorToolchainDeps,
} from './toolchain';
import {
  cleanupPluginDaemonOutputManifest,
  PLUGIN_DAEMON_OUTPUT_MANIFEST_RELATIVE_PATH,
  writePluginDaemonOutputManifest,
} from './daemonOutputManifest';

const execFileAsync = promisify(execFile);

function successfulSpawn() {
  return Promise.resolve({ exitCode: 0, signal: null, stdout: '', stderr: '' });
}

async function createColdAuthorBuildFixture(manifest: Readonly<Record<string, unknown>>): Promise<{
  projectRoot: string;
  cleanup: () => Promise<void>;
}> {
  const projectRoot = await mkdtemp(join(tmpdir(), 'happier-author-toolchain-classification-'));
  await mkdir(join(projectRoot, '.happier-plugin'), { recursive: true });
  await writeFile(
    join(projectRoot, '.happier-plugin', 'plugin.json'),
    `${JSON.stringify(manifest)}\n`,
    'utf8',
  );
  await writeFile(join(projectRoot, 'index.ts'), 'export {}\n', 'utf8');
  return {
    projectRoot,
    cleanup: async () => await rm(projectRoot, { recursive: true, force: true }),
  };
}

describe('resolvePluginAuthorToolchainSpawnInvocation', () => {
  it('wraps the managed Windows JavaScript runtime command shim through cmd.exe', () => {
    const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    if (!originalPlatformDescriptor) {
      throw new Error('Expected process.platform to be configurable for this test');
    }
    Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'win32' });
    try {
      const invocation = resolvePluginAuthorToolchainSpawnInvocation({
        command: 'C:\\Users\\Alice Smith\\.happier\\tools\\js-runtime\\current\\bin\\happier-js-runtime.cmd',
        args: ['C:\\plugin source\\node_modules\\@typescript\\native\\bin\\tsc.js', '--noEmit'],
        cwd: 'C:\\plugin source',
        env: {
          ComSpec: 'C:\\Windows\\System32\\cmd.exe',
          PATH: 'C:\\Windows\\System32',
          PATHEXT: '.COM;.EXE;.BAT;.CMD',
        },
      });
      expect(invocation.command).toBe('C:\\Windows\\System32\\cmd.exe');
      expect(invocation.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
      expect(invocation.args[3]).toContain('happier-js-runtime.cmd');
      expect(invocation.args[3]).toContain('@typescript');
      expect(invocation.cwd).toBe('C:\\plugin source');
      expect(invocation.windowsVerbatimArguments).toBe(true);
    } finally {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    }
  });
});

describe('assertPluginAuthorPrepublicationRuntimeDeclarations', () => {
  it('accepts prepublication packages declared as physically bundled by a packaged CLI', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'happier-author-packaged-runtime-'));
    try {
      await writeFile(join(runtimeRoot, 'package.json'), JSON.stringify({
        name: '@happier-dev/cli',
        dependencies: {},
        bundledDependencies: [
          '@happier-dev/plugin-sdk',
          '@happier-dev/plugin-ui',
        ],
      }), 'utf8');

      const physicalRuntimeRoot = await realpath(runtimeRoot);
      expect(() => assertPluginAuthorPrepublicationRuntimeDeclarations(physicalRuntimeRoot))
        .not.toThrow();
    } finally {
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  });
});

describe('runPluginAuthorToolchain', () => {
  it('cleans stale executable outputs before a descriptor-only compiler emit', async () => {
    const fixture = await createColdAuthorBuildFixture(createPluginManifestV2Fixture({ entrypoints: undefined }));
    const chunksDirectory = join(fixture.projectRoot, 'dist', '.happier-chunks');
    const actionsDirectory = join(fixture.projectRoot, 'dist', 'actions');
    try {
      await mkdir(chunksDirectory, { recursive: true });
      await mkdir(actionsDirectory, { recursive: true });
      await writeFile(join(fixture.projectRoot, 'dist', 'daemon.js'), 'stale daemon\n', 'utf8');
      await writeFile(join(chunksDirectory, 'chunk-stale.js'), 'stale chunk\n', 'utf8');
      await writeFile(
        join(actionsDirectory, 'index.js'),
        'export const authorOwned = true;\n',
        'utf8',
      );
      await writeFile(join(fixture.projectRoot, 'dist', 'source-owned.js'), 'stale daemon\n', 'utf8');
      await writeFile(
        join(fixture.projectRoot, PLUGIN_DAEMON_OUTPUT_MANIFEST_RELATIVE_PATH),
        `${JSON.stringify({ version: 1, outputs: ['dist/source-owned.js'] })}\n`,
        'utf8',
      );
      const spawn = vi.fn(async () => {
        await writeFile(join(fixture.projectRoot, 'dist', 'index.js'), 'fresh descriptor output\n', 'utf8');
        return await successfulSpawn();
      });
      const result = await runPluginAuthorToolchain({
        operation: 'build',
        projectRoot: fixture.projectRoot,
      }, {
        ensureManagedPnpmCommand: async () => '/happier/tools/pnpm/current/bin/pnpm',
        managedPnpmBinPath: () => '/happier/tools/pnpm/current/bin/pnpm',
        managedJavaScriptRuntimeBinPath: () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
        buildManagedPnpmEnvironment: (env = {}) => env,
        ensureManagedJavaScriptRuntimeCommand: async () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
        resolveNativeTypeScriptBin: () => '/fixture/plugin/node_modules/@typescript/native/bin/tsc',
        resolvePluginUiBuildBin: () => null,
        spawn,
        processEnv: {},
      });

      expect(result).toMatchObject({ ok: true, operation: 'build' });
      await expect(readFile(join(fixture.projectRoot, 'dist', 'index.js'), 'utf8'))
        .resolves.toBe('fresh descriptor output\n');
      await expect(readFile(join(fixture.projectRoot, 'dist', 'daemon.js'), 'utf8'))
        .resolves.toBe('stale daemon\n');
      await expect(readFile(join(chunksDirectory, 'chunk-stale.js'), 'utf8'))
        .resolves.toBe('stale chunk\n');
      await expect(readFile(join(actionsDirectory, 'index.js'), 'utf8'))
        .resolves.toBe('export const authorOwned = true;\n');
      await expect(readFile(join(fixture.projectRoot, 'dist', 'source-owned.js'), 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fixture.cleanup();
    }
  });

  it('preserves unmarked daemon and chunk files while removing a marker-owned Action contract', async () => {
    const fixture = await createColdAuthorBuildFixture(createPluginManifestV2Fixture({ entrypoints: undefined }));
    const chunksDirectory = join(fixture.projectRoot, 'dist', '.happier-chunks');
    const actionsDirectory = join(fixture.projectRoot, 'dist', 'actions');
    try {
      await mkdir(chunksDirectory, { recursive: true });
      await mkdir(actionsDirectory, { recursive: true });
      await writeFile(join(fixture.projectRoot, 'dist', 'daemon.js'), 'stale daemon\n', 'utf8');
      await writeFile(join(chunksDirectory, 'chunk-stale.js'), 'stale chunk\n', 'utf8');
      await writeFile(
        join(actionsDirectory, 'index.js'),
        '// Generated by the Happier plugin authoring toolchain; do not edit.\n',
        'utf8',
      );

      await cleanupPluginAuthorGeneratedArtifacts(fixture.projectRoot);

      await expect(readFile(join(fixture.projectRoot, 'dist', 'daemon.js'), 'utf8'))
        .resolves.toBe('stale daemon\n');
      await expect(readFile(join(chunksDirectory, 'chunk-stale.js'), 'utf8'))
        .resolves.toBe('stale chunk\n');
      await expect(readFile(join(actionsDirectory, 'index.js'), 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fixture.cleanup();
    }
  });

  it('fails closed when the plugin metadata directory is a symlink outside the project during marker write', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'happier-daemon-output-marker-write-symlink-'));
    const projectRoot = join(parent, 'project');
    const outsideRoot = join(parent, 'outside');
    try {
      await mkdir(projectRoot, { recursive: true });
      await mkdir(outsideRoot, { recursive: true });
      await symlink(
        outsideRoot,
        join(projectRoot, '.happier-plugin'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );

      await expect(writePluginDaemonOutputManifest({
        projectRoot,
        outputRelativePaths: ['dist/daemon.js'],
      })).rejects.toThrow(/physical|outside|symbolic|symlink/u);
      await expect(readFile(
        join(outsideRoot, '.happier-daemon-outputs.json'),
        'utf8',
      )).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('fails closed when cleanup sees an output marker through a metadata symlink outside the project', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'happier-daemon-output-marker-cleanup-symlink-'));
    const projectRoot = join(parent, 'project');
    const outsideRoot = join(parent, 'outside');
    const outsideMarkerPath = join(outsideRoot, '.happier-daemon-outputs.json');
    try {
      await mkdir(projectRoot, { recursive: true });
      await mkdir(outsideRoot, { recursive: true });
      await symlink(
        outsideRoot,
        join(projectRoot, '.happier-plugin'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      await writeFile(
        outsideMarkerPath,
        `${JSON.stringify({ version: 1, outputs: [] })}\n`,
        'utf8',
      );

      await expect(cleanupPluginDaemonOutputManifest(projectRoot))
        .rejects.toThrow(/physical|outside|symbolic|symlink/u);
      await expect(readFile(outsideMarkerPath, 'utf8'))
        .resolves.toContain('"outputs":[]');
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('removes a previously generated custom daemon output while preserving unrelated descriptor output', async () => {
    const fixture = await createColdAuthorBuildFixture(createPluginManifestV2Fixture({
      entrypoints: undefined,
    }));
    try {
      await mkdir(join(fixture.projectRoot, 'dist'), { recursive: true });
      await writeFile(join(fixture.projectRoot, 'dist', 'source-owned.js'), 'stale daemon\n', 'utf8');
      await writeFile(join(fixture.projectRoot, 'dist', 'descriptor-owned.js'), 'fresh descriptor\n', 'utf8');
      await writeFile(
        join(fixture.projectRoot, PLUGIN_DAEMON_OUTPUT_MANIFEST_RELATIVE_PATH),
        `${JSON.stringify({ version: 1, outputs: ['dist/source-owned.js'] })}\n`,
        'utf8',
      );

      await cleanupPluginAuthorGeneratedArtifacts(fixture.projectRoot);

      await expect(readFile(join(fixture.projectRoot, 'dist', 'source-owned.js'), 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(join(fixture.projectRoot, 'dist', 'descriptor-owned.js'), 'utf8'))
        .resolves.toBe('fresh descriptor\n');
      await expect(readFile(
        join(fixture.projectRoot, PLUGIN_DAEMON_OUTPUT_MANIFEST_RELATIVE_PATH),
        'utf8',
      )).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fixture.cleanup();
    }
  });

  it.each(['build', 'test'] as const)('retires the previous executable output claim before %s compiler output can re-own its path', async (operation) => {
    const fixture = await createColdAuthorBuildFixture(createPluginManifestV2Fixture({
      entrypoints: { daemon: './dist/current-daemon.js' },
    }));
    const priorDaemonPath = join(fixture.projectRoot, 'dist', 'previous-daemon.js');
    const currentDaemonPath = join(fixture.projectRoot, 'dist', 'current-daemon.js');
    const sourceOwnedPath = join(fixture.projectRoot, 'dist', 'source-owned.js');
    let previousOutputWasRetiredBeforeCompile = false;
    try {
      await mkdir(join(fixture.projectRoot, 'dist'), { recursive: true });
      await writeFile(priorDaemonPath, 'prior bundled daemon\n', 'utf8');
      await writeFile(sourceOwnedPath, 'author source output\n', 'utf8');
      await writePluginDaemonOutputManifest({
        projectRoot: fixture.projectRoot,
        outputRelativePaths: ['dist/previous-daemon.js'],
      });
      const spawn = vi.fn(async (input: { args: readonly string[] }) => {
        if (input.args[0] === '/fixture/plugin/node_modules/@typescript/native/bin/tsc') {
          await expect(readFile(priorDaemonPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
          previousOutputWasRetiredBeforeCompile = true;
          await writeFile(priorDaemonPath, 'fresh compiler source output\n', 'utf8');
        }
        return await successfulSpawn();
      });

      const result = await runPluginAuthorToolchain({
        operation,
        projectRoot: fixture.projectRoot,
      }, {
        ensureManagedPnpmCommand: async () => '/happier/tools/pnpm/current/bin/pnpm',
        managedPnpmBinPath: () => '/happier/tools/pnpm/current/bin/pnpm',
        managedJavaScriptRuntimeBinPath: () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
        buildManagedPnpmEnvironment: (env = {}) => env,
        ensureManagedJavaScriptRuntimeCommand: async () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
        resolveNativeTypeScriptBin: () => '/fixture/plugin/node_modules/@typescript/native/bin/tsc',
        resolvePluginUiBuildBin: () => null,
        generatePluginActionContracts: async () => undefined,
        bundlePluginDaemonRuntime: async (projectRoot) => {
          await writeFile(currentDaemonPath, 'current bundled daemon\n', 'utf8');
          await writePluginDaemonOutputManifest({
            projectRoot,
            outputRelativePaths: ['dist/current-daemon.js'],
          });
        },
        spawn,
        processEnv: {},
      });

      expect(result).toMatchObject({ ok: true, operation });
      expect(previousOutputWasRetiredBeforeCompile).toBe(true);
      await expect(readFile(priorDaemonPath, 'utf8')).resolves.toBe('fresh compiler source output\n');
      await expect(readFile(sourceOwnedPath, 'utf8')).resolves.toBe('author source output\n');

      await cleanupPluginAuthorGeneratedArtifacts(fixture.projectRoot);
      await expect(readFile(currentDaemonPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(priorDaemonPath, 'utf8')).resolves.toBe('fresh compiler source output\n');
      await expect(readFile(sourceOwnedPath, 'utf8')).resolves.toBe('author source output\n');
    } finally {
      await fixture.cleanup();
    }
  });

  it.each([
    {
      label: 'descriptor-only cold manifest',
      manifest: createPluginManifestV2Fixture({ entrypoints: undefined }),
      shouldBundleDaemon: false,
    },
    {
      label: 'UI-only cold manifest',
      manifest: createPluginManifestV2Fixture({
        entrypoints: undefined,
        contributes: {
          ui: {
            renderers: [],
            views: [],
          },
        },
      }),
      shouldBundleDaemon: false,
    },
    {
      label: 'executable cold manifest',
      manifest: createPluginManifestV2Fixture({ entrypoints: { daemon: './dist/daemon.js' } }),
      shouldBundleDaemon: true,
    },
  ])('classifies $label from its manifest before daemon staging', async ({ manifest, shouldBundleDaemon }) => {
    const fixture = await createColdAuthorBuildFixture(manifest);
    const generatePluginActionContracts = vi.fn(async () => undefined);
    const bundlePluginDaemonRuntime = vi.fn(async () => undefined);
    try {
      const result = await runPluginAuthorToolchain({
        operation: 'build',
        projectRoot: fixture.projectRoot,
      }, {
        ensureManagedPnpmCommand: async () => '/happier/tools/pnpm/current/bin/pnpm',
        managedPnpmBinPath: () => '/happier/tools/pnpm/current/bin/pnpm',
        managedJavaScriptRuntimeBinPath: () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
        buildManagedPnpmEnvironment: (env = {}) => env,
        ensureManagedJavaScriptRuntimeCommand: async () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
        resolveNativeTypeScriptBin: () => '/fixture/plugin/node_modules/@typescript/native/bin/tsc',
        resolvePluginUiBuildBin: () => null,
        generatePluginActionContracts,
        bundlePluginDaemonRuntime,
        spawn: vi.fn(successfulSpawn),
        processEnv: {},
      });

      expect(result).toMatchObject({ ok: true, operation: 'build' });
      expect(generatePluginActionContracts).toHaveBeenCalledTimes(shouldBundleDaemon ? 1 : 0);
      expect(bundlePluginDaemonRuntime).toHaveBeenCalledTimes(shouldBundleDaemon ? 1 : 0);
    } finally {
      await fixture.cleanup();
    }
  });

  it.each(['build', 'test'] as const)(
    'rejects a development-only manifest before %s compiler or generator publication',
    async (operation) => {
      const fixture = await createColdAuthorBuildFixture(createPluginManifestV2Fixture({
        entrypoints: { development: './src/index.ts' },
        contributes: {
          actions: [{
            id: 'run',
            title: 'Run',
            scopes: ['session'],
            surfaces: ['cli'],
            execution: { target: 'daemon' },
            placementBindings: ['primary'],
            dangerLevel: 'safe',
          }],
        },
      }));
      const spawn = vi.fn(successfulSpawn);
      try {
        const result = await runPluginAuthorToolchain({
          operation,
          projectRoot: fixture.projectRoot,
        }, {
          ensureManagedPnpmCommand: async () => '/happier/tools/pnpm/current/bin/pnpm',
          managedPnpmBinPath: () => '/happier/tools/pnpm/current/bin/pnpm',
          managedJavaScriptRuntimeBinPath: () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
          buildManagedPnpmEnvironment: (env = {}) => env,
          ensureManagedJavaScriptRuntimeCommand: async () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
          resolveNativeTypeScriptBin: () => '/fixture/plugin/node_modules/@typescript/native/bin/tsc',
          resolvePluginUiBuildBin: () => null,
          spawn,
          processEnv: {},
        });

        expect(result).toMatchObject({
          ok: false,
          operation,
          diagnostics: [expect.objectContaining({
            code: 'plugin_author_tool_failed',
            message: expect.stringContaining('entrypoints.daemon'),
          })],
        });
        expect(spawn).not.toHaveBeenCalled();
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it('bundles the complete daemon dependency closure after a successful TypeScript build', async () => {
    const spawn = vi.fn(successfulSpawn);
    const generatePluginActionContracts = vi.fn(async () => undefined);
    const bundlePluginDaemonRuntime = vi.fn(async () => undefined);
    const result = await runPluginAuthorToolchain({
      operation: 'build',
      projectRoot: '/fixture/plugin',
    }, {
      ensureManagedPnpmCommand: async () => '/happier/tools/pnpm/current/bin/pnpm',
      managedPnpmBinPath: () => '/happier/tools/pnpm/current/bin/pnpm',
      managedJavaScriptRuntimeBinPath: () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
      buildManagedPnpmEnvironment: (env = {}) => env,
      ensureManagedJavaScriptRuntimeCommand: async () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
      resolveNativeTypeScriptBin: () => '/fixture/plugin/node_modules/@typescript/native/bin/tsc',
      resolvePluginUiBuildBin: () => null,
      generatePluginActionContracts,
      bundlePluginDaemonRuntime,
      spawn,
      processEnv: {},
    });

    expect(result).toMatchObject({ ok: true, operation: 'build' });
    expect(generatePluginActionContracts).toHaveBeenCalledWith({ projectRoot: '/fixture/plugin' });
    expect(bundlePluginDaemonRuntime).toHaveBeenCalledWith('/fixture/plugin');
    expect(generatePluginActionContracts.mock.invocationCallOrder[0]).toBeLessThan(
      bundlePluginDaemonRuntime.mock.invocationCallOrder[0]!,
    );
  });

  it('reports an unavailable physical plugin bundler as a managed-tool diagnostic', async () => {
    const result = await runPluginAuthorToolchain({
      operation: 'build',
      projectRoot: '/fixture/plugin',
    }, {
      ensureManagedPnpmCommand: async () => '/happier/tools/pnpm/current/bin/pnpm',
      managedPnpmBinPath: () => '/happier/tools/pnpm/current/bin/pnpm',
      managedJavaScriptRuntimeBinPath: () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
      buildManagedPnpmEnvironment: (env = {}) => env,
      ensureManagedJavaScriptRuntimeCommand: async () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
      resolveNativeTypeScriptBin: () => '/fixture/plugin/node_modules/@typescript/native/bin/tsc',
      resolvePluginUiBuildBin: () => null,
      bundlePluginDaemonRuntime: async () => {
        throw new PluginAuthorBundlerUnavailableError();
      },
      spawn: vi.fn(successfulSpawn),
      processEnv: {},
    });

    expect(result).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({
        code: 'plugin_author_managed_tool_unavailable',
      })],
    });
  });

  it('runs the project-local Plugin UI builder before bundling a build that declares a UI target', async () => {
    const spawn = vi.fn(successfulSpawn);
    const bundlePluginDaemonRuntime = vi.fn(async () => undefined);
    const result = await runPluginAuthorToolchain({
      operation: 'build',
      projectRoot: '/fixture/plugin',
    }, {
      ensureManagedPnpmCommand: async () => '/happier/tools/pnpm/current/bin/pnpm',
      managedPnpmBinPath: () => '/happier/tools/pnpm/current/bin/pnpm',
      managedJavaScriptRuntimeBinPath: () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
      buildManagedPnpmEnvironment: (env = {}) => env,
      ensureManagedJavaScriptRuntimeCommand: async () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
      resolveNativeTypeScriptBin: () => '/fixture/plugin/node_modules/@typescript/native/bin/tsc',
      resolvePluginUiBuildBin: () => '/fixture/plugin/node_modules/@happier-dev/plugin-sdk/dist/ui/build/bin.js',
      bundlePluginDaemonRuntime,
      spawn,
      processEnv: {},
    });

    expect(result).toMatchObject({ ok: true, operation: 'build' });
    expect(spawn).toHaveBeenNthCalledWith(3, {
      command: '/happier/tools/js-runtime/current/bin/happier-js-runtime',
      args: [
        '/fixture/plugin/node_modules/@happier-dev/plugin-sdk/dist/ui/build/bin.js',
        '--project-root',
        '/fixture/plugin',
      ],
      cwd: '/fixture/plugin',
      env: {},
    });
    expect(spawn.mock.invocationCallOrder[2]).toBeLessThan(
      bundlePluginDaemonRuntime.mock.invocationCallOrder[0]!,
    );
  });

  it('does not publish a daemon bundle when the declared Plugin UI build fails', async () => {
    const spawn = vi.fn()
      .mockImplementationOnce(successfulSpawn)
      .mockImplementationOnce(successfulSpawn)
      .mockResolvedValueOnce({
        exitCode: 1,
        signal: null,
        stdout: '',
        stderr: 'invalid Plugin UI target',
      });
    const bundlePluginDaemonRuntime = vi.fn(async () => undefined);
    const result = await runPluginAuthorToolchain({
      operation: 'build',
      projectRoot: '/fixture/plugin',
    }, {
      ensureManagedPnpmCommand: async () => '/happier/tools/pnpm/current/bin/pnpm',
      managedPnpmBinPath: () => '/happier/tools/pnpm/current/bin/pnpm',
      managedJavaScriptRuntimeBinPath: () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
      buildManagedPnpmEnvironment: (env = {}) => env,
      ensureManagedJavaScriptRuntimeCommand: async () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
      resolveNativeTypeScriptBin: () => '/fixture/plugin/node_modules/@typescript/native/bin/tsc',
      resolvePluginUiBuildBin: () => '/fixture/plugin/node_modules/@happier-dev/plugin-sdk/dist/ui/build/bin.js',
      bundlePluginDaemonRuntime,
      spawn,
      processEnv: {},
    });

    expect(result).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({
        code: 'plugin_author_tool_failed',
        message: expect.stringContaining('invalid Plugin UI target'),
      })],
    });
    expect(bundlePluginDaemonRuntime).not.toHaveBeenCalled();
  });

  it('installs dependencies through the canonical managed pnpm owner with fixture-scoped registry configuration', async () => {
    const spawn = vi.fn(successfulSpawn);
    const controller = new AbortController();
    const result = await runPluginAuthorToolchain({
      operation: 'install',
      projectRoot: '/fixture/plugin',
      sdkRegistryOrigin: 'http://127.0.0.1:43127',
      signal: controller.signal,
    }, {
      ensureManagedPnpmCommand: async () => '/happier/tools/pnpm/current/bin/pnpm',
      managedPnpmBinPath: () => '/happier/tools/pnpm/current/bin/pnpm',
      managedJavaScriptRuntimeBinPath: () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
      buildManagedPnpmEnvironment: (env) => ({ ...env, PNPM_HOME: '/happier/tools/pnpm/home' }),
      ensureManagedJavaScriptRuntimeCommand: async () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
      resolveNativeTypeScriptBin: () => '/fixture/plugin/node_modules/@typescript/native/bin/tsc',
      spawn,
      processEnv: { PATH: '/usr/bin' },
    });

    expect(result).toMatchObject({ ok: true, operation: 'install' });
    expect(spawn).toHaveBeenCalledWith({
      command: '/happier/tools/pnpm/current/bin/pnpm',
      args: [
        'install',
        '--ignore-scripts',
        '--config.@happier-dev:registry=http://127.0.0.1:43127',
      ],
      cwd: '/fixture/plugin',
      env: expect.objectContaining({ PNPM_HOME: '/happier/tools/pnpm/home' }),
      signal: controller.signal,
    });
  });

  it('installs and loads the prepublication author closure through the real managed file override', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'happier-author-external-sdk-resolution-'));
    try {
      await writeFile(join(projectRoot, 'package.json'), JSON.stringify({
        name: 'external-happier-plugin',
        version: '0.1.0',
        type: 'module',
        dependencies: {
          '@happier-dev/plugin-sdk': '0.0.0',
          '@happier-dev/plugin-ui': '0.0.0',
        },
      }), 'utf8');

      const result = await runPluginAuthorToolchain({
        operation: 'install',
        projectRoot,
      });

      expect(result).toMatchObject({ ok: true, operation: 'install', projectRoot });
      await expect(readFile(join(projectRoot, 'pnpm-workspace.yaml'), 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' });

      const installedSdkRoot = await realpath(join(projectRoot, 'node_modules', '@happier-dev', 'plugin-sdk'));
      const installedUiRoot = join(projectRoot, 'node_modules', '@happier-dev', 'plugin-ui');
      await expect(readFile(join(installedSdkRoot, 'package.json'), 'utf8'))
        .resolves.toContain('"@happier-dev/plugin-sdk"');
      await expect(readFile(join(installedUiRoot, 'package.json'), 'utf8'))
        .resolves.toContain('"@happier-dev/plugin-ui"');

      const authorRequire = createRequire(join(projectRoot, 'package.json'));
      const installedSdkRequire = createRequire(join(installedSdkRoot, 'package.json'));
      const composer = await import(pathToFileURL(authorRequire.resolve('@happier-dev/plugin-sdk/ui')).href);
      const protocolUiClient = await import(pathToFileURL(
        installedSdkRequire.resolve('@happier-dev/protocol/plugins/ui/client'),
      ).href);
      expect(composer.ComposerContentHandleV1Schema).toBe(protocolUiClient.ComposerContentHandleV1Schema);

      // The installed manifest must keep `bin`: it is the only declaration that
      // makes `happier-plugin-build-ui` discoverable, so every `--ui` author's
      // `author build` and `plugins dev` UI stage depend on it surviving the
      // bundled-package sanitizer. Assert it unconditionally — reading the same
      // field into a branch condition would let a regression skip the proof.
      const installedSdkManifest = JSON.parse(await readFile(join(installedSdkRoot, 'package.json'), 'utf8')) as {
        bin?: Record<string, unknown>;
      };
      expect(installedSdkManifest.bin?.['happier-plugin-build-ui']).toEqual(expect.any(String));

      await writeFile(join(projectRoot, 'pluginUiBuild.mjs'), 'export default { targets: [] };\n', 'utf8');
      const builderPath = resolvePluginUiBuildBin(projectRoot);
      expect(builderPath).not.toBeNull();
      const managedRuntimeCommand = await ensureManagedJavaScriptRuntimeCommand(process.env);
      expect(managedRuntimeCommand).not.toBeNull();
      const invocation = resolvePluginAuthorToolchainSpawnInvocation({
        command: managedRuntimeCommand!,
        args: [builderPath!, '--help'],
        cwd: projectRoot,
        env: process.env,
      });
      const builderResult = await execFileAsync(invocation.command, [...invocation.args], {
        cwd: invocation.cwd,
        env: invocation.env,
      });
      expect(builderResult.stdout).toContain('happier-plugin-build-ui');
      expect(builderResult.stderr).toBe('');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  }, 120_000);

  it('does not materialize a prepublication SDK after dependency preparation is already cancelled', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'happier-author-external-sdk-pre-cancelled-'));
    const controller = new AbortController();
    const materializeBundledPrepublicationPackages = vi.fn(async () => {
      throw new Error('A cancelled install must not materialize the Plugin SDK');
    });
    const spawn = vi.fn(async (input: Readonly<{ signal?: AbortSignal }>) => {
      expect(input.signal).toBe(controller.signal);
      return { exitCode: null, signal: 'SIGTERM' as const, stdout: '', stderr: '' };
    });
    try {
      await writeFile(join(projectRoot, 'package.json'), JSON.stringify({
        name: 'external-happier-plugin',
        version: '0.1.0',
        type: 'module',
        dependencies: { '@happier-dev/plugin-sdk': '0.0.0' },
      }), 'utf8');
      controller.abort();

      const result = await runPluginAuthorToolchain({
        operation: 'install',
        projectRoot,
        signal: controller.signal,
      }, {
        ensureManagedPnpmCommand: async () => '/happier/tools/pnpm/current/bin/pnpm',
        managedPnpmBinPath: () => '/happier/tools/pnpm/current/bin/pnpm',
        managedJavaScriptRuntimeBinPath: () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
        buildManagedPnpmEnvironment: (env = {}) => env,
        ensureManagedJavaScriptRuntimeCommand: async () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
        resolveNativeTypeScriptBin: () => '/fixture/plugin/node_modules/@typescript/native/bin/tsc',
        materializeBundledPrepublicationPackages,
        spawn,
        processEnv: {},
      });

      expect(materializeBundledPrepublicationPackages).not.toHaveBeenCalled();
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        ok: false,
        operation: 'install',
        diagnostics: [expect.objectContaining({
          code: 'plugin_author_tool_failed',
          message: expect.stringContaining('SIGTERM'),
        })],
      });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('does not write a transient SDK resolution after cancellation arrives during materialization', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'happier-author-external-sdk-cancel-during-materialization-'));
    const controller = new AbortController();
    const cleanup = vi.fn(async () => undefined);
    const materializeBundledPrepublicationPackages = vi.fn(async () => {
      controller.abort();
      return {
        packageRootsByName: new Map([
          ['@happier-dev/plugin-sdk', join(projectRoot, 'materialized-plugin-sdk')],
        ]),
        cleanup,
      };
    });
    let transientWorkspaceConfigWasWritten = false;
    const spawn = vi.fn(async () => {
      try {
        await readFile(join(projectRoot, 'pnpm-workspace.yaml'), 'utf8');
        transientWorkspaceConfigWasWritten = true;
      } catch (error) {
        expect((error as NodeJS.ErrnoException).code).toBe('ENOENT');
      }
      return { exitCode: null, signal: 'SIGTERM' as const, stdout: '', stderr: '' };
    });
    try {
      await writeFile(join(projectRoot, 'package.json'), JSON.stringify({
        name: 'external-happier-plugin',
        version: '0.1.0',
        type: 'module',
        dependencies: { '@happier-dev/plugin-sdk': '0.0.0' },
      }), 'utf8');

      const result = await runPluginAuthorToolchain({
        operation: 'install',
        projectRoot,
        signal: controller.signal,
      }, {
        ensureManagedPnpmCommand: async () => '/happier/tools/pnpm/current/bin/pnpm',
        managedPnpmBinPath: () => '/happier/tools/pnpm/current/bin/pnpm',
        managedJavaScriptRuntimeBinPath: () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
        buildManagedPnpmEnvironment: (env = {}) => env,
        ensureManagedJavaScriptRuntimeCommand: async () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
        resolveNativeTypeScriptBin: () => '/fixture/plugin/node_modules/@typescript/native/bin/tsc',
        materializeBundledPrepublicationPackages,
        spawn,
        processEnv: {},
      });

      expect(transientWorkspaceConfigWasWritten).toBe(false);
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        ok: false,
        operation: 'install',
        diagnostics: [expect.objectContaining({
          code: 'plugin_author_tool_failed',
          message: expect.stringContaining('SIGTERM'),
        })],
      });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('removes transient bundled-SDK resolution inputs when managed dependency preparation is cancelled', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'happier-author-external-sdk-cancelled-'));
    let materializedSdkRoot: string | undefined;
    const controller = new AbortController();
    const spawn = vi.fn(async (input: Readonly<{ args: readonly string[]; signal?: AbortSignal }>) => {
      const workspaceConfig = await readFile(join(projectRoot, 'pnpm-workspace.yaml'), 'utf8');
      const sdkFileUrl = workspaceConfig.match(
        /^  "@happier-dev\/plugin-sdk": "(file:\/\/\/[^\n]+)"$/mu,
      )?.[1];
      expect(sdkFileUrl).toBeDefined();
      materializedSdkRoot = fileURLToPath(sdkFileUrl!);
      expect(input.args).toEqual(['install', '--ignore-scripts', '--lockfile=false']);
      expect(input.signal).toBe(controller.signal);
      return { exitCode: null, signal: 'SIGTERM' as const, stdout: '', stderr: '' };
    });
    try {
      await writeFile(join(projectRoot, 'package.json'), JSON.stringify({
        name: 'external-happier-plugin',
        version: '0.1.0',
        type: 'module',
        dependencies: { '@happier-dev/plugin-sdk': '0.0.0' },
      }), 'utf8');

      const result = await runPluginAuthorToolchain({
        operation: 'install',
        projectRoot,
        signal: controller.signal,
      }, {
        ensureManagedPnpmCommand: async () => '/happier/tools/pnpm/current/bin/pnpm',
        managedPnpmBinPath: () => '/happier/tools/pnpm/current/bin/pnpm',
        managedJavaScriptRuntimeBinPath: () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
        buildManagedPnpmEnvironment: (env = {}) => env,
        ensureManagedJavaScriptRuntimeCommand: async () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
        resolveNativeTypeScriptBin: () => '/fixture/plugin/node_modules/@typescript/native/bin/tsc',
        spawn,
        processEnv: {},
      });

      expect(result).toMatchObject({
        ok: false,
        operation: 'install',
        diagnostics: [expect.objectContaining({
          code: 'plugin_author_tool_failed',
          message: expect.stringContaining('SIGTERM'),
        })],
      });
      await expect(readFile(join(projectRoot, 'pnpm-workspace.yaml'), 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' });
      expect(materializedSdkRoot).toBeDefined();
      await expect(lstat(materializedSdkRoot!)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  }, 120_000);

  it('refuses to replace an author-owned pnpm workspace configuration for bundled SDK resolution', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'happier-author-owned-pnpm-workspace-'));
    const spawn = vi.fn(successfulSpawn);
    const workspaceConfigPath = join(projectRoot, 'pnpm-workspace.yaml');
    const existingWorkspaceConfig = 'packages:\n  - plugins/*\n';
    try {
      await writeFile(join(projectRoot, 'package.json'), JSON.stringify({
        name: 'external-happier-plugin',
        version: '0.1.0',
        type: 'module',
        dependencies: { '@happier-dev/plugin-sdk': '0.0.0' },
      }), 'utf8');
      await writeFile(workspaceConfigPath, existingWorkspaceConfig, 'utf8');

      const result = await runPluginAuthorToolchain({
        operation: 'install',
        projectRoot,
      }, {
        ensureManagedPnpmCommand: async () => '/happier/tools/pnpm/current/bin/pnpm',
        managedPnpmBinPath: () => '/happier/tools/pnpm/current/bin/pnpm',
        managedJavaScriptRuntimeBinPath: () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
        buildManagedPnpmEnvironment: (env = {}) => env,
        ensureManagedJavaScriptRuntimeCommand: async () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
        resolveNativeTypeScriptBin: () => '/fixture/plugin/node_modules/@typescript/native/bin/tsc',
        spawn,
        processEnv: {},
      });

      expect(result).toMatchObject({
        ok: false,
        operation: 'install',
        diagnostics: [expect.objectContaining({ code: 'plugin_author_tool_failed' })],
      });
      expect(spawn).not.toHaveBeenCalled();
      await expect(readFile(workspaceConfigPath, 'utf8')).resolves.toBe(existingWorkspaceConfig);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  }, 120_000);

  it('uses the package manager default registry when no SDK registry override is supplied', async () => {
    const spawn = vi.fn(successfulSpawn);
    const result = await runPluginAuthorToolchain({
      operation: 'install',
      projectRoot: '/fixture/plugin',
    }, {
      ensureManagedPnpmCommand: async () => '/happier/tools/pnpm/current/bin/pnpm',
      managedPnpmBinPath: () => '/happier/tools/pnpm/current/bin/pnpm',
      managedJavaScriptRuntimeBinPath: () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
      buildManagedPnpmEnvironment: (env = {}) => env,
      ensureManagedJavaScriptRuntimeCommand: async () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
      resolveNativeTypeScriptBin: () => '/fixture/plugin/node_modules/@typescript/native/bin/tsc',
      spawn,
      processEnv: {},
    });

    expect(result).toMatchObject({ ok: true, operation: 'install' });
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
      args: ['install', '--ignore-scripts'],
    }));
  });

  it.each([
    ['typecheck', ['--noEmit', '-p', 'tsconfig.json']],
    ['build', ['-p', 'tsconfig.json']],
  ] as const)('runs %s through the managed JavaScript runtime and project-local TypeScript 7 entrypoint', async (operation, compilerArgs) => {
    const spawn = vi.fn(successfulSpawn);
    const result = await runPluginAuthorToolchain({
      operation,
      projectRoot: '/fixture/plugin',
    }, {
      ensureManagedPnpmCommand: async () => '/happier/tools/pnpm/current/bin/pnpm',
      managedPnpmBinPath: () => '/happier/tools/pnpm/current/bin/pnpm',
      managedJavaScriptRuntimeBinPath: () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
      buildManagedPnpmEnvironment: (env = {}) => env,
      ensureManagedJavaScriptRuntimeCommand: async () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
      resolveNativeTypeScriptBin: () => '/fixture/plugin/node_modules/@typescript/native/bin/tsc',
      resolvePluginUiBuildBin: () => null,
      bundlePluginDaemonRuntime: async () => undefined,
      spawn,
      processEnv: {},
    });

    expect(result).toMatchObject({ ok: true, operation });
    expect(spawn).toHaveBeenNthCalledWith(1, {
      command: '/happier/tools/pnpm/current/bin/pnpm',
      args: ['install', '--ignore-scripts'],
      cwd: '/fixture/plugin',
      env: {},
    });
    expect(spawn).toHaveBeenCalledWith({
      command: '/happier/tools/js-runtime/current/bin/happier-js-runtime',
      args: ['/fixture/plugin/node_modules/@typescript/native/bin/tsc', ...compilerArgs],
      cwd: '/fixture/plugin',
      env: {},
    });
  });

  it('does not resolve project-local compiler tooling after automatic dependency preparation fails', async () => {
    const resolveNativeTypeScriptBin = vi.fn(() => '/fixture/plugin/node_modules/@typescript/native/bin/tsc');
    const spawn = vi.fn(async () => ({
      exitCode: 1,
      signal: null,
      stdout: '',
      stderr: 'dependency resolution failed',
    }));

    const result = await runPluginAuthorToolchain({
      operation: 'typecheck',
      projectRoot: '/fixture/plugin',
    }, {
      ensureManagedPnpmCommand: async () => '/happier/tools/pnpm/current/bin/pnpm',
      managedPnpmBinPath: () => '/happier/tools/pnpm/current/bin/pnpm',
      managedJavaScriptRuntimeBinPath: () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
      buildManagedPnpmEnvironment: (env = {}) => env,
      ensureManagedJavaScriptRuntimeCommand: async () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
      resolveNativeTypeScriptBin,
      spawn,
      processEnv: {},
    });

    expect(result).toMatchObject({
      ok: false,
      operation: 'typecheck',
      diagnostics: [expect.objectContaining({
        code: 'plugin_author_tool_failed',
        message: expect.stringContaining('dependency resolution failed'),
      })],
    });
    expect(spawn).toHaveBeenCalledOnce();
    expect(resolveNativeTypeScriptBin).not.toHaveBeenCalled();
  });

  it('compiles and rebundles a fresh scaffold before running its focused test through the managed JavaScript runtime', async () => {
    const spawn = vi.fn(successfulSpawn);
    const bundlePluginDaemonRuntime = vi.fn(async () => undefined);
    const result = await runPluginAuthorToolchain({
      operation: 'test',
      projectRoot: '/fixture/plugin',
    }, {
      ensureManagedPnpmCommand: async () => '/happier/tools/pnpm/current/bin/pnpm',
      managedPnpmBinPath: () => '/happier/tools/pnpm/current/bin/pnpm',
      managedJavaScriptRuntimeBinPath: () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
      buildManagedPnpmEnvironment: (env = {}) => env,
      ensureManagedJavaScriptRuntimeCommand: async () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
      resolveNativeTypeScriptBin: () => '/fixture/plugin/node_modules/@typescript/native/bin/tsc',
      bundlePluginDaemonRuntime,
      spawn,
      processEnv: {},
    });

    expect(result).toMatchObject({ ok: true, operation: 'test' });
    expect(spawn.mock.calls).toEqual([
      [{
        command: '/happier/tools/pnpm/current/bin/pnpm',
        args: ['install', '--ignore-scripts'],
        cwd: '/fixture/plugin',
        env: {},
      }],
      [{
        command: '/happier/tools/js-runtime/current/bin/happier-js-runtime',
        args: ['/fixture/plugin/node_modules/@typescript/native/bin/tsc', '-p', 'tsconfig.json'],
        cwd: '/fixture/plugin',
        env: {},
      }],
      [{
        command: '/happier/tools/js-runtime/current/bin/happier-js-runtime',
        args: ['--test', 'test/index.test.mjs'],
        cwd: '/fixture/plugin',
        env: {},
      }],
    ]);
    expect(bundlePluginDaemonRuntime).toHaveBeenCalledWith('/fixture/plugin');
    expect(spawn.mock.invocationCallOrder[1]).toBeLessThan(
      bundlePluginDaemonRuntime.mock.invocationCallOrder[0]!,
    );
    expect(bundlePluginDaemonRuntime.mock.invocationCallOrder[0]).toBeLessThan(
      spawn.mock.invocationCallOrder[2]!,
    );
  });

  it('does not bundle or run a stale generated suite when the fresh scaffold compile fails', async () => {
    const spawn = vi.fn()
      .mockImplementationOnce(successfulSpawn)
      .mockResolvedValueOnce({
        exitCode: 1,
        signal: null,
        stdout: '',
        stderr: 'TypeScript compilation failed',
      });
    const bundlePluginDaemonRuntime = vi.fn(async () => undefined);
    const result = await runPluginAuthorToolchain({
      operation: 'test',
      projectRoot: '/fixture/plugin',
    }, {
      ensureManagedPnpmCommand: async () => '/happier/tools/pnpm/current/bin/pnpm',
      managedPnpmBinPath: () => '/happier/tools/pnpm/current/bin/pnpm',
      managedJavaScriptRuntimeBinPath: () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
      buildManagedPnpmEnvironment: (env = {}) => env,
      ensureManagedJavaScriptRuntimeCommand: async () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
      resolveNativeTypeScriptBin: () => '/fixture/plugin/node_modules/@typescript/native/bin/tsc',
      bundlePluginDaemonRuntime,
      spawn,
      processEnv: {},
    });

    expect(result).toMatchObject({
      ok: false,
      operation: 'test',
      diagnostics: [{
        code: 'plugin_author_tool_failed',
        message: expect.stringContaining('TypeScript compilation failed'),
      }],
    });
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(bundlePluginDaemonRuntime).not.toHaveBeenCalled();
  });

  it('fails closed when a managed tool is unavailable', async () => {
    const result = await runPluginAuthorToolchain({
      operation: 'install',
      projectRoot: '/fixture/plugin',
      sdkRegistryOrigin: 'http://127.0.0.1:43127',
    }, {
      ensureManagedPnpmCommand: async () => null,
      managedPnpmBinPath: () => '/happier/tools/pnpm/current/bin/pnpm',
      managedJavaScriptRuntimeBinPath: () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
      buildManagedPnpmEnvironment: (env = {}) => env,
      ensureManagedJavaScriptRuntimeCommand: async () => null,
      resolveNativeTypeScriptBin: () => '/fixture/plugin/node_modules/@typescript/native/bin/tsc',
      spawn: vi.fn(successfulSpawn),
      processEnv: {},
    });

    expect(result).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'plugin_author_managed_tool_unavailable' })],
    });
  });

  it('rejects a PATH pnpm fallback instead of assuming a system package manager', async () => {
    const spawn = vi.fn(successfulSpawn);
    const result = await runPluginAuthorToolchain({
      operation: 'install',
      projectRoot: '/fixture/plugin',
      sdkRegistryOrigin: 'http://127.0.0.1:43127',
    }, {
      ensureManagedPnpmCommand: async () => '/usr/local/bin/pnpm',
      managedPnpmBinPath: () => '/happier/tools/pnpm/current/bin/pnpm',
      managedJavaScriptRuntimeBinPath: () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
      buildManagedPnpmEnvironment: (env = {}) => env,
      ensureManagedJavaScriptRuntimeCommand: async () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
      resolveNativeTypeScriptBin: () => '/fixture/plugin/node_modules/@typescript/native/bin/tsc',
      spawn,
      processEnv: { PATH: '/usr/local/bin:/usr/bin' },
    });

    expect(result).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'plugin_author_managed_tool_unavailable' })],
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('rejects the host process Node executable instead of assuming a system runtime', async () => {
    const spawn = vi.fn(successfulSpawn);
    const result = await runPluginAuthorToolchain({
      operation: 'typecheck',
      projectRoot: '/fixture/plugin',
    }, {
      ensureManagedPnpmCommand: async () => '/happier/tools/pnpm/current/bin/pnpm',
      managedPnpmBinPath: () => '/happier/tools/pnpm/current/bin/pnpm',
      managedJavaScriptRuntimeBinPath: () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
      buildManagedPnpmEnvironment: (env = {}) => env,
      ensureManagedJavaScriptRuntimeCommand: async () => '/usr/bin/node',
      resolveNativeTypeScriptBin: () => '/fixture/plugin/node_modules/@typescript/native/bin/tsc',
      spawn,
      processEnv: { PATH: '/usr/bin' },
    });

    expect(result).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'plugin_author_managed_tool_unavailable' })],
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'pnpm',
      operation: 'install' as const,
      processEnv: { HAPPIER_PNPM_BIN: '/usr/local/bin/pnpm' },
      sdkRegistryOrigin: 'http://127.0.0.1:43127',
    },
    {
      label: 'JavaScript runtime',
      operation: 'typecheck' as const,
      processEnv: { HAPPIER_NODE_PATH: '/usr/bin/node' },
      sdkRegistryOrigin: undefined,
    },
  ])('rejects an explicit host $label override as proof of managed ownership', async ({ operation, processEnv, sdkRegistryOrigin }) => {
    const hostCommand = operation === 'install' ? processEnv.HAPPIER_PNPM_BIN : processEnv.HAPPIER_NODE_PATH;
    const spawn = vi.fn(successfulSpawn);
    const result = await runPluginAuthorToolchain({
      operation,
      projectRoot: '/fixture/plugin',
      sdkRegistryOrigin,
    }, {
      ensureManagedPnpmCommand: async () => hostCommand ?? '/happier/tools/pnpm/current/bin/pnpm',
      managedPnpmBinPath: () => '/happier/tools/pnpm/current/bin/pnpm',
      managedJavaScriptRuntimeBinPath: () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
      buildManagedPnpmEnvironment: (env = {}) => env,
      ensureManagedJavaScriptRuntimeCommand: async () => hostCommand ?? '/happier/tools/js-runtime/current/bin/happier-js-runtime',
      resolveNativeTypeScriptBin: () => '/fixture/plugin/node_modules/@typescript/native/bin/tsc',
      spawn,
      processEnv,
    });

    expect(result).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'plugin_author_managed_tool_unavailable' })],
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('rejects a TypeScript package bin that escapes the installed @typescript/native package', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'happier-author-typescript-bin-'));
    const packageRoot = join(projectRoot, 'node_modules', '@typescript', 'native');
    try {
      await mkdir(packageRoot, { recursive: true });
      await writeFile(join(projectRoot, 'package.json'), '{"type":"module"}\n', 'utf8');
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
        name: '@typescript/native',
        version: '7.0.2',
        bin: { tsc: '../../../outside.js' },
      }), 'utf8');

      expect(() => resolveNativeTypeScriptBin(projectRoot)).toThrow(/inside.*@typescript\/native/u);

      const outsideCompilerPath = join(projectRoot, 'outside.js');
      await mkdir(join(packageRoot, 'bin'), { recursive: true });
      await writeFile(outsideCompilerPath, '', 'utf8');
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
        name: '@typescript/native',
        version: '7.0.2',
        bin: { tsc: './bin/tsc' },
      }), 'utf8');
      await symlink(outsideCompilerPath, join(packageRoot, 'bin', 'tsc'));
      expect(() => resolveNativeTypeScriptBin(projectRoot)).toThrow(/contained regular file/u);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects an ancestor or non-TypeScript-7 @typescript/native package', async () => {
    const parentRoot = await mkdtemp(join(tmpdir(), 'happier-author-typescript-owner-'));
    const projectRoot = join(parentRoot, 'plugin');
    const ancestorPackageRoot = join(parentRoot, 'node_modules', '@typescript', 'native');
    try {
      await mkdir(projectRoot, { recursive: true });
      await mkdir(join(ancestorPackageRoot, 'bin'), { recursive: true });
      await writeFile(join(projectRoot, 'package.json'), '{"type":"module"}\n', 'utf8');
      await writeFile(join(ancestorPackageRoot, 'package.json'), JSON.stringify({
        name: '@typescript/native',
        version: '7.0.2',
        bin: { tsc: './bin/tsc' },
      }), 'utf8');
      await writeFile(join(ancestorPackageRoot, 'bin', 'tsc'), '', 'utf8');
      expect(() => resolveNativeTypeScriptBin(projectRoot)).toThrow(/project-local/u);

      const versionProjectRoot = join(parentRoot, 'plugin-version');
      const localPackageRoot = join(versionProjectRoot, 'node_modules', '@typescript', 'native');
      await mkdir(join(localPackageRoot, 'bin'), { recursive: true });
      await writeFile(join(versionProjectRoot, 'package.json'), '{"type":"module"}\n', 'utf8');
      await writeFile(join(localPackageRoot, 'package.json'), JSON.stringify({
        name: '@typescript/native',
        version: '6.9.9',
        bin: { tsc: './bin/tsc' },
      }), 'utf8');
      await writeFile(join(localPackageRoot, 'bin', 'tsc'), '', 'utf8');
      expect(() => resolveNativeTypeScriptBin(versionProjectRoot)).toThrow(/TypeScript 7/u);
    } finally {
      await rm(parentRoot, { recursive: true, force: true });
    }
  });

  it('resolves the declared Plugin UI builder only from the project-local SDK package', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'happier-author-ui-builder-'));
    const packageRoot = join(projectRoot, 'node_modules', '@happier-dev', 'plugin-sdk');
    try {
      await mkdir(join(packageRoot, 'dist', 'ui', 'build'), { recursive: true });
      await writeFile(join(projectRoot, 'package.json'), JSON.stringify({
        scripts: { build: 'happier plugins author build .' },
      }), 'utf8');
      await writeFile(
        join(projectRoot, 'pluginUiBuild.mjs'),
        'export default { targets: [] };\n',
        'utf8',
      );
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
        name: '@happier-dev/plugin-sdk',
        bin: { 'happier-plugin-build-ui': './dist/ui/build/bin.js' },
      }), 'utf8');
      const expectedBuilder = join(packageRoot, 'dist', 'ui', 'build', 'bin.js');
      await writeFile(expectedBuilder, 'export {};\n', 'utf8');

      expect(resolvePluginUiBuildBin(projectRoot)).toBe(await realpath(expectedBuilder));

      const outsideBuilder = join(projectRoot, 'outside-builder.js');
      await writeFile(outsideBuilder, 'export {};\n', 'utf8');
      await rm(expectedBuilder);
      await symlink(outsideBuilder, expectedBuilder);
      expect(() => resolvePluginUiBuildBin(projectRoot)).toThrow(/contained regular file/u);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('does not require the Plugin UI builder when the project declares no UI build target', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'happier-author-no-ui-builder-'));
    try {
      await writeFile(join(projectRoot, 'package.json'), JSON.stringify({
        scripts: {
          build: 'happier plugins author build .',
          'build:ui': 'unrelated-company-ui-builder',
        },
      }), 'utf8');

      expect(resolvePluginUiBuildBin(projectRoot)).toBeNull();
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});

describe('plugin author toolchain source locations', () => {
  const locatingDeps = (spawn: PluginAuthorToolchainDeps['spawn']): PluginAuthorToolchainDeps => ({
    ensureManagedPnpmCommand: async () => '/happier/tools/pnpm/current/bin/pnpm',
    managedPnpmBinPath: () => '/happier/tools/pnpm/current/bin/pnpm',
    managedJavaScriptRuntimeBinPath: () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
    buildManagedPnpmEnvironment: (env = {}) => env,
    ensureManagedJavaScriptRuntimeCommand: async () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
    resolveNativeTypeScriptBin: () => '/fixture/plugin/node_modules/@typescript/native/bin/tsc',
    resolvePluginUiBuildBin: () => null,
    spawn,
    processEnv: {},
  });

  it('names the compiler-reported source location for a failed author typecheck', async () => {
    const spawn = vi.fn(async (input: { args: readonly string[] }) => (
      input.args.some((arg) => arg.includes('tsc'))
        ? {
            exitCode: 1,
            signal: null,
            stdout: "src/daemon.ts(7,19): error TS2307: Cannot find module 'left-pad'.\n",
            stderr: '',
          }
        : { exitCode: 0, signal: null, stdout: '', stderr: '' }
    ));

    const result = await runPluginAuthorToolchain(
      { operation: 'typecheck', projectRoot: '/fixture/plugin' },
      locatingDeps(spawn as unknown as PluginAuthorToolchainDeps['spawn']),
    );

    expect(result).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({
        code: 'plugin_author_tool_failed',
        source: { file: 'src/daemon.ts', line: 7, column: 19 },
      })],
    });
  });

  it('publishes no source location for a compiler failure naming a path outside the author project root', async () => {
    const spawn = vi.fn(async (input: { args: readonly string[] }) => (
      input.args.some((arg) => arg.includes('tsc'))
        ? {
            exitCode: 1,
            signal: null,
            stdout: '',
            stderr: '/Users/alice/private/other-project/daemon.ts(7,19): error TS2307: nope.\n',
          }
        : { exitCode: 0, signal: null, stdout: '', stderr: '' }
    ));

    const result = await runPluginAuthorToolchain(
      { operation: 'typecheck', projectRoot: '/fixture/plugin' },
      locatingDeps(spawn as unknown as PluginAuthorToolchainDeps['spawn']),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected a failed toolchain result');
    expect(result.diagnostics[0]?.source).toBeUndefined();
  });
});
