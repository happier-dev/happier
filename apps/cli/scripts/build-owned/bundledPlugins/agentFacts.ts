/** Pure projection rendering; filesystem, preparation and publication stay in the generator. */
import {
  readManifestContributionArray,
  readRequiredContributionId,
  renderJsonLiteral,
  renderTsStringLiteral,
} from './literals.ts';
import type {
  BundledPluginPackage,
  JsonValue,
  ReleasedFlatSessionMetadataRuntimeDescriptorReaderContributionDescriptor,
} from './projectionFacts.ts';

export function collectBundledAgentContributionIdentities(
  pluginPackages: readonly BundledPluginPackage[],
): Readonly<Record<string, Readonly<{ pluginId: string; localId: string }>>> {
  return Object.freeze(Object.fromEntries([
    ...pluginPackages.flatMap((pluginPackage) => {
      if (!pluginPackage.agentId) return [];
      const manifestAgent = readManifestContributionArray(pluginPackage.manifest, 'agents')[0];
      const localId = readRequiredContributionId(manifestAgent, 'agents', pluginPackage.pluginPackageId);
      return [[pluginPackage.agentId, Object.freeze({ pluginId: pluginPackage.pluginId, localId })] as const];
    }),
  ]));
}

export function renderBundledAgentDefinitionsTs(params: Readonly<{
  agentIds: readonly string[];
  agentDefinitionsById: Readonly<Record<string, JsonValue>>;
  nativeHomeEnvironmentKeys: readonly string[];
}>): string {
  const lines: string[] = [];
  lines.push('/**');
  lines.push(' * GENERATED FILE CONTRACT (PS-04)');
  lines.push(' *');
  lines.push(' * This file is emitted by:');
  lines.push(' * - `apps/cli/scripts/build-owned/generateBundledPluginEntries.ts`');
  lines.push(' */');
  lines.push('');
  lines.push(`import type { AgentDefinition } from '../definitions/agentDefinition.js';`);
  lines.push('');
  lines.push('type BundledAgentDefinition = AgentDefinition;');
  lines.push('');
  lines.push(`export const BUNDLED_AGENT_NATIVE_HOME_ENVIRONMENT_KEYS: readonly string[] = Object.freeze(${JSON.stringify(params.nativeHomeEnvironmentKeys, null, 2)});`);
  lines.push('');
  lines.push(`export const BUNDLED_AGENT_DEFINITION_IDS: readonly string[] = Object.freeze([`);
  for (const id of params.agentIds) {
    lines.push(`  ${JSON.stringify(id)},`);
  }
  lines.push(']);');
  lines.push('');
  // Keep literal types (e.g. `core.id: "claude"`) intact. Passing the object literal directly into
  // `Object.freeze(...)` can widen nested string literals (via generic inference), which then fails
  // `AgentDefinition` assignment in strict mode.
  lines.push('const _BUNDLED_AGENT_DEFINITIONS_BY_ID = ({');
  for (const id of params.agentIds) {
    const definition = params.agentDefinitionsById[id];
    if (!definition) continue;
    lines.push(`  ${JSON.stringify(id)}: Object.freeze((${renderJsonLiteral(definition)}) as const),`);
  }
  lines.push('}) as const satisfies Readonly<Record<string, BundledAgentDefinition>>;');
  lines.push('');
  lines.push('export const BUNDLED_AGENT_DEFINITIONS_BY_ID: Readonly<Record<string, BundledAgentDefinition>> = Object.freeze(_BUNDLED_AGENT_DEFINITIONS_BY_ID);');
  lines.push('');
  lines.push('// Canonical generated aggregate exports (avoid "*families*" naming).');
  lines.push('export const bundledAgentDefinitionIds = BUNDLED_AGENT_DEFINITION_IDS;');
  lines.push('export const bundledAgentDefinitions = BUNDLED_AGENT_DEFINITIONS_BY_ID;');
  lines.push('');
  return lines.join('\n');
}

