import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { evaluatePluginAuthorRuntimeStagingSource } from './runtimeStagingSource';

function bundledPluginRoot(packageName: string): string {
  return resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../../../packages/plugins',
    packageName,
  );
}

/**
 * Surviving bundled plugin whose runner leaf still owns a custom session runtime
 * and exports the External Sessions companion beside it. Pi is the smallest such
 * source graph, which keeps this real-root staging case affordable.
 */
const PI_PLUGIN_ROOT = bundledPluginRoot('pi');
/** Declarative-ACP bundled plugin: the ACP runtime owns its sessions, so it stages no locator. */
const ANTIGRAVITY_PLUGIN_ROOT = bundledPluginRoot('antigravity');
const execFileAsync = promisify(execFile);

async function createSessionRunnerFixture(input: Readonly<{
  pluginId: string;
  localAgentId?: string;
}>): Promise<Readonly<{
  rootPath: string;
  entryPath: string;
  dispose(): Promise<void>;
}>> {
  const rootPath = await mkdtemp(join(tmpdir(), 'happier-runtime-staging-authority-'));
  const sourceRoot = join(rootPath, 'src');
  await mkdir(sourceRoot, { recursive: true });
  const localAgentId = input.localAgentId ?? 'claude';
  const entryPath = join(sourceRoot, 'index.ts');
  await writeFile(entryPath, [
    "import { createClaudeAgentRuntime } from './runner';",
    'export const manifest = {',
    '  schemaVersion: 2,',
    `  id: ${JSON.stringify(input.pluginId)},`,
    "  version: '1.0.0',",
    "  displayName: 'Runtime staging fixture',",
    "  engines: { happier: '^0.2.0' },",
    '  runtime: { apiVersion: 1 },',
    "  entrypoints: { daemon: './dist/index.js' },",
    '  contributes: { agents: [{',
    `    id: ${JSON.stringify(localAgentId)},`,
    "    title: 'Fixture Agent',",
    "    runtime: { kind: 'custom' },",
    "    primary: 'sessions',",
    '    capabilities: { sessions: {',
    "      open: ['create', 'resume', 'fork'],",
    "      delivery: ['newTurn'],",
    '      cancel: true,',
    '    } },',
    '  }] },',
    '};',
    'export function activate(api: any) {',
    `  api.agents.register(${JSON.stringify(localAgentId)}, createClaudeAgentRuntime, {`,
    '    sessionRunnerFactory: {',
    "      module: './runner',",
    "      export: 'createClaudeAgentRuntime',",
    '      runtimeApiVersion: 1,',
    '    },',
    '    connectedAccountLaunch: { stateSharingDescriptor: {',
    '      nativeHome: { environmentKey: "CUSTOM_AGENT_ROOT", defaultRelativePath: ".custom" },',
    '      providerSupportStatus: "supported",',
    '      config: { supported: true, modes: ["isolated"], entries: [] },',
    '      state: { supported: true, modes: ["isolated"], entries: [',
    '        { path: "state", mode: "env_redirect", envVar: "CUSTOM_AGENT_STATE_ROOT" },',
    '      ] },',
    '      authIsolation: { mode: "materialized_home", secretEntries: [] },',
    '    } },',
    '  });',
    '}',
    '',
  ].join('\n'), 'utf8');
  await writeFile(join(sourceRoot, 'runner.ts'), [
    'export function createClaudeAgentRuntime() {',
    '  return { sessions: { open() { throw new Error("unused"); } } };',
    '}',
    '',
  ].join('\n'), 'utf8');
  return Object.freeze({
    rootPath,
    entryPath,
    dispose: async () => await rm(rootPath, { recursive: true, force: true }),
  });
}

