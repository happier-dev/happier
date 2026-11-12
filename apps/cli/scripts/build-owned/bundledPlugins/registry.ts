/** Pure projection rendering; filesystem, preparation and publication stay in the generator. */
import {
  manifestDeclaresDaemonEntrypoint,
  readManifestContributionArray,
  readRequiredContributionId,
  renderCompactJsonLiteral,
  renderJsonLiteral,
} from './literals.ts';
import type {
  BundledFirstPartyAgentRegistrationIdentity,
  BundledPluginPackage,
} from './projectionFacts.ts';
import '../../../../../packages/cli-common/registerSourceRuntime.mjs';

// The publisher's source loader must be active before linking Protocol's .js
// source specifiers. These are build-time projections, never CLI startup imports.
const { listCompiledActionCliCommands, actionCliCommandPattern } = await import('../../../src/cli/actions/compiledCommands.ts');
const { projectActionCliHelpDeclaration } = await import('../../../src/cli/actions/commandHelp.ts');
const { readActionCliPresentationEnvelopeKind } = await import('../../../src/cli/actions/commandPresentationMetadata.ts');
// Help consumes the same released envelope metadata as execution, never the
// command callbacks (whose runtime aliases are unavailable to plain Node).
const actionCliHelpDeclarations = listCompiledActionCliCommands().map((command) => (
  projectActionCliHelpDeclaration(command, readActionCliPresentationEnvelopeKind(command))
));
const { projectManifestAgentFields } = await import('../../../src/plugins/projection/registry/projectManifestAgentFields.ts');
const { projectBuiltInAgentFields } = await import('../../../src/plugins/projection/registry/builtIn/agentIdentity.ts');
const { readResolvedAgentTitle } = await import('../../../src/plugins/projection/registry/agentCommandTitle.ts');
const { listAgentExecutionTargetsV1 } = await import('@happier-dev/protocol/agents/executionTargetV1');
const { AGENT_PERMISSION_INTENTS_V1 } = await import('@happier-dev/protocol/runtime/permissionIntentV1');
const { PluginScaffoldUiModeSchema } = await import('@happier-dev/protocol/actions/actionSpecs');
const { getAgentCliSetupRecommendedIds } = await import('@happier-dev/agents');
const { projectPluginCommandDeclarations } = await import('../../../src/cli/pluginCommandDeclarations.ts');
const { assertActionCommandPathsFitStaticRegistry } = await import('../../../src/cli/commandDescriptors.ts');
const { compactActionSchemas } = await import('./actionSchemas.ts');
const { ingestPluginManifestV2 } = await import('@happier-dev/protocol/plugins/manifest');
const {
  BUNDLED_DECLARATION_ASSET_DIR, bundledDeclarationAssetFileName, renderBundledDeclarationAssets,
} = await import('../../../src/plugins/projection/registry/builtIn/declarationAssets.ts');


export function bundledPluginManifestAssetRelativePath(pluginPackageId: string): string {
  return `assets/bundled-plugin-manifests/${pluginPackageId}.json`;
}

