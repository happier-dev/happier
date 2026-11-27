import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { ModuleKind, transpileModule } from 'typescript';
import { describe, expect, it } from 'vitest';

import { AGENT_DEFINITION } from '../../../../packages/plugins/custom-acp/src/agent/definition';
import { PLUGIN_MANIFEST } from '../../../../packages/plugins/custom-acp/src/manifest';
import { withWorkspaceBundleLock } from '../../../../packages/cli-common/workspaceBundleLock.mjs';
import { createPackageLayoutSandbox, writeBundledPluginSourceInputs, writeCliBundledHostPackage } from '../__tests__/testkit/packageLayoutSandbox';
import { renderBundledDeclarationAsset } from '../../src/plugins/projection/registry/builtIn/declarationAssets';
import { runRuntimeConsumedAgentFactsPrivatePhase } from './generateBundledPluginEntries';

describe('bundled plugin generator bootstrap', () => {
  it('ignores dormant Agent source when the tracked declaration contributes no Agent', async () => {
    const { repoRoot, happyCliDir, cleanup } = createPackageLayoutSandbox('happier-generator-dormant-agent-');
    const packageRoot = writeBundledPluginSourceInputs({ repoRoot, pluginId: 'custom-acp' });
    writeCliBundledHostPackage({ happyCliDir, bundledDependencies: ['@happier-dev/plugins-custom-acp'] });
    const declarationPath = join(happyCliDir, 'assets/bundled-plugin-manifests/custom-acp.json');
    mkdirSync(dirname(declarationPath), { recursive: true });
    mkdirSync(join(packageRoot, 'src/agent'), { recursive: true });
    writeFileSync(declarationPath, renderBundledDeclarationAsset(JSON.stringify({
      ...PLUGIN_MANIFEST,
      contributes: { ...PLUGIN_MANIFEST.contributes, agents: [] },
    })));
    writeFileSync(join(packageRoot, 'src/agent/definition.ts'), `export const AGENT_DEFINITION = ${JSON.stringify(AGENT_DEFINITION)};`);
    try {
      await withWorkspaceBundleLock(async lease => {
        await runRuntimeConsumedAgentFactsPrivatePhase(repoRoot, lease);
      }, { lockPath: join(repoRoot, 'publication.lock') });
      const published = readFileSync(join(repoRoot, 'packages/agents/src/generated/bundledAgentDefinitions.ts'), 'utf8');
      const exports: Record<string, unknown> = {};
      runInNewContext(transpileModule(published, { compilerOptions: { module: ModuleKind.CommonJS } }).outputText, { exports });
      expect(exports.BUNDLED_AGENT_DEFINITIONS_BY_ID).toEqual({});
    } finally {
      cleanup();
    }
  });

  it('rebuilds Agent facts from tracked declarations when the generated locator is unparseable', async () => {
    const { repoRoot, happyCliDir, cleanup } = createPackageLayoutSandbox('happier-generator-bootstrap-');
    const packageRoot = writeBundledPluginSourceInputs({ repoRoot, pluginId: 'custom-acp' });
    writeCliBundledHostPackage({ happyCliDir, bundledDependencies: ['@happier-dev/plugins-custom-acp'] });
    const locatorPath = join(happyCliDir, 'src/plugins/projection/registry/sources/generatedBundledPluginManifests.ts');
    const declarationPath = join(happyCliDir, 'assets/bundled-plugin-manifests/custom-acp.json');
    mkdirSync(dirname(locatorPath), { recursive: true });
    mkdirSync(dirname(declarationPath), { recursive: true });
    mkdirSync(join(packageRoot, 'src/agent'), { recursive: true });
    writeFileSync(locatorPath, '<<<<<<< local\n=======\n>>>>>>> upstream\n');
    writeFileSync(declarationPath, renderBundledDeclarationAsset(JSON.stringify(PLUGIN_MANIFEST)));
    writeFileSync(join(packageRoot, 'src/agent/definition.ts'), `export const AGENT_DEFINITION = ${JSON.stringify(AGENT_DEFINITION)};`);
    try {
      await withWorkspaceBundleLock(async lease => {
        await runRuntimeConsumedAgentFactsPrivatePhase(repoRoot, lease);
      }, { lockPath: join(repoRoot, 'publication.lock') });
      const published = readFileSync(join(repoRoot, 'packages/agents/src/generated/bundledAgentDefinitions.ts'), 'utf8');
      const exports: Record<string, unknown> = {};
      runInNewContext(transpileModule(published, { compilerOptions: { module: ModuleKind.CommonJS } }).outputText, { exports });
      expect(exports.BUNDLED_AGENT_DEFINITIONS_BY_ID).toMatchObject({
        'custom-acp': { core: { id: 'custom-acp' } },
      });
      expect(readFileSync(locatorPath, 'utf8')).toContain('<<<<<<<');
    } finally {
      cleanup();
    }
  });
});
