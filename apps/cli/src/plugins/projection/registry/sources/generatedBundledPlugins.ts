/* eslint-disable @typescript-eslint/naming-convention */
/**
 * GENERATED FILE CONTRACT (PS-04)
 *
 * This file is emitted by:
 * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`
 *
 * Runtime reads this local artifact; executable plugin packages are only named as locators.
 */

import {
  getAllBackendDefinitions,
  getAllBackendDefinitionContracts,
  getAllProviderDefinitionContracts,
  getProviderDefinition,
  getProviderCliRuntimeSpec,
  isAgentId,
} from '@happier-dev/agents';
import type { AgentId } from '@happier-dev/agents';

import type {
  ResolvedActivationTarget,
  ResolvedBackendContribution,
  ResolvedCatalogEntry,
  ResolvedProviderContribution,
} from '../types';

export type BundledFirstPartyPluginMetadata = Readonly<{
  agentId?: string;
  pluginId: string;
  pluginPackageId: string;
  packageName: string;
  packageVersion: string;
  manifestPath: string;
  manifestDigest: string;
}>;

type BundledContributionMetadataFields = Pick<
  ResolvedActivationTarget,
  'pluginId' | 'manifestPath' | 'manifestDigest' | 'daemonEntryPath' | 'sourceSpec'
>;

export const BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES: readonly string[] = Object.freeze([
  "@happier-dev/plugins-claude",
  "@happier-dev/plugins-codex",
  "@happier-dev/plugins-opencode",
]);

export const BUNDLED_FIRST_PARTY_PLUGIN_METADATA: readonly BundledFirstPartyPluginMetadata[] = Object.freeze(
[
  {
    "agentId": "claude",
    "manifestDigest": "bundled:@happier-dev/plugins-claude@0.0.0",
    "manifestPath": "bundled:claude",
    "packageName": "@happier-dev/plugins-claude",
    "packageVersion": "0.0.0",
    "pluginId": "claude",
    "pluginPackageId": "claude"
  },
  {
    "agentId": "codex",
    "manifestDigest": "bundled:@happier-dev/plugins-codex@0.0.0",
    "manifestPath": "bundled:codex",
    "packageName": "@happier-dev/plugins-codex",
    "packageVersion": "0.0.0",
    "pluginId": "codex",
    "pluginPackageId": "codex"
  },
  {
    "agentId": "opencode",
    "manifestDigest": "bundled:@happier-dev/plugins-opencode@0.0.0",
    "manifestPath": "bundled:opencode",
    "packageName": "@happier-dev/plugins-opencode",
    "packageVersion": "0.0.0",
    "pluginId": "opencode",
    "pluginPackageId": "opencode"
  }
]);

const bundledPluginMetadataByAgentId = new Map(
  BUNDLED_FIRST_PARTY_PLUGIN_METADATA
    .filter((entry): entry is BundledFirstPartyPluginMetadata & Readonly<{ agentId: string }> => typeof entry.agentId === 'string')
    .map((entry) => [entry.agentId, entry] as const),
);

type BuiltInBackendCatalogDefinition = (ReturnType<typeof getAllBackendDefinitions>)[number];

function buildBundledSourceSpec(metadata: BundledFirstPartyPluginMetadata) {
  return {
    kind: 'package' as const,
    locator: metadata.packageName,
    trustPolicy: 'local_trusted' as const,
    installPolicy: 'link' as const,
    resolvedVersion: metadata.packageVersion,
    resolvedDigest: metadata.manifestDigest,
  };
}

function readBundledPluginMetadata(agentId: string): BundledFirstPartyPluginMetadata | null {
  return bundledPluginMetadataByAgentId.get(agentId) ?? null;
}

function requireBuiltInAgentId(value: string, subject: string): AgentId {
  if (!isAgentId(value)) {
    throw new Error(`Expected built-in ${subject} id, received '${value}'`);
  }
  return value;
}

function buildBundledMetadataFields(agentId: string): Partial<BundledContributionMetadataFields> {
  const metadata = readBundledPluginMetadata(agentId);
  if (!metadata) return {};
  return {
    pluginId: metadata.pluginId,
    manifestPath: metadata.manifestPath,
    manifestDigest: metadata.manifestDigest,
    daemonEntryPath: metadata.packageName,
    sourceSpec: buildBundledSourceSpec(metadata),
  };
}

export const BUNDLED_FIRST_PARTY_ACTIVATION_TARGETS: readonly ResolvedActivationTarget[] = Object.freeze(
  BUNDLED_FIRST_PARTY_PLUGIN_METADATA.map((metadata): ResolvedActivationTarget => ({
    provenance: 'external',
    source: { kind: 'bundled' },
    pluginId: metadata.pluginId,
    manifestPath: metadata.manifestPath,
    manifestDigest: metadata.manifestDigest,
    daemonEntryPath: metadata.packageName,
    sourceSpec: buildBundledSourceSpec(metadata),
  })),
);

export const BUNDLED_FIRST_PARTY_PROVIDER_CONTRIBUTIONS: readonly ResolvedProviderContribution[] = Object.freeze(
  getAllProviderDefinitionContracts().map((definition): ResolvedProviderContribution => {
    const providerId = requireBuiltInAgentId(definition.id, 'provider');
    const richDefinition = getProviderDefinition(providerId);
    if (!richDefinition) {
      throw new Error(`Missing built-in provider catalog definition '${definition.id}'`);
    }
    const catalogEntry = Object.freeze({
      id: definition.id,
      cliSubcommand: richDefinition.core.cliSubcommand,
      vendorResumeSupport: richDefinition.core.resume.vendorResume,
    } satisfies ResolvedCatalogEntry);
    return Object.freeze({
      id: definition.id,
      provenance: 'first_party',
      source: { kind: 'bundled' },
      definition,
      richDefinition: {
        provenance: 'first_party',
        definition: richDefinition,
      },
      runtimeSpec: getProviderCliRuntimeSpec(providerId),
      catalogEntry,
      ...buildBundledMetadataFields(definition.id),
    } satisfies ResolvedProviderContribution);
  }),
);

const backendCatalogDefinitionsById = new Map<AgentId, BuiltInBackendCatalogDefinition>(
  getAllBackendDefinitions().map((definition) => [definition.id, definition] as const),
);

export const BUNDLED_FIRST_PARTY_BACKEND_CONTRIBUTIONS: readonly ResolvedBackendContribution[] = Object.freeze(
  getAllBackendDefinitionContracts().map((definition): ResolvedBackendContribution => {
    const backendId = requireBuiltInAgentId(definition.id, 'backend');
    const richDefinition = backendCatalogDefinitionsById.get(backendId);
    if (!richDefinition) {
      throw new Error(`Missing built-in backend catalog definition '${definition.id}'`);
    }
    return Object.freeze({
      id: definition.id,
      providerId: definition.providerId,
      provenance: 'first_party',
      source: { kind: 'bundled' },
      definition,
      richDefinition: {
        provenance: 'first_party',
        definition: richDefinition,
      },
      runtimeKind: richDefinition.engine?.defaultRuntimeKind ?? 'native',
      ...buildBundledMetadataFields(definition.providerId),
    } satisfies ResolvedBackendContribution);
  }),
);

export const BUNDLED_FIRST_PARTY_CATALOG_ENTRIES: readonly ResolvedCatalogEntry[] = Object.freeze(
  BUNDLED_FIRST_PARTY_PROVIDER_CONTRIBUTIONS.map((provider) => provider.catalogEntry)
    .filter((entry): entry is ResolvedCatalogEntry => Boolean(entry)),
);
