import { ProviderBrokerApplicationFailureError } from './providerBrokerApplicationFailure';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { SignedProviderBrokerActionRouteGrantV3Schema, type SignedProviderBrokerActionRouteGrantV3, type ProviderBrokerActionAdmissionResponseV3 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { verifyProviderBrokerActionRouteGrantV3 } from '@/daemon/peer/mediation/verifyProviderBrokerRouteGrantV1';
import type {
  ProviderBrokerAdmissionFailureCodeV1,
  ProviderBrokerApplicationBindingV1,
  ProviderBrokerRelayApplicationBindingV1,
  ProviderBrokerRequestAdmissionResponseV1,
  PeerTcpTunnelRelayAuthorizationV2,
  SignedProviderBrokerRouteGrantV1,
  UsageObservationTokens,
} from '@happier-dev/protocol';
import { decodeProviderBrokerAuthorityV1, encodeProviderBrokerAuthorityV1, encodeProviderBrokerAuthorityV2, SignedProviderBrokerRouteGrantV1Schema,
  SignedProviderBrokerModelRouteGrantV1Schema, SignedProviderBrokerWatcherRouteGrantV1Schema,
  SignedProviderBrokerRouteGrantV2Schema, type IrohProviderBrokerHandshake, type SignedProviderBrokerModelRouteGrantV1,
  type SignedProviderBrokerWatcherRouteGrantV1, type SignedProviderBrokerRouteGrantV2,
  type ProviderBrokerSourceApplicationBindingV1 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import { CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES } from '@happier-dev/protocol/connect/connectedServiceUxDiagnostics';
import { preserveBrokerSourceHealthFailure } from './sourceFailure';

import {
  providerBrokerRouteGrantExpectedBindingV1 as expectedBinding,
  verifyProviderBrokerRouteGrantV1,
  verifyProviderBrokerRouteGrantV2,
  providerBrokerRouteGrantExpectedBindingV2,
  type ProviderBrokerRouteGrantVerificationResultV1,
} from '@/daemon/peer/mediation/verifyProviderBrokerRouteGrantV1';
import type { DirectRouteGrantTrustRoot } from '@/daemon/peer/mediation/verifyRouteGrantSignature';
import { startProviderBrokerApplicationServer } from './providerBrokerApplicationServer';
import { runProviderBrokerApplicationPhase } from './providerBrokerApplicationFailureContext';
import {
  createProviderBrokerRequestHandler,
  type ProviderBrokerApplicationStreamLifetime,
  type ProviderBrokerExternalRequestPolicySnapshot,
  type ProviderBrokerModelCatalogAuthorization,
  type ProviderBrokerRequestAdmission,
  type ProviderBrokerRequestHandlerResult,
  type TeamCredentialRequestModelCatalog,
} from './providerBrokerRequestHandler';
import type {
  TeamCredentialExternalProviderAdmissionResponseV1,
  TeamCredentialExternalProviderTerminalUsageResponseV1,
  TeamCredentialExternalProviderTerminalUsageV1,
  TeamCredentialRequestPolicyV1,
  TeamCredentialResourceSummaryV1,
  TeamCredentialResourceReadinessV1,
  TeamCredentialResourceTestAdmissionResponseV1,
} from '@happier-dev/protocol/teams';
import type { RunnerCredentialSelectionBindingV1 } from '@happier-dev/protocol/ephemeralRunner/review';
import type { ManagedServiceRequest, ManagedServiceResponse } from '@happier-dev/plugin-sdk/managed-services';
import type { ManagedProviderEndpointHttpAccess } from '@/plugins/runtime/invocation/services/managedServicesAdapter';
import {
  teamCredentialBrokerResourceAcceptsMachine,
  type TeamCredentialBrokerOperation,
  type TeamCredentialBrokerSourceOwner,
  type TeamCredentialBrokerSourceAcquireResult,
} from './teamCredentialBrokerSourceOwner';

function brokerSourceAcquisitionFailure(failure: Extract<TeamCredentialBrokerSourceAcquireResult, { ok: false }>) {
  return { ok: false as const,
    reasonCode: failure.reasonCode === 'broker_machine_mismatch' ? 'broker_unavailable' as const : failure.reasonCode,
    ...(failure.failureCause ? { failureCause: failure.failureCause } : {}),
    ...(failure.sourceOpenFailureReason ? { sourceOpenFailureReason: failure.sourceOpenFailureReason } : {}) };
}

type SelectedProviderBrokerRequestAdmission = ProviderBrokerRequestAdmission & Readonly<{
  sourceMemberKey: string;
}>;

/** Home refusals that mean the Session/Run operation itself has lost its
 * authority, as opposed to one request being refused (limits, turn state,
 * source rotation, an unreachable Home). */
const PROVIDER_BROKER_OPERATION_AUTHORITY_LOST: ReadonlySet<ProviderBrokerAdmissionFailureCodeV1> = new Set([
  'resource_forbidden',
  'session_not_active',
  'operation_not_current',
  'execution_run_not_found',
  'execution_run_terminal',
]);

/**
 * Map Home's retained-operation authorization result without confusing a
 * temporary inability to observe authority with authority loss. The managed
 * explicit-start owner treats a thrown read as unknown and retains custody;
 * only the explicit operation-loss codes are allowed to retire it.
 */
export function revalidateExternalProviderBrokerAuthorization(
  result: Readonly<{
    ok: true;
  } | {
    ok: false;
    reasonCode: ProviderBrokerAdmissionFailureCodeV1;
  }>,
): boolean {
  if (result.ok) return true;
  if (PROVIDER_BROKER_OPERATION_AUTHORITY_LOST.has(result.reasonCode)) return false;
  throw new Error('external broker authority unavailable');
}

type ProviderBrokerApplicationTargetInput = Readonly<{
  handshake: IrohProviderBrokerHandshake;
  authority: SignedProviderBrokerRouteGrantV1 | SignedProviderBrokerRouteGrantV2 | SignedProviderBrokerActionRouteGrantV3;
  authenticatedRemoteEndpointId: string;
  localEndpointId: string;
  signal: AbortSignal;
}>;

export type ProviderBrokerAccountConnectionAccess = Readonly<{
  access: ManagedProviderEndpointHttpAccess;
  revalidate(signal?: AbortSignal): Promise<boolean>;
  cleanup(): Promise<void>;
  retire(): Promise<void>;
}>;

export { resolveRunnerCredentialSelectionCurrentness } from './runnerCredentialSelectionCurrentness';

export type DaemonProviderBrokerRuntime = Readonly<{
  accountConnectionIngress: boolean;
  actionOperationIngress?: boolean;
  checkRunnerCredentialSelectionCurrentness(
    input: Readonly<{
      selection: RunnerCredentialSelectionBindingV1;
      modelId: string;
    }>,
    signal: AbortSignal,
  ): Promise<TeamCredentialResourceReadinessV1>;
  resolveProviderBrokerApplicationTarget(
    input: ProviderBrokerApplicationTargetInput,
  ): Promise<Readonly<{ port: number; localCapability: string }> | null>;
  resolveExternalProviderBrokerApplicationTarget(input: Readonly<{
    binding: ProviderBrokerRelayApplicationBindingV1;
    relayAuthorization?: PeerTcpTunnelRelayAuthorizationV2;
    signal?: AbortSignal;
  }>): Promise<Readonly<{ port: number; localCapability: string }> | null>;
  close(): Promise<void>;
}>;

async function responseWithCleanup(
  response: ManagedServiceResponse,
  cleanup: () => Promise<void>,
): Promise<ManagedServiceResponse> {
  if (!response.body) {
    await cleanup().catch(() => undefined);
    return response;
  }
  const source = response.body;
  const reader = source.getReader();
  let finalized = false;
  const finalize = async (): Promise<void> => {
    if (finalized) return;
    finalized = true;
    reader.releaseLock();
    await cleanup().catch(() => undefined);
  };
  return {
    ...response,
    body: new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read();
          if (next.done) {
            controller.close();
            await finalize();
            return;
          }
          controller.enqueue(next.value);
        } catch (error) {
          controller.error(error);
          await finalize();
        }
      },
      async cancel(reason) {
        await reader.cancel(reason).catch(() => undefined);
        await finalize();
      },
    }),
  };
}

