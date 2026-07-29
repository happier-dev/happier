import {
  ConnectedServiceBindingsV1Schema,
  assessProviderEndpoint,
  createProviderErrorV1,
  ProviderErrorV1Schema,
  type AgentProviderBindingMaterializationV1,
  type ConnectedServiceBindingsV1,
  type ConnectedServiceId,
  type ProviderErrorV1,
  type QualifiedConnectedAccountPurposeBindingsV1,
} from '@happier-dev/protocol';
import type {
  AgentProviderBindingCredential,
  AgentProviderBindingResolvedFacts,
} from '@happier-dev/plugin-sdk/agent-runtime';

import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import { materializeLeasedAgentProviderBinding } from '@/plugins/runtime/providerBindings/adapter';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { ProviderRuntimeStateStore } from '../runtimeState';
import { evaluateProviderModelLoadPreflight } from '../modelManagement/load';
import { resolveProviderRuntimeCatalogObservation } from './runtimeCatalog';

import {
  composeProviderBindingMaterialization,
  type ComposedProviderBindingMaterialization,
} from './compose';
import type { ProviderCredentialPlaintextResultForSpawn } from './credentials';
import { createProviderRedactionLease, type ProviderRedactionLease } from './redaction';
import type {
  ProviderSpawnAuthorization,
  ProviderSpawnAuthorizationResult,
} from './resolve';
import {
  resolveProviderSpawnAuthorization,
  type ResolveProviderSpawnAuthorizationInput,
} from './resolve';
import { collectProviderConnectionDnsEvidence } from '../registry/dnsEvidence';
import { resolveProviderConnectionForMachine } from '../registry/resolve';
import { readProviderSettingsForCli } from '../settings/read';
import { resolveProviderCredentialPlaintext } from './credentials';
import { revalidateProviderBindingAuthorizationTicket } from './ticket';
import { createAccountBoundProviderSnapshotReader } from '../lifecycle/currentAccountSettingsSnapshot';
import { activateAgentRuntimeContributionOnDemand } from '@/agent/runtime/registry/activationDemand';
import {
  resolveManagedProviderPurposeBindingSnapshot,
  type ResolveManagedProviderPurposeBindingIntent,
} from '../managed/resolvePurposeBindingSnapshot';

type ExternalProviderSpawnAuthorization = Extract<
  ProviderSpawnAuthorization,
  { deployment: { kind: 'external' } }
>;
type ManagedProviderSpawnAuthorization = Extract<
  ProviderSpawnAuthorization,
  { deployment: { kind: 'managedLocal' } }
>;

type ManagedProviderAuthorizationCurrentnessBasis = Readonly<{
  ticket: Pick<
    ManagedProviderSpawnAuthorization['ticket'],
    | 'connectionId'
    | 'machineId'
    | 'connectionSecurityFingerprint'
    | 'grantFingerprint'
  >;
  deployment: Readonly<{
    contribution: Pick<
      ManagedProviderSpawnAuthorization['deployment']['contribution'],
      'provenance' | 'source' | 'identity'
    >;
    implementation: Pick<
      ManagedProviderSpawnAuthorization['deployment']['implementation'],
      'implementationIdentity' | 'facet' | 'purposeBindings'
    >;
  }>;
}>;

export function sameManagedProviderAuthorizationCurrentnessBasis(
  expected: ManagedProviderAuthorizationCurrentnessBasis,
  actual: ManagedProviderAuthorizationCurrentnessBasis,
): boolean {
  return expected.ticket.connectionId === actual.ticket.connectionId
    && expected.ticket.machineId === actual.ticket.machineId
    && expected.ticket.connectionSecurityFingerprint
      === actual.ticket.connectionSecurityFingerprint
    && expected.ticket.grantFingerprint === actual.ticket.grantFingerprint
    && expected.deployment.contribution.provenance
      === actual.deployment.contribution.provenance
    && expected.deployment.contribution.source.kind
      === actual.deployment.contribution.source.kind
    && JSON.stringify(expected.deployment.contribution.identity)
      === JSON.stringify(actual.deployment.contribution.identity)
    && JSON.stringify(expected.deployment.implementation.implementationIdentity)
      === JSON.stringify(actual.deployment.implementation.implementationIdentity)
    && JSON.stringify(expected.deployment.implementation.facet)
      === JSON.stringify(actual.deployment.implementation.facet);
}

