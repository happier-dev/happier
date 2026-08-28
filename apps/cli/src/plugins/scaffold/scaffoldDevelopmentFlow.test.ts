import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { cp, chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import * as tar from 'tar';
import { describe, expect, it } from 'vitest';
import {
  bundleWorkspacePackageWithRuntimeDependencies,
  resolveInternalWorkspacePackageNameClosure,
  resolveWorkspaceBundlesFromPackageJson,
} from '@happier-dev/cli-common/workspaces';

import { handlePluginsCommand } from '@/cli/commands/plugins';
import { generatePluginActionContracts } from '@/plugins/authoring/actionContracts';
import { bundlePluginDaemonRuntime } from '@/plugins/authoring/bundleDaemonRuntime';
import { runPluginAuthorDoctor } from '@/plugins/authoring/doctor';
import { inspectPluginDevelopmentSource } from '@/plugins/authoring/sourceObserver';
import {
  preparePluginAuthorDependencies,
  resolveNativeTypeScriptBin,
  resolvePluginUiBuildBin,
  runManagedPluginPnpm,
  runPluginAuthorToolchain,
  type PluginAuthorBundledPrepublicationMaterialization,
  type PluginAuthorToolchainDeps,
  type PluginAuthorToolchainSpawnInput,
  type PluginAuthorToolchainSpawnResult,
} from '@/plugins/authoring/toolchain';
import { createDaemonPluginChangeService } from '@/plugins/daemon/changeService';
import { requestPluginDevelopmentChange } from '@/plugins/daemon/developmentClient';
import { createDaemonPathPluginChangePreparer } from '@/plugins/daemon/pathChangePreparer';
import { createTestPluginSdkTarball } from '@/plugins/distribution/testkit/pluginSdkTarball';
import { readCurrentCommittedPluginGenerations } from '@/plugins/store/registry/generationStore';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { captureConsoleText } from '@/testkit/logger/captureOutput';
import { isCanonicalAbsolutePathInsideRoot } from '@/utils/path/expandHomeDirPath';

const execFileAsync = promisify(execFile);
const requireFromTest = createRequire(import.meta.url);

function extractPrintedNextCommand(output: string): string {
  const plainOutput = output.replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '');
  const nextLine = plainOutput
    .split(/\r?\n/u)
    .find((line) => line.trimStart().startsWith('Next:'));
  if (!nextLine) throw new Error(`Missing scaffold next command in output: ${plainOutput}`);
  return nextLine.replace(/^\s*Next:\s*/u, '');
}