describe('plugin author runtime staging authority', () => {
  it('stages the real Antigravity source graph through the source importer when its installed SDK dist lacks the OAuth profile', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'happier-antigravity-source-staging-'));
    const sdkRoot = resolve(ANTIGRAVITY_PLUGIN_ROOT, '../../plugin-sdk');
    const installedSdkRoot = join(rootPath, 'node_modules', '@happier-dev', 'plugin-sdk');
    try {
      await cp(join(ANTIGRAVITY_PLUGIN_ROOT, 'src'), join(rootPath, 'src'), { recursive: true });
      await cp(join(ANTIGRAVITY_PLUGIN_ROOT, 'package.json'), join(rootPath, 'package.json'));
      await mkdir(installedSdkRoot, { recursive: true });
      await symlink(join(sdkRoot, 'src'), join(installedSdkRoot, 'src'), 'junction');
      await symlink(join(sdkRoot, 'dist'), join(installedSdkRoot, 'dist'), 'junction');
      const sdkManifest = JSON.parse(await readFile(join(sdkRoot, 'package.json'), 'utf8'));
      // The installed dependency is the real SDK source/build closure, except
      // this stale compiled export boundary reproduces the missing OAuth profile.
      sdkManifest.exports['./first-party/connected-accounts'] = {
        'happier-source': './src/first-party/connected-accounts/index.ts',
        default: './stale-connected-accounts.cjs',
      };
      await writeFile(join(installedSdkRoot, 'package.json'), JSON.stringify(sdkManifest), 'utf8');
      await writeFile(join(installedSdkRoot, 'stale-connected-accounts.cjs'), 'module.exports = {};\n', 'utf8');
      const ownerPath = fileURLToPath(new URL('./runtimeStagingSource.ts', import.meta.url));
      const generatorTsconfigPath = fileURLToPath(new URL('../../../scripts/build-owned/tsconfig.generator-runtime.json', import.meta.url));
      const sourceRuntimePath = resolve(sdkRoot, '../cli-common/registerSourceRuntime.mjs');
      const inspectionOwnerPath = fileURLToPath(new URL('../../../scripts/build-owned/bundledPlugins/typescriptModuleInspection.ts', import.meta.url));
      const { stdout } = await execFileAsync(process.execPath, [
        '--conditions=happier-source', '--import', sourceRuntimePath, '--input-type=module', '-e',
        [
          'import { register } from "tsx/esm/api";',
          'const [ownerPath, tsconfig, rootPath, inspectionOwnerPath] = process.argv.slice(1);',
          'const loader = register({ namespace: "antigravity-source-staging", tsconfig });',
          'try {',
          '  const { evaluatePluginAuthorRuntimeStagingSource } = await loader.import(ownerPath, import.meta.url);',
          '  const { ANTIGRAVITY_OAUTH_PROFILE } = await loader.import("@happier-dev/plugin-sdk/first-party/connected-accounts", `${rootPath}/src/index.ts`);',
          '  const { inspectTypescriptModule } = await loader.import(inspectionOwnerPath, import.meta.url);',
          '  const { readAgentNativeHomeEnvironmentKeys } = await loader.import(ownerPath.replace("runtimeStagingSource.ts", "agentNativeHomeEnvironmentKeys.ts"), import.meta.url);',
          '  const staticDefinition = await inspectTypescriptModule(`${rootPath}/src/agent/definition.ts`);',
          '  const staged = await evaluatePluginAuthorRuntimeStagingSource({',
          '    locator: `${rootPath}/src/index.ts`, rootPath,',
          '    authority: { kind: "bundled_first_party", pluginId: "happier.agent.antigravity", packageRootPath: rootPath },',
          '    loadModule: entryPath => loader.import(entryPath, import.meta.url),',
          '  });',
          '  console.log(JSON.stringify({ pluginId: staged.evaluated.manifest.id, runnerCount: staged.sessionRunnerFactories.length, allowRawAuthorizationCode: ANTIGRAVITY_OAUTH_PROFILE.allowRawAuthorizationCode, staticHomeKeys: readAgentNativeHomeEnvironmentKeys(staticDefinition.AGENT_STATE_SHARING_DESCRIPTOR), runtimeHomeKeys: staged.agentNativeHomeEnvironmentKeys }));',
          '} catch (error) { console.error(error.message); process.exitCode = 1; } finally { loader(); }',
        ].join('\n'),
      ownerPath, generatorTsconfigPath, rootPath, inspectionOwnerPath,
      ]);
      expect(JSON.parse(stdout.trim())).toEqual({
        pluginId: 'happier.agent.antigravity', runnerCount: 0, allowRawAuthorizationCode: true,
        staticHomeKeys: ['GEMINI_HOME'], runtimeHomeKeys: ['GEMINI_HOME'],
      });
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it('stages Pi with the exact External Sessions companion when entry and leaves share the source importer', async () => {
    const ownerPath = fileURLToPath(new URL('./runtimeStagingSource.ts', import.meta.url));
    const generatorTsconfigPath = fileURLToPath(new URL('../../../scripts/build-owned/tsconfig.generator-runtime.json', import.meta.url));
    const sourceRuntimePath = resolve(PI_PLUGIN_ROOT, '../../cli-common/registerSourceRuntime.mjs');
    const { stdout } = await execFileAsync(process.execPath, [
      '--conditions=happier-source', '--import', sourceRuntimePath, '--input-type=module', '-e',
      [
        'import { register } from "tsx/esm/api";',
        'const [ownerPath, tsconfig, rootPath] = process.argv.slice(1);',
        'const loader = register({ namespace: "pi-source-staging", tsconfig });',
        'try {',
        '  const { evaluatePluginAuthorRuntimeStagingSource } = await loader.import(ownerPath, import.meta.url);',
        '  const staged = await evaluatePluginAuthorRuntimeStagingSource({',
        '    locator: `${rootPath}/src/index.ts`, rootPath,',
        '    authority: { kind: "bundled_first_party", pluginId: "happier.agent.pi", packageRootPath: rootPath },',
        '    loadModule: entryPath => loader.import(entryPath, import.meta.url),',
        '  });',
        '  console.log(JSON.stringify({ factories: staged.sessionRunnerFactories, homeKeys: staged.agentNativeHomeEnvironmentKeys }));',
        '} catch (error) { console.error(error.message); process.exitCode = 1; } finally { loader(); }',
      ].join('\n'),
      ownerPath, generatorTsconfigPath, PI_PLUGIN_ROOT,
    ]);
    expect(JSON.parse(stdout.trim())).toEqual({
      factories: [expect.objectContaining({
        localAgentId: 'pi',
        normalizedModulePath: 'src/agent/runtime/engine.ts',
        loadMode: 'source-ts',
        locator: {
          module: './agent/runtime/engine',
          export: 'createPiAgentRuntime',
          runtimeApiVersion: 1,
          externalSessionsExport: 'piExternalSessionsContribution',
        },
      })],
      homeKeys: ['PI_CODING_AGENT_DIR'],
    });
  });

  it('admits the exact bundled Claude source root through normal activation validation', async () => {
    const fixture = await createSessionRunnerFixture({
      pluginId: 'happier.agent.claude',
    });
    try {
      const staged = await evaluatePluginAuthorRuntimeStagingSource({
        locator: fixture.entryPath,
        rootPath: fixture.rootPath,
        authority: {
          kind: 'bundled_first_party',
          pluginId: 'happier.agent.claude',
          packageRootPath: fixture.rootPath,
        },
      });

      expect(staged.sessionRunnerFactories).toEqual([expect.objectContaining({
        localAgentId: 'claude',
        normalizedModulePath: 'src/runner.ts',
        loadMode: 'source-ts',
        locator: expect.objectContaining({
          module: './runner',
          export: 'createClaudeAgentRuntime',
        }),
      })]);
      expect(staged.sessionRunnerFactories[0]).not.toHaveProperty(
        'workflowRunRecordSessionOpen',
      );
      expect(staged.agentNativeHomeEnvironmentKeys).toEqual(['CUSTOM_AGENT_ROOT', 'CUSTOM_AGENT_STATE_ROOT']);
    } finally {
      await fixture.dispose();
    }
  });

  it('rejects bundled authority whose plugin identity or source root is not exact', async () => {
    const fixture = await createSessionRunnerFixture({
      pluginId: 'happier.agent.claude',
    });
    try {
      await expect(evaluatePluginAuthorRuntimeStagingSource({
        locator: fixture.entryPath,
        rootPath: fixture.rootPath,
        authority: {
          kind: 'bundled_first_party',
          pluginId: 'happier.agent.codex',
          packageRootPath: fixture.rootPath,
        },
      })).rejects.toThrow(/bundled.*identity/iu);

      await expect(evaluatePluginAuthorRuntimeStagingSource({
        locator: fixture.entryPath,
        rootPath: fixture.rootPath,
        authority: {
          kind: 'bundled_first_party',
          pluginId: 'happier.agent.claude',
          packageRootPath: tmpdir(),
        },
      })).rejects.toThrow(/bundled.*source root/iu);
    } finally {
      await fixture.dispose();
    }
  });

  it('ignores the Claude-named companion for an ordinary external plugin', async () => {
    const fixture = await createSessionRunnerFixture({
      pluginId: 'example.external-agent',
    });
    try {
      const staged = await evaluatePluginAuthorRuntimeStagingSource({
        locator: fixture.entryPath,
        rootPath: fixture.rootPath,
      });

      expect(staged.sessionRunnerFactories).toHaveLength(1);
      expect(staged.sessionRunnerFactories[0]).not.toHaveProperty(
        'workflowRunRecordSessionOpen',
      );
    } finally {
      await fixture.dispose();
    }
  });
});
