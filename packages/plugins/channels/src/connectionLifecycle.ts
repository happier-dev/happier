import {
  type ConversationJsonObjectV1,
  type ConversationJsonValueV1,
  type ConversationConnectionHistoryGapFactV1,
  type ConversationProviderDiagnosticV1,
  type ConversationProviderFailureReasonV1,
  type ConversationProviderConnectionStopInputV1,
  type ConversationProviderReadinessAttentionCodeV1,
  type ConversationTransportFactReportInputV1,
  type ConversationTransportKindV1,
} from '@happier-dev/channels-protocol/v1';
import {
  arePluginMachineExecutionOriginsEqual,
  getPluginMachineExecutionOriginRef,
  type PluginInvocationCaller,
  type PluginMachineMaterializationRefV1,
} from '@happier-dev/plugin-sdk';
import { PluginMachineExecutionOriginV1JsonSchema } from '@happier-dev/plugin-sdk/collections';
import { PluginWebhookEndpointIdV1JsonSchema } from '@happier-dev/plugin-sdk/webhooks';
import { PluginContributionIdentityV1JsonSchema } from '@happier-dev/plugin-sdk/manifest';
import {
  PluginMachineExecutionOriginV1Schema,
  PluginMachineExecutionRoutingV1JsonSchema,
  PluginMachineExecutionRoutingV1Schema,
  getPluginMachineExecutionRouting,
  type PluginMachineExecutionOriginV1,
  type PluginMachineExecutionRoutingV1,
} from '@happier-dev/plugin-sdk/actions';
import { compilePluginJsonSchema, isValidPluginJsonSchemaValue } from '@happier-dev/plugin-sdk/manifest';
import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';

/** A retained connection follows the current admitted provider at this placement. */
export type ConversationConnectionTransportOriginV1 = Readonly<Pick<PluginMachineExecutionRoutingV1, 'serverIdentityId' | 'machineId'>>;

export const ConversationConnectionTransportOriginV1JsonSchema: PluginJsonSchema = {
  type: 'object',
  properties: {
    serverIdentityId: PluginMachineExecutionRoutingV1JsonSchema.properties!.serverIdentityId!,
    machineId: PluginMachineExecutionRoutingV1JsonSchema.properties!.machineId!,
  },
  required: ['serverIdentityId', 'machineId'],
  additionalProperties: false,
};
const placementValidator = compilePluginJsonSchema(ConversationConnectionTransportOriginV1JsonSchema);
export const ConversationConnectionTransportOriginV1Schema = {
  parse(value: unknown): ConversationConnectionTransportOriginV1 {
    if (!isValidPluginJsonSchemaValue(placementValidator, value)) throw new Error('Invalid Channels transport placement.');
    return value as ConversationConnectionTransportOriginV1;
  },
  safeParse(value: unknown) {
    try { return { success: true as const, data: this.parse(value) }; }
    catch (error) { return { success: false as const, error }; }
  },
};

export function getConversationConnectionTransportOrigin(origin: PluginMachineExecutionOriginV1): ConversationConnectionTransportOriginV1 {
  const { serverIdentityId, machineId } = getPluginMachineExecutionRouting(origin);
  return Object.freeze({ serverIdentityId, machineId });
}

export function getConversationConnectionExecutionRouting(origin: ConversationConnectionTransportOriginV1, providerPluginId: string): PluginMachineExecutionRoutingV1 {
  return PluginMachineExecutionRoutingV1Schema.parse({ ...origin, pluginId: providerPluginId });
}

export function areConversationConnectionTransportOriginsEqual(left: ConversationConnectionTransportOriginV1, right: ConversationConnectionTransportOriginV1): boolean {
  return left.serverIdentityId === right.serverIdentityId && left.machineId === right.machineId;
}

import type { PersistedConversationProviderContributionSelection } from './collections.js';

/**
 * Read only a complete host-stamped origin whose identity agrees with the
 * immediate caller. The candidate uses the stamp's own Home/Machine evidence,
 * never facts copied from a retained connection or mutable Action input.
 */
