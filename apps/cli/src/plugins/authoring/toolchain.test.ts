import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { createPluginManifestV2Fixture } from '../testkit/manifestV2Fixture';
import { ensureManagedJavaScriptRuntimeCommand } from '@/packagedRuntime/js/managedJavaScriptRuntime';
import { PluginAuthorBundlerUnavailableError } from './bundleDaemonRuntime';
import { collectBundledPrepublicationAuthorPackageNames } from '@happier-dev/cli-common/workspaceRuntimeDependencies';
import { assertPluginAuthorPrepublicationRuntimeDeclarations, resolvePluginUiBuildArguments } from './hostSdkResolution';
import { generatePluginActionContracts } from './actionContracts';
import { classifyPluginAuthorDaemonBuild, cleanupPluginAuthorGeneratedArtifacts, materializePrepublicationAuthorWorkspacePackages, normalizePluginSdkRegistryOrigin, resolvePluginAuthorToolchainSpawnInvocation, resolveNativeTypeScriptBin, resolvePluginUiBuildBin, runPluginAuthorToolchain, runPluginUiArtifactBuild, type PluginAuthorToolchainDeps } from './toolchain';
import { cleanupPluginDaemonOutputManifest, PLUGIN_DAEMON_OUTPUT_MANIFEST_RELATIVE_PATH, writePluginDaemonOutputManifest } from './daemonOutputManifest';

function successfulSpawn(_input?: Parameters<PluginAuthorToolchainDeps['spawn']>[0]) {
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

/**
 * Physical package distribution is fixture input; closure materialization runs
 * the real canonical owner so the toolchain never builds host workspace
 * packages inside a unit test.
 */
async function createFixturePrepublicationMaterializer(params: Readonly<{
  projectRoot: string;
  packages: ReadonlyArray<Readonly<{ name: string; publicAuthor: boolean }>>;
}>): Promise<{
  materialize: NonNullable<PluginAuthorToolchainDeps['materializeBundledPrepublicationPackages']>;
  cleanup: () => Promise<void>;
}> {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'happier-author-prepublication-bundles-'));
  const bundles: { packageName: string; srcDir: string; destDir: string }[] = [];
  for (const { name, publicAuthor } of params.packages) {
    const srcDir = join(fixtureRoot, 'packages', ...name.split('/'));
    await mkdir(join(srcDir, 'dist'), { recursive: true });
    await writeFile(join(srcDir, 'package.json'), JSON.stringify({
      name, version: '0.0.0', type: 'module', main: 'dist/index.js', types: 'dist/index.d.ts', files: ['dist'],
      ...(publicAuthor ? { happier: { publicSdkRelease: { posture: 'developer_preview' } } } : {}),
    }), 'utf8');
    await writeFile(join(srcDir, 'dist', 'index.js'), 'export const installed = true;\n', 'utf8');
    await writeFile(join(srcDir, 'dist', 'index.d.ts'), 'export declare const installed: true;\n', 'utf8');
    bundles.push({ packageName: name, srcDir, destDir: join(fixtureRoot, 'unused', ...name.split('/')) });
  }
  return {
    materialize: async (packageNames) => await materializePrepublicationAuthorWorkspacePackages({
      projectRoot: params.projectRoot, packageNames, bundles,
    }),
    cleanup: async () => await rm(fixtureRoot, { recursive: true, force: true }),
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
  it('accepts requested public author packages declared as physically bundled by a packaged CLI', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'happier-author-packaged-runtime-'));
    try {
      await writeFile(join(runtimeRoot, 'package.json'), JSON.stringify({
        name: '@happier-dev/cli',
        dependencies: {},
        bundledDependencies: [
          '@happier-dev/plugin-sdk',
          '@happier-dev/plugin-ui',
          '@happier-dev/channels-protocol',
          '@happier-dev/triage-protocol',
        ],
      }), 'utf8');

      const physicalRuntimeRoot = await realpath(runtimeRoot);
      expect(() => assertPluginAuthorPrepublicationRuntimeDeclarations(physicalRuntimeRoot, [
        '@happier-dev/plugin-sdk',
        '@happier-dev/plugin-ui',
        '@happier-dev/channels-protocol',
        '@happier-dev/triage-protocol',
      ]))
        .not.toThrow();
    } finally {
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  });
});

