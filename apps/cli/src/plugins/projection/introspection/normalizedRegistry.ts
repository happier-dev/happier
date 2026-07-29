import type {
  PluginContributionIntrospectionProjectionV1,
  PluginDiagnosticHostV1,
  PluginDiagnosticRecordV1,
} from '@happier-dev/protocol';
import { PLUGIN_CONTRIBUTION_CATALOG_V2 } from '@happier-dev/protocol';

import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';
import type { PluginContributionRegistry } from '@/plugins/projection/registry/normalize/package';
import {
  buildPluginContributionIntrospectionQualifiedId,
  enrichPluginDiagnosticRecord,
  projectPluginContributionIntrospection,
} from './project';
import type {
  PluginContributionIntrospectionCandidate,
  PluginContributionRuntimeFacts,
} from './types';
import { mapPluginSourceToDiagnosticSource } from './source';

type PluginIntrospectionMetadata = PluginDiagnosticRecordV1['plugin'];

function readCandidateIdentity(entry: Readonly<{
  identity?: Readonly<{ localId: string }>;
  conflictKey: string | null;
  pluginId: string;
  family: string;
}>): PluginContributionIntrospectionCandidate['identity'] {
  const localId = entry.identity?.localId ?? entry.conflictKey;
  if (localId === null || localId.trim().length === 0) {
    throw new Error(
      `Cannot introspect contribution '${entry.pluginId}/${entry.family}' without a canonical local identity`,
    );
  }
  if (entry.family === 'ui.translations') return { kind: 'locale', locale: localId };
  if (entry.family === 'providers') return { kind: 'delegatedDomain', domainId: localId };
  return { kind: 'localId', localId };
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
    (params.diagnosticsByPluginId[pluginId] ?? []).forEach((diagnostic, ordinal) => {
      diagnostics.push(enrichPluginDiagnosticRecord({
        code: diagnostic.code,
        severity: 'error',
        message: diagnostic.message,
      }, {
        ordinal,
        plugin,
        stage: 'normalization',
        host: params.host,
        platform: params.platform,
        occurredAtMs: params.occurredAtMs,
      }));
    });
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
        identity: readCandidateIdentity(entry),
        stability: entry.introspection.stability,
        registration: entry.introspection.registration,
        consumer: entry.introspection.consumer,
        platforms: entry.introspection.platforms,
      });
    }
  }

  return Object.freeze(candidates.sort((left, right) => (
    buildPluginContributionIntrospectionQualifiedId(left)
      .localeCompare(buildPluginContributionIntrospectionQualifiedId(right))
  )));
}