/** One private application stream owns one *joined view* of the operation's
 * managed Provider projection. The operation itself — the signed Session or
 * Execution Run — outlives every one of its request streams: an Agent keeps
 * several connections alive and opens more between turns. Closing a stream
 * therefore releases only that join; retiring the operation's semantic custody
 * is the separate explicit act below. Home still admits every request, and
 * Connected Pools re-enter their canonical selector before each admission so
 * normal source-owner switching does not strand the stream on a stale member. */
export function createPrivateProviderBrokerStreamLifetime(input: Readonly<{
  sourceOwner: Pick<TeamCredentialBrokerSourceOwner, 'acquire' | 'retireOperation'>;
  application: ProviderBrokerApplicationBindingV1;
  /** The Session or Execution Run the verified authority names. */
  operation: TeamCredentialBrokerOperation;
  brokerAdmissionFingerprint?: string;
  revalidateOperationCurrentness?(input: Readonly<{
    operation: TeamCredentialBrokerOperation;
    application: ProviderBrokerApplicationBindingV1;
  }>, signal?: AbortSignal): Promise<void>;
}>): ProviderBrokerApplicationStreamLifetime {
  const lifetimeController = new AbortController();
  let bindingKey: string | null = null;
  let projectionPromise: Promise<Awaited<ReturnType<TeamCredentialBrokerSourceOwner['acquire']>> | null> | null = null;
  let currentPoolSource: Extract<Awaited<ReturnType<TeamCredentialBrokerSourceOwner['acquire']>>, { ok: true }> | null = null;
  let poolRefreshChain: Promise<void> = Promise.resolve();
  let selectedResult: Readonly<{ access: ManagedProviderEndpointHttpAccess; sourceMemberKey: string }> | null = null;
  let retired = false;
  let released = false;
  let closeInFlight: Promise<void> | null = null;
  let currentnessChecked = false;

  const releaseProjection = async (
    acquired: Extract<Awaited<ReturnType<TeamCredentialBrokerSourceOwner['acquire']>>, { ok: true }> | null,
  ): Promise<void> => {
    if (acquired) await acquired.projection.cleanup();
  };

  const revalidateClosedOperation = async (): Promise<void> => {
    if (currentnessChecked) return;
    currentnessChecked = true;
    // The stream's signal is already aborted. Operation custody has its own
    // lifetime and survives a live consumer closing one of its streams.
    await input.revalidateOperationCurrentness?.({
      operation: input.operation,
      application: input.application,
    }).catch(() => undefined);
  };

  const close = (): Promise<void> => {
    if (released) return Promise.resolve();
    retired = true;
    lifetimeController.abort();
    closeInFlight ??= (async () => {
      try {
        await poolRefreshChain.catch(() => undefined);
        if (currentPoolSource) {
          const acquired = currentPoolSource;
          currentPoolSource = null;
          await releaseProjection(acquired);
          return;
        }
        const acquired = await projectionPromise?.catch(() => null);
        if (acquired?.ok) await releaseProjection(acquired);
      } finally {
        // A prior stream may hold this exact operation even when this stream
        // disconnected before making its first application request.
        await revalidateClosedOperation();
      }
    })().then(
      () => {
        released = true;
        closeInFlight = null;
      },
      (error: unknown) => {
        closeInFlight = null;
        throw error;
      },
    );
    return closeInFlight;
  };

  return Object.freeze({
    async acquireSource({ source, resourceId, brokerMachineId, operation, expectedResourceRevision, application, modelId, sourceRevision, admittedSourceMember }) {
      if (retired) return null;
      // Home checks this admitted job's activity at each request. The model
      // remains a request fact evaluated against its admitted policy; the
      // source projection belongs to this exact operation and application.
      const nextBindingKey = JSON.stringify([
        resourceId,
        brokerMachineId,
        operation,
        source,
        application,
        sourceRevision,
      ]);
      if (bindingKey !== null && bindingKey !== nextBindingKey) {
        await close();
        return null;
      }
      if (source.kind === 'connected_pool') {
        bindingKey ??= nextBindingKey;
        let result: Awaited<ReturnType<ProviderBrokerApplicationStreamLifetime['acquireSource']>> = null;
        const refresh = async (): Promise<void> => {
          if (retired) return;
          let acquired = await input.sourceOwner.acquire({
            source,
            resourceId,
            resourceRevision: expectedResourceRevision,
            brokerMachineId,
            operation,
            application: input.application,
            modelId,
            sourceRevision,
            ...(input.brokerAdmissionFingerprint ? { brokerAdmissionFingerprint: input.brokerAdmissionFingerprint } : {}),
            ...(admittedSourceMember ? { admittedSourceMember } : {}),
            signal: lifetimeController.signal,
          }).catch(preserveBrokerSourceHealthFailure);

          // A changed purpose-binding equality key makes the incumbent
          // managed-service owner retire A and reject that first B join. Drop
          // the old joined view, then re-enter the same source owner once so it
          // can establish the selector's still-current B. No request is
          // admitted with A after this refresh has failed.
          if (acquired && !acquired.ok
            && acquired.sourceOpenFailureReason === 'managed_custody_unavailable'
            && currentPoolSource && !currentPoolSource.projection.isCurrent()) {
            const previous = currentPoolSource;
            currentPoolSource = null;
            await releaseProjection(previous).catch(() => undefined);
            if (retired) return;
            acquired = await input.sourceOwner.acquire({
              source,
              resourceId,
              resourceRevision: expectedResourceRevision,
              brokerMachineId,
              operation,
              application: input.application,
              modelId,
              sourceRevision,
              ...(input.brokerAdmissionFingerprint ? { brokerAdmissionFingerprint: input.brokerAdmissionFingerprint } : {}),
              ...(admittedSourceMember ? { admittedSourceMember } : {}),
              signal: lifetimeController.signal,
            }).catch(preserveBrokerSourceHealthFailure);
          }
          if (retired || !acquired?.ok || !acquired.projection.isCurrent()) {
            // The source owner decides semantic retirement. A stale or closed
            // joined view releases only this stream's projection.
            if (acquired?.ok) {
              await releaseProjection(acquired).catch(() => undefined);
            }
            if (!retired && acquired && !acquired.ok) {
              result = { ...brokerSourceAcquisitionFailure(acquired), reasonCode: acquired.reasonCode === CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceCredentialReconnectRequired
                ? acquired.reasonCode : 'resource_unavailable' };
            }
            return;
          }
          const previous = currentPoolSource;
          currentPoolSource = acquired;
          if (previous) await releaseProjection(previous);
          result = Object.freeze({
            access: acquired.projection.access,
            sourceMemberKey: acquired.sourceMemberKey,
          });
        };
        const queued = poolRefreshChain.then(refresh, refresh);
        poolRefreshChain = queued.then(() => undefined, () => undefined);
        await queued;
        return result;
      }
      if (!projectionPromise) {
        bindingKey = nextBindingKey;
        projectionPromise = input.sourceOwner.acquire({
          source,
          resourceId,
          resourceRevision: expectedResourceRevision,
          brokerMachineId,
          operation,
          application: input.application,
          modelId,
          sourceRevision,
          ...(input.brokerAdmissionFingerprint ? { brokerAdmissionFingerprint: input.brokerAdmissionFingerprint } : {}),
          ...(admittedSourceMember ? { admittedSourceMember } : {}),
          signal: lifetimeController.signal,
        }).catch(preserveBrokerSourceHealthFailure);
      }
      const acquired = await projectionPromise;
      if (retired || !acquired?.ok || !acquired.projection.isCurrent()) {
        const failure = !retired && acquired && !acquired.ok
          ? { ...brokerSourceAcquisitionFailure(acquired), reasonCode: acquired.reasonCode === CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceCredentialReconnectRequired
            ? acquired.reasonCode : 'resource_unavailable' as const }
          : null;
        await close();
        return failure;
      }
      selectedResult ??= Object.freeze({
        access: acquired.projection.access,
        sourceMemberKey: acquired.sourceMemberKey,
      });
      return selectedResult;
    },
    close,
    async retire() {
      // The authorized explicit close. It arrives on its own carrier stream,
      // which has acquired nothing, so the operation named by the verified
      // authority — not a projection this stream happens to hold — is what is
      // retired. Releasing this stream's own join stays part of closing it.
      currentnessChecked = true;
      await close();
      await input.sourceOwner.retireOperation({
        operation: input.operation,
        application: input.application,
      });
    },
  });
}

