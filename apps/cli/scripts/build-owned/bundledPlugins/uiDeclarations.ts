/** Manifest-only UI facts shared by full and retained semantic publication. */
import { collectBundledAgentContributionIdentities } from './agentFacts.ts';
import {
  readJsonObjectProperty, readManifestContributionArray, readRequiredContributionId,
  renderJsonLiteral, renderTsStringLiteral,
} from './literals.ts';
import type { BundledPluginPackage, JsonObject } from './projectionFacts.ts';

export function renderBundledUiDeclarationImportsTs(): string {
  return [
    "import type { PluginAgentAcpDefinitionV2, PluginAgentCliMetadata, PluginAgentContributionV2, PluginContributionIdentityV1 } from '@happier-dev/protocol';",
    "import type { PluginSettingsContributionV2 } from '@happier-dev/protocol/plugins/contributions/settings';",
    "import type { ProviderContributionV1 } from '@happier-dev/protocol/providers/contributions';",
    "import type { MachineProvisionerContributionV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';",
    "import type { PluginConnectedAccountDescriptorContributionV2 } from '@happier-dev/protocol';",
    "import type { PluginLocalizedStringV2 } from '@happier-dev/protocol/plugins/contributions/public-types';",
  ].join('\n');
}

export function renderBundledAgentDeclarationTypeTs(): string {
  return [
    'export type BundledAgentDeclaration = Readonly<{',
    '    identity: PluginContributionIdentityV1;',
    "    capabilities: PluginAgentContributionV2['capabilities'];",
    "    acpStderrRules: PluginAgentAcpDefinitionV2['stderrRules'] | null;",
    '    cli: PluginAgentCliMetadata | null;',
    '    acpRegistryIds?: readonly string[];',
    "    connectedAccounts: NonNullable<PluginAgentContributionV2['connectedAccounts']>;",
    "    providerStateSharing: PluginAgentContributionV2['capabilities']['providerStateSharing'] | null;",
    '    accountSettings: readonly PluginSettingsContributionV2[];',
    "    providerRequirements: PluginAgentContributionV2['providerRequirements'] | null;",
    '}>;',
  ].join('\n');
}

export function readProviderOwnedEnvironmentKeys(pluginPackage: BundledPluginPackage, agentId: string): readonly string[] {
  const contribution = readManifestContributionArray(pluginPackage.manifest, 'agents')
    .find(entry => readRequiredContributionId(entry, 'agents', pluginPackage.packageName) === agentId);
  if (!contribution) return [];
  const providerRequirements = readJsonObjectProperty(contribution, 'providerRequirements');
  const authIsolation = providerRequirements ? readJsonObjectProperty(providerRequirements, 'authIsolation') : undefined;
  const raw = authIsolation?.ownedEnvKeys;
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.some(value => typeof value !== 'string')) {
    throw new Error(`${pluginPackage.packageName}.contributes.agents.${agentId}.providerRequirements.authIsolation.ownedEnvKeys must be a string array`);
  }
  return raw;
}

export function readPermissionModeMapping(pluginPackage: BundledPluginPackage, agentId: string): JsonObject | undefined {
  const contribution = readManifestContributionArray(pluginPackage.manifest, 'agents')
    .find(entry => readRequiredContributionId(entry, 'agents', pluginPackage.packageName) === agentId);
  const runtime = contribution ? readJsonObjectProperty(contribution, 'runtime') : null;
  if (runtime?.kind === 'custom') return readJsonObjectProperty(runtime, 'permissionModeMapping') ?? undefined;
  if (runtime?.kind !== 'acp') return undefined;
  const definition = readJsonObjectProperty(runtime, 'definition');
  return definition ? readJsonObjectProperty(definition, 'permissionModeMapping') ?? undefined : undefined;
}

export function renderBundledPluginPresentationTs(pluginPackages: readonly BundledPluginPackage[]): string {
  const lines = ['export const BUNDLED_FIRST_PARTY_PLUGIN_PRESENTATION: Readonly<Record<string, Readonly<{ displayName: PluginLocalizedStringV2; description?: PluginLocalizedStringV2 }>>> = Object.freeze({'];
  for (const plugin of pluginPackages) {
    const { displayName, description } = plugin.manifest;
    lines.push(`  ${JSON.stringify(plugin.pluginId)}: Object.freeze(${renderJsonLiteral({ displayName, ...(description ? { description } : {}) })}),`);
  }
  lines.push('});');
  return lines.join('\n');
}

