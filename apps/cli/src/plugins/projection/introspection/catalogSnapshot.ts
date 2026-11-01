import type { PluginDiagnosticRecordV1 } from '@happier-dev/protocol';

import type { PluginCatalogEntry } from '@/plugins/projection/catalog/installed';
import type { PluginFinalPolicyCurrentRuntime } from '@/plugins/runtime/policy/facts';
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
import type { PluginContributionIntrospectionCandidate, PluginContributionRuntimeFacts } from './types';
import { isPluginAdmissionExclusion } from '../registry/normalize/admission';

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
    : new Map<string, PluginContributionRuntimeFacts>();
  if (!entry.enabled) {
    for (const contribution of entry.contributionIntrospection.contributions) {
      const reason = entry.unavailableCode || entry.compatibility.status === 'load_error'
        ? 'Plugin unavailable' : 'Plugin disabled';
      contributionRuntimeFacts.set(contribution.contribution.qualifiedId, {
        registration: contribution.registration.requirement === 'required'
          ? { requirement: 'required', state: 'unavailable', reason }
          : { requirement: 'notRequired', state: 'notRequired' },
        activation: contribution.registration.requirement === 'required'
          ? { state: 'unavailable', reason }
          : { state: 'notRequired' },
        projection: { state: 'unavailable', reason },
      });
    }
  }
  const runtimeDiagnostics = runtimeSnapshot?.diagnosticRecords.filter((diagnostic) => (
    diagnostic.plugin.id === entry.pluginId
  )) ?? [];
  const entryAdditionalDiagnostics = additionalDiagnosticRecords.filter((diagnostic) => (
    diagnostic.plugin.id === entry.pluginId
  ));
  const unavailabilityDiagnostics = entry.unavailableCode && ![
    ...entry.contributionIntrospection.diagnostics, ...runtimeDiagnostics, ...entryAdditionalDiagnostics,
  ].some(({ data }) => (
    data.code === 'plugin_runtime_capability_missing'
    && typeof data.details === 'object' && data.details !== null && !Array.isArray(data.details)
    && data.details.reason === entry.unavailableCode
  ))
    ? projectPluginCompatibilityDiagnostics({
        diagnostics: [{
          code: 'plugin_runtime_capability_missing',
          message: 'Plugin unavailable',
          details: { reason: entry.unavailableCode },
        }],
        plugin: { id: entry.pluginId, version: entry.version, source: mapPluginSourceToDiagnosticSource(entry.source) },
        defaultStage: 'normalization', host: 'daemon', platform: process.platform, occurredAtMs: 0,
      })
    : [];
  const contributions = !entry.enabled || runtimeSnapshot || entryAdditionalDiagnostics.length > 0
    ? projectPluginContributionIntrospection({
        generation: runtimeSnapshot?.generation ?? entry.contributionIntrospection.generation,
        candidates: collectCatalogEntryCandidates(entry),
        diagnostics: [
          ...entry.contributionIntrospection.diagnostics.filter((diagnostic) => (
            !runtimeSnapshot || diagnostic.stage !== 'activation'
          )),
          ...runtimeDiagnostics,
          ...entryAdditionalDiagnostics,
          ...unavailabilityDiagnostics,
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
  if (!runtimeSnapshot && additionalDiagnosticRecords.length === 0 && entries.every(entry => entry.enabled)) return entries;
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
    pluginFinalPolicyCurrentRuntimesById?: ReadonlyMap<string, PluginFinalPolicyCurrentRuntime>;
  }> | null | undefined,
): readonly PluginCatalogEntry[] {
  // A live registry derives this map on access. All rows in one synchronous
  // join consume the same fresh observation instead of rebuilding it per row.
  const currentRuntimes = runtimeRegistry?.pluginFinalPolicyCurrentRuntimesById;
  const currentEntries = entries.map((entry) => {
    const current = currentRuntimes?.get(entry.pluginId);
    const currentCatalogGeneration = current
      ? current.sourceCustody.kind === 'managed'
        ? current.sourceCustody.immutableGenerationId
        : current.occurrenceId
      : null;
    const appliedGeneration = current?.applied === true
      && currentCatalogGeneration === entry.desiredGeneration
      ? currentCatalogGeneration
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
  const targetActivationFacts = runtimeRegistry?.targetActivationFacts;
  if (runtimeRegistry?.generation === undefined || !targetActivationFacts) {
    return joinPluginCatalogEntriesIntrospection(currentEntries, undefined, attributedDiagnostics);
  }
  return joinPluginCatalogEntriesIntrospection(currentEntries, resolveInstalledCatalogTargetActivationSnapshot({
    entries: currentEntries,
    generation: runtimeRegistry.generation,
    targetActivationFacts,
    runtimeState: 'current',
  }), attributedDiagnostics);
}

export function projectPluginCatalogEntriesSnapshot(
  entries: readonly PluginCatalogEntry[],
  runtimeSnapshot?: PluginTargetActivationIntrospectionSnapshot,
): readonly PluginCatalogEntryIntrospectionSnapshot[] {
  return entries.map((entry) => projectPluginCatalogEntrySnapshot(entry, runtimeSnapshot));
}