export function renderCliBundledPluginManifestEntriesTs(params: Readonly<{
  pluginPackages: readonly BundledPluginPackage[];
}>): string {
  const actionCommandPaths = listCompiledActionCliCommands().map((command) => ({
    actionId: command.actionId, path: command.path, visibility: command.visibility, pattern: actionCliCommandPattern(command),
  }));
  assertActionCommandPathsFitStaticRegistry(actionCommandPaths);
  const metadata = params.pluginPackages.map((entry) => {
    const manifestAgent = readManifestContributionArray(entry.manifest, 'agents')[0];
    const manifestAgentId = manifestAgent === undefined
      ? undefined
      : readRequiredContributionId(manifestAgent, 'agents', entry.pluginPackageId);
    return {
      // Locator metadata describes the public manifest identity. A registration
      // binding may map that local id to a legacy canonical implementation id;
      // importing the private Agent definition here made source publication and
      // serialized-artifact checks disagree for OhMyPi.
      ...(manifestAgentId ? { agentId: manifestAgentId } : {}),
      manifestPath: `bundled:${entry.pluginId}`,
      packageName: entry.packageName,
      packageVersion: entry.packageVersion,
      pluginId: entry.pluginId,
      pluginPackageId: entry.pluginPackageId,
    };
  });

  const lines: string[] = [];
  lines.push('/* eslint-disable @typescript-eslint/naming-convention */');
  lines.push('/**');
  lines.push(' * GENERATED FILE CONTRACT (WS1.T3)');
  lines.push(' *');
  lines.push(' * Data-only locator and provenance records.');
  lines.push(' * Contribution declarations are ingested from generator-normalized manifest');
  lines.push(' * data by the same canonical path used for installed plugins.');
  lines.push(' */');
  lines.push('');
  lines.push("import type { PluginSourceSpecV1 } from '@happier-dev/protocol/plugins/source-spec';");
  lines.push('');
  lines.push('export type BundledFirstPartyPluginMetadata = Readonly<{');
  lines.push('  agentId?: string;');
  lines.push('  pluginId: string;');
  lines.push('  pluginPackageId: string;');
  lines.push('  packageName: string;');
  lines.push('  packageVersion: string;');
  lines.push('  manifestPath: string;');
  lines.push('}>;');
  lines.push('');
  lines.push('export type BundledFirstPartyPluginLocator = Readonly<{');
  lines.push('  pluginId: string;');
  lines.push('  manifestRelativePath: string;');
  lines.push('  manifestPath: string;');
  lines.push('  daemonEntryPath: string | null;');
  lines.push('  devDaemonEntryPath?: string | null;');
  lines.push('  sourceSpec: PluginSourceSpecV1;');
  lines.push('}>;');
  lines.push('');
  lines.push('export const BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES: readonly string[] = Object.freeze([');
  for (const entry of params.pluginPackages) lines.push(`  ${JSON.stringify(entry.packageName)},`);
  lines.push(']);');
  lines.push('');
  lines.push('export const BUNDLED_FIRST_PARTY_PLUGIN_METADATA: readonly BundledFirstPartyPluginMetadata[] = Object.freeze(');
  lines.push(`${renderJsonLiteral(metadata)});`);
  lines.push('');
  lines.push('export const BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS: readonly BundledFirstPartyPluginLocator[] = Object.freeze([');
  for (const entry of params.pluginPackages) {
    lines.push('  Object.freeze({');
    lines.push(`    pluginId: ${JSON.stringify(entry.pluginId)},`);
    lines.push(`    manifestRelativePath: ${JSON.stringify(bundledPluginManifestAssetRelativePath(entry.pluginPackageId))},`);
    lines.push(`    manifestPath: ${JSON.stringify(`bundled:${entry.pluginId}`)},`);
    lines.push(`    daemonEntryPath: ${manifestDeclaresDaemonEntrypoint(entry.manifest) ? JSON.stringify(entry.packageName) : 'null'},`);
    lines.push('    sourceSpec: Object.freeze({');
    lines.push("      kind: 'bundled',");
    lines.push(`      locator: ${JSON.stringify(entry.packageName)},`);
    lines.push("      trustPolicy: 'local_trusted',");
    lines.push("      installPolicy: 'link',");
    lines.push(`      resolvedVersion: ${JSON.stringify(entry.packageVersion)},`);
    lines.push('    }),');
    lines.push('  }),');
  }
  lines.push(']);');
  lines.push('');
  lines.push('');
  lines.push('/** Narrow build-time projection; executable and schema graphs remain demand-loaded. */');
  lines.push("import type { BundledPluginCommandMetadata } from '../../../../cli/commandDescriptors';");
  lines.push('export const BUNDLED_FIRST_PARTY_PLUGIN_COMMAND_METADATA: readonly BundledPluginCommandMetadata[] = Object.freeze(');
  lines.push(`${JSON.stringify(params.pluginPackages.map((entry) => projectPluginCommandDeclarations({
    manifest: entry.manifest,
    provenance: 'first_party',
    source: { kind: 'bundled' },
    ...(entry.agentId ? { bundledAgentId: entry.agentId } : {}),
  })))});`);
  lines.push('');
  lines.push("import type { ActionCliCommandPathDeclaration } from '../../../../cli/actions/commandPatterns';");
  lines.push('export const BUNDLED_ACTION_CLI_COMMAND_PATHS: readonly ActionCliCommandPathDeclaration[] = Object.freeze(');
  lines.push(`${JSON.stringify(actionCommandPaths)});`);
  lines.push('');
  return lines.join('\n');
}

/** Admit compact declaration assets without changing authored runtime agreement facts. */
export function renderCliBundledPluginManifestAssets(params: Readonly<{
  pluginPackages: readonly BundledPluginPackage[];
}>): readonly Readonly<{ relativePath: string; out: string }>[] {
  return params.pluginPackages.map((entry) => {
    const admitted = ingestPluginManifestV2(compactActionSchemas(entry.manifest));
    if (!admitted.ok) {
      throw new Error(`Invalid compacted manifest '${entry.pluginId}': ${admitted.diagnostics.map(diagnostic => diagnostic.message).join('; ')}`);
    }
    const relativePath = bundledPluginManifestAssetRelativePath(entry.pluginPackageId);
    const out = `${renderCompactJsonLiteral(admitted.manifest)}\n`;
    // Runtime readers load the summary always and each deferred value file on
    // first use; all three are cut from this exact manifest text.
    const declarations = renderBundledDeclarationAssets(out);
    const directory = relativePath.slice(0, relativePath.lastIndexOf('/') + 1) + BUNDLED_DECLARATION_ASSET_DIR;
    const fileName = relativePath.slice(relativePath.lastIndexOf('/') + 1);
    return [{ relativePath, out },
      ...(['summary', 'inputSchema', 'resultSchema'] as const).map(kind => ({
        relativePath: `${directory}/${bundledDeclarationAssetFileName(fileName, kind)}`,
        out: declarations[kind],
      }))];
  }).flat();
}

