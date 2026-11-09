import { randomUUID } from 'node:crypto';
import { assessProviderEndpoint } from '@happier-dev/protocol/providers/safety/url';
import { createProviderErrorV1, ProviderErrorV1Schema } from '@happier-dev/protocol/providers/errors';
import { ConnectedServiceBindingsV2Schema, readBuiltInLegacyConnectedAccountServiceKeyIngress } from '@happier-dev/protocol/connect/connected-service-bindings';
import type { AgentProviderBindingMaterializationV1, ConnectedServiceBindingsV2, ConnectedServiceId, ProviderErrorV1, PluginExecutionScopeV1, QualifiedConnectedAccountPurposeBindingsV1 } from '@happier-dev/protocol';
import type {
  AgentProviderBindingCredential,
  AgentProviderBindingResolvedFacts,
} from '@happier-dev/plugin-sdk/agents/runtime';

import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import { materializeLeasedAgentProviderBinding, readLeasedAgentProviderBindingAdapter } from '@/plugins/runtime/providerBindings/adapter';
import type { ActiveAccountSettingsSnapshot, ActiveAccountSettingsKeys } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
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
  resolveProviderSpawnSelection,
  resolveProviderSpawnDefinitiveRejection,
  selectProviderSpawnClaudeHelperModels,
  type ResolveProviderSpawnAuthorizationInput,
} from './resolve';
import {
  awaitAbortableWithinProviderOperation,
  awaitWithinProviderOperation,
  createProviderOperationLifetime,
  ProviderOperationAbandonedError,
} from '../operationLifetime';
import { resolveProviderConnectionForMachine } from '../registry/resolve';
import { collectProviderConnectionDnsEvidence } from '../registry/dnsEvidence';
import { isRemoteProviderGatewayPlacement } from '../managed/gatewayPlacement';
import { readProviderSettingsForCli } from '../settings/read';
import { prepareProviderConnectionsCatalogForCli, refreshProviderConnectionsCatalogForCli } from '../settings/hydrate';
import { resolveProviderCredentialPlaintext } from './credentials';
import { createAccountBoundProviderSnapshotReader } from '../lifecycle/currentAccountSettingsSnapshot';
import { activateAgentRuntimeContributionOnDemand } from '@/agent/runtime/registry/activationDemand';
import {
  providerManagedPurposeBindingError,
  resolveManagedProviderPurposeBindingSnapshot,
  type ResolveManagedProviderPurposeBindingIntent,
} from '../managed/resolvePurposeBindingSnapshot';
import {
  createRetainedManagedProviderAuthorizationCurrentness,
  isRetainedManagedProviderSettingsGrantCurrent,
  type RetainedManagedProviderAuthorizationCurrentnessCheck,
} from '../sessions/retainedManagedProviderPolicy';
import { projectProviderRuntimeBindingBasis } from './runtimeBindingBasis';
import { admitRuntimeProviderSavedSecret, providerSavedSecretAdmissionError } from './runtimeCredential';
import { createSavedSecretMaterializerFromSnapshotV1, type SavedSecretMaterializerV1 } from '@/settings/secrets/savedSecretCatalog';
import { readProviderSpawnCatalogSnapshot } from './catalogAdmission';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import type { SavedSecretCatalogOperationAdmissionV1 } from '@/settings/secrets/savedSecretCatalogRead';
import { acquireSavedSecretMaterializerForOperation } from '@/settings/secrets/savedSecretCatalogRead';
import { logger } from '@/ui/logger';

type ExternalProviderSpawnAuthorization = Extract<
  ProviderSpawnAuthorization,
  { deployment: { kind: 'external' } }
>;
type ManagedProviderSpawnAuthorization = Extract<
  ProviderSpawnAuthorization,
  { deployment: { kind: 'managedLocal' } }
>;



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
  bindings: ConnectedServiceBindingsV2 | null;
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
    // Only Provider suppression that actually clears selected native intent
    // means explicit none. An originally empty selection keeps its distinct
    // Account-defaulting semantics.
    bindings: suppressedServiceIds.length > 0 && Object.keys(bindingsByServiceId).length === 0
      ? null
      : ConnectedServiceBindingsV2Schema.parse({ v: 2, bindingsByServiceId }),
    suppressedServiceIds: Object.freeze(suppressedServiceIds),
  };
}

