import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { ModuleKind, transpileModule } from 'typescript';
import { expect, it } from 'vitest';
import * as codexDefinition from '../../../../packages/plugins/codex/src/agent/definition';
import { withWorkspaceBundleLock } from '../../../../packages/cli-common/workspaceBundleLock.mjs';
import { createPackageLayoutSandbox, writeBundledPluginSourceInputs, writeCliBundledHostPackage } from '../__tests__/testkit/packageLayoutSandbox';
import { BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS } from '../../src/plugins/projection/registry/sources/generatedBundledPluginManifests';
import { renderProtocolCodexNativeHomePolicyTs } from './bundledPlugins/protocol.ts';
import { runRuntimeConsumedAgentFactsPrivatePhase } from './generateBundledPluginEntries.ts';

it('publishes static Codex home facts from its declaration without loading its runtime', async () => {
  const { repoRoot, happyCliDir, cleanup } = createPackageLayoutSandbox('happier-codex-native-home-facts-');
  const packageRoot = writeBundledPluginSourceInputs({ repoRoot, pluginId: 'codex' });
  writeCliBundledHostPackage({ happyCliDir, bundledDependencies: ['@happier-dev/plugins-codex'] });
  const locator = BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.find(entry => entry.pluginId === 'happier.agent.codex');
  if (!locator) throw new Error('Missing Codex declaration fixture');
  const manifestPath = join(happyCliDir, locator.manifestRelativePath);
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, readFileSync(new URL(`../../${locator.manifestRelativePath}`, import.meta.url), 'utf8'));
  mkdirSync(join(packageRoot, 'src/agent'), { recursive: true });
  const nativeHome = {
    ...codexDefinition.AGENT_STATE_SHARING_DESCRIPTOR.nativeHome,
    environmentKey: 'DECLARED_CODEX_HOME',
    defaultRelativePath: '.declared-codex',
    materializedDirectoryName: 'declared-codex-home',
  };
  writeFileSync(join(packageRoot, 'src/agent/definition.ts'), [
    `export const AGENT_DEFINITION = ${JSON.stringify(codexDefinition.AGENT_DEFINITION)};`,
    `export const AGENT_STATE_SHARING_DESCRIPTOR = ${JSON.stringify({ ...codexDefinition.AGENT_STATE_SHARING_DESCRIPTOR, nativeHome })};`,
  ].join('\n'));
  writeFileSync(join(packageRoot, 'src/manifest.ts'), 'throw new Error("Native-home projection must not activate Codex");');
  try {
    await withWorkspaceBundleLock(async lease => {
      await runRuntimeConsumedAgentFactsPrivatePhase(repoRoot, lease);
    }, { lockPath: join(repoRoot, 'publication.lock') });
    const outPath = join(repoRoot, 'packages/protocol/src/agents/codex/nativeHomePolicy.ts');
    expect(existsSync(outPath)).toBe(true);
    const exports: Record<string, unknown> = {};
    runInNewContext(transpileModule(readFileSync(outPath, 'utf8'), {
      compilerOptions: { module: ModuleKind.CommonJS },
    }).outputText, { exports });
    expect(exports.CODEX_NATIVE_HOME).toEqual({
      environmentKey: nativeHome.environmentKey,
      defaultRelativePath: nativeHome.defaultRelativePath,
    });
    expect(exports.CODEX_CONNECTED_SERVICE_HOME_DIRECTORY_NAME).toBe(nativeHome.materializedDirectoryName);
  } finally { cleanup(); }
});

it('renders declaration-owned Codex homes as standalone static Protocol exports', () => {
  const nativeHome = {
    environmentKey: 'DECLARED_CODEX_HOME',
    defaultRelativePath: '.declared-codex',
    materializedDirectoryName: 'declared-codex-home',
  };
  const exports: Record<string, unknown> = {};
  // Evaluating without require catches accidental runtime or plugin imports.
  runInNewContext(transpileModule(renderProtocolCodexNativeHomePolicyTs(nativeHome), {
    compilerOptions: { module: ModuleKind.CommonJS },
  }).outputText, { exports });
  expect(exports.CODEX_NATIVE_HOME).toEqual({
    environmentKey: nativeHome.environmentKey,
    defaultRelativePath: nativeHome.defaultRelativePath,
  });
  expect(exports.CODEX_CONNECTED_SERVICE_HOME_DIRECTORY_NAME).toBe(nativeHome.materializedDirectoryName);
});
