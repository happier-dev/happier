import type { PluginCatalogEntry } from '@/plugins/projection/catalog/installed';
import type { PluginFinalPolicyCurrentGeneration } from '@/plugins/runtime/policy/facts';
import { collectManifestContributionIntrospectionCandidates } from './manifest';
import {
  buildPluginContributionIntrospectionQualifiedId,
  projectPluginContributionIntrospection,
} from './project';
import { mapPluginSourceToDiagnosticSource } from './source';
import {
  adaptTargetActivationFacts,
  type PluginTargetActivationFact,
  type PluginTargetActivationIntrospectionSnapshot,
} from './targetActivationFacts';
import type { PluginContributionIntrospectionCandidate } from './types';

export type PluginCatalogEntryIntrospectionSnapshot = Readonly<{
  pluginId: PluginCatalogEntry['pluginId'];
  desiredGeneration: PluginCatalogEntry['desiredGeneration'];
  appliedGeneration: PluginCatalogEntry['appliedGeneration'];
  title: PluginCatalogEntry['title'];
  description: PluginCatalogEntry['description'];
  version: PluginCatalogEntry['version'];
  enabled: PluginCatalogEntry['enabled'];
  source: PluginCatalogEntry['source'];
  install: PluginCatalogEntry['install'];
  compatibility: PluginCatalogEntry['compatibility'];
  manifestPath: PluginCatalogEntry['manifestPath'];
  manifestDigest: PluginCatalogEntry['manifestDigest'];
  contributions: PluginCatalogEntry['contributionIntrospection'];
  diagnostics: PluginCatalogEntry['contributionIntrospection']['diagnostics'];
}>;

export function projectPluginCatalogEntrySnapshot(
  entry: PluginCatalogEntry,
  runtimeSnapshot?: PluginTargetActivationIntrospectionSnapshot,
): PluginCatalogEntryIntrospectionSnapshot {
  const contributionRuntimeFacts = runtimeSnapshot
    ? new Map([...runtimeSnapshot.runtimeFactsByQualifiedId].filter(([qualifiedId]) => (
        qualifiedId.startsWith(`${entry.pluginId}/`)
      )))
    : undefined;
  const runtimeDiagnostics = runtimeSnapshot?.diagnosticRecords.filter((diagnostic) => (
    diagnostic.plugin.id === entry.pluginId
  )) ?? [];
  const contributions = runtimeSnapshot
    ? projectPluginContributionIntrospection({
        generation: runtimeSnapshot.generation,
        candidates: collectCatalogEntryCandidates(entry),
        diagnostics: [
          ...entry.contributionIntrospection.diagnostics.filter((diagnostic) => diagnostic.stage !== 'activation'),
          ...runtimeDiagnostics,
        ],
        runtimeFactsByQualifiedId: contributionRuntimeFacts,
        progression: { merged: true },
      })
    : entry.contributionIntrospection;
  return Object.freeze({
    pluginId: entry.pluginId,
    desiredGeneration: entry.desiredGeneration,
    appliedGeneration: entry.appliedGeneration,
    title: entry.title,
    description: entry.description,
    version: entry.version,
    enabled: entry.enabled,
    source: entry.source,
    install: entry.install,
    compatibility: entry.compatibility,
    manifestPath: entry.manifestPath,
    manifestDigest: entry.manifestDigest,
    contributions,
    diagnostics: contributions.diagnostics,
  });
}

