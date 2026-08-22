import type { PluginDiagnosticRecordV1 } from '@happier-dev/protocol';

import type { PluginCatalogEntry } from '@/plugins/projection/catalog/installed';
import type { PluginFinalPolicyCurrentGeneration } from '@/plugins/runtime/policy/facts';
import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';
import { collectManifestContributionIntrospectionCandidates } from './manifest';
import {
  buildPluginContributionIntrospectionQualifiedId,
  projectPluginCompatibilityDiagnostics,
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
  contributions: PluginCatalogEntry['contributionIntrospection'];
  diagnostics: PluginCatalogEntry['contributionIntrospection']['diagnostics'];
}>;

export function projectPluginCatalogEntrySnapshot(
  entry: PluginCatalogEntry,
  runtimeSnapshot?: PluginTargetActivationIntrospectionSnapshot,
  additionalDiagnosticRecords: readonly PluginDiagnosticRecordV1[] = [],
): PluginCatalogEntryIntrospectionSnapshot {
  const contributionRuntimeFacts = runtimeSnapshot
    ? new Map([...runtimeSnapshot.runtimeFactsByQualifiedId].filter(([qualifiedId]) => (
        qualifiedId.startsWith(`${entry.pluginId}/`)
      )))
    : undefined;
  const runtimeDiagnostics = runtimeSnapshot?.diagnosticRecords.filter((diagnostic) => (
    diagnostic.plugin.id === entry.pluginId
  )) ?? [];
  const entryAdditionalDiagnostics = additionalDiagnosticRecords.filter((diagnostic) => (
    diagnostic.plugin.id === entry.pluginId
  ));
  const contributions = runtimeSnapshot || entryAdditionalDiagnostics.length > 0
    ? projectPluginContributionIntrospection({
        generation: runtimeSnapshot?.generation ?? entry.contributionIntrospection.generation,
        candidates: collectCatalogEntryCandidates(entry),
        diagnostics: [
          ...entry.contributionIntrospection.diagnostics.filter((diagnostic) => (
            !runtimeSnapshot || diagnostic.stage !== 'activation'
          )),
          ...runtimeDiagnostics,
          ...entryAdditionalDiagnostics,
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
    contributions,
    diagnostics: contributions.diagnostics,
  });
}

function projectAttributedCatalogDiagnostics(params: Readonly<{
  entries: readonly PluginCatalogEntry[];
  diagnosticsByPluginId: Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>;
  occurredAtMs: number;
}>): readonly PluginDiagnosticRecordV1[] {
  const entriesByPluginId = new Map(params.entries.map((entry) => [entry.pluginId, entry]));
  const records: PluginDiagnosticRecordV1[] = [];
  for (const pluginId of Object.keys(params.diagnosticsByPluginId).sort()) {
    const diagnostics = (params.diagnosticsByPluginId[pluginId] ?? []).filter((diagnostic) => (
      diagnostic.contribution !== undefined
    ));
    if (diagnostics.length === 0) continue;
    const entry = entriesByPluginId.get(pluginId);
    if (!entry) {
      throw new Error(`Missing current catalog entry for attributed diagnostic '${pluginId}'`);
    }
    records.push(...projectPluginCompatibilityDiagnostics({
      diagnostics,
      plugin: {
        id: entry.pluginId,
        version: entry.version,
        source: mapPluginSourceToDiagnosticSource(entry.source),
      },
      defaultStage: 'normalization',
      generation: entry.appliedGeneration ?? entry.desiredGeneration ?? undefined,
      host: 'daemon',
      platform: process.platform,
      occurredAtMs: params.occurredAtMs,
    }));
  }
  return Object.freeze(records);
}

function collectCatalogEntryCandidates(entry: PluginCatalogEntry): readonly PluginContributionIntrospectionCandidate[] {
  const source = mapPluginSourceToDiagnosticSource(entry.source);
  const retainedManifestCandidatesByQualifiedId = new Map(
    entry.manifest
      ? collectManifestContributionIntrospectionCandidates({ manifest: entry.manifest, source })
          .map((candidate) => [buildPluginContributionIntrospectionQualifiedId(candidate), candidate] as const)
      : [],
  );
  return entry.contributionIntrospection.contributions.map((record): PluginContributionIntrospectionCandidate => {
    const retained = retainedManifestCandidatesByQualifiedId
      .get(record.contribution.qualifiedId);
    const presentation = record.presentation ?? retained?.presentation;
    return {
      pluginId: entry.pluginId,
      pluginVersion: entry.version,
      source,
      family: record.contribution.family,
      runtimeRegistrationHost: retained?.runtimeRegistrationHost
        ?? (record.registration.requirement === 'required' ? 'daemon' : null),
      runtimeRegistrationFamily: retained?.runtimeRegistrationFamily
        ?? record.contribution.family,
      identity: record.contribution.kind === 'localId'
        ? { kind: 'localId', localId: record.contribution.localId }
        : record.contribution.kind === 'locale'
          ? { kind: 'locale', locale: record.contribution.locale }
          : { kind: 'delegatedDomain', domainId: record.contribution.domainId },
      registration: record.registration.requirement,
      consumer: record.consumer,
      platforms: record.platforms,
      ...(presentation === undefined ? {} : { presentation }),
    };
  });
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
  additionalDiagnosticRecords: readonly PluginDiagnosticRecordV1[] = [],
): readonly PluginCatalogEntry[] {
  if (!runtimeSnapshot && additionalDiagnosticRecords.length === 0) return entries;
  return entries.map((entry) => ({
    ...entry,
    contributionIntrospection: projectPluginCatalogEntrySnapshot(
      entry,
      runtimeSnapshot,
      additionalDiagnosticRecords,
    ).contributions,
  }));
}

export function joinInstalledCatalogRuntimeIntrospection(
  entries: readonly PluginCatalogEntry[],
  runtimeRegistry: Readonly<{
    generation?: number;
    targetActivationFacts?: readonly PluginTargetActivationFact[];
    pluginDiagnosticsByPluginId?: Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>;
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
  const attributedDiagnostics = projectAttributedCatalogDiagnostics({
    entries: currentEntries,
    diagnosticsByPluginId: runtimeRegistry?.pluginDiagnosticsByPluginId ?? {},
    occurredAtMs: Date.now(),
  });
  if (runtimeRegistry?.generation === undefined || !runtimeRegistry.targetActivationFacts) {
    return joinPluginCatalogEntriesIntrospection(currentEntries, undefined, attributedDiagnostics);
  }
  return joinPluginCatalogEntriesIntrospection(currentEntries, resolveInstalledCatalogTargetActivationSnapshot({
    entries: currentEntries,
    generation: runtimeRegistry.generation,
    targetActivationFacts: runtimeRegistry.targetActivationFacts,
    runtimeState: 'current',
  }), attributedDiagnostics);
}

export function projectPluginCatalogEntriesSnapshot(
  entries: readonly PluginCatalogEntry[],
  runtimeSnapshot?: PluginTargetActivationIntrospectionSnapshot,
): readonly PluginCatalogEntryIntrospectionSnapshot[] {
  return entries.map((entry) => projectPluginCatalogEntrySnapshot(entry, runtimeSnapshot));
}