function isExternalProviderSpawnAuthorization(
  authorization: ProviderSpawnAuthorization,
): authorization is ExternalProviderSpawnAuthorization {
  return authorization.deployment.kind === 'external';
}

function isManagedProviderSpawnAuthorization(
  authorization: ProviderSpawnAuthorization,
): authorization is ManagedProviderSpawnAuthorization {
  return authorization.deployment.kind === 'managedLocal';
}

export function filterSuppressedConnectedServiceBindings(input: Readonly<{
  bindings: ConnectedServiceBindingsV1;
  suppressConnectedServiceIds: readonly ConnectedServiceId[];
}>): Readonly<{
  bindings: ConnectedServiceBindingsV1;
  suppressedServiceIds: readonly ConnectedServiceId[];
}> {
  const parsed = ConnectedServiceBindingsV1Schema.parse(input.bindings);
  const suppressed = new Set(input.suppressConnectedServiceIds);
  const suppressedServiceIds = Object.keys(parsed.bindingsByServiceId)
    .filter((serviceId): serviceId is ConnectedServiceId => suppressed.has(serviceId as ConnectedServiceId));
  const bindingsByServiceId = Object.fromEntries(
    Object.entries(parsed.bindingsByServiceId).filter(([serviceId]) => !suppressed.has(serviceId as ConnectedServiceId)),
  );
  return {
    bindings: ConnectedServiceBindingsV1Schema.parse({ v: 1, bindingsByServiceId }),
    suppressedServiceIds: Object.freeze(suppressedServiceIds),
  };
}

function renderCredential(
  value: string,
  transport: AgentProviderBindingResolvedFacts['runtimeCredentialTransport'],
): readonly string[] {
  if (!transport) return [value];
  const format = transport.destination.format;
  const rendered = format === 'raw'
    ? value
    : format === 'bearer'
      ? `Bearer ${value}`
      : format.template.replace('{secret}', value);
  return rendered === value ? [value] : [value, rendered];
}

export type ProviderSpawnMaterializationResult =
  | Readonly<{
      ok: true;
      materialization: ComposedProviderBindingMaterialization;
      redactionLease: ProviderRedactionLease;
      sessionBindingMetadata: ProviderSpawnAuthorization['sessionBindingMetadata'];
    }>
  | Readonly<{ ok: false; error: ProviderErrorV1 }>;

type ProviderSpawnAuthorizationAttemptCommon<TAuthorization extends ProviderSpawnAuthorization> = Readonly<{
  authorization: TAuthorization;
  isAuthorizationCurrent: () => boolean;
  revalidateBeforeEffect: () => Promise<Readonly<{ ok: true } | { ok: false; error: ProviderErrorV1 }>>;
  revalidateBeforeCommit: () => Promise<Readonly<{ ok: true } | { ok: false; error: ProviderErrorV1 }>>;
  cleanupOnFailure: () => void;
  takeCleanupOnExit: () => (() => void) | null;
}>;

export type ProviderSpawnAuthorizationAttempt =
  | Readonly<
      ProviderSpawnAuthorizationAttemptCommon<ExternalProviderSpawnAuthorization>
      & {
        deployment: ExternalProviderSpawnAuthorization['deployment'];
        materializeAfterHooks: () => Promise<ProviderSpawnMaterializationResult>;
      }
    >
  | Readonly<
      ProviderSpawnAuthorizationAttemptCommon<ManagedProviderSpawnAuthorization>
      & {
        deployment: ManagedProviderSpawnAuthorization['deployment'];
        materializeManagedEndpoint: (input: Readonly<{
          normalizedUrl: string;
          downstreamBearer: string;
        }>) => Promise<ProviderSpawnMaterializationResult>;
      }
    >;