export function renderAgentIdsTs(params: Readonly<{
  agentIds: readonly string[];
  contributionIdentities: Readonly<Record<string, Readonly<{ pluginId: string; localId: string }>>>;
}>): string {
  const { agentIds, contributionIdentities } = params;
  const lines: string[] = [];
  lines.push('/**');
  lines.push(' * GENERATED FILE CONTRACT (A.X-agent-ids-codegen)');
  lines.push(' *');
  lines.push(' * This file is emitted by:');
  lines.push(' * - `apps/cli/scripts/build-owned/generateBundledPluginEntries.ts`');
  lines.push(' *');
  lines.push(' * Agent ids are sourced from the built-in runtime catalog plus bundled plugin `AGENT_DEFINITION.id` values.');
  lines.push(' */');
  lines.push('');
  lines.push('export const AGENT_IDS = Object.freeze([');
  for (const agentId of agentIds) {
    lines.push(`  ${renderTsStringLiteral(agentId)},`);
  }
  lines.push('] as const);');
  lines.push('');
  lines.push('/**');
  lines.push(' * Agent ids bundled with this build.');
  lines.push(' *');
  lines.push(' * Closed by construction: it is the discoverability list of Agents whose facts');
  lines.push(' * ship inside the host, and it is the correct key for records that are');
  lines.push(' * exhaustive over bundled Agents.');
  lines.push(' */');
  lines.push('export type BundledAgentId = (typeof AGENT_IDS)[number];');
  lines.push('');
  lines.push('/**');
  lines.push(' * Any installed Agent id.');
  lines.push(' *');
  lines.push(' * Plugin manifests admit an open local Agent identifier, so an externally');
  lines.push(' * installed Agent legitimately carries an id outside `AGENT_IDS`. The');
  lines.push(' * `(string & {})` member keeps editor autocomplete on the bundled ids while');
  lines.push(' * accepting those contributed ids; validation belongs to the parsing boundary');
  lines.push(' * that produced the id, not to this type.');
  lines.push(' */');
  lines.push('export type AgentId = BundledAgentId | (string & {});');
  lines.push('');
  lines.push('export const BUNDLED_AGENT_CONTRIBUTION_IDENTITIES: Readonly<Record<');
  lines.push('  BundledAgentId,');
  lines.push('  Readonly<{ pluginId: string; localId: string }>');
  lines.push('>> = Object.freeze({');
  for (const agentId of agentIds) {
    const contributionIdentity = contributionIdentities[agentId];
    if (!contributionIdentity) {
      throw new Error(`Missing bundled plugin contribution identity for Agent '${agentId}'`);
    }
    lines.push(`  ${renderTsStringLiteral(agentId)}: Object.freeze({`);
    lines.push(`    pluginId: ${renderTsStringLiteral(contributionIdentity.pluginId)},`);
    lines.push(`    localId: ${renderTsStringLiteral(contributionIdentity.localId)},`);
    lines.push('  }),');
  }
  lines.push('});');
  lines.push('');
  lines.push('const BUNDLED_AGENT_ID_SET: ReadonlySet<string> = new Set(AGENT_IDS);');
  lines.push('');
  lines.push('export function isBundledAgentId(value: unknown): value is BundledAgentId {');
  lines.push('  return typeof value === \'string\' && BUNDLED_AGENT_ID_SET.has(value);');
  lines.push('}');
  lines.push('');
  return lines.join('\n');
}

function toScreamingSnakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
}

export function renderAgentRuntimeDescriptorReadersTs(
  contributions: readonly ReleasedFlatSessionMetadataRuntimeDescriptorReaderContributionDescriptor[],
): string {
  const lines: string[] = [];
  lines.push('/**');
  lines.push(' * GENERATED released flat Session-metadata compatibility readers.');
  lines.push(' *');
  lines.push(' * This bounded registry reads provider-specific metadata written by released');
  lines.push(' * CLI 0.2.0/0.2.1 builds. It is not a current descriptor or plugin-authoring seam.');
  lines.push(' *');
  lines.push(' * This file is emitted by:');
  lines.push(' * - `apps/cli/scripts/build-owned/generateBundledPluginEntries.ts`');
  lines.push(' */');
  lines.push('');
  if (contributions.length > 0) {
    lines.push('import {');
    lines.push('  createGeneratedRuntimeDescriptorReader,');
    lines.push('  type GeneratedRuntimeDescriptorReaderConfig,');
    lines.push('} from \'../runtime/identity/generatedRuntimeProjection.js\';');
  }
  lines.push('import type { RuntimeDescriptorReaderMap } from \'../runtime/identity/runtimeDescriptorTypes.js\';');
  lines.push('');
  for (const contribution of contributions) {
    const constName = `${toScreamingSnakeCase(contribution.agentId)}_GENERATED_RUNTIME_DESCRIPTOR_READER`;
    lines.push(`const ${constName} = createGeneratedRuntimeDescriptorReader(`);
    lines.push(`${renderJsonLiteral(contribution.generatedReader, 2)} satisfies GeneratedRuntimeDescriptorReaderConfig<${renderTsStringLiteral(contribution.agentId)}>,`);
    lines.push(');');
    lines.push('');
  }
  lines.push('export const GENERATED_RUNTIME_DESCRIPTOR_READER_PROVIDER_IDS = [');
  for (const contribution of contributions) {
    lines.push(`  ${renderTsStringLiteral(contribution.agentId)},`);
  }
  lines.push('] as const;');
  lines.push('');
  lines.push('export type GeneratedRuntimeDescriptorReaderProviderId =');
  lines.push('  (typeof GENERATED_RUNTIME_DESCRIPTOR_READER_PROVIDER_IDS)[number];');
  lines.push('');
  lines.push('export const GENERATED_RUNTIME_DESCRIPTOR_READERS: Readonly<Pick<RuntimeDescriptorReaderMap, GeneratedRuntimeDescriptorReaderProviderId>> = Object.freeze({');
  for (const contribution of contributions) {
    lines.push(`  ${contribution.agentId}: ${toScreamingSnakeCase(contribution.agentId)}_GENERATED_RUNTIME_DESCRIPTOR_READER,`);
  }
  lines.push('});');
  lines.push('');
  return lines.join('\n');
}