/** Demand-only help models from the existing compiler; never eager root metadata. */
export function renderCliBundledActionCliHelpAssets(params: Readonly<{ pluginPackages: readonly BundledPluginPackage[] }>): readonly Readonly<{ relativePath: string; out: string }>[] {
  const agents = params.pluginPackages.flatMap((plugin) => (plugin.manifest.contributes.agents ?? []).flatMap((definition) => {
    const fields = projectManifestAgentFields({ definition, pluginId: plugin.pluginId, provenance: 'first_party', source: { kind: 'bundled' } });
    const projected = projectBuiltInAgentFields(fields, plugin.agentId ?? fields.id);
    if (projected.identity && listAgentExecutionTargetsV1(projected.identity).length === 0) return [];
    return [{ id: projected.id, pluginId: plugin.pluginId, identity: projected.identity, title: readResolvedAgentTitle(projected), runtimeSpec: projected.runtimeSpec ?? null }];
  }));
  return [{
    relativePath: 'src/plugins/projection/registry/sources/generatedBundledActionCliHelp.ts',
    out: [
      '/** GENERATED by generateBundledPluginEntries.ts; canonical compiled help declarations only. */',
      "import type { ActionCliHelpDeclaration } from '../../../../cli/actions/helpDeclarations';",
      'export const BUNDLED_ACTION_CLI_HELP: readonly ActionCliHelpDeclaration[] = Object.freeze(',
      `${JSON.stringify(actionCliHelpDeclarations)});`,
      '',
    ].join('\n'),
  }, {
    relativePath: 'src/plugins/projection/registry/sources/generatedBundledCliHelpFacts.ts',
    out: [
      '/** GENERATED by generateBundledPluginEntries.ts; admitted display facts only. */',
      "import type { CliAgentHelpRow } from '../../../../cli/helpDeclarationFacts';",
      'export const BUNDLED_CLI_HELP_FACTS: Readonly<{ agents: readonly CliAgentHelpRow[]; setupRecommendedIds: readonly string[]; permissionIntents: readonly string[]; scaffoldUiModes: readonly string[] }> = Object.freeze(',
      `${JSON.stringify({ agents, setupRecommendedIds: getAgentCliSetupRecommendedIds(), permissionIntents: AGENT_PERMISSION_INTENTS_V1, scaffoldUiModes: PluginScaffoldUiModeSchema.options })});`,
      '',
    ].join('\n'),
  }];
}

export function renderCliBundledAgentRegistrationBindingsTs(
  registrations: readonly BundledFirstPartyAgentRegistrationIdentity[],
): string {
  const lines: string[] = [];
  lines.push('/** GENERATED data-only registration identities for bundled first-party Agents. */');
  lines.push("import type { PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';");
  lines.push('');
  lines.push('export type BundledFirstPartyAgentRegistrationBinding = Readonly<{');
  lines.push('  identity: PluginContributionIdentityV1;');
  lines.push('  implementationOwnerId: string;');
  lines.push('  registrationFamily: string;');
  lines.push('}>;');
  lines.push('');
  lines.push('export const BUNDLED_FIRST_PARTY_AGENT_REGISTRATION_BINDINGS: readonly BundledFirstPartyAgentRegistrationBinding[] = Object.freeze([');
  for (const registration of registrations) {
    lines.push('  Object.freeze({');
    lines.push('    identity: Object.freeze({');
    lines.push(`      pluginId: ${JSON.stringify(registration.pluginId)},`);
    lines.push(`      localId: ${JSON.stringify(registration.localId)},`);
    lines.push('    }),');
    lines.push(`    implementationOwnerId: ${JSON.stringify(registration.implementationOwnerId)},`);
    lines.push(`    registrationFamily: ${JSON.stringify(registration.registrationFamily)},`);
    lines.push('  }),');
  }
  lines.push(']);');
  lines.push('');
  return lines.join('\n');
}

export function renderCliBundledPluginEntriesTs(params: Readonly<{
  pluginPackages: readonly BundledPluginPackage[];
}>): string {
  const registrations = params.pluginPackages.flatMap(
    (pluginPackage): BundledFirstPartyAgentRegistrationIdentity[] => {
      if (!pluginPackage.agentId) return [];
      const manifestAgent = readManifestContributionArray(pluginPackage.manifest, 'agents')[0];
      return [{
        pluginId: pluginPackage.pluginId,
        localId: readRequiredContributionId(
          manifestAgent,
          'agents',
          pluginPackage.pluginPackageId,
        ),
        implementationOwnerId: pluginPackage.agentId,
        registrationFamily: 'agents',
      }];
    },
  );
  return renderCliBundledAgentRegistrationBindingsTs(registrations);
}