type ProviderSpawnAuthorizationAttemptInput<TAuthorization extends ProviderSpawnAuthorization> = Readonly<{
  initial: TAuthorization;
  revalidate: () => Promise<ProviderSpawnAuthorizationResult>;
  resolveCredential: () => ProviderCredentialPlaintextResultForSpawn;
  materialize: (input: Readonly<{
    authorization: TAuthorization;
    binding: AgentProviderBindingResolvedFacts;
    credential: AgentProviderBindingCredential;
  }>) => Promise<AgentProviderBindingMaterializationV1>;
  materializationBaseDir: string;
  sessionId?: string;
  isCurrent?: () => boolean;
  subscribeCurrentness?: (listener: () => void) => () => void;
  createRedactionLease?: typeof createProviderRedactionLease;
}>;

export function createProviderSpawnAuthorizationAttempt(
  input: ProviderSpawnAuthorizationAttemptInput<ExternalProviderSpawnAuthorization>,
): Extract<ProviderSpawnAuthorizationAttempt, { deployment: { kind: 'external' } }>;
export function createProviderSpawnAuthorizationAttempt(
  input: ProviderSpawnAuthorizationAttemptInput<ManagedProviderSpawnAuthorization>,
): Extract<ProviderSpawnAuthorizationAttempt, { deployment: { kind: 'managedLocal' } }>;
export function createProviderSpawnAuthorizationAttempt(
  input: ProviderSpawnAuthorizationAttemptInput<ProviderSpawnAuthorization>,
): ProviderSpawnAuthorizationAttempt;
export function createProviderSpawnAuthorizationAttempt<
  TAuthorization extends ProviderSpawnAuthorization,
