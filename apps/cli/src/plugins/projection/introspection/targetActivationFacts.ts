import type { PluginDiagnosticRecordV1 } from '@happier-dev/protocol';

import type { PluginTargetActivationFact } from '@/plugins/runtime/lifecycle/activation/facts';
import { projectPluginFailureText } from '@/plugins/runtime/lifecycle/utils';
import {
  buildPluginContributionIntrospectionQualifiedId,
  enrichPluginDiagnosticRecord,
  readPluginContributionIntrospectionIdentityValue,
} from './project';
import type { PluginContributionIntrospectionCandidate, PluginContributionRuntimeFacts } from './types';

export type { PluginTargetActivationFact } from '@/plugins/runtime/lifecycle/activation/facts';

export type PluginTargetActivationIntrospectionSnapshot = Readonly<{
  generation: number;
  runtimeState: 'current' | 'disposed';
  runtimeFactsByQualifiedId: ReadonlyMap<string, PluginContributionRuntimeFacts>;
  diagnosticRecords: readonly PluginDiagnosticRecordV1[];
}>;

export type PluginTargetActivationCatalogPlugin = Readonly<{
  pluginId: string;
  pluginVersion: string;
  source: PluginDiagnosticRecordV1['plugin']['source'];
}>;

function targetRefKey(ref: Readonly<{ family: string; localId: string }>): string {
  return `${ref.family}/${ref.localId}`;
}

function assertUniqueRefs(
  refs: readonly Readonly<{ family: string; localId: string }>[],
  label: string,
  pluginId: string,
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const ref of refs) {
    const key = targetRefKey(ref);
    if (keys.has(key)) throw new Error(`Duplicate ${label} contribution '${pluginId}/${key}'`);
    keys.add(key);
  }
  return keys;
}

function setsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((key) => right.has(key));
}

function mapActivationHostToRegistrationHost(host: PluginTargetActivationFact['host']): 'daemon' | 'client' {
  return host === 'web' || host === 'ios' || host === 'android' ? 'client' : 'daemon';
}

