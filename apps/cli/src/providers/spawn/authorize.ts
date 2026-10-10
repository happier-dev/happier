import { PROVIDER_ENDPOINT_SAFETY_LIMITS } from '@happier-dev/protocol/providers/safety/limits';
import { assessProviderEndpoint } from '@happier-dev/protocol/providers/safety/url';
import { createProviderErrorV1, ProviderErrorV1Schema } from '@happier-dev/protocol/providers/errors';
import { ConnectedServiceBindingsV2Schema, readBuiltInLegacyConnectedAccountServiceKeyIngress } from '@happier-dev/protocol/connect/connected-service-bindings';
import { createProviderManagedRuntimeBindingEqualityKeyV1 } from '@happier-dev/protocol/providers/contributions';
import { pluginSourceCustodyV1Equal } from '@happier-dev/protocol/plugins/runtime/sourceCustody';
import type { AgentProviderBindingMaterializationV1, ConnectedServiceBindingsV2, ConnectedServiceId, ProviderErrorV1, PluginExecutionScopeV1, QualifiedConnectedAccountPurposeBindingsV1 } from '@happier-dev/protocol';
import type {
  AgentProviderBindingCredential,
  AgentProviderBindingResolvedFacts,
} from '@happier-dev/plugin-sdk/agents/runtime';

