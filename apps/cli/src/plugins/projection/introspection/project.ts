import {
  PluginContributionIntrospectionProjectionV1Schema,
  PluginDiagnosticRecordV1Schema,
  type PluginContributionIntrospectionIdentityV1,
  type PluginContributionIntrospectionProjectionV1,
  type PluginContributionLifecycleRecordV1,
  type PluginDiagnosticDataV1,
  type PluginDiagnosticHostV1,
  type PluginDiagnosticRecordV1,
  type PluginDiagnosticStageV1,
} from '@happier-dev/protocol';
import type {
  PluginContributionIntrospectionCandidate,
  PluginContributionRuntimeFacts,
} from './types';

export type {
  PluginContributionIntrospectionCandidate,
  PluginContributionRuntimeFacts,
} from './types';

export type PluginDiagnosticEnrichmentContext = Readonly<{
  ordinal: number;
  plugin: PluginDiagnosticRecordV1['plugin'];
  contribution?: PluginDiagnosticRecordV1['contribution'];
  stage: PluginDiagnosticStageV1;
  generation?: string;
  host: PluginDiagnosticHostV1;
  platform: string;
  correlationId?: string;
  occurredAtMs: number;
}>;

export function buildPluginContributionIntrospectionQualifiedId(input: Readonly<{
  pluginId: string;
  family: string;
  identity:
    | Readonly<{ kind: 'localId'; localId: string }>
    | Readonly<{ kind: 'locale'; locale: string }>
    | Readonly<{ kind: 'delegatedDomain'; domainId: string }>;
}>): string {
  const identityValue = input.identity.kind === 'localId'
    ? input.identity.localId
    : input.identity.kind === 'locale'
      ? input.identity.locale
      : input.identity.domainId;
  return `${input.pluginId}/${input.family}/${identityValue}`;
}

export function enrichPluginDiagnosticRecord(
  data: PluginDiagnosticDataV1,
  context: PluginDiagnosticEnrichmentContext,
): PluginDiagnosticRecordV1 {
  const scope = context.contribution
    ? ('qualifiedId' in context.contribution
        ? context.contribution.qualifiedId
        : `${context.contribution.pluginId}/${context.contribution.localId}`)
    : 'plugin';
  return PluginDiagnosticRecordV1Schema.parse({
    version: 1,
    id: `${context.plugin.id}:${context.stage}:${scope}:${context.ordinal}`,
    data,
    plugin: context.plugin,
    ...(context.contribution ? { contribution: context.contribution } : {}),
    stage: context.stage,
    ...(context.generation ? { generation: context.generation } : {}),
    host: context.host,
    platform: context.platform,
    ...(context.correlationId ? { correlationId: context.correlationId } : {}),
    occurredAtMs: context.occurredAtMs,
    resolution: { state: 'current' },
  });
}

function toIdentity(candidate: PluginContributionIntrospectionCandidate): PluginContributionIntrospectionIdentityV1 {
  const common = {
    pluginId: candidate.pluginId,
    family: candidate.family,
    qualifiedId: buildPluginContributionIntrospectionQualifiedId(candidate),
  };
  if (candidate.identity.kind === 'localId') {
    return { ...common, kind: 'localId', localId: candidate.identity.localId };
  }
  if (candidate.identity.kind === 'locale') {
    if (candidate.family !== 'ui.translations') {
      throw new Error(`Locale introspection identity is invalid for family '${candidate.family}'`);
    }
    return { ...common, kind: 'locale', family: 'ui.translations', locale: candidate.identity.locale };
  }
  if (candidate.family !== 'providers') {
    throw new Error(`Delegated-domain introspection identity is invalid for family '${candidate.family}'`);
  }
  return { ...common, kind: 'delegatedDomain', family: 'providers', domainId: candidate.identity.domainId };
}

function defaultRuntimeFacts(
  candidate: PluginContributionIntrospectionCandidate,
): PluginContributionRuntimeFacts {
  return candidate.registration === 'required'
    ? {
        registration: { requirement: 'required', state: 'unbound' },
        activation: { state: 'dormant' },
        projection: { state: 'projected' },
      }
    : {
        registration: { requirement: 'notRequired', state: 'notRequired' },
        activation: { state: 'notRequired' },
        projection: { state: 'projected' },
      };
}

export function projectPluginContributionIntrospection(params: Readonly<{
  generation: number;
  candidates: readonly PluginContributionIntrospectionCandidate[];
  diagnostics: readonly PluginDiagnosticRecordV1[];
  runtimeFactsByQualifiedId?: ReadonlyMap<string, PluginContributionRuntimeFacts>;
  progression?: Readonly<{ merged: boolean }>;
}>): PluginContributionIntrospectionProjectionV1 {
  const seenQualifiedIds = new Set<string>();
  const consumedRuntimeFactIds = new Set<string>();
  const contributions = params.candidates
    .map((candidate): PluginContributionLifecycleRecordV1 => {
      const contribution = toIdentity(candidate);
      if (seenQualifiedIds.has(contribution.qualifiedId)) {
        throw new Error(`Duplicate contribution introspection identity '${contribution.qualifiedId}'`);
      }
      seenQualifiedIds.add(contribution.qualifiedId);

      const explicitRuntimeFacts = params.runtimeFactsByQualifiedId?.get(contribution.qualifiedId);
      if (explicitRuntimeFacts) {
        consumedRuntimeFactIds.add(contribution.qualifiedId);
        if (explicitRuntimeFacts.registration.requirement !== candidate.registration) {
          throw new Error(
            `Runtime registration requirement for '${contribution.qualifiedId}' contradicts its catalog declaration`,
          );
        }
      }
      const runtimeFacts = explicitRuntimeFacts ?? defaultRuntimeFacts(candidate);
      const diagnostics = params.diagnostics.filter((diagnostic) => (
        contribution.kind === 'localId'
        && diagnostic.contribution?.pluginId === contribution.pluginId
        && diagnostic.contribution.localId === contribution.localId
      ));
      return {
        version: 1,
        contribution,
        stability: candidate.stability,
        progression: {
          declared: true,
          normalized: true,
          merged: params.progression?.merged ?? true,
        },
        registration: runtimeFacts.registration,
        activation: runtimeFacts.activation,
        projection: runtimeFacts.projection,
        consumer: candidate.consumer,
        platforms: [...candidate.platforms],
        diagnostics,
      };
    })
    .sort((left, right) => left.contribution.qualifiedId.localeCompare(right.contribution.qualifiedId));

  for (const qualifiedId of params.runtimeFactsByQualifiedId?.keys() ?? []) {
    if (!consumedRuntimeFactIds.has(qualifiedId)) {
      throw new Error(`Runtime facts reference unknown contribution introspection identity '${qualifiedId}'`);
    }
  }

  return PluginContributionIntrospectionProjectionV1Schema.parse({
    version: 1,
    generation: params.generation,
    contributions,
    diagnostics: params.diagnostics,
  });
}