>(
  input: ProviderSpawnAuthorizationAttemptInput<TAuthorization>,
): ProviderSpawnAuthorizationAttempt {
  let composed: ComposedProviderBindingMaterialization | null = null;
  let redactionLease: ProviderRedactionLease | null = null;
  let cleaned = false;
  let transferred = false;
  let authorizationCurrent = input.isCurrent?.() ?? true;
  let unsubscribeCurrentness: (() => void) | null = input.subscribeCurrentness
    ? input.subscribeCurrentness(() => {
        authorizationCurrent = authorizationCurrent && (input.isCurrent?.() ?? true);
      })
    : null;

  const isAuthorizationCurrent = () => {
    authorizationCurrent = authorizationCurrent && (input.isCurrent?.() ?? true);
    return authorizationCurrent;
  };

  const cleanup = () => {
    if (cleaned || transferred) return;
    cleaned = true;
    try {
      composed?.cleanup?.();
    } finally {
      redactionLease?.close();
      unsubscribeCurrentness?.();
      composed = null;
      redactionLease = null;
      unsubscribeCurrentness = null;
    }
  };

  const revalidate = async () => {
    if (!isAuthorizationCurrent()) {
      return {
        ok: false as const,
        error: createProviderErrorV1('provider_authorization_changed', {
          connectionId: input.initial.ticket.connectionId,
          machineId: input.initial.ticket.machineId,
        }),
      };
    }
    const managed = isManagedProviderSpawnAuthorization(input.initial);
    const current = await input.revalidate();
    if (!current.ok) {
      return managed
        ? {
            ok: false as const,
            error: createProviderErrorV1('provider_authorization_changed', {
              connectionId: input.initial.ticket.connectionId,
              machineId: input.initial.ticket.machineId,
            }),
          }
        : { ok: false as const, error: current.error };
    }
    return revalidateProviderBindingAuthorizationTicket(input.initial.ticket, current.authorization.ticket);
  };

  const materialize = async (params: Readonly<{
    binding: AgentProviderBindingResolvedFacts;
    credential: AgentProviderBindingCredential;
  }>): Promise<ProviderSpawnMaterializationResult> => {
    if (composed || redactionLease || cleaned || transferred) {
      throw new Error('Provider binding materialization attempt is single-use');
    }
    redactionLease = (input.createRedactionLease ?? createProviderRedactionLease)({
      values: [
        ...(params.credential.kind === 'apiKey'
          ? renderCredential(
              params.credential.value,
              params.binding.runtimeCredentialTransport,
            )
          : []),
        ...Object.values(params.binding.endpoint.publicHeaders).filter((value) => value.length > 0),
      ],
    });
    try {
      const rawMaterialization = await input.materialize({
        authorization: input.initial,
        binding: params.binding,
        credential: params.credential,
      });
      composed = await composeProviderBindingMaterialization({
        materialization: rawMaterialization,
        materializationBaseDir: input.materializationBaseDir,
        sessionId: input.sessionId,
      });
      redactionLease.add(composed.additionalRedactionValues);
      return {
        ok: true as const,
        materialization: composed,
        redactionLease,
        sessionBindingMetadata: input.initial.sessionBindingMetadata,
      };
    } catch (error) {
      cleanup();
      const providerError = ProviderErrorV1Schema.safeParse(error);
      if (providerError.success) return { ok: false as const, error: providerError.data };
      return {
        ok: false as const,
        error: createProviderErrorV1('provider_materialization_failed', {
          connectionId: input.initial.ticket.connectionId,
          machineId: input.initial.ticket.machineId,
        }),
      };
    }
  };

  const common = {
    isAuthorizationCurrent,
    revalidateBeforeEffect: revalidate,
    revalidateBeforeCommit: async () => {
      const current = await revalidate();
      if (!current.ok) cleanup();
      return current;
    },
    cleanupOnFailure: cleanup,
    takeCleanupOnExit: () => {
      if (cleaned || transferred || (!composed && !redactionLease && !unsubscribeCurrentness)) return null;
      transferred = true;
      const transferredComposed = composed;
      const transferredRedaction = redactionLease;
      const transferredUnsubscribe = unsubscribeCurrentness;
      composed = null;
      redactionLease = null;
      unsubscribeCurrentness = null;
      let exitCleaned = false;
      return () => {
        if (exitCleaned) return;
        exitCleaned = true;
        try {
          transferredComposed?.cleanup?.();
        } finally {
          try {
            transferredRedaction?.close();
          } finally {
            transferredUnsubscribe?.();
          }
        }
      };
    },
  } satisfies Omit<
    ProviderSpawnAuthorizationAttemptCommon<ProviderSpawnAuthorization>,
    'authorization'
  >;

  if (isExternalProviderSpawnAuthorization(input.initial)) {
    const authorization = input.initial;
    return Object.freeze({
      ...common,
      deployment: authorization.deployment,
      authorization,
      materializeAfterHooks: async () => {
      const current = await revalidate();
      if (!current.ok) return current;
      let resolvedCredential: ProviderCredentialPlaintextResultForSpawn;
      try {
        resolvedCredential = input.resolveCredential();
      } catch {
        return {
          ok: false as const,
          error: createProviderErrorV1('provider_secret_missing', {
            connectionId: input.initial.ticket.connectionId,
            machineId: input.initial.ticket.machineId,
          }),
        };
      }
      if (!resolvedCredential.ok) return resolvedCredential;
      const credential: AgentProviderBindingCredential = resolvedCredential.credential.kind === 'none'
        ? { kind: 'none' }
        : {
            kind: 'apiKey',
            transport: authorization.binding.runtimeCredentialTransport!,
            value: resolvedCredential.credential.value,
          };
        return materialize({ binding: authorization.binding, credential });
      },
    });
  }

  if (!isManagedProviderSpawnAuthorization(input.initial)) {
    throw new Error('Unknown Provider deployment kind');
  }
  const authorization = input.initial;
  return Object.freeze({
    ...common,
    deployment: authorization.deployment,
    authorization,
    materializeManagedEndpoint: async ({ normalizedUrl, downstreamBearer }) => {
      const current = await revalidate();
      if (!current.ok) return current;
      if (!downstreamBearer) {
        return {
          ok: false as const,
          error: createProviderErrorV1('provider_materialization_failed', {
            connectionId: input.initial.ticket.connectionId,
            machineId: input.initial.ticket.machineId,
          }),
        };
      }
      let assessed: ReturnType<typeof assessProviderEndpoint>;
      try {
        assessed = assessProviderEndpoint(normalizedUrl);
      } catch {
        return {
          ok: false as const,
          error: createProviderErrorV1('provider_endpoint_unavailable', {
            connectionId: input.initial.ticket.connectionId,
            machineId: input.initial.ticket.machineId,
          }),
        };
      }
      if (assessed.locality !== 'loopback') {
        return {
          ok: false as const,
          error: createProviderErrorV1('provider_endpoint_unavailable', {
            connectionId: input.initial.ticket.connectionId,
            machineId: input.initial.ticket.machineId,
          }),
        };
      }
      const binding: AgentProviderBindingResolvedFacts = {
        ...authorization.binding,
        endpoint: {
          ...authorization.binding.endpoint,
          normalizedUrl: assessed.normalizedUrl,
        },
      };
      return materialize({
        binding,
        credential: {
          kind: 'apiKey',
          transport: authorization.binding.runtimeCredentialTransport,
          value: downstreamBearer,
        },
      });
    },
  });
}

