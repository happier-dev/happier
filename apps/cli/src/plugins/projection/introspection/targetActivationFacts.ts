import type { PluginDiagnosticRecordV1 } from '@happier-dev/protocol';

import type { PluginTargetActivationFact } from '@/plugins/runtime/lifecycle/activation/facts';
import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';
import { projectPluginFailureText } from '@/plugins/runtime/lifecycle/utils';
import {
  buildPluginContributionIntrospectionQualifiedId,
  enrichPluginDiagnosticRecord,
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
  for (const fact of params.targetActivationFacts) {
    const currentPlugin = currentPluginsById.get(fact.pluginId);
    if (!currentPlugin) continue;
    const pluginCandidates = candidatesByPluginId.get(fact.pluginId) ?? [];

    const activationRegistrationHost = mapActivationHostToRegistrationHost(fact.host);
    const requiredCandidates = pluginCandidates.filter((candidate) => (
      candidate.registration === 'required'
      && (candidate.runtimeRegistrationHost ?? 'daemon') === activationRegistrationHost
    ));
    const currentMetadata = (
      fact.pluginVersion === currentPlugin.pluginVersion && fact.source === currentPlugin.source
    );
    // `occurrenceId` on an activation fact is contributor-local currentness. The
    // snapshot generation is the public projection revision, which may advance
    // when a different contributor changes while this activation remains live.
    const usable = params.runtimeState === 'current' && currentMetadata;
    const unavailable = !usable || fact.status === 'unavailable';
    const unavailableReason = projectPluginFailureText(new Error(params.runtimeState === 'disposed'
      ? `Activation occurrence '${fact.occurrenceId}' was disposed`
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
              registration: { requirement: 'required', state: 'bound', occurrenceId: fact.occurrenceId },
              activation: { state: 'active', occurrenceId: fact.occurrenceId },
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
      diagnostic: Readonly<{ code: string; message: string; details?: PluginCompatibilityDiagnostic['details'] }>;
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
        ...(diagnostic.details === undefined ? {} : { details: diagnostic.details }),
      }, {
        ordinal,
        plugin: {
          id: fact.pluginId,
          version: fact.pluginVersion,
          source: fact.source,
        },
        stage: 'activation',
        occurrenceId: fact.occurrenceId,
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