function renderCredential(
  value: string,
  transport: Pick<NonNullable<AgentProviderBindingResolvedFacts['runtimeCredentialTransport']>, 'destination'> | null,
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
  revalidateBeforeEffect: (signal?: AbortSignal) => Promise<Readonly<{ ok: true } | { ok: false; error: ProviderErrorV1 }>>;
  revalidateBeforeCommit: (signal?: AbortSignal) => Promise<Readonly<{ ok: true } | { ok: false; error: ProviderErrorV1 }>>;
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
  signal?: AbortSignal;
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

  const revalidate = async (signal?: AbortSignal) => {
    if (input.signal?.aborted || signal?.aborted) throw new ProviderOperationAbandonedError('cancelled');
    if (!isAuthorizationCurrent()) {
      return {
        ok: false as const,
        error: createProviderErrorV1('provider_authorization_changed', {
          connectionId: input.initial.ticket.connectionId,
          machineId: input.initial.ticket.machineId,
        }),
      };
    }
    return { ok: true as const };
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
          ? [...renderCredential(
              params.credential.value,
              params.binding.runtimeCredentialTransport,
            ), ...(params.credential.additionalCredentials ?? []).flatMap(credential => renderCredential(
              credential.value, params.binding.runtimeCredentialTransport?.additionalCredentials?.find(row => row.slotId === credential.slotId) ?? null,
            ))]
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
      if (error instanceof ProviderOperationAbandonedError || error instanceof Error && error.name === 'AbortError') throw error;
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
    revalidateBeforeCommit: async (signal?: AbortSignal) => {
      const current = await revalidate(signal);
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
      } catch (error) {
        if (error instanceof ProviderOperationAbandonedError || error instanceof Error && error.name === 'AbortError') throw error;
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
            ...(resolvedCredential.credential.additionalCredentials ? { additionalCredentials: resolvedCredential.credential.additionalCredentials } : {}),
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
  sessionConfigOptionOverrides?: ResolveProviderSpawnAuthorizationInput['sessionConfigOptionOverrides'];
  machineId: string;
  agentTargetKey: string;
  agentId: string;
  lease: PluginRuntimeRegistryLease;
  getAccountSettingsSnapshot: () => ActiveAccountSettingsSnapshot | null;
  /** Explicit binding recovery admits against the catalog reviewed since the previous launch. */
  reobserveProviderCatalog?: boolean;
  subscribeAccountSettingsSnapshot?: (listener: () => void, keys: ActiveAccountSettingsKeys) => () => void;
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
  signal?: AbortSignal;
}>): Promise<Readonly<
  | { ok: true; attempt: ProviderSpawnAuthorizationAttempt }
  | { ok: false; error: ProviderErrorV1 }
>> {
  // Session/Run admission must not borrow an endpoint probe's wall cap. The
  // containing launch and transport owners retain their own lifetime policy.
  let admissionLifetime = createProviderOperationLifetime({ signal: input.signal });
  const authorizationId = randomUUID();
  const authorizationStartedAt = performance.now();
  const observePhase = async <T>(phase: 'catalog' | 'agent_activation' | 'dns' | 'purpose_bindings' | 'managed_runtime' | 'model_projection', work: () => Promise<T>): Promise<T> => {
    const startedAt = performance.now();
    const record = (status: 'started' | 'completed' | 'failed', reason?: string) => logger.infoFile('[PROVIDER] Spawn authorization phase', {
      authorizationId, connectionId: input.selection.ref.providerConnectionId, machineId: input.machineId,
      phase, status, durationMs: Math.round(performance.now() - startedAt),
      elapsedMs: Math.round(performance.now() - authorizationStartedAt), ...(reason ? { reason } : {}),
    });
    record('started');
    try {
      const result = await work();
      record('completed');
      return result;
    } catch (error) {
      const parsed = ProviderErrorV1Schema.safeParse(error);
      record('failed', error instanceof ProviderOperationAbandonedError ? error.reason
        : parsed.success ? parsed.data.code : 'unclassified');
      throw error;
    }
  };
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
  const initialScopeKey = initialSnapshot.scopeKey;
  const catalog = !input.reobserveProviderCatalog && initialSnapshot.providerConnectionsCatalog?.status === 'ready'
    ? initialSnapshot.providerConnectionsCatalog
    : await observePhase('catalog', () => awaitWithinProviderOperation(
        (input.reobserveProviderCatalog ? refreshProviderConnectionsCatalogForCli : prepareProviderConnectionsCatalogForCli)({
          expectedScopeKey: initialScopeKey, operationContext: input.savedSecretOperationContext, signal: input.signal,
        }), admissionLifetime));
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

  const activationResults = await observePhase('agent_activation', () => awaitWithinProviderOperation(
    activateAgentRuntimeContributionOnDemand(
      input.lease.registry,
      input.agentId,
    ),
    admissionLifetime,
  ));
  const activationFailures = activationResults.filter((result) => (
    result.diagnostics.length > 0
    && !input.lease.registry.activatedPluginIds.has(result.pluginId)
  ));
  if (activationFailures.length > 0) {
    logger.warnLocalFile('[PROVIDER] Agent activation refused', {
      agentId: input.agentId,
      failures: activationFailures.map(result => ({
        pluginId: result.pluginId,
        diagnosticCodes: result.diagnostics.map(diagnostic => diagnostic.code),
      })),
    });
    return {
      ok: false,
      error: createProviderErrorV1('agent_error', {
        connectionId: input.selection.ref.providerConnectionId ?? undefined,
        machineId: input.machineId,
      }),
    };
  }
  const registry = {
    providersByContributionKey:
      input.lease.registry.contributes.providersByContributionKey ?? new Map(),
  };
  const retirementSignal = input.lease.registry.agentRuntimesByAgentId.get(input.agentId)?.retirementSignal;
  if (retirementSignal) {
    admissionLifetime = createProviderOperationLifetime({
      signal: input.signal ? AbortSignal.any([input.signal, retirementSignal]) : retirementSignal,
    });
  }
  let managedPurposeBindingSnapshot = input.managedPurposeBindingSnapshot;
  let admittedSnapshot: ActiveAccountSettingsSnapshot | null = null;
  const resolveCurrent = async (): Promise<ProviderSpawnAuthorizationResult> => {
    const admittedCatalog = await readProviderSpawnCatalogSnapshot({
      readSnapshot: getAccountSettingsSnapshot, expectedScopeKey: initialScopeKey, lifetime: admissionLifetime,
      connectionId: input.selection.ref.providerConnectionId, machineId: input.machineId,
    });
    if (!admittedCatalog.ok) return admittedCatalog;
    let snapshot = admittedCatalog.snapshot;
    let admittedSavedSecretCatalog: SavedSecretCatalogOperationAdmissionV1 | undefined;
    const providerSettings = readProviderSettingsForCli(snapshot).settings;
    const connectionId = input.selection.ref.providerConnectionId;
    if (connectionId === null) {
      return { ok: false, error: createProviderErrorV1('provider_connection_not_found') };
    }
    // The canonical collector skips Account-consented public configuration;
    // Machine consent still needs its named-private endpoint classification.
    const dnsEvidenceByEndpointUrl = await observePhase('dns', () => collectProviderConnectionDnsEvidence({
        connectionId, machineId: input.machineId, providerSettings, registry,
        ...(input.resolveAddresses ? { resolveAddresses: input.resolveAddresses } : {}), lifetime: admissionLifetime,
      }));
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
    if (connectionResolution.status === 'resolved') {
      const admitted = await admitRuntimeProviderSavedSecret({
        connection: connectionResolution.record,
        providerSettings,
        snapshot,
        getAccountSettingsSnapshot,
        lifetime: admissionLifetime,
        ...(input.savedSecretOperationContext ? { operationContext: input.savedSecretOperationContext } : {}),
      });
      if (!admitted.ok) return admitted;
      snapshot = admitted.snapshot;
      admittedSavedSecretCatalog = admitted;
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
        const deployment = connectionResolution.record.deployment;
        const resolveBindingIntent = input.resolveManagedPurposeBindingIntent;
        try {
          managedPurposeBindingSnapshot =
            await observePhase('purpose_bindings', () => awaitAbortableWithinProviderOperation(signal => resolveManagedProviderPurposeBindingSnapshot({
              implementationIdentity:
                deployment.implementationIdentity,
              connectedAccounts:
                deployment.managedRuntime
                  .connectedAccounts,
              purposeBindingIntents:
                deployment.purposeBindingIntents,
              resolveBindingIntent,
              signal,
            }), admissionLifetime));
        } catch (error) {
          return {
            ok: false,
            error: providerManagedPurposeBindingError(error, {
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
      const deployment = connectionResolution.record.deployment;
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
          await observePhase('managed_runtime', () => awaitWithinProviderOperation(acquireManagedProviderRuntime(
            deployment.implementationIdentity,
          ), admissionLifetime)) ?? undefined;
      } catch (error) {
        if (error instanceof ProviderOperationAbandonedError || error instanceof Error && error.name === 'AbortError') throw error;
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
      runtimeModelObservation = await observePhase('model_projection', () => awaitAbortableWithinProviderOperation(signal => resolveProviderRuntimeCatalogSelectionObservation({
          selection: input.selection,
          machineId: input.machineId,
          accountSettings: snapshot.settings,
          savedSecretResources: snapshot.savedSecretResources,
          savedSecretMaterializer: createSavedSecretMaterializerFromSnapshotV1(snapshot, {
            isCurrent: () => !admissionLifetime.signal?.aborted,
          }),
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
        }), admissionLifetime));
    } catch (error) {
      if (error instanceof ProviderOperationAbandonedError || error instanceof Error && error.name === 'AbortError') throw error;
      const parsed = ProviderErrorV1Schema.safeParse(error);
      return { ok: false, error: parsed.success ? parsed.data : createProviderErrorV1('provider_endpoint_unavailable', {
        connectionId, machineId: input.machineId,
      }) };
    }
    const remotePlacement = connectionResolution.status === 'resolved'
      && connectionResolution.record.deployment.kind === 'managedLocal'
      && isRemoteProviderGatewayPlacement(connectionResolution.record.connection.gatewayPlacement, input.machineId);
    const runtimeModelDescriptor =
      remotePlacement ? runtimeModelObservation?.model ?? null
        : input.runtimeModelDescriptor ?? runtimeModelObservation?.model ?? null;
    const authorizationInput: ResolveProviderSpawnAuthorizationInput = {
      selection: input.selection,
      ...(input.sessionConfigOptionOverrides ? { sessionConfigOptionOverrides: input.sessionConfigOptionOverrides } : {}),
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
    };
    const admissionCredential = connectionResolution.status === 'resolved'
      ? connectionResolution.record.source.kind === 'contribution'
        ? connectionResolution.record.source.definition.credential : connectionResolution.record.source.template.credential
      : undefined;
    if (admissionCredential?.transports.some(transport => transport.additionalCredentials?.length)
      && connectionResolution.status === 'resolved' && connectionResolution.record.deployment.kind === 'external') {
      const selection = resolveProviderSpawnSelection(authorizationInput);
      if (!selection.ok) return selection;
      const additionalCredentials = selection.selection.selectedCredentialTransport?.additionalCredentials;
      if (additionalCredentials?.length) {
        const admitted = await admitRuntimeProviderSavedSecret({
          connection: connectionResolution.record, providerSettings, snapshot, getAccountSettingsSnapshot,
          lifetime: admissionLifetime, additionalCredentials,
          ...(admittedSavedSecretCatalog ? { admittedCatalog: admittedSavedSecretCatalog } : {}),
          ...(input.savedSecretOperationContext ? { operationContext: input.savedSecretOperationContext } : {}),
        });
        if (!admitted.ok) return admitted;
        snapshot = admitted.snapshot;
      }
    }
    const authorization = resolveProviderSpawnAuthorization({ ...authorizationInput,
      accountSettings: snapshot.settings, savedSecretResources: snapshot.savedSecretResources,
      savedSecretMaterializer: createSavedSecretMaterializerFromSnapshotV1(snapshot, {
        isCurrent: () => !admissionLifetime.signal?.aborted,
      }) });
    if (!authorization.ok) return authorization;
    admittedSnapshot = snapshot;
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
  const credentialReference = initial.authorization.credentialReference;
  let savedSecretMaterializer: SavedSecretMaterializerV1 | undefined;
  try {
    savedSecretMaterializer = admittedSnapshot && credentialReference.kind === 'apiKey'
      ? await acquireSavedSecretMaterializerForOperation({
      snapshot: admittedSnapshot,
      references: [{ ref: credentialReference.secretId }, ...(credentialReference.additionalCredentials ?? []).map(row => ({ ref: row.secretId }))],
      operationContext: input.savedSecretOperationContext,
      secretSources: input.lease.registry.secretSources,
      signal: admissionLifetime.signal,
      isCurrent: () => getAccountSettingsSnapshot()?.scopeKey === initialScopeKey && !admissionLifetime.signal?.aborted,
      }) : undefined;
  } catch (error) {
    if (error instanceof ProviderOperationAbandonedError || error instanceof Error && error.name === 'AbortError') throw error;
    return { ok: false, error: providerSavedSecretAdmissionError(error, {
      connectionId: initial.authorization.ticket.connectionId, machineId: input.machineId,
    }) };
  }
  const retainedManagedRuntimeBindingBasis =
    isManagedProviderSpawnAuthorization(initial.authorization)
      ? projectProviderRuntimeBindingBasis(initial.authorization)
      : null;
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
  const subscribeAccountSettingsSnapshot = input.subscribeAccountSettingsSnapshot;
  return {
    ok: true,
    attempt: createProviderSpawnAuthorizationAttempt({
      initial: initial.authorization,
      signal: admissionLifetime.signal,
      resolveCredential: () => {
        const snapshot = admittedSnapshot;
        if (!snapshot || getAccountSettingsSnapshot()?.scopeKey !== initialScopeKey) {
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
          savedSecretMaterializer: savedSecretMaterializer ?? null,
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
      isCurrent: () => getAccountSettingsSnapshot()?.scopeKey === initialScopeKey && !admissionLifetime.signal?.aborted,
      isRetainedPolicyCurrent: isManagedRetainedAuthorizationCurrent,
      ...(subscribeAccountSettingsSnapshot
        // This observer reads Account lifetime only. Retained Provider policy
        // is read separately at its point of effect above.
        ? { subscribeCurrentness: (listener: () => void) => subscribeAccountSettingsSnapshot(listener, {}) }
        : {}),
    }),
  };
}
