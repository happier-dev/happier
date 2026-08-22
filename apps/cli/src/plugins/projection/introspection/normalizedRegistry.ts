import type {
  PluginContributionCatalogEntryV2,
  PluginContributionIntrospectionProjectionV1,
  PluginDiagnosticHostV1,
  PluginDiagnosticRecordV1,
} from '@happier-dev/protocol';
import {
  PLUGIN_CONTRIBUTION_CATALOG_V2,
} from '@happier-dev/protocol';

import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';
import type { PluginContributionRegistry } from '@/plugins/projection/registry/normalize/package';
import {
  buildPluginContributionIntrospectionIdentity,
  buildPluginContributionIntrospectionQualifiedId,
  projectPluginCompatibilityDiagnostics,
  projectPluginContributionIntrospection,
  readPluginContributionIntrospectionPresentation,
} from './project';
import type {
  PluginContributionIntrospectionCandidate,
  PluginContributionRuntimeFacts,
} from './types';
import { mapPluginSourceToDiagnosticSource } from './source';

type PluginIntrospectionMetadata = PluginDiagnosticRecordV1['plugin'];

function readCandidateIdentity(
  entry: Readonly<{
    identity?: Readonly<{ localId: string }>;
    conflictKey: string | null;
    pluginId: string;
    family: string;
  }>,
  catalogEntry: PluginContributionCatalogEntryV2 | undefined,
): PluginContributionIntrospectionCandidate['identity'] {
  const identityValue = entry.identity?.localId ?? entry.conflictKey;
  if (identityValue === null || identityValue.trim().length === 0) {
    throw new Error(
      `Cannot introspect contribution '${entry.pluginId}/${entry.family}' without a canonical local identity`,
    );
  }
  // The registry only ever keys families by `catalogEntry.manifestKey`, so a
  // catalog entry resolves for every entry reached here. An unresolved family
  // keeps the plain `localId` presentation — the same conservative shape the
  // sibling catalog-derived facts below fall back to — so an unmodelled family
  // can never fail the whole daemon contribution catalog projection.
  return buildPluginContributionIntrospectionIdentity({
    identityKind: catalogEntry?.identityKind ?? 'localId',
    identityValue,
  });
}

export function projectNormalizedRegistryIntrospection(params: Readonly<{
  registry: PluginContributionRegistry;
  generation: number;
  host: PluginDiagnosticHostV1;
  platform: string;
  occurredAtMs: number;
  diagnosticsByPluginId: Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>;
  pluginMetadataById?: Readonly<Record<string, PluginIntrospectionMetadata>>;
  runtimeFactsByQualifiedId?: ReadonlyMap<string, PluginContributionRuntimeFacts>;
}>): PluginContributionIntrospectionProjectionV1 {
  const candidates = collectNormalizedRegistryIntrospectionCandidates(params.registry);
  const pluginMetadataById = new Map<string, PluginIntrospectionMetadata>(
    Object.entries(params.pluginMetadataById ?? {}),
  );

  for (const candidate of candidates) {
    const metadata: PluginIntrospectionMetadata = {
      id: candidate.pluginId,
      version: candidate.pluginVersion,
      source: candidate.source,
    };
    const existing = pluginMetadataById.get(candidate.pluginId);
    if (existing && (
      existing.version !== metadata.version
      || existing.source !== metadata.source
    )) {
      throw new Error(`Conflicting introspection metadata for plugin '${candidate.pluginId}'`);
    }
    pluginMetadataById.set(candidate.pluginId, metadata);
  }

  const diagnostics: PluginDiagnosticRecordV1[] = [];
  for (const pluginId of Object.keys(params.diagnosticsByPluginId).sort()) {
    const plugin = pluginMetadataById.get(pluginId);
    if (!plugin) {
      throw new Error(`Missing host-owned introspection metadata for diagnostic plugin '${pluginId}'`);
    }
    diagnostics.push(...projectPluginCompatibilityDiagnostics({
      diagnostics: params.diagnosticsByPluginId[pluginId] ?? [],
      plugin,
      defaultStage: 'normalization',
      host: params.host,
      platform: params.platform,
      occurredAtMs: params.occurredAtMs,
    }));
  }

  return projectPluginContributionIntrospection({
    generation: params.generation,
    candidates,
    diagnostics,
    runtimeFactsByQualifiedId: params.runtimeFactsByQualifiedId,
  });
}

export function collectNormalizedRegistryIntrospectionCandidates(
  registry: PluginContributionRegistry,
): readonly PluginContributionIntrospectionCandidate[] {
  const candidates: PluginContributionIntrospectionCandidate[] = [];
  for (const contributions of registry.semanticContributionsByFamily.values()) {
    for (const entry of contributions) {
      const catalogEntry = PLUGIN_CONTRIBUTION_CATALOG_V2.find((candidate) => (
        candidate.manifestKey === entry.family
      ));
      const definition = entry.definition && typeof entry.definition === 'object'
        ? entry.definition as Readonly<Record<string, unknown>>
        : null;
      const presentation = readPluginContributionIntrospectionPresentation(entry.family, definition);
      candidates.push({
        pluginId: entry.pluginId,
        pluginVersion: entry.pluginVersion,
        source: mapPluginSourceToDiagnosticSource(entry.sourceSpec),
        family: entry.family,
        runtimeRegistrationHost: catalogEntry && definition
          ? catalogEntry.runtimeRegistrationHost(definition)
          : entry.introspection.registration === 'required' ? 'daemon' : null,
        runtimeRegistrationFamily: catalogEntry && definition
          ? catalogEntry.runtimeRegistrationFamily(definition)
          : entry.family,
        identity: readCandidateIdentity(entry, catalogEntry),
        registration: entry.introspection.registration,
        consumer: entry.introspection.consumer,
        platforms: entry.introspection.platforms,
        ...(presentation === undefined ? {} : { presentation }),
      });
    }
  }

  return Object.freeze(candidates.sort((left, right) => (
    buildPluginContributionIntrospectionQualifiedId(left)
      .localeCompare(buildPluginContributionIntrospectionQualifiedId(right))
  )));
}