import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import { materializeLeasedAgentProviderBinding, readLeasedAgentProviderBindingAdapter } from '@/plugins/runtime/providerBindings/adapter';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { ProviderRuntimeStateStore } from '../runtimeState';
import { evaluateProviderModelLoadPreflight } from '../modelManagement/load';
import { resolveProviderRuntimeCatalogSelectionObservation } from './runtimeCatalog';
import type { ProviderRuntimeCatalogSelectionObservation, ProviderRuntimeModelProjectionReader } from './runtimeCatalog';

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
  resolveProviderSpawnDefinitiveRejection,
  selectProviderSpawnClaudeHelperModels,
  type ResolveProviderSpawnAuthorizationInput,
} from './resolve';
import { collectProviderConnectionDnsEvidence } from '../registry/dnsEvidence';
import {
  awaitAbortableWithinProviderOperation,
  awaitWithinProviderOperation,
  createProviderOperationLifetime,
  ProviderOperationAbandonedError,
} from '../operationLifetime';
import { resolveProviderConnectionForMachine } from '../registry/resolve';
import { readProviderSettingsForCli } from '../settings/read';
import { prepareProviderConnectionsCatalogForCli } from '../settings/hydrate';
import { resolveProviderCredentialPlaintext } from './credentials';
import { revalidateProviderBindingAuthorizationTicket } from './ticket';
import { createAccountBoundProviderSnapshotReader } from '../lifecycle/currentAccountSettingsSnapshot';
import { activateAgentRuntimeContributionOnDemand } from '@/agent/runtime/registry/activationDemand';
import {
  resolveManagedProviderPurposeBindingSnapshot,
  type ResolveManagedProviderPurposeBindingIntent,
} from '../managed/resolvePurposeBindingSnapshot';
import {
  createRetainedManagedProviderAuthorizationCurrentness,
  isRetainedManagedProviderSettingsGrantCurrent,
  type RetainedManagedProviderAuthorizationCurrentnessCheck,
} from '../sessions/retainedManagedProviderPolicy';
import { projectProviderRuntimeBindingBasis } from './runtimeBindingBasis';
import { admitRuntimeProviderSavedSecret } from './runtimeCredential';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';

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
      'identity'
    >;
    implementation: Pick<
      ManagedProviderSpawnAuthorization['deployment']['implementation'],
      | 'implementationIdentity'
      | 'managedRuntime'
      | 'runtime'
      | 'purposeBindings'
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
    && expected.deployment.contribution.identity.pluginId
      === actual.deployment.contribution.identity.pluginId
    && expected.deployment.contribution.identity.localId
      === actual.deployment.contribution.identity.localId
    && expected.deployment.implementation.implementationIdentity.pluginId
      === actual.deployment.implementation.implementationIdentity.pluginId
    && expected.deployment.implementation.implementationIdentity.localId
      === actual.deployment.implementation.implementationIdentity.localId
    && createProviderManagedRuntimeBindingEqualityKeyV1({
      implementationIdentity:
        expected.deployment.implementation.implementationIdentity,
      managedRuntime: expected.deployment.implementation.managedRuntime,
      purposeBindings: expected.deployment.implementation.purposeBindings,
    })
      === createProviderManagedRuntimeBindingEqualityKeyV1({
        implementationIdentity:
          actual.deployment.implementation.implementationIdentity,
        managedRuntime: actual.deployment.implementation.managedRuntime,
        purposeBindings: actual.deployment.implementation.purposeBindings,
      })
    && expected.deployment.implementation.runtime.runtime
      === actual.deployment.implementation.runtime.runtime
    && expected.deployment.implementation.runtime.activationOccurrenceId
      === actual.deployment.implementation.runtime.activationOccurrenceId
    && pluginSourceCustodyV1Equal(
      expected.deployment.implementation.runtime.sourceCustody,
      actual.deployment.implementation.runtime.sourceCustody,
    )
    && expected.deployment.implementation.runtime.isCurrent() === true
    && actual.deployment.implementation.runtime.isCurrent() === true;
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
  bindings: ConnectedServiceBindingsV2;
  suppressConnectedServiceIds: readonly ConnectedServiceId[];
}>): Readonly<{
  bindings: ConnectedServiceBindingsV2;
  suppressedServiceIds: readonly ConnectedServiceId[];
}> {
  const parsed = ConnectedServiceBindingsV2Schema.parse(input.bindings);
  const suppressionByServiceKey = new Map(
    input.suppressConnectedServiceIds.flatMap((serviceId) => {
      const serviceKey = readBuiltInLegacyConnectedAccountServiceKeyIngress(serviceId);
      return serviceKey ? [[serviceKey, serviceId] as const] : [];
    }),
  );
  const suppressedServiceIds = Object.keys(parsed.bindingsByServiceId)
    .flatMap((serviceKey) => {
      const serviceId = suppressionByServiceKey.get(serviceKey);
      return serviceId ? [serviceId] : [];
    });
  const bindingsByServiceId = Object.fromEntries(
    Object.entries(parsed.bindingsByServiceId)
      .filter(([serviceKey]) => !suppressionByServiceKey.has(serviceKey)),
  );
  return {
    bindings: ConnectedServiceBindingsV2Schema.parse({ v: 2, bindingsByServiceId }),
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
  isRetainedAuthorizationCurrent: (
    input: RetainedManagedProviderAuthorizationCurrentnessCheck,
  ) => boolean;
  revalidateBeforeEffect: () => Promise<Readonly<{ ok: true } | { ok: false; error: ProviderErrorV1 }>>;
  revalidateBeforeCommit: () => Promise<Readonly<{ ok: true } | { ok: false; error: ProviderErrorV1 }>>;
  cleanupOnFailure: () => void;
  takeCleanupOnExit: () => (() => void) | null;
  transferLaunchMaterializationCleanupOwnership: () => void;
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
          downstreamBearer: string | null;
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
  scope?: PluginExecutionScopeV1;
  isCurrent?: () => boolean;
  isRetainedPolicyCurrent?: () => boolean;
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
  let exitComposed: ComposedProviderBindingMaterialization | null = null;
  let redactionLease: ProviderRedactionLease | null = null;
  let cleaned = false;
  let transferred = false;
  let authorizationCurrent = input.isCurrent?.() ?? true;
  let unsubscribeCurrentness: (() => void) | null = input.subscribeCurrentness
    ? input.subscribeCurrentness(() => {
        const current = input.isCurrent?.() ?? true;
        authorizationCurrent = authorizationCurrent && current;
      })
    : null;

  const isAuthorizationCurrent = () => {
    authorizationCurrent = authorizationCurrent && (input.isCurrent?.() ?? true);
    return authorizationCurrent;
  };

  const isRetainedAuthorizationCurrent =
    createRetainedManagedProviderAuthorizationCurrentness({
      isRetainedPolicyCurrent: input.isRetainedPolicyCurrent ?? (() => false),
    });

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
        sessionId: input.scope?.kind === 'session' ? input.scope.sessionId : input.sessionId,
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
    isRetainedAuthorizationCurrent,
    revalidateBeforeEffect: revalidate,
    revalidateBeforeCommit: async () => {
      const current = await revalidate();
      if (!current.ok) cleanup();
      return current;
    },
    cleanupOnFailure: cleanup,
    transferLaunchMaterializationCleanupOwnership: () => {
      (composed ?? exitComposed)?.takeCleanupOwnership();
    },
    takeCleanupOnExit: () => {
      if (cleaned || transferred || (!composed && !redactionLease && !unsubscribeCurrentness)) return null;
      transferred = true;
      const transferredComposed = composed;
      exitComposed = transferredComposed;
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
          exitComposed = null;
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
      const runtimeCredentialTransport =
        authorization.binding.runtimeCredentialTransport;
      if (
        (runtimeCredentialTransport === null && downstreamBearer !== null)
        || (runtimeCredentialTransport !== null && !downstreamBearer)
      ) {
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
        credential: runtimeCredentialTransport === null
          ? { kind: 'none' }
          : {
              kind: 'apiKey',
              transport: runtimeCredentialTransport,
              value: downstreamBearer!,
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
  readModelProjection?: ProviderRuntimeModelProjectionReader;
  materializationBaseDir: string;
  sessionId?: string;
  scope?: PluginExecutionScopeV1;
  resolveAddresses?: (hostname: string) => Promise<readonly string[]>;
  resolveManagedPurposeBindingIntent?: ResolveManagedProviderPurposeBindingIntent;
  managedPurposeBindingSnapshot?: QualifiedConnectedAccountPurposeBindingsV1;
  savedSecretOperationContext?: SavedSecretOperationContextV1;
}>): Promise<Readonly<
  | { ok: true; attempt: ProviderSpawnAuthorizationAttempt }
  | { ok: false; error: ProviderErrorV1 }
>> {
  const admissionLifetime = createProviderOperationLifetime({
    wallTimeMs: PROVIDER_ENDPOINT_SAFETY_LIMITS.maxWallTimeMs,
  });
  // Reject only cold, locally definitive facts before activation can create an
  // executable plugin runtime or any downstream launch state.  A later fresh
  // resolution still owns dynamic prerequisites and can legitimately fail.
  const getAccountSettingsSnapshot = createAccountBoundProviderSnapshotReader(
    input.getAccountSettingsSnapshot,
  );
  let initialSnapshot = getAccountSettingsSnapshot();
  if (!initialSnapshot?.scopeKey) {
    return {
      ok: false,
      error: createProviderErrorV1('provider_connection_not_found', {
        connectionId: input.selection.ref.providerConnectionId ?? undefined,
        machineId: input.machineId,
      }),
    };
  }
  let catalog;
  try {
    catalog = initialSnapshot.providerConnectionsCatalog?.status === 'ready'
      ? initialSnapshot.providerConnectionsCatalog
      : await awaitWithinProviderOperation(prepareProviderConnectionsCatalogForCli({ expectedScopeKey: initialSnapshot.scopeKey,
          operationContext: input.savedSecretOperationContext }), admissionLifetime);
  } catch (error) {
    if (error instanceof ProviderOperationAbandonedError) {
      return { ok: false, error: createProviderErrorV1('provider_endpoint_unavailable', {
        connectionId: input.selection.ref.providerConnectionId ?? undefined, machineId: input.machineId,
      }) };
    }
    throw error;
  }
  initialSnapshot = getAccountSettingsSnapshot();
  if (catalog.status !== 'ready' || !initialSnapshot) return { ok: false, error: createProviderErrorV1('provider_settings_invalid') };
  const definitive = resolveProviderSpawnDefinitiveRejection({
    selection: input.selection.ref,
    agentTargetKey: input.agentTargetKey,
    agentId: input.agentId,
    providerSettings: readProviderSettingsForCli(initialSnapshot).settings,
    registry: input.lease.registry.contributes,
  });
  if (!definitive.ok) return definitive;

  let activationResults;
  try {
    activationResults = await awaitWithinProviderOperation(
      activateAgentRuntimeContributionOnDemand(
        input.lease.registry,
        input.agentId,
      ),
      admissionLifetime,
    );
  } catch (error) {
    if (error instanceof ProviderOperationAbandonedError) {
      return {
        ok: false,
        error: createProviderErrorV1('provider_endpoint_unavailable', {
          connectionId: input.selection.ref.providerConnectionId ?? undefined,
          machineId: input.machineId,
        }),
      };
    }
    throw error;
  }
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
  const registry = {
    providersByContributionKey:
      input.lease.registry.contributes.providersByContributionKey ?? new Map(),
  };
  let managedPurposeBindingSnapshot = input.managedPurposeBindingSnapshot;
  const resolveCurrent = async (
    lifetime = createProviderOperationLifetime({
      wallTimeMs: PROVIDER_ENDPOINT_SAFETY_LIMITS.maxWallTimeMs,
    }),
    admitSavedSecret = false,
  ): Promise<ProviderSpawnAuthorizationResult> => {
    let snapshot = getAccountSettingsSnapshot();
    if (snapshot?.providerConnectionsCatalog?.status !== 'ready') {
      return {
        ok: false,
        error: createProviderErrorV1('provider_connection_not_found', {
          connectionId: input.selection.ref.providerConnectionId ?? undefined,
          machineId: input.machineId,
        }),
      };
    }
    const providerSettings = readProviderSettingsForCli(snapshot).settings;
    const connectionId = input.selection.ref.providerConnectionId;
    if (connectionId === null) {
      return { ok: false, error: createProviderErrorV1('provider_connection_not_found') };
    }
    let dnsEvidenceByEndpointUrl;
    try {
      dnsEvidenceByEndpointUrl = await collectProviderConnectionDnsEvidence({
        connectionId,
        machineId: input.machineId,
        providerSettings,
        registry,
        ...(input.resolveAddresses ? { resolveAddresses: input.resolveAddresses } : {}),
        lifetime,
      });
    } catch (error) {
      if (error instanceof ProviderOperationAbandonedError) {
        return {
          ok: false,
          error: createProviderErrorV1('provider_endpoint_unavailable', {
            connectionId,
            machineId: input.machineId,
          }),
        };
      }
      throw error;
    }
    const connectionResolution = resolveProviderConnectionForMachine({
      connectionId,
      machineId: input.machineId,
      providerSettings,
      registry,
      dnsEvidenceByEndpointUrl,
      ...(input.localCandidateUrlsByConnectionId
        ? {
            localCandidateUrlsByConnectionId:
              input.localCandidateUrlsByConnectionId,
          }
        : {}),
    });
    if (admitSavedSecret && connectionResolution.status === 'resolved') {
      const admitted = await admitRuntimeProviderSavedSecret({
        connection: connectionResolution.record,
        providerSettings,
        snapshot,
        getAccountSettingsSnapshot,
        lifetime,
        ...(input.savedSecretOperationContext ? { operationContext: input.savedSecretOperationContext } : {}),
      });
      if (!admitted.ok) return admitted;
      snapshot = admitted.snapshot;
    }
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
              connectedAccounts:
                connectionResolution.record.deployment.managedRuntime
                  .connectedAccounts,
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
    let managedProviderRuntime:
      ResolveProviderSpawnAuthorizationInput['managedProviderRuntime'];
    if (
      connectionResolution.status === 'resolved'
      && connectionResolution.record.deployment.kind === 'managedLocal'
    ) {
      const acquireManagedProviderRuntime =
        input.lease.registry.acquireManagedProviderRuntime;
      if (!acquireManagedProviderRuntime) {
        return {
          ok: false,
          error: createProviderErrorV1('provider_connection_invalid', {
            connectionId,
            machineId: input.machineId,
          }),
        };
      }
      try {
        managedProviderRuntime =
          await acquireManagedProviderRuntime(
            connectionResolution.record.deployment
              .implementationIdentity,
          ) ?? undefined;
      } catch {
        managedProviderRuntime = undefined;
      }
      if (!managedProviderRuntime?.isCurrent()) {
        return {
          ok: false,
          error: createProviderErrorV1('provider_connection_invalid', {
            connectionId,
            machineId: input.machineId,
          }),
        };
      }
    }
    let additionalModelIds: readonly string[] | undefined;
    if (connectionResolution.status === 'resolved'
      && connectionResolution.record.deployment.kind === 'managedLocal') {
      try {
        additionalModelIds = Object.values(selectProviderSpawnClaudeHelperModels({
          adapter: readLeasedAgentProviderBindingAdapter({ lease: input.lease, agentId: input.agentId })?.adapter,
          configuredModels: connectionResolution.record.connection.claudeHelperModels,
        }) ?? {});
      } catch {
        return { ok: false, error: createProviderErrorV1('provider_incompatible_with_agent', {
          connectionId, machineId: input.machineId,
        }) };
      }
    }
    let runtimeModelObservation: ProviderRuntimeCatalogSelectionObservation | null;
    try {
      runtimeModelObservation = await awaitAbortableWithinProviderOperation(signal => resolveProviderRuntimeCatalogSelectionObservation({
          selection: input.selection,
          machineId: input.machineId,
          accountSettings: snapshot.settings,
          savedSecretResources: snapshot.savedSecretResources,
          providerSettings,
          registry,
          dnsEvidenceByEndpointUrl,
          ...(input.runtimeStateStore ? { runtimeStateStore: input.runtimeStateStore } : {}),
          ...(input.readModelProjection ? { readModelProjection: input.readModelProjection } : {}),
          signal,
          ...(additionalModelIds ? { additionalModelIds } : {}),
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
        }), lifetime);
    } catch (error) {
      const parsed = ProviderErrorV1Schema.safeParse(error);
      return { ok: false, error: parsed.success ? parsed.data : createProviderErrorV1('provider_endpoint_unavailable', {
        connectionId, machineId: input.machineId,
      }) };
    }
    const remotePlacement = connectionResolution.status === 'resolved'
      && connectionResolution.record.deployment.kind === 'managedLocal'
      && connectionResolution.record.connection.gatewayPlacement?.kind === 'machine'
      && connectionResolution.record.connection.gatewayPlacement.machineId !== input.machineId;
    const runtimeModelDescriptor =
      remotePlacement ? runtimeModelObservation?.model ?? null
        : input.runtimeModelDescriptor ?? runtimeModelObservation?.model ?? null;
    const authorization = resolveProviderSpawnAuthorization({
      selection: input.selection,
      machineId: input.machineId,
      agentTargetKey: input.agentTargetKey,
      agentId: input.agentId,
      accountSettings: snapshot.settings,
      savedSecretResources: snapshot.savedSecretResources,
      providerSettings,
      registry,
      dnsEvidenceByEndpointUrl,
      lease: input.lease,
      ...(managedProviderRuntime ? { managedProviderRuntime } : {}),
      ...(managedPurposeBindingSnapshot ? { managedPurposeBindingSnapshot } : {}),
      ...(input.localCandidateUrlsByConnectionId
        ? { localCandidateUrlsByConnectionId: input.localCandidateUrlsByConnectionId }
        : {}),
      ...(runtimeModelDescriptor ? { runtimeModelDescriptor } : {}),
      ...(runtimeModelObservation?.additionalModels
        ? { runtimeAdditionalModelDescriptors: runtimeModelObservation.additionalModels }
        : {}),
      ...(runtimeModelObservation !== null
        ? { runtimeCatalogSnapshotExists: true }
        : {}),
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
  const initial = await resolveCurrent(admissionLifetime, true);
  if (!initial.ok) return initial;
  const retainedManagedRuntimeBindingBasis =
    isManagedProviderSpawnAuthorization(initial.authorization)
      ? projectProviderRuntimeBindingBasis(initial.authorization)
      : null;
  const resolveManagedAuthorizationCurrentnessBasis = ():
    ManagedProviderAuthorizationCurrentnessBasis | null => {
    if (!isManagedProviderSpawnAuthorization(initial.authorization)) return null;
    const snapshot = getAccountSettingsSnapshot();
    if (snapshot?.providerConnectionsCatalog?.status !== 'ready') return null;
    const current = resolveProviderConnectionForMachine({
      connectionId: initial.authorization.ticket.connectionId,
      machineId: input.machineId,
      providerSettings: readProviderSettingsForCli(snapshot).settings,
      registry,
      dnsEvidenceByEndpointUrl: new Map(),
    });
    if (
      current.status !== 'resolved'
      || !current.record.authorization.authorized
      || current.record.deployment.kind !== 'managedLocal'
      || current.record.source.kind !== 'contribution'
    ) {
      return null;
    }
    const contribution = registry.providersByContributionKey.get(
      current.record.source.contributionKey,
    );
    if (
      !contribution
      || contribution.definition.managedRuntime?.kind !== 'managed'
      || contribution.identity.pluginId
        !== current.record.deployment.implementationIdentity.pluginId
      || contribution.identity.localId
        !== current.record.deployment.implementationIdentity.localId
      || !initial.authorization.deployment.implementation
        .runtime.isCurrent()
    ) {
      return null;
    }
    return {
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
          managedRuntime:
            current.record.deployment.managedRuntime,
          runtime:
            initial.authorization.deployment.implementation.runtime,
          purposeBindings:
            initial.authorization.deployment.implementation.purposeBindings,
        },
      },
    };
  };
  const isManagedAuthorizationCurrent = (): boolean => {
    if (!isManagedProviderSpawnAuthorization(initial.authorization)) return true;
    const current = resolveManagedAuthorizationCurrentnessBasis();
    return current !== null
      && sameManagedProviderAuthorizationCurrentnessBasis(
        initial.authorization,
        current,
      );
  };
  const isManagedRetainedAuthorizationCurrent = (): boolean => {
    if (!isManagedProviderSpawnAuthorization(initial.authorization)) {
      return false;
    }
    const snapshot = getAccountSettingsSnapshot();
    if (snapshot?.providerConnectionsCatalog?.status !== 'ready' || !retainedManagedRuntimeBindingBasis) return false;
    const providerSettings = readProviderSettingsForCli(snapshot).settings;
    return isRetainedManagedProviderSettingsGrantCurrent({
      machineId: input.machineId,
      providerSettings,
      runtimeBindingBasis: retainedManagedRuntimeBindingBasis,
    });
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
          savedSecretResources: snapshot.savedSecretResources,
          settingsSecretsReadKeys: snapshot.settingsSecretsReadKeys,
          ...(input.savedSecretOperationContext ? { isCurrent: () => input.savedSecretOperationContext?.readSnapshot() === snapshot } : {}),
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
      ...(input.scope ? { scope: input.scope } : { sessionId: input.sessionId }),
      isCurrent: isManagedAuthorizationCurrent,
      isRetainedPolicyCurrent: isManagedRetainedAuthorizationCurrent,
      ...(input.subscribeAccountSettingsSnapshot
        ? { subscribeCurrentness: input.subscribeAccountSettingsSnapshot }
        : {}),
    }),
  };
}