export function getSelfStampedPluginCallerExecutionOrigin(
  caller: PluginInvocationCaller | undefined,
): PluginMachineExecutionOriginV1 | undefined {
  if (caller?.kind !== 'plugin') return undefined;
  const origin = PluginMachineExecutionOriginV1Schema.safeParse(caller.executionOrigin);
  if (!origin.success) return undefined;
  const ref = getPluginMachineExecutionOriginRef(origin.data);
  const candidate = PluginMachineExecutionOriginV1Schema.safeParse('sourceRef' in origin.data
    ? { serverIdentityId: origin.data.serverIdentityId, sourceRef: {
      machineId: ref.machineId, pluginId: caller.pluginId, sourceCustody: caller.sourceCustody,
    } }
    : { serverIdentityId: origin.data.serverIdentityId, materializationRef: caller.materialization });
  return ref.pluginId === caller.pluginId && candidate.success
    && arePluginMachineExecutionOriginsEqual(origin.data, candidate.data)
    ? origin.data
    : undefined;
}

/**
 * Canonical pure connection-lifecycle transitions shared by online management
 * Actions and Account-local desired-state CAS. The caller owns row revision,
 * provider invocation, confirmation, and final tombstoning; this module owns
 * only the field-sensitive Channel authority state.
 */

export type ConversationConnectionOverlapSafetyV1 =
  | 'safe'
  | 'providerExclusive';

export type ConversationConnectionDeletionStateV1 =
  | 'none'
  | 'pendingStopReconciliation'
  | 'finalizingDelete';

export type ConversationConnectionHistoryGapV1 = ConversationConnectionHistoryGapFactV1 & Readonly<{
  reportedAt: number;
}>;

/**
 * Provider-neutral, remotely repairable readiness attention retained by the
 * canonical connection lifecycle. A null value is the explicit current-ready
 * state; provider-specific recovery remains outside this common projection.
 */
export type ConversationConnectionProviderReadinessV1 = Readonly<{
  code: ConversationProviderReadinessAttentionCodeV1;
  diagnostic?: ConversationProviderDiagnosticV1;
}> | null;

/**
 * The sole durable receive-supervisor disposition. It records only provider
 * facts or the reduced cross-boundary Action error that survives execution;
 * it never turns a thrown error into a retryability decision.
 */
export type ConversationConnectionPollFailureEvidenceV1 =
  | Readonly<{
    kind: 'provider';
    reason: ConversationProviderFailureReasonV1;
    diagnostic?: string;
  }>
  | Readonly<{
    kind: 'action';
    code: string;
    message: string;
  }>;

export type ConversationConnectionPollFailureV1 =
  | Readonly<{
    phase: 'retryDue';
    attemptCount: number;
    retryNotBeforeMs: number;
    evidence: ConversationConnectionPollFailureEvidenceV1;
  }>
  | Readonly<{
    phase: 'blocked';
    attemptCount: number;
    retryNotBeforeMs: null;
    evidence: ConversationConnectionPollFailureEvidenceV1;
  }>;

/**
 * Historical invocation facts retained only to decode predecessor rows.
 * They no longer authorize stop proof or a lifecycle settlement.
 */
export type ConversationCheckpointedPollInvocationBasisV1 = Readonly<{
  connectionRevision: number;
  authorityEpoch: number;
  transportOrigin: ConversationConnectionTransportOriginV1;
}>;

/**
 * Historical endpoint-retarget grammar. Current endpoint convergence reads
 * desired placement directly and creates no retained retarget obligation.
 */
export type ConversationPendingEndpointRetargetV1 = 'notRequired' | 'pending';

/**
 * An inert predecessor payload, retained so actual stored rows remain readable.
 * Current lifecycle admission and cleanup do not depend on this stop envelope.
 */
export type ConversationPendingProviderStopV1 = Readonly<{
  /** The predecessor's original invocation facts, not current authority. */
  predecessorCheckpointedPollInvocation: ConversationCheckpointedPollInvocationBasisV1;
  transportOrigin: ConversationConnectionTransportOriginV1;
  /** The original contributor selection, retained without an invocation path. */
  providerContributionSelection: PersistedConversationProviderContributionSelection;
  stopRequest: Readonly<ConversationProviderConnectionStopInputV1>;
  /**
   * The predecessor transport, not the current connection's receive mode.
   */
  predecessorTransportKind: ConversationTransportKindV1;
  endpointRetarget: ConversationPendingEndpointRetargetV1;
  overlapSafety: ConversationConnectionOverlapSafetyV1 | 'destructive';
  acceptedPossibleLoss: boolean;
}>;

