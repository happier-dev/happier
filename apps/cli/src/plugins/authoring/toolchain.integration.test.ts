import { lstat, mkdtemp, readFile, rm, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { ensureManagedJavaScriptRuntimeCommand } from '@/packagedRuntime/js/managedJavaScriptRuntime';
import { resolveNativeTypeScriptBin, runPluginAuthorToolchain, type PluginAuthorToolchainDeps, resolvePluginAuthorToolchainSpawnInvocation, resolvePluginUiBuildBin } from './toolchain';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { preparePluginDevelopmentRoot } from '@/plugins/daemon/developmentCandidateMaterializer';

function successfulSpawn(_input?: Parameters<PluginAuthorToolchainDeps['spawn']>[0]) {
  return Promise.resolve({ exitCode: 0, signal: null, stdout: '', stderr: '' });
}

const execFileAsync = promisify(execFile);

describe('runPluginAuthorToolchain', () => {

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
});

describe('runPluginAuthorToolchain', () => {

  it('installs, refreshes and loads the prepublication author closure through the real managed file override', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'happier-author-external-sdk-resolution-'));
    const harnessHome = await mkdtemp(join(tmpdir(), 'happier-author-refresh-home-'));
    // Every declared author package must come from the transient file overrides;
    // an undeclared package must not fall back to a registry request.
    vi.stubEnv('npm_config_offline', 'true');
    vi.stubEnv('HAPPIER_HOME_DIR', harnessHome);
    try {
      await writeFile(join(projectRoot, 'package.json'), JSON.stringify({
        name: 'external-happier-plugin',
        version: '0.1.0',
        type: 'module',
        dependencies: {
          '@happier-dev/plugin-sdk': '0.0.0',
          '@happier-dev/plugin-ui': '0.0.0',
          '@happier-dev/channels-protocol': '0.0.0',
          '@happier-dev/triage-protocol': '0.0.0',
        },
      }), 'utf8');

      const result = await runPluginAuthorToolchain({
        operation: 'install',
        projectRoot,
      });

      expect(result, JSON.stringify(result, null, 2))
        .toMatchObject({ ok: true, operation: 'install', projectRoot });
      // Dev dependency installation is followed by daemon-owned preparation
      // during `plugins install --dev`. Each pass disposes its transient SDK.
      // pnpm must not try to reopen the deleted source from the prior pass.
      const refreshed = await preparePluginDevelopmentRoot({
        sourceRootPath: projectRoot,
        prepareDependencies: true,
      });
      expect(refreshed.rootPath).toBe(await realpath(projectRoot));
      await refreshed.cleanup();
      await expect(readFile(join(projectRoot, 'pnpm-workspace.yaml'), 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' });

      const installedSdkRoot = await realpath(join(projectRoot, 'node_modules', '@happier-dev', 'plugin-sdk'));
      const installedUiRoot = join(projectRoot, 'node_modules', '@happier-dev', 'plugin-ui');
      const installedChannelsProtocolRoot = join(projectRoot, 'node_modules', '@happier-dev', 'channels-protocol');
      const installedTriageProtocolRoot = join(projectRoot, 'node_modules', '@happier-dev', 'triage-protocol');
      await expect(readFile(join(installedSdkRoot, 'package.json'), 'utf8'))
        .resolves.toContain('"@happier-dev/plugin-sdk"');
      await expect(readFile(join(installedUiRoot, 'package.json'), 'utf8'))
        .resolves.toContain('"@happier-dev/plugin-ui"');
      await expect(readFile(join(installedChannelsProtocolRoot, 'package.json'), 'utf8'))
        .resolves.toContain('"@happier-dev/channels-protocol"');
      await expect(readFile(join(installedTriageProtocolRoot, 'package.json'), 'utf8'))
        .resolves.toContain('"@happier-dev/triage-protocol"');

      const authorRequire = createRequire(join(projectRoot, 'package.json'));
      const installedSdkRequire = createRequire(join(installedSdkRoot, 'package.json'));
      const composer = await import(pathToFileURL(authorRequire.resolve('@happier-dev/plugin-sdk/ui')).href);
      const protocolUiClient = await import(pathToFileURL(
        installedSdkRequire.resolve('@happier-dev/protocol/plugins/ui/client'),
      ).href);
      expect(composer.ComposerContentHandleV1Schema).toBe(protocolUiClient.ComposerContentHandleV1Schema);

      // A third-party Triage source imports the complete published feature
      // protocol surface through the same managed author dependency path.
      await writeFile(join(projectRoot, 'triage-source-entrypoints.mjs'), [
        "import { TriageSourcesContributionPointV1 } from '@happier-dev/triage-protocol';",
        "import { TRIAGE_SOURCES_ADMINISTER_ACTION_REF_V1 } from '@happier-dev/triage-protocol/v1';",
        "import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';",
        'export {',
        '  TriageSourcesContributionPointV1,',
        '  TRIAGE_SOURCES_ADMINISTER_ACTION_REF_V1,',
        '  createTriageSourceV1Fixture,',
        '};',
        '',
      ].join('\n'), 'utf8');
      const triageSourceEntrypoints = await import(pathToFileURL(
        join(projectRoot, 'triage-source-entrypoints.mjs'),
      ).href);
      expect(triageSourceEntrypoints.TriageSourcesContributionPointV1).toEqual(expect.any(Object));
      expect(triageSourceEntrypoints.TRIAGE_SOURCES_ADMINISTER_ACTION_REF_V1).toEqual(expect.any(Object));
      expect(triageSourceEntrypoints.createTriageSourceV1Fixture).toEqual(expect.any(Function));

      // The installed manifest must keep `bin`: it is the only declaration that
      // makes the conventional UI compiler discoverable during author builds.
      const installedSdkManifest = JSON.parse(await readFile(join(installedSdkRoot, 'package.json'), 'utf8')) as {
        bin?: Record<string, unknown>;
      };
      expect(installedSdkManifest.bin?.['happier-plugin-build-ui']).toEqual(expect.any(String));

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
      vi.unstubAllEnvs();
      await rm(projectRoot, { recursive: true, force: true });
      await rm(harnessHome, { recursive: true, force: true });
    }
  }, 300_000);
});