export async function createRuntimeProviderSpawnAuthorizationAttempt(input: Readonly<{
  selection: ResolveProviderSpawnAuthorizationInput['selection'];
  machineId: string;
  agentTargetKey: string;
  agentId: string;
  lease: PluginRuntimeRegistryLease;
  getAccountSettingsSnapshot: () => ActiveAccountSettingsSnapshot | null;
  subscribeAccountSettingsSnapshot?: (listener: () => void) => () => void;
  localCandidateUrlsByConnectionId?: ResolveProviderSpawnAuthorizationInput['localCandidateUrlsByConnectionId'];
  runtimeModelDescriptor?:
    ResolveProviderSpawnAuthorizationInput['runtimeModelDescriptor'];
  runtimeStateStore?: Pick<ProviderRuntimeStateStore, 'read'>;
  materializationBaseDir: string;
  sessionId?: string;
  resolveAddresses?: (hostname: string) => Promise<readonly string[]>;
  resolveManagedPurposeBindingIntent?: ResolveManagedProviderPurposeBindingIntent;
  managedPurposeBindingSnapshot?: QualifiedConnectedAccountPurposeBindingsV1;
}>): Promise<Readonly<
  | { ok: true; attempt: ProviderSpawnAuthorizationAttempt }
  | { ok: false; error: ProviderErrorV1 }