describe('runPluginAuthorToolchain', () => {
  it.each(['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const)(
    'resolves only satisfying Happier prepublication specifiers in %s',
    (section) => {
      expect(collectBundledPrepublicationAuthorPackageNames({
        name: 'external-happier-plugin', version: '1.0.0',
        [section]: {
          '@happier-dev/plugin-sdk': '0.0.0',
          '@happier-dev/triage-protocol': ' >=0.0.0 <1.0.0 ',
          '@happier-dev/triage-sources': '>=1.0.0 <2.0.0',
          'third-party-protocol': '0.0.0',
          '@happier-dev/plugin-ui': 'file:../plugin-ui',
          '@happier-dev/channels-protocol': 'latest',
          '@happier-dev/email-transports-protocol': 'not a range',
        },
      })).toEqual([
        '@happier-dev/plugin-sdk', '@happier-dev/triage-protocol',
      ]);
    },
  );

  it('resolves the real out-of-tree Triage fixture package through bundled author packages', async () => {
    const packageJson: unknown = JSON.parse(await readFile(new URL(
      '../../../../../packages/tests/fixtures/plugin-platform/out-of-tree-triage-source/package.json',
      import.meta.url,
    ), 'utf8'));
    expect(collectBundledPrepublicationAuthorPackageNames(packageJson)).toEqual([
      '@happier-dev/plugin-sdk', '@happier-dev/triage-protocol', '@happier-dev/triage-sources',
    ]);
  });

  it.each([
    { name: 'author-owned', contents: 'packages:\n  - plugins/*\n', replaceable: false },
    { name: 'author-owned with a quoted marker', contents: 'packages:\n  - plugins/*\n# Happier transient public author workspace\n', replaceable: false },
    { name: 'empty leaked', contents: '', replaceable: true },
    { name: 'marked leaked', contents: '# Happier transient public author workspace\noverrides:\n  stale: file:///missing\n', replaceable: true },
  ])('handles $name pnpm workspace configuration for bundled SDK resolution', async ({ contents, replaceable }) => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'happier-author-owned-pnpm-workspace-'));
    const workspaceConfigPath = join(projectRoot, 'pnpm-workspace.yaml');
    const prepublication = await createFixturePrepublicationMaterializer({
      projectRoot,
      packages: [{ name: '@happier-dev/plugin-sdk', publicAuthor: true }],
    });
    const spawn = vi.fn(async () => {
      const config = await readFile(workspaceConfigPath, 'utf8');
      const sdkFileUrl = config.match(/^  "@happier-dev\/plugin-sdk": "(file:\/\/\/[^\n]+)"$/mu)?.[1];
      expect(sdkFileUrl).toBeDefined();
      expect((await lstat(fileURLToPath(sdkFileUrl!))).isDirectory()).toBe(true);
      return successfulSpawn();
    });
    try {
      await writeFile(join(projectRoot, 'package.json'), JSON.stringify({
        name: 'external-happier-plugin', version: '0.1.0', type: 'module',
        dependencies: { '@happier-dev/plugin-sdk': '0.0.0' },
      }), 'utf8');
      await writeFile(workspaceConfigPath, contents, 'utf8');
      const result = await runPluginAuthorToolchain({ operation: 'install', projectRoot }, {
        ensureManagedPnpmCommand: async () => '/happier/tools/pnpm/current/bin/pnpm',
        managedPnpmBinPath: () => '/happier/tools/pnpm/current/bin/pnpm',
        managedJavaScriptRuntimeBinPath: () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
        buildManagedPnpmEnvironment: (env = {}) => env,
        ensureManagedJavaScriptRuntimeCommand: async () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
        resolveNativeTypeScriptBin: () => '/fixture/plugin/node_modules/@typescript/native/bin/tsc',
        materializeBundledPrepublicationPackages: prepublication.materialize,
        spawn, processEnv: {},
      });
      if (replaceable) {
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, operation: 'install' });
        await expect(readFile(workspaceConfigPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      } else {
        expect(result).toMatchObject({
          ok: false, operation: 'install',
          diagnostics: [expect.objectContaining({
            code: 'plugin_author_tool_failed',
            message: expect.stringContaining('refuses to replace an author-owned pnpm workspace configuration'),
          })],
        });
        expect(spawn).not.toHaveBeenCalled();
        await expect(readFile(workspaceConfigPath, 'utf8')).resolves.toBe(contents);
      }
    } finally {
      await prepublication.cleanup();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('does not reinstall dependencies before a focused check when the author root is already materialized', async () => {
    const fixture = await createColdAuthorBuildFixture(createPluginManifestV2Fixture({ entrypoints: undefined }));
    try {
      const sdkRoot = join(fixture.projectRoot, 'node_modules', '@happier-dev', 'plugin-sdk');
      await mkdir(sdkRoot, { recursive: true });
      await writeFile(join(sdkRoot, 'package.json'), JSON.stringify({
        name: '@happier-dev/plugin-sdk',
        version: '0.0.0',
      }), 'utf8');
      const spawn = vi.fn(successfulSpawn);

      const result = await runPluginAuthorToolchain({
        operation: 'typecheck',
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

      expect(result).toMatchObject({ ok: true, operation: 'typecheck' });
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(spawn.mock.calls[0]?.[0]).toMatchObject({
        command: '/happier/tools/js-runtime/current/bin/happier-js-runtime',
      });
    } finally {
      await fixture.cleanup();
    }
  });

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
    try {
      await expect(classifyPluginAuthorDaemonBuild(fixture.projectRoot))
        .resolves.toBe(shouldBundleDaemon ? 'required' : 'not-required');
      if (shouldBundleDaemon) return;

      // The real daemon bundler would fail on this manifest-less source, so a
      // successful build proves the toolchain honoured the classification.
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
        spawn: vi.fn(successfulSpawn),
        processEnv: {},
      });

      expect(result).toMatchObject({ ok: true, operation: 'build' });
      await expect(readFile(join(fixture.projectRoot, PLUGIN_DAEMON_OUTPUT_MANIFEST_RELATIVE_PATH), 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(join(fixture.projectRoot, 'dist', 'actions', 'index.js'), 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' });
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
    const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'happier-author-build-closure-')));
    const pluginId = 'acme.toolchain-build-closure';
    const manifest = createPluginManifestV2Fixture({
      id: pluginId,
      entrypoints: { development: './src/index.ts', daemon: './dist/index.js' },
      contributes: {
        actions: [{
          id: 'publish',
          title: 'Publish',
          scopes: ['global'],
          surfaces: ['cli'],
          placementBindings: ['commandPalette'],
          dangerLevel: 'safe',
          execution: { target: 'daemon' },
        }],
      },
    });
    try {
      await mkdir(join(projectRoot, '.happier-plugin'), { recursive: true });
      await mkdir(join(projectRoot, 'src'), { recursive: true });
      await writeFile(join(projectRoot, 'package.json'), JSON.stringify({
        name: 'acme-toolchain-build-closure', version: '1.0.0', type: 'module',
      }), 'utf8');
      await writeFile(join(projectRoot, '.happier-plugin', 'plugin.json'), JSON.stringify(manifest), 'utf8');
      await mkdir(join(projectRoot, 'src', 'lib'), { recursive: true });
      await writeFile(join(projectRoot, 'src', 'lib', 'answer.ts'), 'export const answer = 42;\n', 'utf8');
      await writeFile(join(projectRoot, 'src', 'index.ts'), [
        "import { answer } from './lib/answer';",
        `export const manifest = ${JSON.stringify(manifest)};`,
        `export const actionContracts = Object.freeze({ publish: Object.freeze({ pluginId: ${JSON.stringify(pluginId)}, localId: 'publish' }) });`,
        'export function activate(api: { actions: { register(id: string, handler: () => unknown): void } }) {',
        "  api.actions.register('publish', async () => ({ answer }));",
        '}',
        '',
      ].join('\n'), 'utf8');

      const result = await runPluginAuthorToolchain({
        operation: 'build',
        projectRoot,
      }, {
        ensureManagedPnpmCommand: async () => '/happier/tools/pnpm/current/bin/pnpm',
        managedPnpmBinPath: () => '/happier/tools/pnpm/current/bin/pnpm',
        managedJavaScriptRuntimeBinPath: () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
        buildManagedPnpmEnvironment: (env = {}) => env,
        ensureManagedJavaScriptRuntimeCommand: async () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
        resolveNativeTypeScriptBin: () => '/fixture/plugin/node_modules/@typescript/native/bin/tsc',
        resolvePluginUiBuildBin: () => null,
        generatePluginActionContracts,
        spawn: vi.fn(successfulSpawn),
        processEnv: {},
      });

      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, operation: 'build' });
      // The bundled daemon carries its local import closure, and the public
      // Action barrel types itself against that same daemon module.
      await expect(readFile(join(projectRoot, 'dist', 'index.js'), 'utf8')).resolves.toContain('42');
      await expect(readFile(join(projectRoot, 'dist', 'actions', 'index.js'), 'utf8'))
        .resolves.toContain('"publish"');
      await expect(readFile(join(projectRoot, 'dist', 'actions', 'index.d.ts'), 'utf8'))
        .resolves.toMatch(/typeof import\(["']\.\.\/index\.js["']\)\.actionContracts/u);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
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

  it('materializes the daemon-owned manifest before building declared Plugin UI artifacts', async () => {
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
    expect(bundlePluginDaemonRuntime.mock.invocationCallOrder[0]).toBeLessThan(
      spawn.mock.invocationCallOrder[2]!,
    );
  });

  it('reports a Plugin UI build failure after materializing the manifest it consumes', async () => {
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
    expect(bundlePluginDaemonRuntime).toHaveBeenCalledWith('/fixture/plugin');
    expect(bundlePluginDaemonRuntime.mock.invocationCallOrder[0]).toBeLessThan(
      spawn.mock.invocationCallOrder[2]!,
    );
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

  it('uses the Protocol loopback grammar for an IPv6 Plugin SDK registry origin', () => {
    expect(normalizePluginSdkRegistryOrigin('http://[::1]:43127'))
      .toBe('http://[::1]:43127');
    expect(normalizePluginSdkRegistryOrigin('http://[::ffff:127.0.0.1]:43127'))
      .toBe('http://[::ffff:7f00:1]:43127');
    expect(() => normalizePluginSdkRegistryOrigin('http://[::ffff:192.168.1.1]:43127'))
      .toThrow(/loopback HTTP origin/u);
  });

  it('overrides only declared public current-source author packages', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'happier-author-declared-public-packages-'));
    const materializedRoot = join(projectRoot, 'materialized');
    const cleanup = vi.fn(async () => undefined);
    try {
      await writeFile(join(projectRoot, 'package.json'), JSON.stringify({
        name: 'external-happier-plugin',
        version: '0.1.0',
        dependencies: {
          '@happier-dev/plugin-sdk': '0.0.0',
          '@happier-dev/channels-protocol': '0.0.0',
        },
      }), 'utf8');
      const packageRootsByName = new Map([
        ['@happier-dev/plugin-sdk', join(materializedRoot, 'plugin-sdk')],
        ['@happier-dev/channels-protocol', join(materializedRoot, 'channels-protocol')],
      ]);
      const spawn = vi.fn(async () => {
        const workspaceConfig = await readFile(join(projectRoot, 'pnpm-workspace.yaml'), 'utf8');
        expect(workspaceConfig).toContain('"@happier-dev/plugin-sdk"');
        expect(workspaceConfig).toContain('"@happier-dev/channels-protocol"');
        expect(workspaceConfig).not.toContain('"@happier-dev/plugin-ui"');
        expect(workspaceConfig).not.toContain('"@happier-dev/triage-protocol"');
        return successfulSpawn();
      });

      const result = await runPluginAuthorToolchain({ operation: 'install', projectRoot }, {
        ensureManagedPnpmCommand: async () => '/happier/tools/pnpm/current/bin/pnpm',
        managedPnpmBinPath: () => '/happier/tools/pnpm/current/bin/pnpm',
        managedJavaScriptRuntimeBinPath: () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
        buildManagedPnpmEnvironment: (env = {}) => env,
        ensureManagedJavaScriptRuntimeCommand: async () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
        resolveNativeTypeScriptBin: () => '/fixture/plugin/node_modules/@typescript/native/bin/tsc',
        materializeBundledPrepublicationPackages: async (packageNames) => {
          // The materialization request must name exactly the author-declared
          // packages — never the predecessor fixed set. A manual plugin-ui or
          // triage-protocol injection here would be the retired fixed-set path
          // surviving inside the toolchain.
          expect(packageNames).toEqual([
            '@happier-dev/channels-protocol',
            '@happier-dev/plugin-sdk',
          ]);
          return { packageRootsByName, cleanup };
        },
        spawn,
        processEnv: {},
      });

      expect(result).toMatchObject({ ok: true, operation: 'install' });
      expect(cleanup).toHaveBeenCalledOnce();
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('refuses a declared internal current-source package that lacks public author classification', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'happier-author-private-package-'));
    const spawn = vi.fn(successfulSpawn);
    const prepublication = await createFixturePrepublicationMaterializer({
      projectRoot,
      packages: [
        { name: '@happier-dev/plugin-sdk', publicAuthor: true },
        { name: '@happier-dev/protocol', publicAuthor: false },
      ],
    });
    try {
      await writeFile(join(projectRoot, 'package.json'), JSON.stringify({
        name: 'external-happier-plugin',
        version: '0.1.0',
        dependencies: { '@happier-dev/protocol': '0.0.0' },
      }), 'utf8');

      const result = await runPluginAuthorToolchain({ operation: 'install', projectRoot }, {
        ensureManagedPnpmCommand: async () => '/happier/tools/pnpm/current/bin/pnpm',
        managedPnpmBinPath: () => '/happier/tools/pnpm/current/bin/pnpm',
        managedJavaScriptRuntimeBinPath: () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
        buildManagedPnpmEnvironment: (env = {}) => env,
        ensureManagedJavaScriptRuntimeCommand: async () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
        resolveNativeTypeScriptBin: () => '/fixture/plugin/node_modules/@typescript/native/bin/tsc',
        materializeBundledPrepublicationPackages: prepublication.materialize,
        spawn,
        processEnv: {},
      });

      expect(result).toMatchObject({
        ok: false,
        operation: 'install',
        diagnostics: [expect.objectContaining({
          code: 'plugin_author_tool_failed',
          message: expect.stringContaining('not classified for public author use'),
        })],
      });
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      await prepublication.cleanup();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

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
    ['typecheck', [
      '--noEmit',
      '--tsBuildInfoFile',
      'node_modules/.cache/happier/plugin-author.typecheck.tsbuildinfo',
      '-p',
      'tsconfig.json',
    ]],
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

  it('builds one explicit test-only module and the managed UI before running a fresh scaffold test', async () => {
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
      resolvePluginUiBuildBin: () => '/fixture/plugin/node_modules/@happier-dev/plugin-sdk/dist/ui/build/bin.js',
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
        args: [
          '/fixture/plugin/node_modules/@typescript/native/bin/tsc',
          '--noEmit',
          'false',
          '--outDir',
          'node_modules/.cache/happier/plugin-author-test',
          '--tsBuildInfoFile',
          'node_modules/.cache/happier/plugin-author-test.tsbuildinfo',
          '-p',
          'tsconfig.json',
        ],
        cwd: '/fixture/plugin',
        env: {},
      }],
      [{
        command: '/happier/tools/js-runtime/current/bin/happier-js-runtime',
        args: [
          '/fixture/plugin/node_modules/@happier-dev/plugin-sdk/dist/ui/build/bin.js',
          '--project-root',
          '/fixture/plugin',
        ],
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
      spawn.mock.invocationCallOrder[3]!,
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

  it.each(['@typescript/native', 'typescript'])('resolves an ancestor TypeScript 7 package named %s while refusing another compiler', async packageName => {
    const parentRoot = await mkdtemp(join(tmpdir(), 'happier-author-typescript-owner-'));
    const projectRoot = join(parentRoot, 'plugin');
    const ancestorPackageRoot = join(parentRoot, 'node_modules', '@typescript', 'native');
    try {
      await mkdir(projectRoot, { recursive: true });
      await mkdir(join(ancestorPackageRoot, 'bin'), { recursive: true });
      await writeFile(join(projectRoot, 'package.json'), '{"type":"module"}\n', 'utf8');
      await writeFile(join(ancestorPackageRoot, 'package.json'), JSON.stringify({
        name: packageName,
        version: '7.0.2',
        bin: { tsc: './bin/tsc' },
      }), 'utf8');
      await writeFile(join(ancestorPackageRoot, 'bin', 'tsc'), '', 'utf8');
      expect(resolveNativeTypeScriptBin(projectRoot)).toBe(await realpath(join(ancestorPackageRoot, 'bin', 'tsc')));
      await rm(join(ancestorPackageRoot, 'bin', 'tsc'));
      expect(() => resolveNativeTypeScriptBin(projectRoot)).toThrow();

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
      await writeFile(join(localPackageRoot, 'package.json'), JSON.stringify({
        name: 'different-compiler', version: '7.0.2', bin: { tsc: './bin/tsc' },
      }), 'utf8');
      expect(() => resolveNativeTypeScriptBin(versionProjectRoot)).toThrow(/@typescript\/native/u);
      await writeFile(join(localPackageRoot, 'package.json'), JSON.stringify({
        name: '@typescript/native', version: '7.0.2',
      }), 'utf8');
      expect(() => resolveNativeTypeScriptBin(versionProjectRoot)).toThrow(/entrypoint/u);
    } finally {
      await rm(parentRoot, { recursive: true, force: true });
    }
  });

  it('resolves a linked external SDK builder while refusing an entrypoint outside that SDK', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'happier-author-ui-builder-'));
    const packageRoot = join(projectRoot, 'sdk');
    try {
      await mkdir(join(projectRoot, 'node_modules', '@happier-dev'), { recursive: true });
      await symlink(packageRoot, join(projectRoot, 'node_modules', '@happier-dev', 'plugin-sdk'), 'junction');
      await mkdir(join(packageRoot, 'dist', 'ui', 'build'), { recursive: true });
      await writeFile(join(projectRoot, 'package.json'), JSON.stringify({
        dependencies: { '@happier-dev/plugin-sdk': '0.0.0' },
        scripts: { build: 'happier plugins dev build .' },
      }), 'utf8');
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
        name: '@happier-dev/plugin-sdk',
        bin: { 'happier-plugin-build-ui': './dist/ui/build/bin.js' },
      }), 'utf8');
      const expectedBuilder = join(packageRoot, 'dist', 'ui', 'build', 'bin.js');
      await writeFile(expectedBuilder, 'export {};\n', 'utf8');

      expect(resolvePluginUiBuildBin(projectRoot)).toBe(await realpath(expectedBuilder));
      const nestedProject = join(projectRoot, 'nested-plugin');
      await mkdir(nestedProject);
      await writeFile(join(nestedProject, 'package.json'), JSON.stringify({
        dependencies: { '@happier-dev/plugin-sdk': '0.0.0' },
      }), 'utf8');
      expect(resolvePluginUiBuildBin(nestedProject)).toBe(await realpath(expectedBuilder));

      const outsideBuilder = join(projectRoot, 'outside-builder.js');
      await writeFile(outsideBuilder, 'export {};\n', 'utf8');
      await rm(expectedBuilder);
      await symlink(outsideBuilder, expectedBuilder);
      expect(() => resolvePluginUiBuildBin(projectRoot)).toThrow(/contained regular file/u);
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: '@happier-dev/plugin-sdk' }), 'utf8');
      expect(() => resolvePluginUiBuildBin(projectRoot)).toThrow(/entrypoint/u);
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: 'different-sdk' }), 'utf8');
      expect(() => resolvePluginUiBuildBin(projectRoot)).toThrow(/@happier-dev\/plugin-sdk/u);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('requires the canonical Plugin UI builder even when a project has no hand-authored UI config', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'happier-author-no-ui-builder-'));
    try {
      await mkdir(join(projectRoot, 'node_modules', '@happier-dev'), { recursive: true });
      await writeFile(join(projectRoot, 'package.json'), JSON.stringify({
        dependencies: { '@happier-dev/plugin-sdk': '0.0.0' },
        scripts: {
          build: 'happier plugins dev build .',
          'build:ui': 'unrelated-company-ui-builder',
        },
      }), 'utf8');

      expect(() => resolvePluginUiBuildBin(projectRoot)).toThrow(/plugin-sdk/u);
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

describe('classifyPluginAuthorDaemonBuild', () => {
  const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

  it('selects the current source SDK builder for a canonical first-party workspace', () => {
    expect(resolvePluginUiBuildBin(resolve(REPO_ROOT, 'packages/plugins/channels')))
      .toBe(resolve(REPO_ROOT, 'packages/plugin-sdk/src/ui/build/bin.ts'));
  });

  it('launches the workspace UI compiler through the source runtime without emitting a daemon build', async () => {
    const spawn = vi.fn(successfulSpawn);
    const runtime = '/fixture/managed/happier-js-runtime';
    const result = await runPluginUiArtifactBuild({
      projectRoot: resolve(REPO_ROOT, 'packages/plugins/channels'),
    }, {
      ensureManagedPnpmCommand: async () => null,
      managedPnpmBinPath: () => '',
      buildManagedPnpmEnvironment: (env = {}) => env,
      ensureManagedJavaScriptRuntimeCommand: async () => runtime,
      managedJavaScriptRuntimeBinPath: () => runtime,
      resolveNativeTypeScriptBin: () => { throw new Error('Daemon dev reload must not compile TypeScript dist'); },
      spawn,
      processEnv: {},
    });
    expect(result).toMatchObject({ ok: true, built: true });
    const invocation = spawn.mock.calls[0]?.[0];
    expect(invocation?.command).toBe(runtime);
    expect(invocation?.args).toContain('--conditions=happier-source');
    expect(invocation?.args.some(arg => arg.endsWith('/cli-common/registerSourceRuntime.mjs'))).toBe(true);
  });

  it('uses the resolved SDK package bin rather than granting source-workspace authority to a copied author', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-devplug-copied-author-'));
    try {
      await writeFile(join(root, 'package.json'), JSON.stringify({
        name: '@happier-dev/plugins-channels',
        dependencies: { '@happier-dev/plugin-sdk': '0.0.0' },
      }));
      await mkdir(join(root, 'node_modules/@happier-dev'), { recursive: true });
      await symlink(resolve(REPO_ROOT, 'packages/plugin-sdk'), join(root, 'node_modules/@happier-dev/plugin-sdk'), 'junction');
      expect(resolvePluginUiBuildBin(root)).toBe(await realpath(resolve(REPO_ROOT, 'packages/plugin-sdk/dist/ui/build/bin.js')));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('compiles third-party UI imports through the real source SDK across an edit and restore', async () => {
    const project = await mkdtemp(join(tmpdir(), 'happier-devplug-ui-source-'));
    const workspaceRoot = resolve(REPO_ROOT, 'packages/plugins/channels');
    try {
      await mkdir(join(project, 'src'), { recursive: true });
      await mkdir(join(project, '.happier-plugin'));
      await writeFile(join(project, 'package.json'), JSON.stringify({
        name: 'devplug-ui-fixture', type: 'module', dependencies: { zod: '*' }, exports: {
          './happier-plugin-ui/panel': { 'happier-source': './src/panel.ts', default: './stale.ts' },
        },
      }));
      // This disposable author project uses the already installed dependency;
      // neither dependency preparation nor shared node_modules is mutated.
      await mkdir(join(project, 'node_modules'));
      await symlink(dirname(createRequire(import.meta.url).resolve('zod/package.json')), join(project, 'node_modules/zod'), 'junction');
      await writeFile(join(project, '.happier-plugin/plugin.json'), JSON.stringify(createPluginManifestV2Fixture({
        contributes: { ui: { renderers: [{ id: 'panel', kind: 'reactNative', artifact: 'panel' }] } },
      })));
      const args = resolvePluginUiBuildArguments({
        projectRoot: workspaceRoot, builderPath: resolvePluginUiBuildBin(workspaceRoot)!,
      }).map(arg => arg === workspaceRoot ? project : arg);
      // The source adapter is selected from the canonical workspace; isolate
      // the compiler's output in this fixture rather than the shared plugin.
      for (const marker of ['original', 'edited', 'original']) {
        await writeFile(join(project, 'src/panel.ts'), [
          "import { z } from 'zod';",
          `export function renderSurface() { return z.literal(${JSON.stringify(marker)}).parse(${JSON.stringify(marker)}); }`,
        ].join('\n'));
        await promisify(execFile)(process.execPath, [...args], { cwd: REPO_ROOT });
        const artifactsRoot = join(project, 'dist/happier-plugin-ui');
        const inventory = JSON.parse(await readFile(join(artifactsRoot, 'ui-artifacts.json'), 'utf8'));
        expect(inventory.entries).toEqual([expect.objectContaining({ artifactId: 'panel' })]);
        const bytes = await readFile(join(artifactsRoot, inventory.entries[0].entry), 'utf8');
        const module = { exports: {} as Record<string, unknown> };
        new Function('module', 'exports', bytes)(module, module.exports);
        const renderSurface = module.exports.renderSurface;
        expect(renderSurface).toBeTypeOf('function');
        if (typeof renderSurface !== 'function') throw new Error('Expected the compiled UI export');
        expect(renderSurface()).toBe(marker);
      }
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  }, 120_000);

  it('classifies a bundled workspace source as local development without granting bundled authority', async () => {
    // `happier.scm.backend.git` is a reserved-namespace id whose bundled
    // manifest declares the build-time `^0.0.0` engine placeholder. The author
    // build command reads its source as external local development; generated
    // artifact custody is decided separately at the exact artifact resolver.
    await expect(classifyPluginAuthorDaemonBuild(
      resolve(REPO_ROOT, 'packages/plugins/scm-git'),
    )).resolves.toBe('required');
  });

  // C1: the dev loop reaches this classifier through `plugins.dev.build` and
  // `plugins.dev.test`, so refusing a reserved id here gave bundled plugins a
  // loop external authors could not have. A project root is a working tree on
  // this machine, never a distributed artifact. The rule stays fully enforced
  // where custody actually transfers: `resolveLocalPathPluginSource` rejects the
  // same id for every registry-custodied kind (see `discovery/sources/localPath.test.ts`),
  // so an archive built from this root is still refused at install.
  it('classifies a non-bundled author root claiming the reserved happier.* namespace', async () => {
    const fixture = await createColdAuthorBuildFixture(createPluginManifestV2Fixture({
      id: 'happier.impostor',
    }));
    try {
      // Reaching a real classification (not a throw) is the contract: the
      // fixture declares a daemon entrypoint, so its build is `required`.
      await expect(classifyPluginAuthorDaemonBuild(fixture.projectRoot))
        .resolves.toBe('required');
    } finally {
      await fixture.cleanup();
    }
  });
});
