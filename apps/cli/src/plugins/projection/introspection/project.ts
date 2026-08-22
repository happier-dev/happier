import {
  PluginComposerReferenceProviderContributionV1Schema,
  PluginContributionIntrospectionProjectionV1Schema,
  PluginDiagnosticRecordV1Schema,
  type PluginContributionCatalogEntryV2,
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
import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';
import { projectPluginFailureText } from '@/plugins/runtime/lifecycle/utils';

export type {
  PluginContributionIntrospectionCandidate,
  PluginContributionRuntimeFacts,
} from './types';

/**
 * Extracts the bounded manifest display facts a lifecycle consumer may need.
 * This projection owner is shared by normalized runtime and catalog snapshots,
 * so neither producer can silently invent or drop a competing presentation.
 */
export function readPluginContributionIntrospectionPresentation(
  family: string,
  definition: Readonly<Record<string, unknown>> | null,
): PluginContributionIntrospectionCandidate['presentation'] | undefined {
  if (family !== 'composerReferences' || !definition) return undefined;
  const parsed = PluginComposerReferenceProviderContributionV1Schema.safeParse(definition);
  if (!parsed.success) return undefined;
  return {
    kind: 'composerReference',
    title: parsed.data.title,
    ...(parsed.data.description === undefined ? {} : { description: parsed.data.description }),
    icon: parsed.data.icon,
    triggers: parsed.data.triggers,
  };
}

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

/**
 * Reads the one canonical identity value of an introspection candidate. The
 * identity union only records how the catalog *presents* that value
 * (`identityKind`); every kind carries the same string the catalog derives from
 * the family's `identityField`, which is also the local id the daemon
 * registration rights are keyed by. Consumers must read the value through here
 * rather than treat one presentation kind as the only registrable identity.
 */
export function readPluginContributionIntrospectionIdentityValue(
  identity: PluginContributionIntrospectionCandidate['identity'],
): string {
  return identity.kind === 'localId'
    ? identity.localId
    : identity.kind === 'locale'
      ? identity.locale
      : identity.domainId;
}

/**
 * Builds the presentation of a contribution's one canonical identity value.
 * `PluginContributionCatalogEntryV2.identityKind` is the catalog's single
 * authority for how a family presents that value, so every introspection
 * producer derives the presentation here. A producer that instead hardcodes its
 * own family list projects a different `kind` than its sibling as soon as a
 * family's identity kind changes or a second delegated-domain/locale family
 * lands.
 */
export function buildPluginContributionIntrospectionIdentity(input: Readonly<{
  identityKind: PluginContributionCatalogEntryV2['identityKind'];
  identityValue: string;
}>): PluginContributionIntrospectionCandidate['identity'] {
  if (input.identityKind === 'locale') return { kind: 'locale', locale: input.identityValue };
  if (input.identityKind === 'delegatedDomain') return { kind: 'delegatedDomain', domainId: input.identityValue };
  return { kind: 'localId', localId: input.identityValue };
}

export function buildPluginContributionIntrospectionQualifiedId(input: Readonly<{
  pluginId: string;
  family: string;
  identity: PluginContributionIntrospectionCandidate['identity'];
}>): string {
  return `${input.pluginId}/${input.family}/${readPluginContributionIntrospectionIdentityValue(input.identity)}`;
}

export function enrichPluginDiagnosticRecord(
  data: PluginDiagnosticDataV1,
  context: PluginDiagnosticEnrichmentContext,
): PluginDiagnosticRecordV1 {
  const projectedData = data.message === undefined
    ? data
    : { ...data, message: projectPluginFailureText(new Error(data.message)) };
  const scope = context.contribution
    ? ('qualifiedId' in context.contribution
        ? context.contribution.qualifiedId
        : `${context.contribution.pluginId}/${context.contribution.localId}`)
    : 'plugin';
  return PluginDiagnosticRecordV1Schema.parse({
    version: 1,
    id: `${context.plugin.id}:${context.stage}:${scope}:${context.ordinal}`,
    data: projectedData,
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

export function readPluginDiagnosticDisplayMessage(
  diagnostic: PluginDiagnosticRecordV1,
): string {
  return diagnostic.data.message ?? diagnostic.data.code;
}

/**
 * Projects a compatibility diagnostic through the one record-enrichment
 * chokepoint. Callers supply the owning plugin metadata; this helper carries
 * the optional contribution identity and bounded detail facts without opening
 * a second diagnostics representation.
 */
export function projectPluginCompatibilityDiagnostics(params: Readonly<{
  diagnostics: readonly PluginCompatibilityDiagnostic[];
  plugin: PluginDiagnosticRecordV1['plugin'];
  defaultStage: PluginDiagnosticStageV1;
  generation?: string;
  host: PluginDiagnosticHostV1;
  platform: string;
  occurredAtMs: number;
}>): readonly PluginDiagnosticRecordV1[] {
  return Object.freeze(params.diagnostics.map((diagnostic, ordinal) => (
    enrichPluginDiagnosticRecord({
      code: diagnostic.code,
      severity: 'error',
      message: diagnostic.message,
      ...(diagnostic.details === undefined ? {} : { details: diagnostic.details }),
    }, {
      ordinal,
      plugin: params.plugin,
      ...(diagnostic.contribution === undefined ? {} : { contribution: diagnostic.contribution }),
      stage: diagnostic.stage ?? params.defaultStage,
      ...(params.generation === undefined ? {} : { generation: params.generation }),
      host: params.host,
      platform: params.platform,
      occurredAtMs: params.occurredAtMs,
    })
  )));
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
        progression: {
          declared: true,
          normalized: true,
          merged: params.progression?.merged ?? true,
        },
        registration: runtimeFacts.registration,
        activation: runtimeFacts.activation,
        projection: runtimeFacts.projection,
        ...(candidate.presentation === undefined ? {} : { presentation: candidate.presentation }),
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