>> {
  const activationResults = await activateAgentRuntimeContributionOnDemand(
    input.lease.registry,
    input.agentId,
  );
  if (activationResults.some((result) => (
    result.diagnostics.length > 0
    && !input.lease.registry.activatedPluginIds.has(result.pluginId)
  ))) {
    return {
      ok: false,
      error: createProviderErrorV1('provider_agent_runtime_unsupported', {
        connectionId: input.selection.ref.providerConnectionId ?? undefined,
        machineId: input.machineId,
      }),
    };
  }
  const getAccountSettingsSnapshot = createAccountBoundProviderSnapshotReader(
    input.getAccountSettingsSnapshot,
  );
  const registry = {
    providersByContributionKey:
      input.lease.registry.contributes.providersByContributionKey ?? new Map(),
  };
  let managedPurposeBindingSnapshot = input.managedPurposeBindingSnapshot;
  const resolveCurrent = async (): Promise<ProviderSpawnAuthorizationResult> => {
    const snapshot = getAccountSettingsSnapshot();
    if (!snapshot) {
      return {
        ok: false,
        error: createProviderErrorV1('provider_connection_not_found', {
          connectionId: input.selection.ref.providerConnectionId ?? undefined,
          machineId: input.machineId,
        }),
      };
    }
    const providerSettings = readProviderSettingsForCli(snapshot.settings).settings;
    const connectionId = input.selection.ref.providerConnectionId;
    if (connectionId === null) {
      return { ok: false, error: createProviderErrorV1('provider_connection_not_found') };
    }
    const dnsEvidenceByEndpointUrl = await collectProviderConnectionDnsEvidence({
      connectionId,
      machineId: input.machineId,
      providerSettings,
      registry,
      ...(input.resolveAddresses ? { resolveAddresses: input.resolveAddresses } : {}),
    });
    const connectionResolution = resolveProviderConnectionForMachine({
      connectionId,
      machineId: input.machineId,
      accountSettings: snapshot.settings,
      registry,
      dnsEvidenceByEndpointUrl,
      ...(input.localCandidateUrlsByConnectionId
        ? {
            localCandidateUrlsByConnectionId:
              input.localCandidateUrlsByConnectionId,
          }
        : {}),
    });
    if (
      connectionResolution.status === 'resolved'
      && connectionResolution.record.deployment.kind === 'managedLocal'
    ) {
      if (
        !input.resolveManagedPurposeBindingIntent
        && !managedPurposeBindingSnapshot
      ) {
        return {
          ok: false,
          error: createProviderErrorV1('provider_connection_invalid', {
            connectionId,
            machineId: input.machineId,
          }),
        };
      }
      if (!managedPurposeBindingSnapshot && input.resolveManagedPurposeBindingIntent) {
        try {
          managedPurposeBindingSnapshot =
            await resolveManagedProviderPurposeBindingSnapshot({
              implementationIdentity:
                connectionResolution.record.deployment.implementationIdentity,
              facet: connectionResolution.record.deployment.facet,
              purposeBindingIntents:
                connectionResolution.record.deployment.purposeBindingIntents,
              resolveBindingIntent: input.resolveManagedPurposeBindingIntent,
            });
        } catch {
          return {
            ok: false,
            error: createProviderErrorV1('provider_connection_invalid', {
              connectionId,
              machineId: input.machineId,
            }),
          };
        }
      }
    }
    const runtimeModelObservation = input.runtimeStateStore
      ? await resolveProviderRuntimeCatalogObservation({
          selection: input.selection,
          machineId: input.machineId,
          accountSettings: snapshot.settings,
          providerSettings,
          registry,
          dnsEvidenceByEndpointUrl,
          runtimeStateStore: input.runtimeStateStore,
          ...(input.resolveManagedPurposeBindingIntent
            ? {
                resolveManagedPurposeBindingIntent:
                  input.resolveManagedPurposeBindingIntent,
              }
            : {}),
          ...(managedPurposeBindingSnapshot
            ? { managedPurposeBindingSnapshot }
            : {}),
          ...(input.localCandidateUrlsByConnectionId
            ? { localCandidateUrlsByConnectionId: input.localCandidateUrlsByConnectionId }
            : {}),
        })
      : null;
    const runtimeModelDescriptor =
      input.runtimeModelDescriptor ?? runtimeModelObservation?.model ?? null;
    const authorization = resolveProviderSpawnAuthorization({
      selection: input.selection,
      machineId: input.machineId,
      agentTargetKey: input.agentTargetKey,
      agentId: input.agentId,
      accountSettings: snapshot.settings,
      providerSettings,
      registry,
      dnsEvidenceByEndpointUrl,
      lease: input.lease,
      ...(managedPurposeBindingSnapshot ? { managedPurposeBindingSnapshot } : {}),
      ...(input.localCandidateUrlsByConnectionId
        ? { localCandidateUrlsByConnectionId: input.localCandidateUrlsByConnectionId }
        : {}),
      ...(runtimeModelDescriptor ? { runtimeModelDescriptor } : {}),
    });
    if (!authorization.ok) return authorization;
    const modelLoadDescriptor =
      connectionResolution.status === 'resolved'
      && connectionResolution.record.source.kind === 'contribution'
        ? connectionResolution.record.source.definition.modelLoad ?? null
        : null;
    const modelLoadPreflight = evaluateProviderModelLoadPreflight({
      descriptor: modelLoadDescriptor,
      loadState: runtimeModelObservation?.loadState ?? 'unknown',
    });
    if (modelLoadPreflight.status === 'blocked') {
      return {
        ok: false,
        error: createProviderErrorV1('provider_model_unloaded', {
          connectionId,
          machineId: input.machineId,
          modelLoadAvailable: true,
        }),
      };
    }
    return authorization;
  };
  const initial = await resolveCurrent();
  if (!initial.ok) return initial;
  const isManagedAuthorizationCurrent = (): boolean => {
    if (!isManagedProviderSpawnAuthorization(initial.authorization)) return true;
    const snapshot = getAccountSettingsSnapshot();
    if (!snapshot) return false;
    const current = resolveProviderConnectionForMachine({
      connectionId: initial.authorization.ticket.connectionId,
      machineId: input.machineId,
      accountSettings: snapshot.settings,
      registry,
      dnsEvidenceByEndpointUrl: new Map(),
    });
    if (
      current.status !== 'resolved'
      || !current.record.authorization.authorized
      || current.record.deployment.kind !== 'managedLocal'
      || current.record.source.kind !== 'contribution'
      || current.record.source.provenance !== 'first_party'
    ) {
      return false;
    }
    const contribution = registry.providersByContributionKey.get(
      current.record.source.contributionKey,
    );
    if (
      !contribution
      || contribution.provenance !== 'first_party'
      || contribution.source.kind !== 'bundled'
      || !contribution.managed
    ) {
      return false;
    }
    return sameManagedProviderAuthorizationCurrentnessBasis(
      initial.authorization,
      {
        ticket: {
          connectionId: current.record.connectionId,
          machineId: current.record.machineId,
          connectionSecurityFingerprint:
            current.record.connectionSecurityFingerprint,
          grantFingerprint: current.record.authorization.grantFingerprint,
        },
        deployment: {
          contribution,
          implementation: {
            implementationIdentity:
              current.record.deployment.implementationIdentity,
            facet: current.record.deployment.facet,
            purposeBindings:
              initial.authorization.deployment.implementation.purposeBindings,
          },
        },
      },
    );
  };
  return {
    ok: true,
    attempt: createProviderSpawnAuthorizationAttempt({
      initial: initial.authorization,
      revalidate: resolveCurrent,
      resolveCredential: () => {
        const snapshot = getAccountSettingsSnapshot();
        if (!snapshot) {
          return {
            ok: false,
            error: createProviderErrorV1('provider_authorization_changed', {
              connectionId: initial.authorization.ticket.connectionId,
              machineId: input.machineId,
            }),
          };
        }
        return resolveProviderCredentialPlaintext({
          reference: initial.authorization.credentialReference,
          accountSettings: snapshot.settings,
          settingsSecretsReadKeys: snapshot.settingsSecretsReadKeys,
          connectionId: initial.authorization.ticket.connectionId,
          machineId: input.machineId,
        });
      },
      materialize: ({ authorization, binding, credential }) => materializeLeasedAgentProviderBinding({
        lease: input.lease,
        agentId: input.agentId,
        binding,
        prepared: authorization.prepared,
        credential,
      }),
      materializationBaseDir: input.materializationBaseDir,
      sessionId: input.sessionId,
      isCurrent: isManagedAuthorizationCurrent,
      ...(input.subscribeAccountSettingsSnapshot
        ? { subscribeCurrentness: input.subscribeAccountSettingsSnapshot }
        : {}),
    }),
  };
}