/** Reader for the predecessor's persisted endpoint intent; new writes omit it. */
export type ConversationPendingEndpointRetargetIntentV1 = Readonly<{
  kind: 'endpointRetarget';
  webhookEndpointId: string;
  webhookContributionRef: Readonly<{ pluginId: string; localId: string }>;
  webhookSourceInstanceId: string;
  targetMaterialization: PluginMachineMaterializationRefV1;
  transferAuthorityEpoch: number;
}>;
export type ConversationPendingOldTransportStopV1 = ConversationPendingProviderStopV1 | ConversationPendingEndpointRetargetIntentV1;
export const ConversationPendingEndpointRetargetIntentV1JsonSchema: PluginJsonSchema = {
  type: 'object',
  properties: {
    kind: { const: 'endpointRetarget' },
    webhookEndpointId: PluginWebhookEndpointIdV1JsonSchema,
    webhookContributionRef: PluginContributionIdentityV1JsonSchema,
    webhookSourceInstanceId: { type: 'string', minLength: 1, maxLength: 256 },
    targetMaterialization: PluginMachineExecutionOriginV1JsonSchema.anyOf![0]!.properties!.materializationRef!,
    transferAuthorityEpoch: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
  },
  required: ['kind', 'webhookEndpointId', 'webhookContributionRef', 'webhookSourceInstanceId', 'targetMaterialization', 'transferAuthorityEpoch'],
  additionalProperties: false,
};
const endpointIntentValidator = compilePluginJsonSchema(ConversationPendingEndpointRetargetIntentV1JsonSchema);
export function readConversationPendingEndpointRetargetIntent(value: unknown): ConversationPendingEndpointRetargetIntentV1 {
  if (!isValidPluginJsonSchemaValue(endpointIntentValidator, value)) throw new Error('Invalid Channels endpoint-retarget intent.');
  return freezeJsonValue(value as ConversationJsonValueV1) as ConversationPendingEndpointRetargetIntentV1;
}
export function isConversationPendingEndpointRetarget(pending: unknown): pending is ConversationPendingEndpointRetargetIntentV1 {
  return pending !== null && typeof pending === 'object' && 'kind' in pending && pending.kind === 'endpointRetarget';
}

/**
 * The lifecycle-owned projection of a validated private connection payload.
 * It intentionally excludes provider configuration, credentials, and origin:
 * this transition never decodes or reselects any of those authorities.
 */
export type ConversationConnectionLifecycleStateV1 = Readonly<{
  authorityEpoch: number;
  enabled: boolean;
  deletionState: ConversationConnectionDeletionStateV1;
  /** The precursor value is readable only; no current provider produces it. */
  overlapSafety: ConversationConnectionOverlapSafetyV1 | 'destructive';
  pendingOldTransportStop: ConversationPendingOldTransportStopV1 | null;
  historyGap: ConversationConnectionHistoryGapV1 | null;
  providerReadiness: ConversationConnectionProviderReadinessV1;
  pollFailure: ConversationConnectionPollFailureV1 | null;
}>;

/** The Account-local policy facts mutable by the ordinary connection Action. */
export type ConversationConnectionRequestedStateV1 = Readonly<{
  enabled: boolean;
}>;

export type ConversationConnectionDeleteStartResultV1 =
  | Readonly<{ kind: 'deleteFinalizing'; connection: ConversationConnectionLifecycleStateV1 }>
  | Readonly<{ kind: 'rejoined'; connection: ConversationConnectionLifecycleStateV1 }>
  | Readonly<{ kind: 'rejected'; code: 'authorityEpochExhausted' }>;

export type ConversationConnectionTransferStartResultV1 =
  | Readonly<{ kind: 'transferred'; connection: ConversationConnectionLifecycleStateV1 }>
  | Readonly<{
    kind: 'rejected';
    code:
      | 'deleteInProgress'
      | 'authorityEpochExhausted';
  }>;

