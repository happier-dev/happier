import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ingestPluginManifestV2 } from '../../../../../packages/protocol/src/plugins/manifest/ingest.ts';
import { PLUGIN_MANIFEST as CUSTOM_ACP_MANIFEST } from '../../../../../packages/plugins/custom-acp/src/manifest.ts';
import { AGENT_DEFINITION as CUSTOM_ACP_DEFINITION } from '../../../../../packages/plugins/custom-acp/src/agent/definition.ts';
import { renderCliBundledAgentRegistrationBindingsTs } from '../../build-owned/bundledPlugins/registry.ts';
import { writeBundledPluginSourceInputs, writeWorkspacePackageFixture } from './packageLayoutSandbox.ts';

export function writeRetainedCatalogAgent(repoRoot: string, happyCliDir: string) {
  // A declarative ACP Agent supplies a real retained identity without a
  // custom runtime/factory graph unrelated to semantic publication.
  const manifest = {
    schemaVersion: 2, id: 'happier.fixture-acp', version: '0.0.0', displayName: 'Fixture ACP',
    runtime: { apiVersion: 1 }, contributes: { agents: [{
      ...CUSTOM_ACP_MANIFEST.contributes.agents![0]!, id: 'fixture-acp',
      runtime: { kind: 'acp', transport: { kind: 'webSocket', url: 'ws://localhost/fixture' } },
    }] },
  };
  const ingestion = ingestPluginManifestV2(manifest);
  if (!ingestion.ok) throw new Error(JSON.stringify(ingestion.diagnostics));
  const packageRoot = writeWorkspacePackageFixture({
    repoRoot, workspacePath: 'packages/plugins/fixture-acp', packageName: '@happier-dev/plugins-fixture-acp',
  });
  writeBundledPluginSourceInputs({ repoRoot, pluginId: 'fixture-acp', writePackageJson: false });
  writeFileSync(join(packageRoot, 'src/manifest.ts'), `export const PLUGIN_MANIFEST = ${JSON.stringify(manifest)};`);
  writeFileSync(join(packageRoot, 'src/index.ts'), `export { PLUGIN_MANIFEST as manifest } from './manifest.js'; export function activate() {}`);
  mkdirSync(join(packageRoot, 'src/agent'), { recursive: true });
  writeFileSync(join(packageRoot, 'src/agent/definition.ts'), `export const AGENT_DEFINITION = ${JSON.stringify({
    ...CUSTOM_ACP_DEFINITION, id: 'fixture-acp', core: {
      ...CUSTOM_ACP_DEFINITION.core, id: 'fixture-acp', cliSubcommand: 'fixture-acp', detectKey: 'fixture-acp',
    },
  })};`);
  mkdirSync(join(packageRoot, '.happier-plugin'), { recursive: true });
  writeFileSync(join(packageRoot, '.happier-plugin/plugin.json'), JSON.stringify(manifest));
  const bindingsPath = join(happyCliDir, 'src/plugins/projection/registry/sources/generatedBundledPlugins.ts');
  mkdirSync(dirname(bindingsPath), { recursive: true });
  writeFileSync(bindingsPath, renderCliBundledAgentRegistrationBindingsTs([{
    pluginId: manifest.id, localId: 'fixture-acp',
    implementationOwnerId: 'fixture-acp', registrationFamily: 'agents',
  }]));
}