function collectCatalogEntryCandidates(entry: PluginCatalogEntry): readonly PluginContributionIntrospectionCandidate[] {
  const source = mapPluginSourceToDiagnosticSource(entry.source);
  const retainedManifestCandidatesByQualifiedId = new Map(
    entry.manifest
      ? collectManifestContributionIntrospectionCandidates({ manifest: entry.manifest, source })
          .map((candidate) => [buildPluginContributionIntrospectionQualifiedId(candidate), candidate] as const)
      : [],
  );
  return entry.contributionIntrospection.contributions.map((record): PluginContributionIntrospectionCandidate => ({
    pluginId: entry.pluginId,
    pluginVersion: entry.version,
    source,
    family: record.contribution.family,
    runtimeRegistrationHost: retainedManifestCandidatesByQualifiedId
      .get(record.contribution.qualifiedId)?.runtimeRegistrationHost
      ?? (record.registration.requirement === 'required' ? 'daemon' : null),
    runtimeRegistrationFamily: retainedManifestCandidatesByQualifiedId
      .get(record.contribution.qualifiedId)?.runtimeRegistrationFamily
      ?? record.contribution.family,
    identity: record.contribution.kind === 'localId'
      ? { kind: 'localId', localId: record.contribution.localId }
      : record.contribution.kind === 'locale'
        ? { kind: 'locale', locale: record.contribution.locale }
        : { kind: 'delegatedDomain', domainId: record.contribution.domainId },
    stability: record.stability,
    registration: record.registration.requirement,
    consumer: record.consumer,
    platforms: record.platforms,
  }));
}

export function resolveInstalledCatalogTargetActivationSnapshot(params: Readonly<{
  entries: readonly PluginCatalogEntry[];
  generation: number;
  targetActivationFacts: readonly PluginTargetActivationFact[];
  runtimeState: 'current' | 'disposed';
}>): PluginTargetActivationIntrospectionSnapshot {
  const candidates = params.entries.flatMap(collectCatalogEntryCandidates);
  const candidatePluginIds = new Set(params.entries.map((entry) => entry.pluginId));
  const relevantFacts = params.targetActivationFacts.filter((fact) => (
    candidatePluginIds.has(fact.pluginId)
  ));
  const plugins = params.entries.map((entry) => ({
    pluginId: entry.pluginId,
    pluginVersion: entry.version,
    source: mapPluginSourceToDiagnosticSource(entry.source),
  }));
  return adaptTargetActivationFacts({ ...params, candidates, plugins, targetActivationFacts: relevantFacts });
}

export function joinPluginCatalogEntriesIntrospection(
  entries: readonly PluginCatalogEntry[],
  runtimeSnapshot?: PluginTargetActivationIntrospectionSnapshot,
): readonly PluginCatalogEntry[] {
  if (!runtimeSnapshot) return entries;
  return entries.map((entry) => ({
    ...entry,
    contributionIntrospection: projectPluginCatalogEntrySnapshot(entry, runtimeSnapshot).contributions,
  }));
}

export function joinInstalledCatalogRuntimeIntrospection(
  entries: readonly PluginCatalogEntry[],
  runtimeRegistry: Readonly<{
    generation?: number;
    targetActivationFacts?: readonly PluginTargetActivationFact[];
    pluginFinalPolicyCurrentGenerationsById?: ReadonlyMap<string, PluginFinalPolicyCurrentGeneration>;
  }> | null | undefined,
): readonly PluginCatalogEntry[] {
  const currentEntries = entries.map((entry) => {
    const current = runtimeRegistry?.pluginFinalPolicyCurrentGenerationsById?.get(entry.pluginId);
    const appliedGeneration = current?.applied === true
      && current.immutableGenerationId === entry.desiredGeneration
      ? current.immutableGenerationId
      : null;
    return appliedGeneration === entry.appliedGeneration
      ? entry
      : { ...entry, appliedGeneration };
  });
  if (runtimeRegistry?.generation === undefined || !runtimeRegistry.targetActivationFacts) {
    return currentEntries;
  }
  return joinPluginCatalogEntriesIntrospection(currentEntries, resolveInstalledCatalogTargetActivationSnapshot({
    entries: currentEntries,
    generation: runtimeRegistry.generation,
    targetActivationFacts: runtimeRegistry.targetActivationFacts,
    runtimeState: 'current',
  }));
}

export function projectPluginCatalogEntriesSnapshot(
  entries: readonly PluginCatalogEntry[],
  runtimeSnapshot?: PluginTargetActivationIntrospectionSnapshot,
): readonly PluginCatalogEntryIntrospectionSnapshot[] {
  return entries.map((entry) => projectPluginCatalogEntrySnapshot(entry, runtimeSnapshot));
}