/**
 * Installs the target daemon's one Provider-broker application handler.
 * The carrier authenticates each stream. The source owner retains the signed
 * job's admitted source and policy; Home checks only job activity per request.
 */
export async function startDaemonProviderBrokerRuntime(input: Readonly<{
  machineId: string;
  /** Captured canonical Home/Account identity; personal ingress stays absent
   * until the private catalog and shared-custody producer are installed. */
  actionOperations?: Readonly<{
    admit(request: Readonly<{ v: 3; authority: SignedProviderBrokerActionRouteGrantV3 }>, signal: AbortSignal): Promise<ProviderBrokerActionAdmissionResponseV3>;
    execute(request: Readonly<{ authority: SignedProviderBrokerActionRouteGrantV3; input: JsonValue; signal: AbortSignal }>): Promise<ActionExecuteResult>;
  }>;
  accountConnection?: Readonly<{
    homeId: string;
    accountId: string;
    open(request: Readonly<{ authority: SignedProviderBrokerRouteGrantV2; signal: AbortSignal }>): Promise<ProviderBrokerAccountConnectionAccess | null>;
    retire(request: Readonly<{ authority: SignedProviderBrokerRouteGrantV2 }>): Promise<void>;
    revalidateCurrentness?(request: Readonly<{ authority: SignedProviderBrokerRouteGrantV2 }>, signal?: AbortSignal): Promise<void>;
  }>;
  watcherReads?(request: Readonly<{
    authority: SignedProviderBrokerWatcherRouteGrantV1;
    requestId: string;
    request: ManagedServiceRequest;
  }>): Promise<ProviderBrokerRequestHandlerResult>;
  resolveTrustRoots: () => readonly DirectRouteGrantTrustRoot[];
  nowMs: () => number;
  verifyAuthority?: (input: Readonly<{
    authority: unknown;
    authenticatedRemoteEndpointId: string;
    expected: ReturnType<typeof expectedBinding>;
    /** Only stream admission asks; application requests never do. */
    enforceExpiry?: boolean;
  }>) => ProviderBrokerRouteGrantVerificationResultV1;
  resolveRequestPolicy(input: Readonly<{
    authority: SignedProviderBrokerModelRouteGrantV1['payload'];
    request: ManagedServiceRequest;
  }>): Promise<Readonly<{
    resourceRevision: number;
    sourceRevision: string;
    application: ProviderBrokerApplicationBindingV1;
    policy: TeamCredentialRequestPolicyV1 | null;
    modelCatalog: TeamCredentialRequestModelCatalog;
    source: import('@happier-dev/protocol/teams').TeamCredentialSourceBindingV1;
  }> | null>;
  admitRequest(input: SelectedProviderBrokerRequestAdmission): Promise<ProviderBrokerRequestAdmissionResponseV1>;
  revalidateOperationCurrentness?(input: Readonly<{
    operation: TeamCredentialBrokerOperation;
    application: ProviderBrokerApplicationBindingV1;
  }>, signal?: AbortSignal): Promise<void>;
  authorizeModelCatalog(input: Readonly<{
    authorization: ProviderBrokerModelCatalogAuthorization;
    expectedResourceRevision: number;
    request: ManagedServiceRequest;
  }>): Promise<Readonly<{ ok: true }> | Readonly<{
    ok: false;
    reasonCode: ProviderBrokerAdmissionFailureCodeV1;
  }>>;
  resolveExternalRequestPolicy?(input: Readonly<{
    binding: Extract<ProviderBrokerRelayApplicationBindingV1, { kind: 'external_api_key' }>;
    request: ManagedServiceRequest;
  }>): Promise<ProviderBrokerExternalRequestPolicySnapshot | null>;
  admitExternalRequest?(input: Readonly<{
    binding: Extract<ProviderBrokerRelayApplicationBindingV1, { kind: 'external_api_key' }>;
    expectedResourceRevision: number;
    application: ProviderBrokerSourceApplicationBindingV1;
    requestFacts: ProviderBrokerRequestAdmission['requestFacts'];
    request: ManagedServiceRequest;
  }>): Promise<TeamCredentialExternalProviderAdmissionResponseV1>;
  retireExternalApiKey?(input: Readonly<{
    externalApiKeyId: string;
    operationId: string;
    application: ProviderBrokerSourceApplicationBindingV1;
  }>): Promise<boolean>;
  retireExternalOperation?(input: Readonly<{
    externalApiKeyId: string;
    operationId: string;
    brokerMachineId: string;
  }>): Promise<void>;
  recordExternalTerminalUsage?(
    request: TeamCredentialExternalProviderTerminalUsageV1,
  ): Promise<TeamCredentialExternalProviderTerminalUsageResponseV1>;
  resolveResourceTestRequestPolicy?(input: Readonly<{
    binding: Extract<ProviderBrokerRelayApplicationBindingV1, { kind: 'resource_test' }>;
    request: ManagedServiceRequest;
  }>): Promise<Readonly<{
    resourceRevision: number;
    policy: TeamCredentialRequestPolicyV1 | null;
    application: ProviderBrokerSourceApplicationBindingV1;
    modelCatalog: TeamCredentialRequestModelCatalog;
  }> | null>;
  admitResourceTestRequest?(input: Readonly<{
    binding: Extract<ProviderBrokerRelayApplicationBindingV1, { kind: 'resource_test' }>;
    relayAuthorization: PeerTcpTunnelRelayAuthorizationV2;
    expectedResourceRevision: number;
    application: ProviderBrokerSourceApplicationBindingV1;
    requestFacts: ProviderBrokerRequestAdmission['requestFacts'];
    request: ManagedServiceRequest;
  }>): Promise<TeamCredentialResourceTestAdmissionResponseV1>;
  sourceOwner: TeamCredentialBrokerSourceOwner;
  checkRunnerCredentialSelectionCurrentness?(input: Readonly<{
    selection: RunnerCredentialSelectionBindingV1;
    modelId: string;
    signal: AbortSignal;
  }>): Promise<TeamCredentialResourceReadinessV1>;
  createRequestId: () => string;
}>): Promise<DaemonProviderBrokerRuntime> {
  const verify = input.verifyAuthority ?? ((request): ProviderBrokerRouteGrantVerificationResultV1 =>
    verifyProviderBrokerRouteGrantV1({
      authority: request.authority,
      trustRoots: input.resolveTrustRoots(),
      nowMs: input.nowMs(),
      enforceExpiry: request.enforceExpiry ?? false,
      expected: request.expected,
      authenticatedRemoteEndpointId: request.authenticatedRemoteEndpointId,
    }));
  const retireExternalApiKey = async (request: Readonly<{
    binding: Extract<ProviderBrokerRelayApplicationBindingV1, { kind: 'external_api_key' }>;
    application: ProviderBrokerSourceApplicationBindingV1;
  }>): Promise<void> => {
    const retire = input.retireExternalApiKey;
    if (!retire || !request.binding.operationId) return;
    await retire({
      externalApiKeyId: request.binding.externalApiKeyId,
      operationId: request.binding.operationId,
      application: request.application,
    }).catch(() => false);
  };

  const handler = createProviderBrokerRequestHandler({
    readAdmittedRequestPolicy: input.sourceOwner.readAdmittedRequestPolicy,
    retainAdmittedRequestPolicy: input.sourceOwner.retainAdmittedRequestPolicy,
    resolveRequestPolicy: input.resolveRequestPolicy,
    authorizeModelCatalog: async (request) => {
      const authorization = await input.authorizeModelCatalog(request);
      if (
        !authorization.ok
        && request.authorization.kind === 'external_api_key'
        && PROVIDER_BROKER_OPERATION_AUTHORITY_LOST.has(authorization.reasonCode)
      ) {
        await retireExternalApiKey({
          binding: request.authorization.binding,
          application: request.authorization.application,
        });
      }
      return authorization;
    },
    ...(input.resolveExternalRequestPolicy ? {
      resolveExternalRequestPolicy: input.resolveExternalRequestPolicy,
    } : {}),
    ...(input.resolveResourceTestRequestPolicy ? {
      resolveResourceTestRequestPolicy: input.resolveResourceTestRequestPolicy,
    } : {}),
    createRequestId: input.createRequestId,
    admit: async (request) => {
      const unavailable = { ok: false as const, reasonCode: 'resource_unavailable' as const };
      const streamLifetime = request.streamLifetime;
      if (!streamLifetime) return unavailable;
      // Home admission precedes every source effect (L10/03 request path,
      // L10/11 BROKER-05): the member it attributes the request to is read
      // without starting or joining managed custody, so a refused request
      // materializes nothing.
      const selectedMember = await runProviderBrokerApplicationPhase('source_select', request.requestId, () =>
        input.sourceOwner.selectSourceMember({
          source: request.selectedSource,
          application: request.authority.payload.application,
          signal: request.request.signal ?? new AbortController().signal,
        })).catch(preserveBrokerSourceHealthFailure);
      if (!selectedMember) return unavailable;
      const { sourceMemberKey, sourceMember } = selectedMember;
      const admitted = await runProviderBrokerApplicationPhase('home_admission', request.requestId, () =>
        input.admitRequest({ ...request, sourceMemberKey }));
      // Home liveness refuses this request at its natural boundary. Physical
      // custody belongs to the operation and may still serve an in-flight body.
      if (!admitted.ok) return admitted;
      if (
        admitted.resourceId !== request.authority.payload.resourceId
        || admitted.brokerMachineId !== input.machineId
        || JSON.stringify(admitted.source) !== JSON.stringify(request.selectedSource)
        || JSON.stringify(admitted.operation) !== JSON.stringify(request.authority.payload.consumer)
      ) return unavailable;
      const selected = await runProviderBrokerApplicationPhase('source_open', request.requestId, () =>
        streamLifetime.acquireSource({
          source: request.selectedSource,
          resourceId: request.authority.payload.resourceId,
          brokerMachineId: request.authority.payload.target.machineId,
          operation: request.authority.payload.consumer,
          expectedResourceRevision: request.expectedResourceRevision,
          application: request.authority.payload.application,
          modelId: request.requestFacts.modelId,
          sourceRevision: request.expectedSourceRevision,
          admittedSourceMember: sourceMember,
        }));
      if (!selected) return unavailable;
      if ('reasonCode' in selected) return selected;
      // Acquisition materializes the admitted member; never forward under a
      // member the Home did not admit.
      if (selected.sourceMemberKey !== sourceMemberKey) {
        return { ok: false as const, reasonCode: 'resource_changed' as const };
      }
      return {
        ok: true as const,
        access: selected.access,
      };
    },
    ...(input.admitExternalRequest ? {
      admitExternal: async (request) => {
        const admitted = await input.admitExternalRequest!(request);
        if (!admitted.ok) {
          if (PROVIDER_BROKER_OPERATION_AUTHORITY_LOST.has(admitted.reasonCode)) {
            await retireExternalApiKey({
              binding: request.binding,
              application: request.application,
            });
          }
          // Every refusal is terminal for this request. Only the authority-loss
          // subset retires retained custody; transient/currentness refusals keep
          // the operation for a later, explicitly revalidated attempt.
          return admitted;
        }
        const admissionUsageEventId = admitted.usageEventId;
        const terminalRequestId = admitted.terminalRequestId;
        const terminalUsage = admissionUsageEventId && terminalRequestId
          && input.recordExternalTerminalUsage
          ? {
              record: async ({ outcome, actualModelId, tokens, reportedCostUsd }: Readonly<{
                outcome: 'succeeded' | 'failed' | 'cancelled';
                actualModelId: string | null;
                tokens: UsageObservationTokens | null;
                reportedCostUsd?: number;
              }>) => {
                const result = await input.recordExternalTerminalUsage!({
                  v: 1,
                  admissionUsageEventId,
                  requestId: terminalRequestId,
                  brokerMachineId: admitted.brokerMachineId,
                  completedAtMs: input.nowMs(),
                  outcome,
                  // The observed token fact is the measurement; there is no
                  // separate claim the Home could believe without it.
                  measurement: tokens ? 'reported' : 'unavailable',
                  actualModelId,
                  tokens,
                  ...(reportedCostUsd !== undefined ? { reportedCostUsd } : {}),
                });
                if (!result.ok) throw new Error(`External terminal usage rejected: ${result.reasonCode}`);
              },
            }
          : undefined;
        const acquired = await input.sourceOwner.acquire({
          source: admitted.source,
          resourceId: admitted.resourceId,
          resourceRevision: request.expectedResourceRevision,
          brokerMachineId: admitted.brokerMachineId,
          operation: admitted.operation,
          ...(input.retireExternalOperation ? {
            retirementGroup: {
              identity: JSON.stringify([admitted.operation.externalApiKeyId, admitted.operation.operationId]),
              onRetired: async () => await input.retireExternalOperation!({
                externalApiKeyId: admitted.operation.externalApiKeyId,
                operationId: admitted.operation.operationId,
                brokerMachineId: admitted.brokerMachineId,
              }),
            },
          } : {}),
          application: request.application,
          signal: request.request.signal ?? new AbortController().signal,
        });
        if (!acquired.ok) {
          await terminalUsage?.record({
            outcome: request.request.signal?.aborted ? 'cancelled' : 'failed',
            // Nothing reached the Provider, so no token fact exists.
            actualModelId: null,
            tokens: null,
          }).catch(() => undefined);
          return brokerSourceAcquisitionFailure(acquired);
        }
        let cleaned = false;
        const cleanup = async () => { if (!cleaned) { cleaned = true; await acquired.projection.cleanup(); } };
        return {
          ok: true as const,
          ...(terminalUsage ? { terminalUsage: { ...terminalUsage,
            ...(acquired.projection.requestCostParser ? { requestCostParser: acquired.projection.requestCostParser } : {}),
          } } : {}),
          access: {
            endpointUrl: acquired.projection.access.endpointUrl,
            async request(providerRequest: ManagedServiceRequest) {
              try {
                const response = await acquired.projection.access.request(providerRequest);
                return await responseWithCleanup(response, cleanup);
              } catch (error) {
                await cleanup().catch(() => undefined);
                throw error;
              }
            },
          },
        };
      },
    } : {}),
    ...(input.admitResourceTestRequest ? {
      admitResourceTest: async (request) => {
        const admitted = await input.admitResourceTestRequest!(request);
        if (!admitted.ok) return admitted;
        const acquired = await input.sourceOwner.acquire({
          source: admitted.source,
          resourceId: admitted.resourceId,
          resourceRevision: admitted.resourceRevision,
          brokerMachineId: admitted.brokerMachineId,
          operation: {
            ...admitted.operation,
            requestId: request.binding.requestId,
          },
          application: request.application,
          signal: request.request.signal ?? new AbortController().signal,
        });
        if (!acquired.ok) return brokerSourceAcquisitionFailure(acquired);
        let cleaned = false;
        // A resource test is genuinely one request: its operation is keyed by
        // that request id and nothing else will ever join it, so the response
        // ending is the operation ending.
        const cleanup = async (): Promise<void> => {
          if (cleaned) return;
          cleaned = true;
          try {
            await acquired.retire();
          } finally {
            await acquired.projection.cleanup();
          }
        };
        return {
          ok: true as const,
          access: {
            endpointUrl: acquired.projection.access.endpointUrl,
            async request(providerRequest: ManagedServiceRequest) {
              try {
                return await responseWithCleanup(
                  await acquired.projection.access.request(providerRequest),
                  cleanup,
                );
              } catch (error) {
                await cleanup().catch(() => undefined);
                throw error;
              }
            },
          },
        };
      },
    } : {}),
  });
  const application = await startProviderBrokerApplicationServer({ handler });

  return Object.freeze({
    accountConnectionIngress: input.accountConnection !== undefined,
    actionOperationIngress: input.actionOperations !== undefined,
    async checkRunnerCredentialSelectionCurrentness(currentness, signal) {
      return await input.checkRunnerCredentialSelectionCurrentness?.({ ...currentness, signal }) ?? { kind: 'update_required' };
    },
    async resolveExternalProviderBrokerApplicationTarget({ binding, relayAuthorization, signal }) {
      if (binding.kind === 'external_api_key') {
        if (!input.resolveExternalRequestPolicy || !input.admitExternalRequest || !input.recordExternalTerminalUsage) return null;
      } else if (!input.resolveResourceTestRequestPolicy || !input.admitResourceTestRequest) {
        return null;
      }
      if (binding.kind === 'resource_test') {
        if (relayAuthorization === undefined) return null;
        return await application.createStreamTarget({ kind: 'external', binding, relayAuthorization }, signal);
      }
      return await application.createStreamTarget({ kind: 'external', binding }, signal);
    },
    async resolveProviderBrokerApplicationTarget(request) {
      request.signal.throwIfAborted();
      if (request.handshake.v === 3) {
        const parsed = SignedProviderBrokerActionRouteGrantV3Schema.safeParse(request.authority);
        const executor = input.actionOperations;
        if (!parsed.success || !executor) return null;
        const authority = parsed.data;
        if (authority.payload.target.machineId !== input.machineId
          || authority.payload.target.endpointId !== request.localEndpointId) return null;
        const verified = verifyProviderBrokerActionRouteGrantV3({ authority, trustRoots: input.resolveTrustRoots(),
          nowMs: input.nowMs(),
          authenticatedRemoteEndpointId: request.authenticatedRemoteEndpointId, enforceExpiry: true });
        if (!verified.valid) return null;
        return await application.createActionStreamTarget({ kind: 'action_operation', authority,
          execute: async ({ input: actionInput, signal }) => {
            const admitted = await executor.admit({ v: 3, authority }, signal);
            if (!admitted.ok) throw new ProviderBrokerApplicationFailureError(admitted);
            signal.throwIfAborted();
            return await executor.execute({ authority, input: actionInput, signal });
          },
        }, request.signal);
      }
      if (request.handshake.v === 2) {
        const parsed = SignedProviderBrokerRouteGrantV2Schema.safeParse(request.authority);
        const owner = input.accountConnection;
        if (!parsed.success || !owner) return null;
        const authority = parsed.data;
        if (encodeProviderBrokerAuthorityV2(authority) !== encodeProviderBrokerAuthorityV2(request.handshake.authority)
          || authority.payload.homeId !== owner.homeId || authority.payload.accountId !== owner.accountId
          || authority.payload.target.machineId !== input.machineId
          || authority.payload.target.endpointId !== request.localEndpointId) return null;
        const verification = verifyProviderBrokerRouteGrantV2({
          authority, trustRoots: input.resolveTrustRoots(), nowMs: input.nowMs(),
          expected: providerBrokerRouteGrantExpectedBindingV2(authority),
          authenticatedRemoteEndpointId: request.authenticatedRemoteEndpointId,
          enforceExpiry: false,
        });
        if (!verification.valid) return null;
        let currentnessCheck: Promise<void> | undefined;
        const revalidateClosedOperation = (): Promise<void> => currentnessCheck ??= (async () => {
          await owner.revalidateCurrentness?.({ authority });
        })().catch(() => undefined);
        if (request.handshake.intent === 'release' || authority.payload.expiresAt <= input.nowMs()) {
          return await application.createStreamTarget({
            kind: 'account_connection', authority, releaseOnly: true,
            authenticatedRemoteEndpointId: request.authenticatedRemoteEndpointId,
            acquireSource: async () => null,
            streamLifetime: {
              close: revalidateClosedOperation,
              retire: async () => {
                currentnessCheck ??= Promise.resolve();
                await owner.retire({ authority });
              },
            },
          }, request.signal);
        }
        // Native's control deadline covers signed carrier admission. Private
        // Home/catalog reads and gateway startup belong to the application
        // request, as for Team sources. No endpoint or inference is exposed
        // until the same canonical source owner has admitted and revalidated it.
        const lifetime = new AbortController();
        let opening: Promise<ProviderBrokerAccountConnectionAccess | null> | undefined;
        let closed = false;
        let closing: Promise<void> | undefined;
        const close = (): Promise<void> => {
          closed = true;
          lifetime.abort();
          closing ??= (async () => {
            try {
              const opened = await opening?.catch(() => null);
              await opened?.cleanup();
            } finally {
              await revalidateClosedOperation();
            }
          })().catch(error => { closing = undefined; throw error; });
          return closing;
        };
        try {
          request.signal.throwIfAborted();
          return await application.createStreamTarget({
            kind: 'account_connection', authority,
            authenticatedRemoteEndpointId: request.authenticatedRemoteEndpointId,
            async acquireSource(signal) {
              signal?.throwIfAborted();
              if (closed) return null;
              // A fresh source open already performs this request's Home
              // admission. Existing access admits only the next request.
              const opened = opening
                ? await opening.then(async current => current && await current.revalidate(signal ?? lifetime.signal) ? current : null)
                : await (opening = owner.open({ authority, signal: lifetime.signal }));
              if (closed || !opened) return null;
              signal?.throwIfAborted();
              return closed ? null : opened.access;
            },
            streamLifetime: {
              close,
              retire: async () => {
                currentnessCheck ??= Promise.resolve();
                await close();
                await owner.retire({ authority });
              },
            },
          }, request.signal);
        } catch (error) {
          await close().catch(() => undefined);
          throw error;
        }
      }
      const parsedAuthority = SignedProviderBrokerRouteGrantV1Schema.safeParse(request.authority);
      if (!parsedAuthority.success) return null;
      if (
        encodeProviderBrokerAuthorityV1(request.handshake.authority)
          !== encodeProviderBrokerAuthorityV1(parsedAuthority.data)
        || parsedAuthority.data.payload.target.machineId !== input.machineId
        || parsedAuthority.data.payload.target.endpointId !== request.localEndpointId
      ) return null;
      if ('scope' in parsedAuthority.data.payload) {
        const watcher = SignedProviderBrokerWatcherRouteGrantV1Schema.safeParse(parsedAuthority.data);
        const read = input.watcherReads;
        if (!watcher.success || !read) return null;
        const authority = watcher.data;
        const expected = expectedBinding(authority);
        const verifyRead = (authority: SignedProviderBrokerWatcherRouteGrantV1) => verify({ authority, expected,
          authenticatedRemoteEndpointId: request.authenticatedRemoteEndpointId, enforceExpiry: true });
        if (!verifyRead(authority).valid) return null;
        return await application.createStreamTarget({
          kind: 'automation_event_watcher',
          authority,
          async read(applicationRequest, authorization) {
            // A renewed bearer can keep using the same authenticated stream.
            // The canonical verifier binds it to the stream's signed watcher.
            const signed = authorization?.startsWith('Bearer ')
              ? decodeProviderBrokerAuthorityV1(authorization.slice('Bearer '.length)) : null;
            if (!signed || !('scope' in signed.payload)) return { ok: false, reasonCode: 'transport_identity_mismatch' };
            const requestAuthority = { payload: signed.payload, signature: signed.signature };
            const verified = verifyRead(requestAuthority);
            if (!verified.valid) return { ok: false,
              reasonCode: verified.reasonCode === 'grant_expired' ? 'grant_expired' : 'transport_identity_mismatch' };
            return await read({ authority: requestAuthority, requestId: input.createRequestId(), request: applicationRequest });
          },
        }, request.signal);
      }
      const modelAuthority = SignedProviderBrokerModelRouteGrantV1Schema.safeParse(parsedAuthority.data);
      if (!modelAuthority.success) return null;
      const expected = expectedBinding(modelAuthority.data);
      const verified: ProviderBrokerRouteGrantVerificationResultV1 = verify({
        authority: request.authority,
        authenticatedRemoteEndpointId: request.authenticatedRemoteEndpointId,
        expected,
      });
      if (!verified.valid) return null;
      const authoritative = SignedProviderBrokerModelRouteGrantV1Schema.safeParse(verified.authority);
      if (!authoritative.success) return null;
      const authority = authoritative.data;
      if (
        authority.payload.application.agentTargetKey
          !== expected.application.agentTargetKey
        || authority.payload.application.implementationIdentity.pluginId
          !== expected.application.implementationIdentity.pluginId
        || authority.payload.application.implementationIdentity.localId
          !== expected.application.implementationIdentity.localId
        || authority.payload.application.endpointTemplateId
          !== expected.application.endpointTemplateId
        || authority.payload.application.protocol
          !== expected.application.protocol
      ) return null;
      // Expiry bounds new work, not the operation (L10/04 §5.6, L10/11 A3):
      // a stream admitted on an expired authority exists only to release
      // the exact claim that authority already names, so a long-lived
      // Session/Run can still retire its custody after the handshake TTL.
      const current = verify({
        authority: request.authority,
        authenticatedRemoteEndpointId: request.authenticatedRemoteEndpointId,
        expected,
        enforceExpiry: true,
      });
      if (!current.valid && current.reasonCode !== 'grant_expired') return null;
      request.signal.throwIfAborted();
      return await application.createStreamTarget({
        authenticatedRemoteEndpointId: request.authenticatedRemoteEndpointId,
        authority,
        expected,
        releaseOnly: !current.valid,
        streamLifetime: createPrivateProviderBrokerStreamLifetime({
          sourceOwner: input.sourceOwner,
          application: authority.payload.application,
          operation: authority.payload.consumer,
          brokerAdmissionFingerprint: authority.payload.brokerPlacementFingerprint,
          ...(input.revalidateOperationCurrentness ? {
            revalidateOperationCurrentness: input.revalidateOperationCurrentness,
          } : {}),
        }),
      }, request.signal);
    },
    async close() {
      try { await application.close(); }
      finally { input.sourceOwner.clearAdmittedRequests(); }
    },
  });
}