export function renderBundledAgentDeclarationsTs(pluginPackages: readonly BundledPluginPackage[]): string {
  const lines = ['export const BUNDLED_CANONICAL_AGENT_DECLARATIONS: Readonly<Partial<Record<CanonicalAgentId, BundledAgentDeclaration>>> = Object.freeze<Partial<Record<CanonicalAgentId, BundledAgentDeclaration>>>({'];
  const contributionIdentities = collectBundledAgentContributionIdentities(pluginPackages);
  for (const entry of pluginPackages) {
    if (!entry.agentId) continue;
    const identity = contributionIdentities[entry.agentId];
    const agent = entry.manifest.contributes.agents?.find(definition => definition.id === identity?.localId);
    if (!agent) throw new Error(`Missing admitted Agent declaration for ${entry.packageName}`);
    const accountSettings = (entry.manifest.contributes.settings ?? []).filter(definition => definition.scope === 'account');
    const declaration = {
      identity,
      capabilities: agent.capabilities,
      acpStderrRules: agent.runtime.kind === 'acp' ? agent.runtime.definition?.stderrRules ?? null : null,
      cli: agent.cli ?? null,
      acpRegistryIds: agent.catalog?.acpRegistryIds ?? [],
      connectedAccounts: agent.connectedAccounts ?? [],
      providerStateSharing: agent.capabilities.providerStateSharing ?? null,
      accountSettings,
      providerRequirements: agent.providerRequirements ?? null,
    };
    lines.push(`    ${renderTsStringLiteral(entry.agentId)}: ${JSON.stringify(declaration)},`);
  }
  lines.push('});');
  return lines.join('\n');
}

/** Machine kind, billing and guest facts come from the same admitted manifests in every publication mode. */
export function renderBundledMachineProvisionerDeclarationsTs(pluginPackages: readonly BundledPluginPackage[]): string {
  const lines = ['export const BUNDLED_MACHINE_PROVISIONER_DECLARATIONS: Readonly<Record<string, Readonly<{ contribution: PluginContributionIdentityV1; descriptor: MachineProvisionerContributionV1 }>>> = Object.freeze<Record<string, Readonly<{ contribution: PluginContributionIdentityV1; descriptor: MachineProvisionerContributionV1 }>>>({'];
  for (const entry of pluginPackages) {
    for (const descriptor of entry.manifest.contributes.machineProvisioners ?? []) {
      const contribution = { pluginId: entry.pluginId, localId: descriptor.id };
      lines.push(`    ${renderTsStringLiteral(`${contribution.pluginId}/${contribution.localId}`)}: ${JSON.stringify({ contribution, descriptor })},`);
    }
  }
  lines.push('});');
  return lines.join('\n');
}

/** Account grant authoring consumes exactly the daemon's admitted Provider effects. */
export function renderBundledAccountProviderDeclarationsTs(pluginPackages: readonly BundledPluginPackage[]): string {
  const lines = ['export const BUNDLED_ACCOUNT_PROVIDER_DECLARATIONS: Readonly<Record<string, Readonly<{ contributionKey: string; definition: ProviderContributionV1; provenance: \'first_party\' }>>> = Object.freeze<Record<string, Readonly<{ contributionKey: string; definition: ProviderContributionV1; provenance: \'first_party\' }>>>({'];
  for (const entry of pluginPackages) {
    for (const definition of entry.manifest.contributes.providers ?? []) {
      const contributionKey = `${entry.pluginId}/${definition.id}`;
      lines.push(`    ${renderTsStringLiteral(contributionKey)}: ${JSON.stringify({ contributionKey, definition, provenance: 'first_party' })},`);
    }
  }
  lines.push('});');
  return lines.join('\n');
}

/** Account setup consumes the same admitted descriptors as the daemon. */
export function renderBundledAccountConnectedServiceDeclarationsTs(pluginPackages: readonly BundledPluginPackage[]): string {
  const lines = ['export const BUNDLED_ACCOUNT_CONNECTED_SERVICE_DECLARATIONS: Readonly<Record<string, Readonly<{ service: PluginContributionIdentityV1; descriptor: PluginConnectedAccountDescriptorContributionV2 }>>> = Object.freeze({'];
  for (const entry of pluginPackages) {
    for (const descriptor of entry.manifest.contributes.connectedAccountDescriptors ?? []) {
      const service = { pluginId: entry.pluginId, localId: descriptor.id };
      lines.push(`    ${renderTsStringLiteral(`${service.pluginId}/${service.localId}`)}: ${JSON.stringify({ service, descriptor })},`);
    }
  }
  lines.push('});');
  return lines.join('\n');
}