export type ConversationConnectionEnabledResultV1 =
  | Readonly<{ kind: 'updated'; connection: ConversationConnectionLifecycleStateV1 }>
  | Readonly<{ kind: 'unchanged'; connection: ConversationConnectionLifecycleStateV1 }>
  | Readonly<{
    kind: 'rejected';
    code: 'deleteInProgress' | 'authorityEpochExhausted';
  }>;

export type ConversationConnectionTransitionResultV1 = ConversationConnectionEnabledResultV1;

export type ConversationConnectionHistoryGapResultV1 =
  | Readonly<{ kind: 'recorded'; connection: ConversationConnectionLifecycleStateV1 }>
  | Readonly<{ kind: 'rejoined'; connection: ConversationConnectionLifecycleStateV1 }>
  | Readonly<{ kind: 'staleAuthority' }>;

export type ConversationConnectionProviderReadinessResultV1 =
  | Readonly<{ kind: 'recorded'; connection: ConversationConnectionLifecycleStateV1 }>
  | Readonly<{ kind: 'rejoined'; connection: ConversationConnectionLifecycleStateV1 }>
  | Readonly<{ kind: 'staleAuthority' }>;

const MAX_SAFE_INTEGER = 9_007_199_254_740_991;

function hasAuthoritySteps(
  authorityEpoch: number,
  steps: number,
): boolean {
  return authorityEpoch <= MAX_SAFE_INTEGER - steps;
}

function freezeJsonValue(value: ConversationJsonValueV1): ConversationJsonValueV1 {
  if (Array.isArray(value)) return Object.freeze(value.map((entry) => freezeJsonValue(entry)));
  if (value === null || typeof value !== 'object') return value;
  const copy: Record<string, ConversationJsonValueV1> = {};
  for (const [key, entry] of Object.entries(value)) copy[key] = freezeJsonValue(entry);
  return Object.freeze(copy) as ConversationJsonObjectV1;
}

export function freezeConversationConnectionTransportOrigin(
  origin: ConversationConnectionTransportOriginV1,
): ConversationConnectionTransportOriginV1 {
  return Object.freeze({ ...ConversationConnectionTransportOriginV1Schema.parse(origin) });
}

function freezeCheckpointedPollInvocationBasis(
  basis: ConversationCheckpointedPollInvocationBasisV1,
): ConversationCheckpointedPollInvocationBasisV1 {
  return Object.freeze({
    connectionRevision: basis.connectionRevision,
    authorityEpoch: basis.authorityEpoch,
    transportOrigin: freezeConversationConnectionTransportOrigin(basis.transportOrigin),
  });
}

function freezeProviderContributionSelection(
  selection: PersistedConversationProviderContributionSelection,
): PersistedConversationProviderContributionSelection {
  return Object.freeze({
    contributionId: selection.contributionId,
  });
}

function freezeStopRequest(
  request: Readonly<ConversationProviderConnectionStopInputV1>,
): Readonly<ConversationProviderConnectionStopInputV1> {
  return Object.freeze({
    v: request.v,
    connectionId: request.connectionId,
    providerConnectionKey: request.providerConnectionKey,
    providerConfigVersion: request.providerConfigVersion,
    providerConfig: freezeJsonValue(request.providerConfig),
    credentialRef: request.credentialRef === null
      ? null
      : Object.freeze({
        service: Object.freeze({
          pluginId: request.credentialRef.service.pluginId,
          localId: request.credentialRef.service.localId,
        }),
        accountId: request.credentialRef.accountId,
      }),
    authorityEpoch: request.authorityEpoch,
    reason: request.reason,
  });
}

type ConversationProviderReadinessFactV1 = Extract<
  ConversationTransportFactReportInputV1['fact'],
  Readonly<{ kind: 'providerReadiness' }>
>;

function providerReadinessFromFact(
  fact: ConversationProviderReadinessFactV1,
): ConversationConnectionProviderReadinessV1 {
  if (fact.status === 'ready') return null;
  return Object.freeze({
    code: fact.code,
    ...(fact.diagnostic === undefined ? {} : { diagnostic: fact.diagnostic }),
  });
}

