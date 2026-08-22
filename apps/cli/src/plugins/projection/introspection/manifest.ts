import {
  PLUGIN_CONTRIBUTION_CATALOG_V2,
  type PluginDiagnosticHostV1,
  type PluginDiagnosticRecordV1,
  type PluginDiagnosticStageV1,
  type PluginContributionIntrospectionProjectionV1,
} from '@happier-dev/protocol';

import type { CanonicalPluginManifest } from '@/plugins/manifest/types';
import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';
import {
  buildPluginContributionIntrospectionIdentity,
  buildPluginContributionIntrospectionQualifiedId,
  projectPluginCompatibilityDiagnostics,
  projectPluginContributionIntrospection,
  readPluginContributionIntrospectionPresentation,
} from './project';
import type { PluginContributionIntrospectionCandidate } from './types';

export function collectManifestContributionIntrospectionCandidates(params: Readonly<{
  manifest: CanonicalPluginManifest;
  source: PluginDiagnosticRecordV1['plugin']['source'];
}>): readonly PluginContributionIntrospectionCandidate[] {
  const candidates: PluginContributionIntrospectionCandidate[] = [];
  for (const catalogEntry of PLUGIN_CONTRIBUTION_CATALOG_V2) {
    for (const rawDefinition of catalogEntry.readEntries(params.manifest.contributes)) {
      const definition = catalogEntry.canonicalize(rawDefinition);
      if (!definition || typeof definition !== 'object' || Array.isArray(definition)) continue;
      const record = definition as Readonly<Record<string, unknown>>;
      const introspection = catalogEntry.projectIntrospection(record);
      const localId = introspection.localId ?? catalogEntry.conflictKey(record);
      if (localId === null || localId.trim().length === 0) {
        throw new Error(
          `Cannot introspect contribution '${params.manifest.id}/${catalogEntry.manifestKey}' without a canonical local identity`,
        );
      }
      const identity = buildPluginContributionIntrospectionIdentity({
        identityKind: catalogEntry.identityKind,
        identityValue: localId,
      });
      const presentation = readPluginContributionIntrospectionPresentation(
        catalogEntry.manifestKey,
        record,
      );
      candidates.push({
        pluginId: params.manifest.id,
        pluginVersion: params.manifest.version,
        source: params.source,
        family: catalogEntry.manifestKey,
        runtimeRegistrationHost: catalogEntry.runtimeRegistrationHost(record),
        runtimeRegistrationFamily: catalogEntry.runtimeRegistrationFamily(record),
        identity,
        registration: introspection.registration,
        consumer: introspection.consumer,
        platforms: introspection.platforms,
        ...(presentation === undefined ? {} : { presentation }),
      });
    }
  }
  return Object.freeze(candidates.sort((left, right) => (
    buildPluginContributionIntrospectionQualifiedId(left)
      .localeCompare(buildPluginContributionIntrospectionQualifiedId(right))
  )));
}

export function projectManifestContributionIntrospection(params: Readonly<{
  manifest: CanonicalPluginManifest;
  source: PluginDiagnosticRecordV1['plugin']['source'];
  generation: number;
  host: PluginDiagnosticHostV1;
  platform: string;
  occurredAtMs: number;
  diagnosticStage?: PluginDiagnosticStageV1;
  diagnostics: readonly PluginCompatibilityDiagnostic[];
}>): PluginContributionIntrospectionProjectionV1 {
  const diagnostics = projectPluginCompatibilityDiagnostics({
    diagnostics: params.diagnostics,
    plugin: {
      id: params.manifest.id,
      version: params.manifest.version,
      source: params.source,
    },
    defaultStage: params.diagnosticStage ?? 'normalization',
    host: params.host,
    platform: params.platform,
    occurredAtMs: params.occurredAtMs,
  });
  return projectPluginContributionIntrospection({
    generation: params.generation,
    candidates: collectManifestContributionIntrospectionCandidates(params),
    diagnostics,
    progression: { merged: false },
  });
}