export function adaptTargetActivationFacts(params: Readonly<{
  generation: number;
  candidates: readonly PluginContributionIntrospectionCandidate[];
  plugins: readonly PluginTargetActivationCatalogPlugin[];
  targetActivationFacts: readonly PluginTargetActivationFact[];
  runtimeState: 'current' | 'disposed';
}>): PluginTargetActivationIntrospectionSnapshot {
  const candidatesByPluginId = new Map<string, PluginContributionIntrospectionCandidate[]>();
  for (const candidate of params.candidates) {
    const entries = candidatesByPluginId.get(candidate.pluginId) ?? [];
    entries.push(candidate);
    candidatesByPluginId.set(candidate.pluginId, entries);
  }
  const currentPluginsById = new Map<string, PluginTargetActivationCatalogPlugin>();
  for (const plugin of params.plugins) {
    const current = currentPluginsById.get(plugin.pluginId);
    if (current && (current.pluginVersion !== plugin.pluginVersion || current.source !== plugin.source)) {
      throw new Error(`Current catalog has contradictory plugin metadata for '${plugin.pluginId}'`);
    }
    currentPluginsById.set(plugin.pluginId, plugin);
  }

  const runtimeFactsByQualifiedId = new Map<string, PluginContributionRuntimeFacts>();
  const diagnosticRecords: PluginDiagnosticRecordV1[] = [];
  const seenPluginIds = new Set<string>();

  for (const fact of params.targetActivationFacts) {
    if (seenPluginIds.has(fact.pluginId)) {
      throw new Error(`Duplicate target activation fact for plugin '${fact.pluginId}'`);
    }
    seenPluginIds.add(fact.pluginId);

    const currentPlugin = currentPluginsById.get(fact.pluginId);
    if (!currentPlugin) {
      throw new Error(`Target activation facts reference unknown plugin '${fact.pluginId}'`);
    }
    const pluginCandidates = candidatesByPluginId.get(fact.pluginId) ?? [];
    const pluginMetadata = pluginCandidates[0];
    if (pluginMetadata && pluginCandidates.some((candidate) => (
      candidate.pluginVersion !== pluginMetadata.pluginVersion || candidate.source !== pluginMetadata.source
    ))) {
      throw new Error(`Target activation facts have contradictory plugin metadata for '${fact.pluginId}'`);
    }
    if (pluginMetadata && (
      pluginMetadata.pluginVersion !== currentPlugin.pluginVersion || pluginMetadata.source !== currentPlugin.source
    )) {
      throw new Error(`Target activation catalog metadata contradicts contribution metadata for '${fact.pluginId}'`);
    }

    const activationRegistrationHost = mapActivationHostToRegistrationHost(fact.host);
    const requiredCandidates = pluginCandidates.filter((candidate) => (
      candidate.registration === 'required'
      && (candidate.runtimeRegistrationHost ?? 'daemon') === activationRegistrationHost
    ));
    // Registration demand is keyed by the canonical identity value the catalog
    // derives from the family's identity field — the same string the daemon's
    // registration rights carry. The introspection identity kind only records
    // how that value is presented, so a delegated-domain family such as
    // `providers` registers exactly like a local-id one.
    const expectedRequired = new Set(requiredCandidates.map((candidate) => targetRefKey({
      family: candidate.runtimeRegistrationFamily ?? candidate.family,
      localId: readPluginContributionIntrospectionIdentityValue(candidate.identity),
    })));
    const reportedRequired = assertUniqueRefs(fact.required, 'required', fact.pluginId);
    const reportedBound = assertUniqueRefs(fact.bound, 'bound', fact.pluginId);
    for (const ref of reportedRequired) {
      if (!expectedRequired.has(ref)) throw new Error(`Target activation fact references unknown required contribution '${fact.pluginId}/${ref}'`);
    }
    if (!setsEqual(expectedRequired, reportedRequired)) {
      throw new Error(`Target activation required contributions for '${fact.pluginId}' do not exactly match catalog demand`);
    }
    for (const ref of reportedBound) {
      if (!reportedRequired.has(ref)) throw new Error(`Target activation fact binds undeclared contribution '${fact.pluginId}/${ref}'`);
    }
    if (fact.status === 'active' && !setsEqual(reportedRequired, reportedBound)) {
      throw new Error(`Active target bindings for '${fact.pluginId}' must exactly match required contributions`);
    }
    if (fact.status !== 'active' && reportedBound.size > 0) {
      throw new Error(`Inactive target '${fact.pluginId}' cannot publish bound contributions`);
    }

    const currentMetadata = (
      fact.pluginVersion === currentPlugin.pluginVersion && fact.source === currentPlugin.source
    );
    // `generation` on an activation fact is contributor-local provenance. The
    // snapshot generation is the public projection revision, which may advance
    // when a different contributor changes while this activation remains live.
    const usable = params.runtimeState === 'current' && currentMetadata;
    const unavailable = !usable || fact.status === 'unavailable';
    const unavailableReason = projectPluginFailureText(new Error(params.runtimeState === 'disposed'
      ? `Activation generation '${fact.generation}' was disposed`
      : !currentMetadata
        ? `Activation facts for '${fact.pluginId}' describe ${fact.source} version '${fact.pluginVersion}', not current ${currentPlugin.source} version '${currentPlugin.pluginVersion}'`
        : fact.diagnostics[0]?.message ?? `Plugin '${fact.pluginId}' activation is unavailable`));

    for (const candidate of requiredCandidates) {
      const qualifiedId = buildPluginContributionIntrospectionQualifiedId(candidate);
      runtimeFactsByQualifiedId.set(qualifiedId, unavailable
        ? {
            registration: { requirement: 'required', state: 'unavailable', reason: unavailableReason },
            activation: { state: 'dormant' },
            projection: { state: 'projected' },
          }
        : fact.status === 'active'
          ? {
              registration: { requirement: 'required', state: 'bound', generation: fact.generation },
              activation: { state: 'active', generation: fact.generation },
              projection: { state: 'projected' },
            }
          : {
              registration: { requirement: 'required', state: 'unbound' },
              activation: { state: 'dormant' },
              projection: { state: 'projected' },
            });
    }

    const stateDiagnostic = params.runtimeState === 'disposed'
      ? { code: 'plugin_activation_generation_disposed', message: unavailableReason }
      : !currentMetadata
        ? { code: 'plugin_activation_metadata_stale', message: unavailableReason }
        : fact.status === 'unavailable' && fact.diagnostics.length === 0
          ? { code: 'plugin_activation_unavailable', message: unavailableReason }
          : null;
    const diagnostics: readonly Readonly<{
      diagnostic: Readonly<{ code: string; message: string }>;
      ordinal: number;
    }>[] = [
      ...(stateDiagnostic ? [{ diagnostic: stateDiagnostic, ordinal: fact.diagnostics.length }] : []),
      ...fact.diagnostics.map((diagnostic, ordinal) => ({ diagnostic, ordinal })),
    ];
    diagnostics.forEach(({ diagnostic, ordinal }) => {
      diagnosticRecords.push(enrichPluginDiagnosticRecord({
        code: diagnostic.code,
        severity: 'error',
        message: diagnostic.message,
      }, {
        ordinal,
        plugin: {
          id: fact.pluginId,
          version: fact.pluginVersion,
          source: fact.source,
        },
        stage: 'activation',
        generation: fact.generation,
        host: fact.host,
        platform: fact.platform,
        occurredAtMs: fact.occurredAtMs,
      }));
    });
  }

  return Object.freeze({
    generation: params.generation,
    runtimeState: params.runtimeState,
    runtimeFactsByQualifiedId,
    diagnosticRecords: Object.freeze(diagnosticRecords),
  });
}