function areConversationProviderReadinessStatesEqual(
  left: ConversationConnectionProviderReadinessV1,
  right: ConversationConnectionProviderReadinessV1,
): boolean {
  return left === right
    || (left !== null
      && right !== null
      && left.code === right.code
      && left.diagnostic === right.diagnostic);
}

/**
 * Reads an immutable predecessor slot without granting it lifecycle authority.
 * Current delete and transfer writes never construct this historical shape.
 */
export function freezeConversationPendingOldTransportStop(input: Readonly<{
  predecessorCheckpointedPollInvocation: ConversationCheckpointedPollInvocationBasisV1;
  transportOrigin: ConversationConnectionTransportOriginV1;
  providerContributionSelection: PersistedConversationProviderContributionSelection;
  stopRequest: Readonly<ConversationProviderConnectionStopInputV1>;
  predecessorTransportKind: ConversationTransportKindV1;
  endpointRetarget: ConversationPendingEndpointRetargetV1;
  overlapSafety: ConversationConnectionOverlapSafetyV1 | 'destructive';
  acceptedPossibleLoss: boolean;
}>): ConversationPendingProviderStopV1 {
  return Object.freeze({
    predecessorCheckpointedPollInvocation: freezeCheckpointedPollInvocationBasis(
      input.predecessorCheckpointedPollInvocation,
    ),
    transportOrigin: freezeConversationConnectionTransportOrigin(input.transportOrigin),
    providerContributionSelection: freezeProviderContributionSelection(
      input.providerContributionSelection,
    ),
    stopRequest: freezeStopRequest(input.stopRequest),
    predecessorTransportKind: input.predecessorTransportKind,
    endpointRetarget: input.endpointRetarget,
    overlapSafety: input.overlapSafety,
    acceptedPossibleLoss: input.acceptedPossibleLoss,
  });
}

/**
 * The sole field-sensitive desired-state transition for an existing
 * connection. It is shared by online management Actions and Account-local
 * desired-state CAS; callers keep row/currentness and provider authority.
 */
export function transitionConversationConnection(input: Readonly<{
  current: ConversationConnectionLifecycleStateV1;
  requested: ConversationConnectionRequestedStateV1;
}>): ConversationConnectionTransitionResultV1 {
  const { current, requested } = input;
  if (current.deletionState !== 'none') {
    return { kind: 'rejected', code: 'deleteInProgress' };
  }
  const enabledChanged = current.enabled !== requested.enabled;
  if (!enabledChanged) {
    return { kind: 'unchanged', connection: current };
  }
  if (!hasAuthoritySteps(current.authorityEpoch, 1)) {
    return { kind: 'rejected', code: 'authorityEpochExhausted' };
  }

  return {
    kind: 'updated',
    connection: {
      ...current,
      enabled: requested.enabled,
      // A requested policy write drops retired stop metadata; reads and
      // unchanged requests leave the historical stored row untouched.
      pendingOldTransportStop: null,
      pollFailure: null,
      authorityEpoch: current.authorityEpoch + 1,
      historyGap: current.historyGap,
      providerReadiness: null,
    },
  };
}

/**
 * Withdraws connection admission in one generation change. The retained
 * deletion marker is only a recovery anchor for bounded dependent cleanup.
 */
export function startConversationConnectionDelete(input: Readonly<{
  current: ConversationConnectionLifecycleStateV1;
}>): ConversationConnectionDeleteStartResultV1 {
  const { current } = input;
  if (current.deletionState === 'finalizingDelete' && current.pendingOldTransportStop === null) {
    return { kind: 'rejoined', connection: current };
  }
  // A historical pending delete already withdrew this generation. Explicit
  // Delete recovers cleanup without demanding an unreachable worker's proof.
  const alreadyDeleting = current.deletionState !== 'none';
  if (!alreadyDeleting && !hasAuthoritySteps(current.authorityEpoch, 1)) {
    return { kind: 'rejected', code: 'authorityEpochExhausted' };
  }
  return {
    kind: 'deleteFinalizing',
    connection: {
      ...current,
      authorityEpoch: current.authorityEpoch + (alreadyDeleting ? 0 : 1),
      enabled: false,
      deletionState: 'finalizingDelete',
      pendingOldTransportStop: null,
      providerReadiness: null,
      pollFailure: null,
    },
  };
}