describe('CLI scaffold development flow', () => {
  it('cold-starts an untouched scaffold through its documented dev command and retains its current generation across a failed dependency preparation', async () => {
    const workspaceRoot = await realpath(fileURLToPath(new URL('../../../../../', import.meta.url)));
    const parentRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-cold-author-'));
    const targetDir = join(parentRoot, "cold author 'quoted' $value");
    const happyHomeDir = join(parentRoot, 'happy-home');
    const sdkTarball = await createTestPluginSdkTarball();
    const packageManagerCalls: Array<Readonly<{ projectRoot: string; args: readonly string[] }>> = [];
    let failNextDependencyPreparation = false;
    const runManagedPluginPnpm = async (input: Readonly<{
      projectRoot: string;
      args: readonly string[];
    }>) => {
      packageManagerCalls.push({ projectRoot: input.projectRoot, args: [...input.args] });
      if (failNextDependencyPreparation) {
        failNextDependencyPreparation = false;
        return { ok: false as const, message: 'simulated package resolution failure' };
      }
      const sdkRoot = join(input.projectRoot, 'node_modules', '@happier-dev', 'plugin-sdk');
      const temporaryTarballPath = join(input.projectRoot, '.happier-test-plugin-sdk.tgz');
      await mkdir(sdkRoot, { recursive: true });
      await writeFile(temporaryTarballPath, sdkTarball);
      try {
        await tar.x({ file: temporaryTarballPath, cwd: sdkRoot, strip: 1 });
      } finally {
        await rm(temporaryTarballPath, { force: true });
      }
      const candidatePackage = JSON.parse(await readFile(join(input.projectRoot, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>;
      };
      if (candidatePackage.dependencies?.['fixture-dependency']) {
        const dependencyRoot = join(input.projectRoot, 'node_modules', 'fixture-dependency');
        await mkdir(dependencyRoot, { recursive: true });
        await writeFile(join(dependencyRoot, 'package.json'), JSON.stringify({
          name: 'fixture-dependency',
          version: '1.0.0',
          type: 'module',
          exports: './index.js',
        }));
        await writeFile(join(dependencyRoot, 'index.js'), "export const installed = 'daemon-owned';\n");
      }
      return {
        ok: true as const,
        result: { exitCode: 0, signal: null, stdout: '', stderr: '' },
      };
    };
    const service = createDaemonPluginChangeService({
      prepare: createDaemonPathPluginChangePreparer({
        happyHomeDir,
        runtimeLifecycle: {
          prepare: async () => ({ abort: async () => undefined, adopt: async () => undefined }),
        },
        runManagedPluginPnpm,
      }),
      createPendingChangeId: () => `pending-${packageManagerCalls.length}`,
    });
    const requestDevelopmentChange = async (
      request: Parameters<typeof requestPluginDevelopmentChange>[0],
      options?: Readonly<{ signal?: AbortSignal; approval?: 'prompt' | 'none' }>,
    ) => await requestPluginDevelopmentChange(request, {
      ensureDaemon: async () => undefined,
      confirm: async () => true,
      requestChange: async (change) => await service.requestPluginChange(change),
      decideChange: async (decision) => await service.decidePluginChange(decision),
      createInteractionId: () => 'cold-start-author-test',
      nowMs: () => 1,
    }, {
      ...(options?.signal ? { signal: options.signal } : {}),
      approval: options?.approval ?? 'prompt',
    });
    const runPluginAuthorToolchain = async (input: Readonly<{
      operation: 'install' | 'typecheck' | 'build' | 'test';
      projectRoot: string;
    }>) => {
      const preparation = await runManagedPluginPnpm({
        projectRoot: input.projectRoot,
        args: ['install', '--ignore-scripts'],
      });
      if (!preparation.ok) {
        return {
          ok: false as const,
          operation: input.operation,
          projectRoot: input.projectRoot,
          diagnostics: [{ code: 'plugin_author_tool_failed' as const, message: preparation.message }],
        };
      }
      return { ok: true as const, operation: input.operation, projectRoot: input.projectRoot };
    };
    const runDevelopmentCommand = async (changedPaths?: readonly string[]): Promise<string> => {
      const controller = new AbortController();
      const output = captureConsoleText();
      try {
        await handlePluginsCommand(['dev', targetDir], {
          isInteractiveTerminal: () => true,
          runPluginAuthorToolchain,
          startPluginDevelopmentSourceObserver: async (input) => {
            const observation = await inspectPluginDevelopmentSource({
              projectRoot: input.projectRoot,
              ...(input.sdkRegistryOrigin ? { sdkRegistryOrigin: input.sdkRegistryOrigin } : {}),
            });
            if (!observation.ok) throw new Error('The freshly generated author source was not observable');
            await input.onObservation(changedPaths
              ? { ...observation, request: { ...observation.request, changedPaths } }
              : observation);
            queueMicrotask(() => controller.abort());
            return { stop: () => undefined };
          },
          requestDevelopmentChange,
        }, { signal: controller.signal });
        return output.text();
      } finally {
        output.restore();
      }
    };
    const readCurrentGeneration = async (context = '') => {
      const current = await readCurrentCommittedPluginGenerations(resolvePluginStorePaths({ happyHomeDir }));
      const generation = current?.generations.get('local.cold-author-quoted-value');
      expect(generation, context).toBeDefined();
      if (!generation) throw new Error(`Expected the daemon to retain a current generated-plugin generation${context ? `: ${context}` : ''}`);
      return generation;
    };

    try {
      const createOutput = captureConsoleText();
      try {
        await handlePluginsCommand(['create', targetDir]);
        const nextCommand = extractPrintedNextCommand(createOutput.text());
        if (process.platform === 'win32') {
          expect(nextCommand).toBe(`happier plugins dev "${targetDir}"`);
        } else {
          const fakeBinDir = join(parentRoot, 'fake-bin');
          const invocationPath = join(parentRoot, 'printed-next-command.txt');
          const fakeHappierPath = join(fakeBinDir, 'happier');
          await mkdir(fakeBinDir, { recursive: true });
          await writeFile(fakeHappierPath, [
            '#!/bin/sh',
            'printf "%s\\n" "$PWD" > "$HAPPIER_PRINTED_NEXT_COMMAND_RECORD"',
            'printf "%s\\n" "$*" >> "$HAPPIER_PRINTED_NEXT_COMMAND_RECORD"',
            '',
          ].join('\n'), 'utf8');
          await chmod(fakeHappierPath, 0o755);

          await execFileAsync('/bin/sh', ['-c', nextCommand], {
            cwd: parentRoot,
            env: {
              ...process.env,
              PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
              HAPPIER_PRINTED_NEXT_COMMAND_RECORD: invocationPath,
            },
          });
          await expect(readFile(invocationPath, 'utf8')).resolves.toBe(`${targetDir}\nplugins dev\n`);
        }
      } finally {
        createOutput.restore();
      }
      await expect(lstat(join(targetDir, 'pnpm-lock.yaml'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(lstat(join(targetDir, 'node_modules'))).rejects.toMatchObject({ code: 'ENOENT' });

      const initialDevelopmentOutput = await runDevelopmentCommand();
      expect(initialDevelopmentOutput).toContain('Development candidate accepted');
      const preparationCallsAfterInitialDevelopment = packageManagerCalls.length;
      expect(preparationCallsAfterInitialDevelopment).toBeGreaterThan(0);
      expect(packageManagerCalls[0]?.args).toEqual(expect.arrayContaining([
        'install',
        '--ignore-scripts',
      ]));
      const firstGeneration = await readCurrentGeneration(initialDevelopmentOutput);
      const installedSdkRoot = join(firstGeneration.rootPath, 'node_modules', '@happier-dev', 'plugin-sdk');
      const resolvedInstalledSdkRoot = await realpath(installedSdkRoot);
      expect((await lstat(resolvedInstalledSdkRoot)).isSymbolicLink()).toBe(false);
      expect(isCanonicalAbsolutePathInsideRoot(workspaceRoot, resolvedInstalledSdkRoot)).toBe(false);
      await expect(readFile(join(installedSdkRoot, 'API.md'), 'utf8'))
        .resolves.toContain('> Generated from `api-surface.json`. Do not hand-edit.');
      await expect(lstat(join(targetDir, 'pnpm-lock.yaml'))).rejects.toMatchObject({ code: 'ENOENT' });

      const sourceEntryPath = join(targetDir, 'src', 'index.ts');
      await writeFile(sourceEntryPath, `${await readFile(sourceEntryPath, 'utf8')}\n// source-only edit\n`, 'utf8');
      expect(await runDevelopmentCommand(['src/index.ts'])).toContain('Development candidate accepted');
      // The first `plugins dev` prepared the author root the scaffold left
      // unmaterialized; a warm root is not reinstalled, and the daemon's
      // source-only candidate cycle reuses its prior immutable closure without
      // invoking the package materializer either.
      expect(packageManagerCalls).toHaveLength(preparationCallsAfterInitialDevelopment);

      const packageJsonPath = join(targetDir, 'package.json');
      const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as Record<string, unknown>;
      await writeFile(packageJsonPath, `${JSON.stringify({
        ...packageJson,
        dependencies: { ...(packageJson.dependencies as Record<string, string>), 'fixture-dependency': '1.0.0' },
      }, null, 2)}\n`, 'utf8');
      const preparationCallsBeforeDependencyChange = packageManagerCalls.length;
      expect(await runDevelopmentCommand(['package.json']))
        .toContain('plugin_dev_adoption_pending');
      expect(packageManagerCalls.length).toBeGreaterThan(preparationCallsBeforeDependencyChange);
      const stableGeneration = await readCurrentGeneration();
      await expect(readFile(join(stableGeneration.rootPath, 'node_modules', 'fixture-dependency', 'index.js'), 'utf8'))
        .resolves.toContain("installed = 'daemon-owned'");

      const failingPackageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as Record<string, unknown>;
      await writeFile(packageJsonPath, `${JSON.stringify({ ...failingPackageJson, description: 'dependency-input failure' }, null, 2)}\n`, 'utf8');
      failNextDependencyPreparation = true;
      const preparationCallsBeforeFailure = packageManagerCalls.length;
      expect(await runDevelopmentCommand(['package.json'])).toContain('simulated package resolution failure');
      expect(packageManagerCalls.length).toBeGreaterThan(preparationCallsBeforeFailure);
      expect((await readCurrentGeneration()).immutableGenerationId).toBe(stableGeneration.immutableGenerationId);
    } finally {
      await service.shutdown();
      await rm(parentRoot, { recursive: true, force: true });
    }
  }, 60_000);

  it('takes a clean external code-defined scaffold through create, dev, development checks, and doctor without an author-owned SDK resolver', async () => {
    const workspaceRoot = await realpath(fileURLToPath(new URL('../../../../../', import.meta.url)));
    const cliPackageRoot = join(workspaceRoot, 'apps', 'cli');
    const workspaceBundles = resolveWorkspaceBundlesFromPackageJson({
      repoRoot: workspaceRoot,
      hostPackageDir: cliPackageRoot,
    });
    const bundlesByPackageName = new Map(workspaceBundles.map((bundle) => [bundle.packageName, bundle] as const));
    const sdkRuntimeClosureBundles = resolveInternalWorkspacePackageNameClosure({
      repoRoot: workspaceRoot,
      packageNames: ['@happier-dev/plugin-sdk'],
    }).map((packageName) => {
      const bundle = bundlesByPackageName.get(packageName);
      if (!bundle) throw new Error(`The running CLI must bundle Plugin SDK runtime dependency '${packageName}'.`);
      return bundle;
    });
    const sdkBundle = sdkRuntimeClosureBundles.find((bundle) => bundle.packageName === '@happier-dev/plugin-sdk');
    if (!sdkBundle) throw new Error('The running CLI must bundle the public Plugin SDK.');

    const parentRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-external-lifecycle-'));
    const targetDir = join(parentRoot, 'external-plugin');
    const happyHomeDir = join(parentRoot, 'happy-home');
    const managedPnpmCommand = join(parentRoot, 'managed-pnpm');
    const managedPnpmCalls: PluginAuthorToolchainSpawnInput[] = [];
    const materializedSdkRoots: string[] = [];
    const cachedSdkPackageRoot = join(
      parentRoot,
      'sdk-runtime-closure',
      'node_modules',
      '@happier-dev',
      'plugin-sdk',
    );
    let preparedSdkRuntimeClosure = false;

    const prepareCachedSdkRuntimeClosure = async (): Promise<string> => {
      if (preparedSdkRuntimeClosure) return cachedSdkPackageRoot;
      try {
        bundleWorkspacePackageWithRuntimeDependencies({
          packageName: sdkBundle.packageName,
          srcDir: sdkBundle.srcDir,
          destDir: cachedSdkPackageRoot,
          dereferenceRootDir: sdkBundle.dereferenceRootDir,
          pruneStale: true,
        });
        for (const runtimeBundle of sdkRuntimeClosureBundles) {
          if (runtimeBundle.packageName === '@happier-dev/plugin-sdk') continue;
          bundleWorkspacePackageWithRuntimeDependencies({
            packageName: runtimeBundle.packageName,
            srcDir: runtimeBundle.srcDir,
            destDir: join(cachedSdkPackageRoot, 'node_modules', ...runtimeBundle.packageName.split('/')),
            dereferenceRootDir: runtimeBundle.dereferenceRootDir,
            pruneStale: true,
          });
        }
        const packageJsonPath = join(cachedSdkPackageRoot, 'package.json');
        const materializedPackageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
          dependencies?: Record<string, string>;
        };
        const dependencies = { ...materializedPackageJson.dependencies };
        const bundledDependencies = sdkRuntimeClosureBundles
          .filter((bundle) => bundle.packageName !== '@happier-dev/plugin-sdk')
          .map((bundle) => bundle.packageName)
          .sort((left, right) => left.localeCompare(right));
        for (const runtimeBundle of sdkRuntimeClosureBundles) {
          if (runtimeBundle.packageName === '@happier-dev/plugin-sdk') continue;
          const runtimePackageJson = JSON.parse(await readFile(join(runtimeBundle.srcDir, 'package.json'), 'utf8')) as {
            version?: string;
          };
          if (!runtimePackageJson.version) {
            throw new Error(`Plugin SDK runtime dependency '${runtimeBundle.packageName}' has no version.`);
          }
          dependencies[runtimeBundle.packageName] = runtimePackageJson.version;
        }
        await writeFile(packageJsonPath, `${JSON.stringify({
          ...materializedPackageJson,
          dependencies,
          bundledDependencies,
        }, null, 2)}\n`, 'utf8');
        preparedSdkRuntimeClosure = true;
        return cachedSdkPackageRoot;
      } catch (error) {
        await rm(join(parentRoot, 'sdk-runtime-closure'), { recursive: true, force: true });
        throw error;
      }
    };

    const materializeBundledPrepublicationPackages = async (): Promise<PluginAuthorBundledPrepublicationMaterialization> => {
      const materializationRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-sdk-lifecycle-'));
      const packageRoot = join(materializationRoot, 'node_modules', '@happier-dev', 'plugin-sdk');
      try {
        // The authoritative materializer has dedicated closure tests. This
        // lifecycle test preserves that exact package graph but clones a
        // single prepared copy so five author commands remain a practical
        // end-to-end contract check.
        await mkdir(dirname(packageRoot), { recursive: true });
        await cp(await prepareCachedSdkRuntimeClosure(), packageRoot, {
          recursive: true,
          force: true,
          dereference: true,
          mode: constants.COPYFILE_FICLONE,
        });
        materializedSdkRoots.push(packageRoot);
        return {
          packageRootsByName: new Map([['@happier-dev/plugin-sdk', packageRoot]]),
          cleanup: async () => await rm(materializationRoot, { recursive: true, force: true }),
        };
      } catch (error) {
        await rm(materializationRoot, { recursive: true, force: true });
        throw error;
      }
    };

    const copyInstalledPackage = async (projectRoot: string, packageName: string): Promise<void> => {
      const packageJsonPath = requireFromTest.resolve(`${packageName}/package.json`);
      const packageRoot = await realpath(dirname(packageJsonPath));
      const destination = join(projectRoot, 'node_modules', ...packageName.split('/'));
      await mkdir(dirname(destination), { recursive: true });
      await cp(packageRoot, destination, {
        recursive: true,
        force: true,
        dereference: true,
        mode: constants.COPYFILE_FICLONE,
      });
    };

    const runManagedRuntime = async (
      input: PluginAuthorToolchainSpawnInput,
    ): Promise<PluginAuthorToolchainSpawnResult> => {
      try {
        await execFileAsync(input.command, [...input.args], {
          cwd: input.cwd,
          env: input.env,
          ...(input.signal ? { signal: input.signal } : {}),
        });
        return { exitCode: 0, signal: null, stdout: '', stderr: '' };
      } catch (error) {
        return {
          exitCode: 1,
          signal: null,
          stdout: '',
          stderr: error instanceof Error ? error.stack ?? error.message : String(error),
        };
      }
    };

    const toolchainDeps: PluginAuthorToolchainDeps = {
      ensureManagedPnpmCommand: async () => managedPnpmCommand,
      managedPnpmBinPath: () => managedPnpmCommand,
      buildManagedPnpmEnvironment: (environment = {}) => environment,
      ensureManagedJavaScriptRuntimeCommand: async () => process.execPath,
      managedJavaScriptRuntimeBinPath: () => process.execPath,
      resolveNativeTypeScriptBin,
      resolvePluginUiBuildBin,
      materializeBundledPrepublicationPackages,
      generatePluginActionContracts,
      bundlePluginDaemonRuntime,
      spawn: async (input) => {
        if (resolve(input.command) !== resolve(managedPnpmCommand)) {
          return await runManagedRuntime(input);
        }

        managedPnpmCalls.push(input);
        const workspaceConfigPath = join(input.cwd, 'pnpm-workspace.yaml');
        const workspaceConfig = await readFile(workspaceConfigPath, 'utf8');
        const bundledSdkUrl = workspaceConfig.match(
          /^  "@happier-dev\/plugin-sdk": "(file:\/\/\/[^\n]+)"$/mu,
        )?.[1];
        expect(bundledSdkUrl).toBeDefined();
        expect(input.args).toContain('--lockfile=false');
        expect(input.args.some((argument) => argument.startsWith('--config.@happier-dev:registry='))).toBe(false);

        const bundledSdkRoot = fileURLToPath(bundledSdkUrl!);
        const bundledSdkManifest = JSON.parse(await readFile(join(bundledSdkRoot, 'package.json'), 'utf8')) as {
          bundledDependencies?: string[];
        };
        const expectedBundledRuntimeDependencies = sdkRuntimeClosureBundles
          .filter((bundle) => bundle.packageName !== '@happier-dev/plugin-sdk')
          .map((bundle) => bundle.packageName)
          .sort((left, right) => left.localeCompare(right));
        expect(bundledSdkManifest.bundledDependencies).toEqual(expectedBundledRuntimeDependencies);
        for (const packageName of expectedBundledRuntimeDependencies) {
          const runtimeDependencyRoot = join(bundledSdkRoot, 'node_modules', ...packageName.split('/'));
          expect((await lstat(runtimeDependencyRoot)).isDirectory()).toBe(true);
          expect((await lstat(runtimeDependencyRoot)).isSymbolicLink()).toBe(false);
        }
        const installedSdkRoot = join(input.cwd, 'node_modules', '@happier-dev', 'plugin-sdk');
        await mkdir(dirname(installedSdkRoot), { recursive: true });
        await rm(installedSdkRoot, { recursive: true, force: true });
        if (input.args.includes('--config.node-linker=hoisted')) {
          // The daemon candidate is copied through pnpm's hoisted/copy mode,
          // because its containment verifier rejects symlinked package trees.
          await cp(bundledSdkRoot, installedSdkRoot, {
            recursive: true,
            force: true,
            dereference: true,
            mode: constants.COPYFILE_FICLONE,
          });
        } else {
          // An ordinary author-root install keeps pnpm's normal virtual-store
          // link. The resolved package, rather than the top-level link, is
          // the physical SDK closure contract.
          const virtualStoreSdkRoot = join(
            input.cwd,
            'node_modules',
            '.pnpm',
            '@happier-dev+plugin-sdk@0.0.0',
            'node_modules',
            '@happier-dev',
            'plugin-sdk',
          );
          await mkdir(dirname(virtualStoreSdkRoot), { recursive: true });
          await cp(bundledSdkRoot, virtualStoreSdkRoot, {
            recursive: true,
            force: true,
            dereference: true,
            mode: constants.COPYFILE_FICLONE,
          });
          await symlink(
            process.platform === 'win32'
              ? virtualStoreSdkRoot
              : relative(dirname(installedSdkRoot), virtualStoreSdkRoot),
            installedSdkRoot,
            process.platform === 'win32' ? 'junction' : 'dir',
          );
        }
        await Promise.all([
          copyInstalledPackage(input.cwd, '@types/node'),
          copyInstalledPackage(input.cwd, 'undici-types'),
          copyInstalledPackage(input.cwd, '@typescript/native'),
          copyInstalledPackage(input.cwd, `@typescript/typescript-${process.platform}-${process.arch}`),
        ]);
        return { exitCode: 0, signal: null, stdout: '', stderr: '' };
      },
      processEnv: { ...process.env },
    };

    const runManagedPnpmForTest = async (input: Readonly<{
      projectRoot: string;
      args: readonly string[];
      sdkRegistryOrigin?: string | null;
      signal?: AbortSignal;
    }>) => await runManagedPluginPnpm(input, toolchainDeps);
    const service = createDaemonPluginChangeService({
      prepare: createDaemonPathPluginChangePreparer({
        happyHomeDir,
        runtimeLifecycle: {
          prepare: async () => ({ abort: async () => undefined, adopt: async () => undefined }),
        },
        runManagedPluginPnpm: runManagedPnpmForTest,
      }),
      createPendingChangeId: () => 'external-lifecycle-pending',
    });
    const requestDevelopmentChange = async (
      request: Parameters<typeof requestPluginDevelopmentChange>[0],
      options?: Readonly<{ signal?: AbortSignal; approval?: 'prompt' | 'none' }>,
    ) => await requestPluginDevelopmentChange(request, {
      ensureDaemon: async () => undefined,
      confirm: async () => true,
      requestChange: async (change) => await service.requestPluginChange(change),
      decideChange: async (decision) => await service.decidePluginChange(decision),
      createInteractionId: () => 'external-lifecycle-test',
      nowMs: () => 1,
    }, {
      ...(options?.signal ? { signal: options.signal } : {}),
      approval: options?.approval ?? 'prompt',
    });

    const runCliCommand = async (args: string[]): Promise<string> => {
      const output = captureConsoleText();
      const previousExitCode = process.exitCode;
      process.exitCode = undefined;
      try {
        await handlePluginsCommand(args, {
          runPluginAuthorToolchain: async (input) => await runPluginAuthorToolchain(input, toolchainDeps),
          runPluginAuthorDoctor: async (input) => await runPluginAuthorDoctor({
            ...input,
            prepareDependencies: async ({ projectRoot }) => await preparePluginAuthorDependencies({ projectRoot }, toolchainDeps),
          }),
        });
        expect(process.exitCode).not.toBe(1);
        return output.text();
      } finally {
        process.exitCode = previousExitCode;
        output.restore();
      }
    };

    try {
      const createOutput = captureConsoleText();
      try {
        await handlePluginsCommand(['create', targetDir, '--id', 'acme.external-lifecycle']);
        expect(createOutput.text()).toContain('Created External Plugin.');
      } finally {
        createOutput.restore();
      }
      const packageJson = JSON.parse(await readFile(join(targetDir, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>;
      };
      expect(packageJson.dependencies?.['@happier-dev/plugin-sdk']).toBe('0.0.0');
      await expect(lstat(join(targetDir, 'pnpm-workspace.yaml'))).rejects.toMatchObject({ code: 'ENOENT' });

      const devController = new AbortController();
      const devOutput = captureConsoleText();
      try {
        await handlePluginsCommand(['dev', targetDir], {
          isInteractiveTerminal: () => true,
          runPluginAuthorToolchain: async (input) => await runPluginAuthorToolchain(input, toolchainDeps),
          startPluginDevelopmentSourceObserver: async (input) => {
            expect(input.sdkRegistryOrigin).toBeUndefined();
            const observation = await inspectPluginDevelopmentSource({ projectRoot: input.projectRoot });
            if (!observation.ok) throw new Error('The clean external scaffold was not observable.');
            await input.onObservation(observation);
            queueMicrotask(() => devController.abort());
            return { stop: () => undefined };
          },
          requestDevelopmentChange,
        }, { signal: devController.signal });
        expect(devOutput.text()).toContain('Development candidate accepted');
      } finally {
        devOutput.restore();
      }

      expect(await runCliCommand(['dev', 'typecheck', targetDir]))
        .toContain('Plugin development typecheck completed');
      expect(await runCliCommand(['dev', 'build', targetDir]))
        .toContain('Plugin development build completed');
      expect(await runCliCommand(['test', targetDir]))
        .toContain('Plugin development test completed');
      await expect(readFile(
        join(targetDir, 'node_modules', '.cache', 'happier', 'plugin-author.tsbuildinfo'),
        'utf8',
      )).resolves.toContain('fileNames');
      await expect(readFile(
        join(targetDir, 'node_modules', '.cache', 'happier', 'plugin-author.typecheck.tsbuildinfo'),
        'utf8',
      )).resolves.toContain('fileNames');
      expect(await runCliCommand(['doctor', targetDir]))
        .toContain('evaluated in');

      const installedSdkRoot = join(targetDir, 'node_modules', '@happier-dev', 'plugin-sdk');
      const resolvedInstalledSdkRoot = await realpath(installedSdkRoot);
      expect((await lstat(resolvedInstalledSdkRoot)).isSymbolicLink()).toBe(false);
      expect(isCanonicalAbsolutePathInsideRoot(workspaceRoot, resolvedInstalledSdkRoot)).toBe(false);
      expect(await readFile(join(installedSdkRoot, 'API.md'), 'utf8'))
        .toContain('> Generated from `api-surface.json`. Do not hand-edit.');
      // Cold development prepares the author root once. The daemon separately
      // prepares its isolated candidate copy; focused typecheck/build/test and
      // doctor must not reinstall the root the author is editing.
      expect(managedPnpmCalls.filter((call) => call.cwd === targetDir)).toHaveLength(1);
      await expect(lstat(join(targetDir, 'pnpm-workspace.yaml'))).rejects.toMatchObject({ code: 'ENOENT' });
      for (const materializedSdkRoot of materializedSdkRoots) {
        await expect(lstat(materializedSdkRoot)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(isCanonicalAbsolutePathInsideRoot(materializedSdkRoot, resolvedInstalledSdkRoot)).toBe(false);
      }
    } finally {
      await service.shutdown();
      await rm(parentRoot, { recursive: true, force: true });
    }
  }, 300_000);
});
