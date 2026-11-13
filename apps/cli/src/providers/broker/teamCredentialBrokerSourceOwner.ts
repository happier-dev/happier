import type { ProviderBrokerSourceOpenFailureReasonV1, ProviderBrokerSourceApplicationBindingV1, ProviderBrokerRouteGrantPayloadV1 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import type { ProviderBrokerRequestPolicySnapshot } from './providerBrokerRequestHandler';
import { projectProviderConnectionBrokerApplication } from './providerConnectionCpxBridge';
import type { ProviderContributionRegistryView } from '@/providers/registry';
import type { ManagedServiceRequest } from '@happier-dev/plugin-sdk/managed-services';
import { computeTeamCredentialSourceMemberKeyV1 } from '@happier-dev/protocol/teams/credentials/directMaterialV1';
import { TeamCredentialSourceBindingV1Schema } from '@happier-dev/protocol/teams/credentials/sourceBindingV1';
import type { TeamCredentialBrokerPlacementV1, TeamCredentialSourceBindingV1, TeamCredentialSourceMemberV1 } from '@happier-dev/protocol/teams';

import type {
  ManagedProviderEndpointAccessProjection,
} from '@/plugins/runtime/invocation/services/managedServicesAdapter';
import type { ManagedProviderExplicitStartCustody } from '@/providers/connections/publicManagedRuntimeStart';
import { ProviderBrokerApplicationFailureError } from './providerBrokerApplicationFailure';
import { logger } from '@/ui/logger';
import { isConnectedAccountSourceReconnectRequiredError } from '@/daemon/connectedServices/purposeBindings/sourceHealth';
import { preserveBrokerSourceHealthFailure } from './sourceFailure';
import { CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES } from '@happier-dev/protocol/connect/connectedServiceUxDiagnostics';

type ConnectedServicesSource = Extract<
  TeamCredentialSourceBindingV1,
  { kind: 'connected_account' | 'connected_pool' }
>;
type ProviderConnectionSource = Extract<
  TeamCredentialSourceBindingV1,
  { kind: 'provider_connection' }
>;

/** The Home has already selected and signed the exact request target. Exact
 * placement remains a Machine match; Pool placement deliberately does not
 * turn current membership into a second ongoing authorization decision. */
export function teamCredentialBrokerPlacementAcceptsMachine(
  placement: TeamCredentialBrokerPlacementV1 | null,
  machineId: string,
): boolean {
  return machineId.trim().length > 0
    && placement !== null
    && (placement.kind === 'machine_pool' || placement.machineId === machineId);
}

/** Common receiver-side resource eligibility. Team, frozen revision and
 * request-policy checks belong to each admission boundary; a policy-only
 * revision change must not replace an already-open source. */
export function teamCredentialBrokerResourceAcceptsMachine<T extends Readonly<{
  enabled: boolean;
  brokerPlacement: TeamCredentialBrokerPlacementV1 | null;
  source: TeamCredentialSourceBindingV1 | null;
}>>(
  resource: T | null,
  machineId: string,
): resource is T & Readonly<{ source: TeamCredentialSourceBindingV1 }> {
  return resource !== null
    && resource.enabled
    && resource.source !== null
    && teamCredentialBrokerPlacementAcceptsMachine(resource.brokerPlacement, machineId);
}

/** Source adapters compare the exact admitted source representation. Resource
 * test requests separately compare semantic JSON at their signed-input boundary. */
export function sameTeamCredentialBrokerSource(
  left: TeamCredentialSourceBindingV1,
  right: TeamCredentialSourceBindingV1,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * True when the signed request names an executable application whose
 * contribution declares the private source-envelope transport. The contribution
 * owns that identity, so the generic broker hosts compare against its own
 * projection instead of repeating a Provider id.
 */
export function isCpxBrokerApplication(
  registry: ProviderContributionRegistryView,
  application: ProviderBrokerSourceApplicationBindingV1,
): boolean {
  const projected = projectProviderConnectionBrokerApplication({
    registry,
    agentTargetKey: application.agentTargetKey,
    protocol: application.protocol,
    expectedApplication: application,
  });
  return projected !== null
    && projected.implementationIdentity.pluginId === application.implementationIdentity.pluginId
    && projected.implementationIdentity.localId === application.implementationIdentity.localId;
}

/** A Provider Connection source names its one credential slot exactly, so
 * its source member needs no selection. */
export function providerConnectionBrokerSourceMember(
  source: ProviderConnectionSource,
): TeamCredentialSourceMemberV1 {
  return Object.freeze({
    kind: 'provider_credential_slot' as const,
    connectionId: source.connectionId,
    credentialSlotId: source.credentialSlotId,
  });
}

export type TeamCredentialBrokerOperation = Readonly<
  | { kind: 'session'; sessionId: string }
  | { kind: 'execution_run'; executionRunId: string }
  | { kind: 'resource_test'; actorAccountId: string; requestId: string }
  | {
      kind: 'external_api_key';
      externalApiKeyId: string;
      operationId: string;
      assignedAccountId: string;
      assignedTeamMembershipId: string;
    }
>;

type ExactSourceOpenInput<TSource extends TeamCredentialSourceBindingV1> = Readonly<{
  retirementGroup?: import('@/providers/connections/publicManagedRuntimeStart').ManagedProviderExplicitStartCustodyRequest['retirementGroup'];
  source: TSource;
  resourceId: string;
  resourceRevision: number;
  brokerMachineId: string;
  operation: TeamCredentialBrokerOperation;
  application: ProviderBrokerSourceApplicationBindingV1;
  modelId?: string;
  sourceRevision?: string;
  /** Signed job identity, stable across grant renewal and stream reconnects. */
  brokerAdmissionFingerprint?: string;
  /** The member the Home admitted this request against. A Pool open
   * materializes exactly it, so a rotation after admission cannot refuse or
   * re-attribute the admitted request; the next request selects again. */
  admittedSourceMember?: TeamCredentialSourceMemberV1;
  signal: AbortSignal;
}>;

export type TeamCredentialBrokerSourceOpenInput = ExactSourceOpenInput<
  TeamCredentialSourceBindingV1
>;

/** Closed prerequisite codes safe for broker diagnostics and requester refusals.
 * Source identifiers, credentials and raw exception text remain private. */
export type TeamCredentialBrokerSourceOpenFailureReason = ProviderBrokerSourceOpenFailureReasonV1;

export type TeamCredentialBrokerSourceAcquireResult =
  | Readonly<{
      ok: true;
      projection: ManagedProviderEndpointAccessProjection;
      sourceMemberKey: string;
      /** Retires the operation-scoped managed Provider semantic custody.
       * Projection cleanup alone releases only this caller's joined view. */
      retire(): Promise<void>;
    }>
  | Readonly<{
      ok: false;
      sourceOpenFailureReason?: TeamCredentialBrokerSourceOpenFailureReason;
      reasonCode:
        | typeof CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceCredentialReconnectRequired
        | 'source_invalid'
        | 'source_unavailable'
        | 'broker_unavailable'
        | 'broker_machine_mismatch';
    }>;

export type TeamCredentialBrokerSourceOwner = Readonly<{
  readAdmittedRequestPolicy(authority: ProviderBrokerRouteGrantPayloadV1): ProviderBrokerRequestPolicySnapshot | null;
  retainAdmittedRequestPolicy(authority: ProviderBrokerRouteGrantPayloadV1, snapshot: ProviderBrokerRequestPolicySnapshot): void;
  /**
   * The current source member a request would use, read without starting or
   * joining managed custody. The Home attributes and admits the request
   * against it before `acquire` materializes anything (L10/03 request path,
   * L10/11 BROKER-05); `acquire` then materializes this admitted member
   * (`admittedSourceMember`) rather than selecting again.
   */
  selectSourceMember(input: Readonly<{
    source: TeamCredentialSourceBindingV1;
    application: ProviderBrokerSourceApplicationBindingV1;
    signal: AbortSignal;
  }>): Promise<Readonly<{ sourceMemberKey: string; sourceMember: TeamCredentialSourceMemberV1 }> | null>;
  acquire(
    input: TeamCredentialBrokerSourceOpenInput,
  ): Promise<TeamCredentialBrokerSourceAcquireResult>;
  /** Drops host-private admission captures when this broker runtime closes. */
  clearAdmittedRequests(): void;
  /**
   * Retires the operation-scoped managed Provider custody named by an already
   * verified authority, whether or not the caller holds a joined view of it.
   * The explicit close of a Session/Run broker open arrives on its own stream,
   * which has acquired nothing, so the operation — not a projection — is what
   * the request names.
   */
  retireOperation(input: Readonly<{
    operation: TeamCredentialBrokerOperation;
    application: ProviderBrokerSourceApplicationBindingV1;
  }>): Promise<void>;
}>;

export type TeamCredentialBrokerOpenedSource = Readonly<{
  projection: ManagedProviderEndpointAccessProjection;
  sourceMember: TeamCredentialSourceMemberV1;
  retire(): Promise<void>;
  /** Rejoin custody using this successful admission's captured source facts. */
  reopen?(signal: AbortSignal): SourceOpenResult;
}>;

type SourceOpenResult = Promise<TeamCredentialBrokerOpenedSource
  | Readonly<{ unavailable: TeamCredentialBrokerSourceOpenFailureReason }> | null>;

function admittedRequestPolicyKey(authority: ProviderBrokerRouteGrantPayloadV1): string {
  return JSON.stringify(['policy', authority.teamId, authority.resourceId, authority.sourceRevision,
    authority.brokerPlacementFingerprint, authority.initiatorTokenEpoch, authority.initiator, authority.target,
    authority.consumer, authority.executionRunOccurrenceId ?? null, authority.application]);
}

function validOperation(operation: TeamCredentialBrokerOperation): boolean {
  if (operation.kind === 'session') {
    return Object.keys(operation).length === 2
      && typeof operation.sessionId === 'string'
      && operation.sessionId.trim().length > 0;
  }
  if (operation.kind === 'execution_run') {
    return Object.keys(operation).length === 2
      && typeof operation.executionRunId === 'string'
      && operation.executionRunId.trim().length > 0;
  }
  if (operation.kind === 'resource_test') {
    return Object.keys(operation).length === 3
      && operation.actorAccountId.trim().length > 0
      && operation.requestId.trim().length > 0;
  }
  return Object.keys(operation).length === 5
    && operation.operationId.trim().length > 0
    && operation.externalApiKeyId.trim().length > 0
    && operation.assignedAccountId.trim().length > 0
    && operation.assignedTeamMembershipId.trim().length > 0;
}

function readsCurrent(projection: ManagedProviderEndpointAccessProjection): boolean {
  try {
    return projection.isCurrent() === true;
  } catch {
    return false;
  }
}

function logSourceCurrentnessRefusal(
  code: 'projection_not_current' | 'request_cancelled' | 'source_join_retired',
): void {
  try {
    logger.warnLocalFile('[provider-broker-source]', { stage: 'source_currentness', code });
  } catch {
    // A diagnostic sink failure cannot change refusal or custody cleanup.
  }
}

/**
 * Machine-local composition for one Team credential broker source.
 *
 * Connected Accounts and Connected Service Pools deliberately share one
 * adapter: the established Connected Services owner remains responsible for
 * exact-account selection, Pool switching, refresh and materialization. A
 * Provider Connection uses its separate Provider/CPX adapter. This owner only
 * fixes the already-admitted resource, Machine and Session/Run operation for
 * the returned SVC09 projection. Pool member selection is deliberately
 * re-entered by the stream lifetime before each request.
 */
export function createTeamCredentialBrokerSourceOwner(input: Readonly<{
  machineId: string;
  /** The same managed-Provider custody the source opens acquire through. */
  custody: Pick<ManagedProviderExplicitStartCustody, 'retire'>;
  selectConnectedServicesSourceMember(input: Readonly<{
    source: ConnectedServicesSource;
    application: ProviderBrokerSourceApplicationBindingV1;
    signal: AbortSignal;
  }>): Promise<TeamCredentialSourceMemberV1 | null>;
  openConnectedServicesSource(
    input: ExactSourceOpenInput<ConnectedServicesSource>,
  ): SourceOpenResult;
  openProviderConnectionSource(
    input: ExactSourceOpenInput<ProviderConnectionSource>,
  ): SourceOpenResult;
}>): TeamCredentialBrokerSourceOwner {
  // Stream cleanup releases a physical join. These job captures live until
  // explicit operation retirement or broker shutdown, including metadata-only jobs.
  const admittedRequests = new Map<string, Readonly<{
    operation: TeamCredentialBrokerOperation;
    application: ProviderBrokerSourceApplicationBindingV1;
  }> & (
    | Readonly<{ kind: 'source'; reopen: NonNullable<TeamCredentialBrokerOpenedSource['reopen']> }>
    | Readonly<{ kind: 'policy'; snapshot: ProviderBrokerRequestPolicySnapshot }>
  )>();
  const clearAdmittedOperation = (operation: TeamCredentialBrokerOperation, application: ProviderBrokerSourceApplicationBindingV1): void => {
    for (const [key, admitted] of admittedRequests) {
      if (JSON.stringify(admitted.operation) === JSON.stringify(operation)
        && JSON.stringify(admitted.application) === JSON.stringify(application)) admittedRequests.delete(key);
    }
  };
  return Object.freeze({
    clearAdmittedRequests() { admittedRequests.clear(); },
    readAdmittedRequestPolicy(authority) {
      const admitted = admittedRequests.get(admittedRequestPolicyKey(authority));
      return admitted?.kind === 'policy' ? admitted.snapshot : null;
    },
    retainAdmittedRequestPolicy(authority, snapshot) {
      const key = admittedRequestPolicyKey(authority);
      if (!admittedRequests.has(key)) admittedRequests.set(key, {
        kind: 'policy', operation: authority.consumer, application: authority.application, snapshot,
      });
    },
    async selectSourceMember({ source: rawSource, application, signal }) {
      const source = TeamCredentialSourceBindingV1Schema.safeParse(rawSource);
      if (!source.success || signal.aborted) return null;
      const member = source.data.kind === 'provider_connection'
        ? providerConnectionBrokerSourceMember(source.data)
        : await input.selectConnectedServicesSourceMember({
            source: source.data,
            application,
            signal,
          }).catch(preserveBrokerSourceHealthFailure);
      return member ? { sourceMemberKey: computeTeamCredentialSourceMemberKeyV1(member), sourceMember: member } : null;
    },
    async retireOperation({ operation, application }) {
      if (!validOperation(operation)) return;
      clearAdmittedOperation(operation, application);
      await input.custody.retire({
        identity: application.implementationIdentity,
        operationClaim: { kind: 'providerBroker', operation },
      });
    },
    async acquire(rawInput) {
      if (
        rawInput.brokerMachineId !== input.machineId
        || input.machineId.trim().length === 0
      ) {
        return Object.freeze({
          ok: false as const,
          reasonCode: 'broker_machine_mismatch' as const,
        });
      }
      const source = TeamCredentialSourceBindingV1Schema.safeParse(
        rawInput.source,
      );
      if (
        !source.success
        || !validOperation(rawInput.operation)
        || rawInput.resourceId.trim().length === 0
        || !Number.isSafeInteger(rawInput.resourceRevision)
        || rawInput.resourceRevision < 0
        || rawInput.application.endpointTemplateId.trim().length === 0
        || (rawInput.modelId !== undefined && rawInput.modelId.trim().length === 0)
        || (rawInput.sourceRevision !== undefined && rawInput.sourceRevision.trim().length === 0)
      ) {
        return Object.freeze({
          ok: false as const,
          reasonCode: 'source_invalid' as const,
        });
      }
      if (rawInput.signal.aborted) {
        return Object.freeze({
          ok: false as const,
          reasonCode: 'broker_unavailable' as const,
        });
      }

      const exactInput = Object.freeze({
        ...(rawInput.retirementGroup ? { retirementGroup: rawInput.retirementGroup } : {}),
        source: source.data,
        resourceId: rawInput.resourceId,
        resourceRevision: rawInput.resourceRevision,
        brokerMachineId: input.machineId,
        operation: Object.freeze({ ...rawInput.operation }),
        application: Object.freeze({
          ...rawInput.application,
          implementationIdentity: Object.freeze({
            ...rawInput.application.implementationIdentity,
          }),
        }),
        ...(rawInput.modelId !== undefined ? { modelId: rawInput.modelId } : {}),
        ...(rawInput.sourceRevision !== undefined ? { sourceRevision: rawInput.sourceRevision } : {}),
        ...(rawInput.admittedSourceMember ? { admittedSourceMember: rawInput.admittedSourceMember } : {}),
        signal: rawInput.signal,
      });
      const admissionKey = JSON.stringify([
        'source',
        rawInput.brokerAdmissionFingerprint ?? null,
        rawInput.resourceId, rawInput.resourceRevision, input.machineId,
        rawInput.operation, source.data, rawInput.application,
        rawInput.sourceRevision ?? null, rawInput.admittedSourceMember ?? null,
      ]);
      const retainedConsumer = rawInput.operation.kind === 'session' || rawInput.operation.kind === 'execution_run';
      const admittedSource = retainedConsumer ? admittedRequests.get(admissionKey) : undefined;
      let opened: Awaited<SourceOpenResult>;
      try {
        opened = admittedSource?.kind === 'source' ? await admittedSource.reopen(rawInput.signal)
          : source.data.kind === 'provider_connection'
          ? await input.openProviderConnectionSource({
              ...exactInput,
              source: source.data,
            })
          : await input.openConnectedServicesSource({
              ...exactInput,
              source: source.data,
            });
      } catch (error) {
        if (isConnectedAccountSourceReconnectRequiredError(error)) return Object.freeze({ ok: false as const,
          reasonCode: CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceCredentialReconnectRequired });
        preserveBrokerSourceHealthFailure(error);
        logger.warnLocalFile('[provider-broker-source]', { stage: 'source_open', code: 'exception' });
        return Object.freeze({
          ok: false as const,
          reasonCode: 'source_unavailable' as const,
        });
      }
      if (!opened || 'unavailable' in opened) {
        const sourceOpenFailureReason = opened?.unavailable;
        logger.warnLocalFile('[provider-broker-source]', { stage: 'source_open', code: 'projection_unavailable',
          ...(sourceOpenFailureReason ? { reason: sourceOpenFailureReason } : {}) });
        return Object.freeze({
          ok: false as const,
          reasonCode: 'source_unavailable' as const,
          ...(sourceOpenFailureReason ? { sourceOpenFailureReason } : {}),
        });
      }
      const { projection, sourceMember } = opened;
      const refusalCode = rawInput.signal.aborted ? 'request_cancelled'
        : readsCurrent(projection) ? null : 'projection_not_current';
      if (refusalCode) {
        logSourceCurrentnessRefusal(refusalCode);
        // A physical projection that failed before its first dispatch cannot
        // serve this join. Caller cancellation never retires shared custody.
        if (refusalCode === 'projection_not_current') {
          clearAdmittedOperation(rawInput.operation, rawInput.application);
          await opened.retire().catch(() => undefined);
        }
        await Promise.resolve(projection.cleanup()).catch(() => undefined);
        return Object.freeze({
          ok: false as const,
          reasonCode: 'source_unavailable' as const,
          ...(refusalCode === 'projection_not_current' ? { sourceOpenFailureReason: refusalCode } : {}),
        });
      }

      let retired = false;
      let cleaned = false;
      let semanticRetired = false;
      let cleanupInFlight: Promise<void> | null = null;
      let retireInFlight: Promise<void> | null = null;
      // The caller's signal ends the *caller's* joined view, nothing more.
      // One operation is joined by every request stream it opens, so retiring
      // its semantic custody here would let one closed connection tear the
      // gateway down under the others. Retirement is an explicit act:
      // `retire()` below, or `retireOperation` from the operation's owner.
      const onAbort = (): void => {
        void cleanup().catch(() => undefined);
      };
      const retire = (): Promise<void> => {
        retired = true;
        clearAdmittedOperation(rawInput.operation, rawInput.application);
        if (semanticRetired) return Promise.resolve();
        retireInFlight ??= Promise.resolve(opened.retire()).then(
          () => {
            semanticRetired = true;
            retireInFlight = null;
          },
          (error: unknown) => {
            retireInFlight = null;
            throw error;
          },
        );
        return retireInFlight;
      };
      const cleanup = (): Promise<void> => {
        retired = true;
        if (cleaned) return Promise.resolve();
        cleanupInFlight ??= Promise.resolve(projection.cleanup()).then(
          () => {
            cleaned = true;
            cleanupInFlight = null;
            rawInput.signal.removeEventListener('abort', onAbort);
          },
          (error: unknown) => {
            cleanupInFlight = null;
            throw error;
          },
        );
        return cleanupInFlight;
      };
      rawInput.signal.addEventListener('abort', onAbort, { once: true });
      if (rawInput.signal.aborted) {
        await cleanup().catch(() => undefined);
        return Object.freeze({
          ok: false as const,
          reasonCode: 'broker_unavailable' as const,
        });
      }
      if (retainedConsumer && opened.reopen && !admittedSource) admittedRequests.set(admissionKey, {
        kind: 'source', operation: rawInput.operation, application: rawInput.application, reopen: opened.reopen,
      });
      return Object.freeze({
        ok: true as const,
        sourceMemberKey: computeTeamCredentialSourceMemberKeyV1(sourceMember),
        retire,
        projection: Object.freeze({
          ...(projection.requestCostParser ? { requestCostParser: projection.requestCostParser } : {}),
          access: Object.freeze({
            endpointUrl: projection.access.endpointUrl,
            async request(request: ManagedServiceRequest) {
              if (retired || rawInput.signal.aborted) {
                logSourceCurrentnessRefusal(rawInput.signal.aborted ? 'request_cancelled' : 'source_join_retired');
                throw new ProviderBrokerApplicationFailureError({ ok: false, reasonCode: 'source_unavailable' });
              }
              return await projection.access.request(request);
            },
          }),
          isCurrent: () => (
            !retired
            && !rawInput.signal.aborted
            && readsCurrent(projection)
          ),
          cleanup,
        }),
      });
    },
  });
}