/**
 * Replaces a connection's transport authority under the one
 * connection epoch. The caller has already proved immutable provider identity
 * and replacement setup/test facts. Retired workers lose admission at their
 * next observation; transfer does not retain a physical-stop obligation.
 */
export function startConversationConnectionTransfer(input: Readonly<{
  current: ConversationConnectionLifecycleStateV1;
  replacement: Readonly<{
    enabled: boolean;
    overlapSafety: ConversationConnectionOverlapSafetyV1;
    historyGap: ConversationConnectionHistoryGapV1 | null;
  }>;
}>): ConversationConnectionTransferStartResultV1 {
  const { current } = input;
  if (current.deletionState !== 'none') {
    return { kind: 'rejected', code: 'deleteInProgress' };
  }
  if (!hasAuthoritySteps(current.authorityEpoch, 1)) {
    return { kind: 'rejected', code: 'authorityEpochExhausted' };
  }
  const replacementAuthorityEpoch = current.authorityEpoch + 1;
  return {
    kind: 'transferred',
    connection: {
      ...current,
      authorityEpoch: replacementAuthorityEpoch,
      enabled: input.replacement.enabled,
      overlapSafety: input.replacement.overlapSafety,
      pendingOldTransportStop: null,
      // An existing gap may fence checkpoint-first baseline coverage. A
      // transfer changes authority but must not clear that fence mid-stage;
      // the replacement provider's baseline re-enters and replaces its
      // checkpoint under the new revision.
      historyGap: current.historyGap ?? input.replacement.historyGap,
      providerReadiness: null,
      pollFailure: null,
    },
  };
}

/**
 * Persists only the first exact-current history-gap fact. Later reports rejoin
 * that evidence rather than replacing its timestamp or reason.
 */
export function recordConversationConnectionHistoryGap(input: Readonly<{
  current: ConversationConnectionLifecycleStateV1;
  reportedAuthorityEpoch: number;
  reportedAt: number;
  fact: ConversationConnectionHistoryGapFactV1;
}>): ConversationConnectionHistoryGapResultV1 {
  const { current, reportedAuthorityEpoch, reportedAt, fact } = input;
  if (
    current.deletionState !== 'none'
    || !current.enabled
    || reportedAuthorityEpoch !== current.authorityEpoch
  ) {
    return { kind: 'staleAuthority' };
  }
  if (current.historyGap !== null) {
    return { kind: 'rejoined', connection: current };
  }
  return {
    kind: 'recorded',
    connection: {
      ...current,
      // A transport report also carries its envelope discriminator (`kind`).
      // Retain only domain evidence accepted by the closed Account schema.
      historyGap: {
        reportedAt,
        reason: fact.reason,
        ...(fact.reason === 'providerHistoryUnavailable' && fact.diagnostic !== undefined
          ? { diagnostic: fact.diagnostic }
          : {}),
      },
      pollFailure: null,
    },
  };
}

/**
 * Records only current provider readiness through the connection owner. An
 * exact ready report clears prior remotely repairable attention; a changed
 * attention payload supersedes its stale diagnostic without changing
 * connection authority.
 */
export function recordConversationConnectionProviderReadiness(input: Readonly<{
  current: ConversationConnectionLifecycleStateV1;
  reportedAuthorityEpoch: number;
  fact: ConversationProviderReadinessFactV1;
}>): ConversationConnectionProviderReadinessResultV1 {
  const { current, reportedAuthorityEpoch, fact } = input;
  if (
    current.deletionState !== 'none'
    || !current.enabled
    || reportedAuthorityEpoch !== current.authorityEpoch
  ) {
    return { kind: 'staleAuthority' };
  }
  const providerReadiness = providerReadinessFromFact(fact);
  if (areConversationProviderReadinessStatesEqual(current.providerReadiness, providerReadiness)) {
    return { kind: 'rejoined', connection: current };
  }
  return {
    kind: 'recorded',
    connection: {
      ...current,
      providerReadiness,
    },
  };
}
