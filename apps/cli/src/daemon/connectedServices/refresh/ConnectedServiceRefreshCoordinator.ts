import type { AgentPluginAccountSettingsSource } from '@/plugins/runtime/agentPluginSettings';
import { ConnectedServiceIdSchema, readBuiltInLegacyConnectedAccountServiceKeyIngress } from '@happier-dev/protocol/connect/connected-service-bindings';
import { isJsonObject } from '@happier-dev/protocol/json/strictJsonValue';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { ConnectedServiceCredentialHealthV1Schema, ConnectedServiceCredentialRefreshFailureKindV1Schema } from '@happier-dev/protocol/connect/connected-service-schemas';
import { BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID } from '@happier-dev/protocol/connect/generatedBuiltInLegacyConnectedAccountCompatibility';
import { CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES, type ConnectedServiceCredentialReconnectCauseV1 } from '@happier-dev/protocol/connect/connectedServiceUxDiagnostics';
import type { AccountSettings, ConnectedAccountServiceKey, BuiltInLegacyConnectedAccountOperation, ConnectedServiceCredentialHealthV1, ConnectedServiceCredentialRecordV1, ConnectedServiceCredentialRevisionBoundaryV1, ConnectedServiceCredentialRevisionV1, ConnectedServiceExecutionAuthorityV1, ConnectedServiceId, QualifiedConnectedAccountPurposeBindingV1, QualifiedConnectedAccountCredentialSnapshotV4, QualifiedConnectedAccountGroupV4, QualifiedConnectedAccountProfileV4, QualifiedConnectedAccountRef } from '@happier-dev/protocol';
import type { ConnectedAccountHealthResult as PluginConnectedAccountHealthResult } from '@happier-dev/plugin-sdk/connected-accounts';
import { isPluginError } from '@happier-dev/plugin-sdk';
import { randomBytes, randomUUID } from 'node:crypto';
import { waitForAccountEncryptionObservation as waitForSharedOperation } from '@happier-dev/sync-client';
import { isDeepStrictEqual } from 'node:util';

import type { ApiClient } from '@/api/api';
import type { SingleFlightLoopSchedule } from '@/daemon/lifecycle/singleFlightIntervalLoop';
import {
  resolveFirstPartyLegacyConnectedServiceIdForQualifiedServiceKey,
  resolveFirstPartyQualifiedConnectedAccountServiceForLegacyServiceInput,
} from '@/plugins/projection/registry/connectedAccountPurposeCompatibility';
import type {
  QualifiedConnectedAccountPeerClass,
  QualifiedConnectedAccountPeerOperationTransport,
  readQualifiedConnectedAccountCredentialV4,
} from '@/api/client/qualifiedConnectedAccountApi';
import { QualifiedConnectedAccountCompatibilityError, QualifiedConnectedAccountCredentialConflictError } from '@/api/client/qualifiedConnectedAccountApi';
import type { CatalogAgentId } from '@/agent/catalog/ids';
import { readCurrentCatalogHook } from '@/agent/catalog/runtimeEntry';
import type { StoredCredentials } from '@/persistence';
import { logger } from '@/ui/logger';

import {
  resolveConnectedServiceCredentialSource,
  resolveConnectedServiceCredentialResolutions,
} from '@/cloud/connectedServices/resolveConnectedServiceCredentials';
import {
  resolveConnectedServiceAccountMode,
  type ConnectedServiceAccountMode,
} from '@/cloud/connectedServices/resolveConnectedServiceAccountMode';
import {
  ConnectedServiceMaterializationBlockedError,
  materializeConnectedServicesForSpawn,
} from '../materialize/materializeConnectedServicesForSpawn';
import { resolveConnectedServiceMaterializedRootDir } from '../materialize/resolveConnectedServiceMaterializedRootDir';
import { observeCurrentConnectedServiceMaterializationPhase } from '../materialize/materializationPhase';
import { resolveForcedRefreshFreshnessDecision } from './credentialFreshness/adoptFreshFirst';
import {
  computeConnectedServiceAccessTokenFingerprint,
  normalizeConnectedServiceAccessTokenFingerprint,
} from './credentialFreshness/tokenFingerprint';
import {
  canReprobeCredentialHealth,
  shouldReadCredentialHealthForRefresh,
  type ConnectedServiceCredentialRefreshReason,
  type CredentialHealthReprobeState,
} from './credentialHealthReprobe';
import type { ConnectedServiceChildSelection } from '../connectedServiceChildEnvironment';
import type {
  ConnectedServiceMaterializationCredentialRefreshFailureCategory,
  ConnectedServiceResolvedSelection,
  ConnectedServicesMaterializationDiagnostic,
} from '../materialization/materializer';
import {
  ConnectedServiceRuntimeRegistry,
  type ConnectedServiceRuntimeRefreshTarget,
  type ConnectedServiceRuntimeTarget,
} from '../runtimeRegistry/registry';
import {
  getConnectedServiceMaterializedHomeFreshness,
  resolveConnectedServiceMaterializedHomeRoot,
} from '../catalogHooks';
import {
  resolveQualifiedRequestAuthPurposeBindingsFromSnapshot,
  type AgentSpawnQualifiedPurposeBindingSnapshot,
} from '../requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import {
  assertQualifiedPurposeAuthorityForSelections,
  ConnectedServiceQualifiedPurposeAuthorityError,
} from '../requestAuth/qualifiedPurposeAuthority';
import { parseConnectedServiceBindingSelections } from '../parseConnectedServicesBindings';
import type { ConnectedServiceProjectedCredentialPresence } from '../accountGroups/generation/connectedServiceProjectionSnapshot';
import type {
  QualifiedConnectedAccountEstablishedRuntimeOwner,
  QualifiedConnectedAccountScheduledReceipt,
} from '../qualifiedConnectedAccountEstablishedRuntimeOwner';
import type { ConnectedAccountPurposeBindingOwner } from '../purposeBindings/ConnectedAccountPurposeBindingOwner';
import { readQualifiedConnectedAccountCredentialMaterial } from '../qualifiedConnectedAccountEstablishedRuntimeOwner';
import type {
  QualifiedConnectedAccountV4Support,
} from '../qualifiedConnectedAccountV4Support';
import {
  refreshQualifiedConnectedAccount,
  QualifiedConnectedAccountRefreshLeaseError,
  QualifiedConnectedAccountRefreshSettlementError,
  type QualifiedConnectedAccountRefreshSettlement,
} from './refreshQualifiedConnectedAccount';
import { sanitizeConnectedServiceDiagnosticError } from '../runtimeAuth/sanitizeConnectedServiceDiagnosticString';
import type { ConnectedServiceDaemonAuthBridgeRefreshResult } from '../daemonAuthBridgeTypes';
import { runtimeTargetOwnsConnectedServiceRuntimeAuthRefreshSelection } from '../runtimeAuthRefreshAuthorization';
import {
  boundConnectedServiceMaterializationDiagnosticValue,
} from '../diagnostics/buildConnectedServiceDiagnosticSpawnErrorResult';

import { bindingKey, qualifiedAccountKey, runConnectedServiceRefreshTick, type BoundProfile } from './tick';
import { notifyQualifiedHealthSettled, recordCredentialHealthWrite, settleQualifiedHealth, type QualifiedHealthSettlementInput } from './qualifiedHealthSettlement';
import type { ConnectedAccountReauthEvent } from '../accountGroups/switching/reauthPools';
import { classifyConnectedServiceMaterializationDiagnosticForCredentialRefresh, isReauthRequiredFailure,
  persistConnectedServiceCredentialHealthForMaterializationFailure } from './failureHealth';
export { classifyConnectedServiceMaterializationDiagnosticForCredentialRefresh,
  persistConnectedServiceCredentialHealthForMaterializationFailure } from './failureHealth';
export type { ConnectedServiceMaterializationCredentialRefreshClassification } from './failureHealth';
type ScheduledStatusInvocation = () => Promise<QualifiedConnectedAccountScheduledReceipt<'status'>>;
export type ScheduledQualifiedAccountHealth = Readonly<{
  due: boolean;
  nextDeadline(): number | null;
  settle(outcome: PromiseSettledResult<QualifiedConnectedAccountScheduledReceipt<'status'>>, signal?: AbortSignal): Promise<void>;
}>;

export type QualifiedConnectedAccountRefreshRuntime = Readonly<{
  resolvePeerClass(): QualifiedConnectedAccountPeerClass;
  resolveOperationTransport?(input: Readonly<{
    service: QualifiedConnectedAccountRef['service'];
    operation: BuiltInLegacyConnectedAccountOperation;
  }>): QualifiedConnectedAccountPeerOperationTransport;
  establishedRuntimeOwner: Pick<
    QualifiedConnectedAccountEstablishedRuntimeOwner,
    'invokeWithReceipt'
  >;
  mutateCredentialHealth(input: Readonly<{
    token: string;
    patch: unknown;
    signal?: AbortSignal;
  }>): Promise<Readonly<{
    credentialRevision: string;
    configurationRevision: string | null;
  }>>;
  readCredential: typeof readQualifiedConnectedAccountCredentialV4;
  readGroup?(input: Readonly<{
    service: QualifiedConnectedAccountRef['service'];
    groupId: string;
    signal?: AbortSignal;
  }>): Promise<QualifiedConnectedAccountGroupV4 | null>;
  acquireRefreshLease(input: Readonly<{
    token: string;
    lease: unknown;
    signal?: AbortSignal;
  }>): Promise<Readonly<{
    acquired: boolean;
    leaseUntil: number;
    ownerId: string;
    credentialRevision: string;
  }>>;
  mutateCredential(input: Readonly<{
    token: string;
    mutation: unknown;
    signal?: AbortSignal;
  }>): Promise<Readonly<{
    success: true;
    credentialRevision: string;
    configurationRevision: string | null;
  }>>;
  listScheduledAccounts?(service?: QualifiedConnectedAccountRef['service'], signal?: AbortSignal): Promise<
    readonly QualifiedConnectedAccountProfileV4[]
  >;
  onCredentialUpdated?(
    account: QualifiedConnectedAccountRef,
    options?: Readonly<{ reason?: 'provider_context'; signal?: AbortSignal }>,
  ): void | Promise<void>;
  onReauthRequired?(event: ConnectedAccountReauthEvent): Promise<void>;
  onCredentialHealthChanged?(event: import('./qualifiedHealthSettlement').ConnectedServiceCredentialHealthTransition): void;
}>;

function peerClassV4Support(
  peerClass: QualifiedConnectedAccountPeerClass,
): QualifiedConnectedAccountV4Support {
  if (peerClass === 'advertised_v4') return 'advertised';
  if (peerClass === 'indeterminate') return 'indeterminate';
  return 'absent';
}

export type QualifiedConnectedAccountConfigurationConsequence = Readonly<{
  account: QualifiedConnectedAccountRef;
  authenticationModeId: string;
  configurationScope: 'service' | 'account';
  behavior: 'refresh' | 'reconnect';
  runtimeConfigurationRevision: string;
}>;

type QualifiedConnectedAccountStatusProbeOutcome =
  | Readonly<{ status: 'not_configured' | 'not_eligible' }>
  | Readonly<{ status: 'deferred' | 'unavailable' }>
  | Readonly<{ status: 'settled'; reconnectRequired: boolean; settleDeferredHealth?: () => Promise<void> }>;

type RuntimeAuthRefreshSelection<TServiceId extends ConnectedServiceId> = Readonly<
  | { kind: 'profile'; serviceId: TServiceId; profileId: string }
  | {
      kind: 'group';
      serviceId: TServiceId;
      groupId: string;
      activeProfileId: string;
      fallbackProfileId: string;
      generation: number;
    }
>;

type CodexChatGptAuthTokensRefreshSelection = RuntimeAuthRefreshSelection<'openai-codex'>;
type CodexChatGptAuthTokensRefreshResponse = Readonly<{
  accessToken: string;
  chatgptAccountId: string | null;
  chatgptPlanType: string | null;
  credentialRevision: ConnectedServiceCredentialRevisionV1;
}>;
type ClaudeSubscriptionAuthTokensRefreshSelection = RuntimeAuthRefreshSelection<'claude-subscription'>;
type ClaudeSubscriptionAuthTokensRefreshResponse = Readonly<{
  accessToken: string;
  anthropicAccountId: string | null;
  expiresAt: number | null;
}>;
type ConnectedServiceCredentialSourceBase = Readonly<{
  storageMode: 'plain' | 'sealed';
  record: ConnectedServiceCredentialRecordV1;
  expiresAt: number | null;
}>;
type ConnectedServiceCredentialSource =
  ConnectedServiceCredentialSourceBase & ConnectedServiceCredentialRevisionBoundaryV1;
type RevisionedConnectedServiceCredentialSource =
  ConnectedServiceCredentialSourceBase & Extract<
    ConnectedServiceCredentialRevisionBoundaryV1,
    { revisionSemantics: 'revisioned' }
  >;

export type ConnectedServiceRefreshFailureCategory =
  ConnectedServiceMaterializationCredentialRefreshFailureCategory;

export type ConnectedServiceCredentialRefreshStatus =
  | 'refreshed'
  | 'not_needed'
  | 'not_oauth'
  | 'lease_not_acquired'
  | 'credential_missing'
  | 'blocked_by_credential_health'
  | 'refresh_failed';

export type ConnectedServiceCredentialRefreshDiagnostic = Readonly<{
  serviceId: ConnectedServiceId;
  profileId: string;
  reason: ConnectedServiceCredentialRefreshReason;
  status: ConnectedServiceCredentialRefreshStatus;
  category?: ConnectedServiceRefreshFailureCategory;
  providerStatus?: number | null;
  providerErrorCode?: string | null;
  expiresAt: number | null;
  expiryAgeMs: number | null;
  refreshWindowMs: number;
}>;

export type ConnectedServiceCredentialRefreshResult = Readonly<{
  status: ConnectedServiceCredentialRefreshStatus;
  credential: ConnectedServiceCredentialRecordV1 | null;
  diagnostic: ConnectedServiceCredentialRefreshDiagnostic;
  credentialRevision?: ConnectedServiceCredentialRevisionV1;
}>;

export type QualifiedConnectedAccountSpawnPreflightResult = Readonly<{
  status: 'ready';
  profile: Extract<QualifiedConnectedAccountProfileV4, { revisionSemantics: 'revisioned' }>;
  reason?: never;
}> | Readonly<{
  status: 'reconnect_required' | 'refresh_failed';
  reason?: QualifiedConnectedAccountRefreshLeaseError['code'] | 'project_requester_home_unavailable'
    | QualifiedConnectedAccountCredentialConflictError['diagnosticCode'];
  reconnectCause?: ConnectedServiceCredentialReconnectCauseV1;
}>;

export type ConnectedServiceAuthGroupCandidatePreparationResult =
  | Readonly<{ status: 'ready' }>
  | Readonly<{
      status: 'ineligible';
      memberState: Readonly<{
        credentialHealthStatus: 'needs_reauth' | 'refresh_failed_retryable';
      }>;
    }>;

export function resolveConnectedServiceAuthGroupCandidatePreparation(input: Readonly<{
  reason: string;
  refreshResult: ConnectedServiceCredentialRefreshResult;
}>): ConnectedServiceAuthGroupCandidatePreparationResult {
  switch (input.refreshResult.status) {
    case 'refreshed':
    case 'not_needed':
    case 'not_oauth':
      return { status: 'ready' };
    case 'blocked_by_credential_health':
    case 'credential_missing':
      return {
        status: 'ineligible',
        memberState: { credentialHealthStatus: 'needs_reauth' },
      };
    case 'refresh_failed':
      return {
        status: 'ineligible',
        memberState: {
          credentialHealthStatus: isReauthRequiredFailure(
            input.refreshResult.diagnostic.category ?? 'unknown',
          )
            ? 'needs_reauth'
            : 'refresh_failed_retryable',
        },
      };
    case 'lease_not_acquired':
      return {
        status: 'ineligible',
        memberState: { credentialHealthStatus: 'refresh_failed_retryable' },
      };
  }
}

export type ConnectedServiceRuntimeAuthCredentialRefreshResult =
  ConnectedServiceCredentialRefreshResult & Readonly<{
    runtimeAuthDisposition?: 'superseded_by_current_group';
  }>;

export type ConnectedServiceCredentialHealthNotificationStatus =
  | 'reconnect_required'
  | 'refresh_failed_retryable';

export type ConnectedServiceCredentialHealthNotificationDiagnostic = Readonly<
  Omit<Pick<ConnectedServiceCredentialRefreshDiagnostic,
    'serviceId' | 'profileId' | 'status' | 'category' | 'providerStatus' | 'providerErrorCode'>, 'serviceId'>
  & { serviceId: string }
>;

export type ConnectedServiceCredentialHealthNotificationTarget = Readonly<{
  pid: number;
  agentId: string | null;
  sessionId: string;
}>;

type SpawnTarget = ConnectedServiceRuntimeRefreshTarget;

type RematerializedTargetFailure = Readonly<{
  target: SpawnTarget;
  binding: BoundProfile;
  diagnostic: ConnectedServicesMaterializationDiagnostic;
}>;

type RematerializedTargetsResult = Readonly<{
  affectedTargets: ReadonlyArray<SpawnTarget>;
  rematerializedTargets: ReadonlyArray<SpawnTarget>;
  failedTargets: ReadonlyArray<RematerializedTargetFailure>;
}>;
type CanonicalGroupStateForRefresh = Readonly<{ activeProfileId: string | null; generation: number }>;



/**
 * Whether a caller can adopt an already-in-flight refresh result instead of running its own.
 * A non-forced caller always adopts. A forced (reactive) caller adopts any result that actually
 * exercised (or attempted) a rotation; a `not_needed` early-return performed no rotation, so a
 * forced caller behind one must still run its own serialized refresh.
 */
function inFlightResultSatisfiesCaller(
  result: ConnectedServiceCredentialRefreshResult,
  options: Readonly<{ force?: boolean }>,
): boolean {
  if (options.force !== true) return true;
  return result.status !== 'not_needed';
}



function qualifiedConfigurationConsequenceError(
  code:
    | 'connected_account_configuration_consequence_stale'
    | 'connected_account_configuration_consequence_unavailable',
  message: string,
  cause?: unknown,
): Error & Readonly<{ code: string }> {
  return Object.assign(new Error(message, cause === undefined ? {} : { cause }), {
    code,
  });
}


export type ConnectedServiceCredentialRefreshFailureCode =
  | typeof CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceCredentialReconnectRequired
  | typeof CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceCredentialRefreshUnavailable;

export class ConnectedServiceCredentialRefreshError extends Error {
  readonly code: ConnectedServiceCredentialRefreshFailureCode;
  readonly diagnostic: ConnectedServiceCredentialRefreshDiagnostic;

  constructor(diagnostic: ConnectedServiceCredentialRefreshDiagnostic) {
    const reconnectRequired = diagnostic.status === 'blocked_by_credential_health'
      || (diagnostic.category !== undefined && isReauthRequiredFailure(diagnostic.category));
    const code = reconnectRequired
      ? CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceCredentialReconnectRequired
      : CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceCredentialRefreshUnavailable;
    super(code);
    this.name = 'ConnectedServiceCredentialRefreshError';
    this.code = code;
    this.diagnostic = diagnostic;
  }
}

function isReconnectRequiredProfileStatus(status: unknown): boolean {
  return status === 'needs_reauth';
}

function readBoundedPluginDiagnosticCode(
  result: PluginConnectedAccountHealthResult | QualifiedConnectedAccountRefreshSettlement['result'],
): string | undefined {
  const diagnostic = 'diagnostic' in result ? result.diagnostic : undefined;
  const details = diagnostic?.details;
  const providerCode = details !== null && typeof details === 'object' && !Array.isArray(details)
    && 'providerErrorCode' in details ? details.providerErrorCode : undefined;
  const code = typeof providerCode === 'string' ? providerCode.trim() : diagnostic?.code.trim();
  return code && code.length <= 128 ? code : undefined;
}

function buildCredentialHealthFromPluginStatus(
  result: PluginConnectedAccountHealthResult | QualifiedConnectedAccountRefreshSettlement['result'],
): ConnectedServiceCredentialHealthV1 {
  const providerErrorCode = readBoundedPluginDiagnosticCode(result);
  if (result.status === 'connected') {
    return {
      v: 1,
      status: 'connected',
      reconnectRequired: false,
    };
  }
  const rawDetails = result.diagnostic?.details;
  const details = isJsonObject(rawDetails) ? rawDetails : undefined;
  const failureKind = ConnectedServiceCredentialRefreshFailureKindV1Schema.safeParse(details?.credentialRefreshFailureKind);
  const providerHttpStatus = ConnectedServiceCredentialHealthV1Schema.shape.providerHttpStatus.safeParse(details?.providerHttpStatus);
  const diagnosticHealth = {
    ...(providerHttpStatus.success && providerHttpStatus.data !== undefined ? { providerHttpStatus: providerHttpStatus.data } : {}),
    ...(providerErrorCode ? { providerErrorCode } : {}),
  };
  if (
    result.status === 'reconnectRequired'
    || result.status === 'rejected'
  ) {
    return {
      v: 1,
      status: 'needs_reauth',
      reconnectRequired: true,
      lastRefreshFailureKind: failureKind.success ? failureKind.data : 'unknown',
      ...diagnosticHealth,
    };
  }
  // Local expiry is recoverable by refresh; it is not a provider rejection.
  return {
    v: 1,
    status: 'refresh_failed_retryable',
    reconnectRequired: false,
    ...(failureKind.success ? { lastRefreshFailureKind: failureKind.data } : {}),
    ...diagnosticHealth,
  };
}

function buildCredentialHealthFromPluginRefresh(
  settlement: QualifiedConnectedAccountRefreshSettlement,
  now: number,
): ConnectedServiceCredentialHealthV1 {
  const health = buildCredentialHealthFromPluginStatus(settlement.result);
  if (settlement.status === 'unchanged') return health;
  return {
    ...health,
    lastRefreshAttemptAt: now,
    ...(settlement.status === 'refreshed'
      ? { lastRefreshSuccessAt: now }
      : { lastRefreshFailureAt: now }),
  };
}


function buildRefreshDiagnostic(params: Readonly<{
  binding: BoundProfile;
  reason: ConnectedServiceCredentialRefreshReason;
  status: ConnectedServiceCredentialRefreshStatus;
  category?: ConnectedServiceRefreshFailureCategory;
  providerStatus?: number | null;
  providerErrorCode?: string | null;
  expiresAt?: number | null;
  now: number;
  refreshWindowMs: number;
}>): ConnectedServiceCredentialRefreshDiagnostic {
  const expiresAt = params.expiresAt ?? null;
  return {
    serviceId: params.binding.serviceId,
    profileId: params.binding.profileId,
    reason: params.reason,
    status: params.status,
    ...(params.category ? { category: params.category } : {}),
    ...(params.providerStatus !== undefined ? { providerStatus: params.providerStatus } : {}),
    ...(params.providerErrorCode !== undefined ? { providerErrorCode: params.providerErrorCode } : {}),
    expiresAt,
    expiryAgeMs: typeof expiresAt === 'number' && Number.isFinite(expiresAt) ? params.now - expiresAt : null,
    refreshWindowMs: params.refreshWindowMs,
  };
}

function resolveRuntimeAuthRematerializationFailures(input: Readonly<{
  result: RematerializedTargetsResult;
  sessionId: string | null;
}>): ReadonlyArray<RematerializedTargetFailure> {
  if (input.sessionId) {
    const sessionFailures = input.result.failedTargets.filter((failure) => failure.target.sessionId === input.sessionId);
    if (sessionFailures.length > 0) return sessionFailures;
    const sessionWasAffected = input.result.affectedTargets.some((target) => target.sessionId === input.sessionId);
    return sessionWasAffected ? [] : input.result.failedTargets;
  }
  if (input.result.affectedTargets.length === 0) return [];
  if (input.result.rematerializedTargets.length > 0) return [];
  return input.result.failedTargets;
}

function wasRuntimeAuthSessionRematerialized(input: Readonly<{
  result: RematerializedTargetsResult;
  sessionId: string | null;
}>): boolean {
  if (!input.sessionId) return true;
  return input.result.rematerializedTargets.some((target) => target.sessionId === input.sessionId);
}

function didRuntimeAuthSessionAdoptAnotherGroupMember(input: Readonly<{
  result: RematerializedTargetsResult;
  sessionId: string | null;
  binding: BoundProfile;
}>): boolean {
  if (!input.sessionId) return false;
  const target = input.result.rematerializedTargets.find(
    (candidate) => candidate.sessionId === input.sessionId,
  );
  const selection = target?.childSelectionsByServiceId?.get(input.binding.serviceId);
  return selection?.kind === 'group'
    && selection.activeProfileId !== input.binding.profileId;
}




async function readCredentialForRefresh(params: Readonly<{
  signal?: AbortSignal;
  api: ApiClient;
  credentials: StoredCredentials;
  binding: BoundProfile;
  readCredential?: QualifiedConnectedAccountRefreshRuntime['readCredential'];
}>): Promise<ConnectedServiceCredentialSource | null> {
  params.signal?.throwIfAborted();
  const accountMode = await resolveConnectedServiceAccountMode(params.api, { signal: params.signal });
  const resolved = await resolveConnectedServiceCredentialSource({
    credentials: params.credentials,
    api: params.api,
    binding: params.binding,
    accountMode,
    ...(params.signal ? { signal: params.signal } : {}),
    ...(params.readCredential ? { readCredential: params.readCredential } : {}),
  });
  if (!resolved) return null;
  const source = {
    storageMode: resolved.storageMode === 'e2ee' ? 'sealed' : 'plain',
    record: resolved.record,
    expiresAt:
      typeof resolved.record.expiresAt === 'number'
      && Number.isFinite(resolved.record.expiresAt)
        ? resolved.record.expiresAt
        : null,
  } as const;
  return resolved.revisionSemantics === 'revisioned' ? {
    ...source,
    revisionSemantics: 'revisioned',
    credentialRevision: resolved.credentialRevision,
  } : {
    ...source,
    revisionSemantics: 'legacy_unfenced',
    credentialRevision: null,
  };
}


export class ConnectedServiceRefreshCoordinator {
  private readonly runtimeRegistry: ConnectedServiceRuntimeRegistry;
  private readonly inFlightRefreshes = new Map<string, Readonly<{
    kind: 'binding';
    credentialReady: Promise<ConnectedServiceCredentialRefreshResult>;
    completion: Promise<ConnectedServiceCredentialRefreshResult>;
  }> | Readonly<{
    kind: 'qualified';
    reason?: 'provider_context';
    completion: Promise<QualifiedConnectedAccountRefreshSettlement>;
  }>>();
  private readonly inFlightRefreshRematerializations = new Map<string, Promise<RematerializedTargetsResult>>();
  private readonly inFlightRefreshAuthUpdatedNotifications = new Map<string, Promise<void>>();
  // RR-1: rotate+distribute is ONE transaction on the single 'refreshed' completion path. This guard
  // stops a distribution-triggered nested refresh from recursing back into another distribution.
  private readonly distributingRefreshedBindings = new Set<string>();
  // The rematerialization result produced by the by-construction distribution of the LAST 'refreshed'
  // completion for a binding. Runtime-auth reads it to derive per-session materialization outcomes
  // WITHOUT a second rematerialize/notify (preserving single-materialize under concurrent callers).
  private readonly lastRefreshedDistributionByKey = new Map<string, RematerializedTargetsResult>();
  private readonly credentialHealthReprobeState = new Map<string, CredentialHealthReprobeState>();
  private readonly healthProbeIntervalMs: number;
  private readonly scheduledHealthProbeAtByKey = new Map<string, Readonly<{
    at: number;
    basis?: string;
  } & Partial<Pick<QualifiedConnectedAccountProfileV4, 'credentialRevision' | 'configurationRevision'>>>>();
  private readonly bridgeRefreshAttemptByBinding = new Map<string, {
    kind: 'codex';
    refreshAttemptId: string;
    expectedCredentialRevision?: ConnectedServiceCredentialRevisionV1;
    promise: Promise<CodexChatGptAuthTokensRefreshResponse>;
    settlement: 'pending' | 'fulfilled' | 'rejected';
  } | {
    kind: 'runtime_auth';
    refreshAttemptId: string;
    expectedCredentialRevision: ConnectedServiceCredentialRevisionV1;
    authority: object;
    targetBinding: ConnectedServiceChildSelection;
    promise: Promise<ConnectedServiceDaemonAuthBridgeRefreshResult>;
    settlement: 'pending' | 'fulfilled' | 'rejected';
  }>();

  constructor(private readonly params: Readonly<{
    api: ApiClient;
    credentials: StoredCredentials;
    machineIdProvider: () => string;
    ownerIdProvider?: () => string | null | undefined;
    activeServerDir: string;
    baseDir: string;
    refreshWindowMs: number;
    refreshLeaseMs: number;
    /** Existing external status-acquisition policy, independent of inventory invalidation. */
    healthProbeIntervalMs?: number;
    now: () => number;
    accountSettingsProvider?: () => AccountSettings | Readonly<Record<string, unknown>> | null | undefined;
    processEnv?: NodeJS.ProcessEnv;
    runtimeRegistry?: ConnectedServiceRuntimeRegistry;
    isAccountRuntimeCurrent?: (signal?: AbortSignal) => Promise<boolean>;
    runAccountOperation?: <T>(operation: () => Promise<T>, signal?: AbortSignal) => Promise<T>;
    allowNativeAccountState?: boolean;
    accountPluginSettingsSource?: AgentPluginAccountSettingsSource;
    connectedAccountsOwner?: Parameters<typeof materializeConnectedServicesForSpawn>[0]['connectedAccountsOwner'];
    activatePurposeBindings?: ConnectedAccountPurposeBindingOwner['activatePurposeBindings'];
    resolveQualifiedPurposeBindingSnapshot?: (input: Readonly<{
      signal?: AbortSignal;
      agentId: CatalogAgentId;
      connectedServicesBindingsRaw: unknown;
    }>) => Promise<AgentSpawnQualifiedPurposeBindingSnapshot | null>;
    qualifiedConnectedAccountRuntime?: QualifiedConnectedAccountRefreshRuntime;
    onAuthUpdated?: (event: Readonly<{
      signal?: AbortSignal;
      binding: Readonly<{ serviceId: ConnectedAccountServiceKey; profileId: string }>;
      affectedTargets: ReadonlyArray<SpawnTarget>;
      trigger: 'refresh_triggered_restart' | 'reconnect_propagation';
      credentialPresence?: ConnectedServiceProjectedCredentialPresence;
      executionAuthority: ConnectedServiceExecutionAuthorityV1;
    }>) => void | Promise<void>;
    onCredentialHealthNotification?: (event: Readonly<{
      signal?: AbortSignal;
      diagnostic: ConnectedServiceCredentialHealthNotificationDiagnostic;
      healthStatus: ConnectedServiceCredentialHealthNotificationStatus;
      affectedTargets: ReadonlyArray<ConnectedServiceCredentialHealthNotificationTarget>;
    }>) => void | Promise<void>;
  }>) {
    this.healthProbeIntervalMs = params.healthProbeIntervalMs ?? 30_000;
    this.runtimeRegistry = params.runtimeRegistry ?? new ConnectedServiceRuntimeRegistry();
    const runtime = params.qualifiedConnectedAccountRuntime;
    if (runtime && (params.isAccountRuntimeCurrent || params.runAccountOperation)) {
      this.params = {
        ...params,
        qualifiedConnectedAccountRuntime: {
          ...runtime,
          readCredential: (input) => this.runCurrentAccountOperation(() => runtime.readCredential(input), true, input.signal),
          mutateCredentialHealth: (input) => this.runCurrentAccountOperation(() => runtime.mutateCredentialHealth(input), false, input.signal),
          acquireRefreshLease: (input) => this.runCurrentAccountOperation(() => runtime.acquireRefreshLease(input), false, input.signal),
          mutateCredential: (input) => this.runCurrentAccountOperation(() => runtime.mutateCredential(input), false, input.signal),
          establishedRuntimeOwner: {
            invokeWithReceipt: (input) => this.runCurrentAccountOperation(
              // Invocation publication is qualified by the dispatcher. Preserve
              // its completed receipt so an exchanged token can settle.
              () => runtime.establishedRuntimeOwner.invokeWithReceipt(input), false, input.signal,
            ),
          },
          ...(runtime.readGroup ? {
            readGroup: (input) => this.runCurrentAccountOperation(() => runtime.readGroup!(input), true, input.signal),
          } : {}),
          ...(runtime.listScheduledAccounts ? {
            listScheduledAccounts: (service, signal) => this.runCurrentAccountOperation(() => runtime.listScheduledAccounts!(service, signal), true, signal),
          } : {}),
          ...(runtime.onCredentialUpdated ? {
            onCredentialUpdated: (account, options) => this.runCurrentAccountOperation(async () => {
              await runtime.onCredentialUpdated!(account, options);
            }, false, options?.signal),
          } : {}),
          ...(runtime.onReauthRequired ? {
            onReauthRequired: (event) => this.runCurrentAccountOperation(() => runtime.onReauthRequired!(event)),
          } : {}),
        },
      };
    }
  }

  publishCredentialHealthTransition(event: import('./qualifiedHealthSettlement').ConnectedServiceCredentialHealthTransition): void {
    this.params.qualifiedConnectedAccountRuntime?.onCredentialHealthChanged?.(event);
  }

  private async assertAccountRuntimeCurrent(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.params.isAccountRuntimeCurrent && !await this.params.isAccountRuntimeCurrent(signal)) {
      throw new Error('connected_account_runtime_not_current');
    }
  }

  private async runCurrentAccountOperation<T>(operation: () => Promise<T>, checkAfterRead = false, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    await this.assertAccountRuntimeCurrent(signal);
    const result = await (this.params.runAccountOperation ? this.params.runAccountOperation(operation, signal) : operation());
    // Reads cannot disclose a result after admission is lost. A completed durable
    // mutation keeps its receipt; its subsequent read/distribution is fenced separately.
    if (checkAfterRead) await this.assertAccountRuntimeCurrent(signal);
    return result;
  }

  private resolveOperationTransport(
    binding: BoundProfile,
    operation: BuiltInLegacyConnectedAccountOperation,
  ): QualifiedConnectedAccountPeerOperationTransport | null {
    const runtime = this.params.qualifiedConnectedAccountRuntime;
    const compatibility =
      BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID[
        binding.serviceId
      ];
    if (!runtime) return null;
    if (!runtime.resolveOperationTransport) {
      const peerClass = runtime.resolvePeerClass();
      if (peerClass === 'advertised_v4') return { kind: 'v4' };
      return null;
    }
    try {
      return runtime.resolveOperationTransport({
        service: compatibility.service,
        operation,
      });
    } catch {
      return null;
    }
  }

  private async readCredentialForRefresh(input: Parameters<typeof readCredentialForRefresh>[0], signal?: AbortSignal): ReturnType<typeof readCredentialForRefresh> {
    signal?.throwIfAborted();
    const transport = this.resolveOperationTransport(input.binding, 'credential_read');
    if (this.params.qualifiedConnectedAccountRuntime && transport?.kind !== 'v4') {
      throw new QualifiedConnectedAccountCompatibilityError('connected_account_capability_indeterminate');
    }
    return await this.runCurrentAccountOperation(() => readCredentialForRefresh({
      ...input,
      ...(signal ? { signal } : {}),
      ...(transport?.kind === 'v4' && this.params.qualifiedConnectedAccountRuntime
        ? { readCredential: this.params.qualifiedConnectedAccountRuntime.readCredential }
        : {}),
    }), true, signal);
  }

  private shouldRunQualifiedOperation(
    account: QualifiedConnectedAccountRef,
    operation: BuiltInLegacyConnectedAccountOperation,
  ): boolean {
    const runtime = this.params.qualifiedConnectedAccountRuntime;
    if (!runtime) return false;
    if (!runtime.resolveOperationTransport) {
      return runtime.resolvePeerClass() === 'advertised_v4';
    }
    try {
      return runtime.resolveOperationTransport({
        service: account.service,
        operation,
      }).kind === 'v4';
    } catch {
      return false;
    }
  }

  private isOperationAvailable(
    binding: BoundProfile,
    operation: BuiltInLegacyConnectedAccountOperation,
  ): boolean {
    const runtime = this.params.qualifiedConnectedAccountRuntime;
    if (!runtime?.resolveOperationTransport) return true;
    return this.resolveOperationTransport(binding, operation) !== null;
  }

  registerSpawnTarget(params: Readonly<{
    pid: number;
    /** Absent for a configured backend target, which has no catalog Agent identity. */
    agentId: CatalogAgentId | null;
    sessionId?: string | null;
    spawnTrackingKey?: string;
    materializationKey: string;
    connectedServicesBindingsRaw: unknown;
    connectedServiceSelectionsEnv?: Pick<NodeJS.ProcessEnv, string> | null;
    connectedServiceSelectionsEnvRaw?: string;
  }>): void {
    this.runtimeRegistry.registerTarget({
      pid: params.pid,
      agentId: params.agentId,
      sessionId: typeof params.sessionId === 'string' && params.sessionId.trim().length > 0
        ? params.sessionId.trim()
        : null,
      ...(params.spawnTrackingKey ? { spawnTrackingKey: params.spawnTrackingKey } : {}),
      materializationKey: params.materializationKey,
      connectedServicesBindingsRaw: params.connectedServicesBindingsRaw,
      ...(params.connectedServiceSelectionsEnv
        ? { connectedServiceSelectionsEnv: params.connectedServiceSelectionsEnv }
        : {}),
      connectedServiceSelectionsEnvRaw: params.connectedServiceSelectionsEnvRaw,
    });
  }

  unregisterPid(pid: number): void {
    this.runtimeRegistry.unregisterPid(pid);
  }

  async applyQualifiedConnectedAccountConfigurationConsequence(
    input: QualifiedConnectedAccountConfigurationConsequence,
  ): Promise<void> {
    const runtime = this.params.qualifiedConnectedAccountRuntime;
    if (!runtime || runtime.resolvePeerClass() !== 'advertised_v4') {
      throw qualifiedConfigurationConsequenceError(
        'connected_account_configuration_consequence_unavailable',
        'Qualified Connected Account configuration consequence runtime is unavailable',
      );
    }
    const authenticationModeId = input.authenticationModeId.trim();
    const runtimeConfigurationRevision =
      input.runtimeConfigurationRevision.trim();
    if (!authenticationModeId || !runtimeConfigurationRevision) {
      throw qualifiedConfigurationConsequenceError(
        'connected_account_configuration_consequence_stale',
        'Qualified Connected Account configuration consequence basis is invalid',
      );
    }
    const expectedCredential = await runtime.readCredential({
      token: this.params.credentials.token,
      ref: input.account,
      requestPurpose: 'connected-accounts:qualification',
    });
    if (
      !expectedCredential
      || qualifiedAccountKey(expectedCredential.ref)
        !== qualifiedAccountKey(input.account)
      || expectedCredential.authenticationModeId !== authenticationModeId
      || (
        input.configurationScope === 'service'
          ? expectedCredential.configurationRevision !== null
          : expectedCredential.configurationRevision
            !== runtimeConfigurationRevision
      )
    ) {
      throw qualifiedConfigurationConsequenceError(
        'connected_account_configuration_consequence_stale',
        'Qualified Connected Account credential no longer matches the committed configuration consequence',
      );
    }

    if (input.behavior === 'reconnect') {
      try {
        const health = Object.freeze({
          v: 1 as const, status: 'needs_reauth' as const, reconnectRequired: true,
          providerErrorCode: 'connected_account_configuration_changed',
        });
        recordCredentialHealthWrite({ path: 'configuration-reconnect', account: input.account,
          credentialRevision: expectedCredential.credentialRevision, configurationRevision: expectedCredential.configurationRevision,
          before: expectedCredential.health ?? null, after: health });
        const mutation = await runtime.mutateCredentialHealth({
          token: this.params.credentials.token,
          patch: Object.freeze({
            ref: input.account,
            expectedCredentialRevision:
              expectedCredential.credentialRevision,
            expectedConfigurationRevision:
              expectedCredential.configurationRevision,
            health,
          }),
        });
        const current = await runtime.readCredential({
          token: this.params.credentials.token,
          ref: input.account,
          requestPurpose: 'connected-accounts:qualification',
        });
        if (
          mutation.credentialRevision
            !== expectedCredential.credentialRevision
          || mutation.configurationRevision
            !== expectedCredential.configurationRevision
          || !current
          || qualifiedAccountKey(current.ref)
            !== qualifiedAccountKey(input.account)
          || current.authenticationModeId !== authenticationModeId
          || current.credentialRevision !== mutation.credentialRevision
          || current.configurationRevision !== mutation.configurationRevision
        ) {
          throw qualifiedConfigurationConsequenceError(
            'connected_account_configuration_consequence_stale',
            'Qualified Connected Account reconnect consequence settled against a stale credential basis',
          );
        }
        notifyQualifiedHealthSettled({ account: input.account, credentialRevision: mutation.credentialRevision,
          previousHealth: expectedCredential.health, health }, runtime);
        this.armQualifiedConnectedAccountHealthBackoff(input.account);
        await this.notifyQualifiedConnectedAccountCredentialUpdated(input.account);
        return;
      } catch (error) {
        this.armQualifiedConnectedAccountHealthBackoff(input.account);
        if (
          error
          && typeof error === 'object'
          && 'code' in error
          && (
            error.code === 'connected_account_configuration_consequence_stale'
            || error.code
              === 'connected_account_configuration_consequence_unavailable'
          )
        ) {
          throw error;
        }
        throw qualifiedConfigurationConsequenceError(
          'connected_account_configuration_consequence_unavailable',
          'Qualified Connected Account reconnect consequence was not accepted',
          error,
        );
      }
    }

    const ownerBase =
      this.params.ownerIdProvider?.()?.trim()
      || this.params.machineIdProvider().trim();
    if (!ownerBase) {
      throw qualifiedConfigurationConsequenceError(
        'connected_account_configuration_consequence_unavailable',
        'Qualified Connected Account refresh consequence owner is unavailable',
      );
    }
    let settlement: Awaited<
      ReturnType<typeof refreshQualifiedConnectedAccount>
    >;
    try {
      settlement = await this.refreshQualifiedAccount({
        account: input.account,
        token: this.params.credentials.token,
        ownerId: ownerBase,
        leaseMs: this.params.refreshLeaseMs,
        operationId: randomBytes(16).toString('hex'),
        expectedCredential,
        establishedRuntimeOwner: runtime.establishedRuntimeOwner,
        resolveV4Support: () =>
          peerClassV4Support(runtime.resolvePeerClass()),
        acquireRefreshLease: runtime.acquireRefreshLease,
        mutateCredential: runtime.mutateCredential,
      });
    } catch (error) {
      this.armQualifiedConnectedAccountHealthBackoff(input.account);
      throw qualifiedConfigurationConsequenceError(
        'connected_account_configuration_consequence_unavailable',
        'Qualified Connected Account refresh consequence was not accepted',
        error,
      );
    }
    if (
      settlement.basis.runtimeConfigurationRevision
        !== runtimeConfigurationRevision
      || settlement.basis.credentialRevision
        !== expectedCredential.credentialRevision
      || settlement.basis.credentialConfigurationRevision
        !== expectedCredential.configurationRevision
      || (settlement.status !== 'refreshed' && !settlement.basis.isCurrent())
    ) {
      throw qualifiedConfigurationConsequenceError(
        'connected_account_configuration_consequence_stale',
        'Qualified Connected Account refresh consequence used a stale configuration basis',
      );
    }
    if (
      settlement.status === 'not_connected'
      || settlement.status === 'outcome_unknown'
    ) {
      const health = buildCredentialHealthFromPluginRefresh(settlement, this.params.now());
      await this.settleQualifiedConnectedAccountHealth({
        account: input.account,
        basis: settlement.basis,
        health,
      });
      this.armQualifiedConnectedAccountHealthBackoff(input.account);
      await this.notifyQualifiedConnectedAccountCredentialUpdated(input.account);
      return;
    }
    const current = await runtime.readCredential({
      token: this.params.credentials.token,
      ref: input.account,
      requestPurpose: 'connected-accounts:qualification',
    });
    const expectedCurrentRevision = settlement.status === 'refreshed'
      ? settlement.credentialRevision
      : expectedCredential.credentialRevision;
    if (
      !current
      || qualifiedAccountKey(current.ref) !== qualifiedAccountKey(input.account)
      || current.authenticationModeId !== authenticationModeId
      || current.credentialRevision !== expectedCurrentRevision
      || current.configurationRevision
        !== expectedCredential.configurationRevision
    ) {
      throw qualifiedConfigurationConsequenceError(
        'connected_account_configuration_consequence_stale',
        'Qualified Connected Account refresh consequence settled against a stale credential basis',
      );
    }
    this.resetQualifiedConnectedAccountHealthBackoff(input.account);
    await this.settleQualifiedConnectedAccountHealth({
      account: input.account, basis: settlement.basis,
      health: buildCredentialHealthFromPluginRefresh(settlement, this.params.now()),
      ...(settlement.status === 'refreshed'
        ? { settledCredentialRevision: settlement.credentialRevision } : {}),
    });
    await this.notifyQualifiedConnectedAccountCredentialUpdated(input.account);
  }

  transferPid(fromPid: number, toPid: number): void {
    this.runtimeRegistry.transferPid(fromPid, toPid);
  }

  public prepareScheduledQualifiedHealth(profile: QualifiedConnectedAccountProfileV4, now: number, signal?: AbortSignal): ScheduledQualifiedAccountHealth {
    signal?.throwIfAborted();
    const binding = this.runtimeRegistry.listRefreshTargets().flatMap(target => this.resolveBoundProfiles(target)).find(candidate => {
      const service = BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID[candidate.serviceId].service;
      return qualifiedAccountKey({ service, accountId: candidate.profileId }) === qualifiedAccountKey(profile.ref);
    });
    const key = `qualified:${qualifiedAccountKey(profile.ref)}`;
    const available = this.shouldRunQualifiedOperation(profile.ref, 'credential_health');
    const identity = { credentialRevision: profile.credentialRevision, configurationRevision: profile.configurationRevision };
    const basis = JSON.stringify([profile.authenticationModeId, profile.kind, profile.expiresAt, available]);
    const previous = this.scheduledHealthProbeAtByKey.get(key);
    if (previous?.basis !== basis || previous.credentialRevision !== identity.credentialRevision
      || previous.configurationRevision !== identity.configurationRevision) {
      // A health settlement changes listing metadata without replacing the
      // credential. Only a known replacement may discard its recovery delay.
      if (previous && (previous.credentialRevision !== identity.credentialRevision
        || previous.configurationRevision !== identity.configurationRevision)) {
        this.credentialHealthReprobeState.delete(key);
        if (binding) this.credentialHealthReprobeState.delete(bindingKey(binding));
      }
      this.scheduledHealthProbeAtByKey.set(key, { ...identity, basis, at: -Infinity });
    }
    if (!available || isReconnectRequiredProfileStatus(profile.status)) {
      this.scheduledHealthProbeAtByKey.set(key, { ...identity, basis, at: Infinity });
    }
    const nextDeadline = () => {
      if (!available || isReconnectRequiredProfileStatus(profile.status)) return null;
      const at = (binding ? this.credentialHealthReprobeState.get(bindingKey(binding))?.nextProbeAt : undefined)
        ?? this.credentialHealthReprobeState.get(key)?.nextProbeAt
        ?? this.scheduledHealthProbeAtByKey.get(key)?.at;
      return typeof at === 'number' && Number.isFinite(at) ? at : null;
    };
    const scheduledAt = (binding ? this.credentialHealthReprobeState.get(bindingKey(binding))?.nextProbeAt : undefined)
      ?? this.credentialHealthReprobeState.get(key)?.nextProbeAt
      ?? this.scheduledHealthProbeAtByKey.get(key)?.at ?? Infinity;
    const due = available && !isReconnectRequiredProfileStatus(profile.status) && scheduledAt <= now;
    return { due, nextDeadline, settle: async (outcome, settlementSignal = signal) => {
      const signal = settlementSignal;
      signal?.throwIfAborted();
      const status: ScheduledStatusInvocation = () => outcome.status === 'fulfilled'
        ? Promise.resolve(outcome.value) : Promise.reject(outcome.reason);
      let expiresAt = profile.kind === 'oauth' ? profile.expiresAt : null;
      try {
        if (binding && profile.kind === 'oauth') expiresAt = (await this.maybeRefreshBinding(binding, now, status, signal)).diagnostic.expiresAt;
        else expiresAt = await this.maybeRefreshScheduledQualifiedAccount(profile, now, status, signal) ?? expiresAt;
      } finally {
        // Static credentials have no renewal deadline. A failed observation is
        // settled until credential/configuration change or an explicit check;
        // publishing its health must not create another provider request.
        const renewable = profile.kind === 'oauth' || (outcome.status === 'fulfilled'
          && (outcome.value.result.status === 'expired' || 'expiresAt' in outcome.value.result));
        if (!renewable) {
          this.credentialHealthReprobeState.delete(key);
          if (binding) this.credentialHealthReprobeState.delete(bindingKey(binding));
        }
        const expiry = typeof expiresAt === 'number' ? expiresAt - this.params.refreshWindowMs : Infinity;
        if (!signal?.aborted) this.scheduledHealthProbeAtByKey.set(key, {
          ...identity, basis, ...this.scheduledHealthProbeAtByKey.get(key), at: expiry > this.params.now() ? expiry : Infinity,
        });
      }
    } };
  }

  public retainScheduledQualifiedHealthAccounts(profiles: readonly QualifiedConnectedAccountProfileV4[]): void {
    const keys = new Set(profiles.map(profile => `qualified:${qualifiedAccountKey(profile.ref)}`));
    for (const key of this.scheduledHealthProbeAtByKey.keys()) {
      if (key.startsWith('qualified:') && !keys.has(key)) {
        this.scheduledHealthProbeAtByKey.delete(key);
        this.credentialHealthReprobeState.delete(key);
      }
    }
  }

  async tickOnce(options?: Readonly<{ skipQualified?: boolean; signal?: AbortSignal }>): Promise<SingleFlightLoopSchedule> {
    return await runConnectedServiceRefreshTick({
      now: this.params.now,
      refreshWindowMs: this.params.refreshWindowMs,
      runtimeRegistry: this.runtimeRegistry,
      qualifiedConnectedAccountRuntime: this.params.qualifiedConnectedAccountRuntime,
      isAccountRuntimeCurrent: this.params.isAccountRuntimeCurrent,
      credentialHealthReprobeState: this.credentialHealthReprobeState,
      scheduledHealthProbeAtByKey: this.scheduledHealthProbeAtByKey,
      resolveBoundProfiles: target => this.resolveBoundProfiles(target),
      resolveOperationTransport: (binding, operation) => this.resolveOperationTransport(binding, operation),
      isOperationAvailable: (binding, operation) => this.isOperationAvailable(binding, operation),
      maybeRefreshBinding: (binding, now, signal) => this.maybeRefreshBinding(binding, now, undefined, signal),
      prepareScheduledQualifiedHealth: (profile, now, signal) => this.prepareScheduledQualifiedHealth(profile, now, signal),
    }, options);
  }

  private async maybeRefreshScheduledQualifiedAccount(
    profile: QualifiedConnectedAccountProfileV4,
    now: number,
    scheduledStatus?: ScheduledStatusInvocation, signal?: AbortSignal,
  ): Promise<number | null | undefined> {
    signal?.throwIfAborted();
    const runtime = this.params.qualifiedConnectedAccountRuntime;
    if (
      !runtime
      || runtime.resolvePeerClass() !== 'advertised_v4'
      || !this.shouldRunQualifiedOperation(
        profile.ref,
        'credential_health',
      )
    ) {
      return;
    }
    const key = `qualified:${qualifiedAccountKey(profile.ref)}`;
    const previous = this.credentialHealthReprobeState.get(key);
    if (previous && now < previous.nextProbeAt) return;
    const armBackoff = (): void => {
      this.armQualifiedConnectedAccountHealthBackoff(profile.ref);
    };
    let settleDeferredHealth: (() => Promise<void>) | undefined;
    try {
      // Reconnecting replaces the credential revision and clears this status.
      // An expiry-only status probe cannot rehabilitate a rejected refresh grant.
      if (isReconnectRequiredProfileStatus(profile.status)) return;
      const statusInvocation = scheduledStatus ? await scheduledStatus() :
        await runtime.establishedRuntimeOwner.invokeWithReceipt({ ...(signal ? { signal } : {}),
          account: profile.ref,
          operation: Object.freeze({ kind: 'status' as const }),
        });
      const health = buildCredentialHealthFromPluginStatus(
        statusInvocation.result,
      );
      const expired = statusInvocation.result.status === 'expired';
      const settleStatus = async () => {
        settleDeferredHealth = undefined;
        await this.settleQualifiedConnectedAccountHealth({
          account: profile.ref,
          basis: statusInvocation.basis,
          health,
          providerIdentity: statusInvocation.result.status === 'connected' ? statusInvocation.result.providerIdentity : undefined,
          healthWritePath: 'status',
        }, signal);
      };
      settleDeferredHealth = settleStatus;
      if (health.status !== 'connected' && !expired) {
        await settleStatus();
        armBackoff();
        return;
      }
      this.credentialHealthReprobeState.delete(key);
      const expiresAt = ('expiresAt' in statusInvocation.result ? statusInvocation.result.expiresAt : undefined)
        ?? (profile.kind === 'oauth' ? profile.expiresAt : null);
      const shouldRefresh =
        expired || (
          profile.kind === 'oauth'
          && profile.status === 'refresh_failed_retryable'
        ) || (
          typeof expiresAt === 'number'
          && Number.isFinite(expiresAt)
          && expiresAt - now <= this.params.refreshWindowMs
        );
      if (!shouldRefresh) {
        await settleStatus();
        return expiresAt;
      }
      if (
        !this.shouldRunQualifiedOperation(
          profile.ref,
          'credential_read',
        )
      ) {
        await settleStatus();
        return;
      }
      const expectedCredential = await runtime.readCredential({ ...(signal ? { signal } : {}),
        token: this.params.credentials.token,
        ref: profile.ref,
        requestPurpose: 'connected-accounts:qualification',
      });
      if (!expectedCredential) {
        await settleStatus();
        return;
      }
      const ownerId =
        this.params.ownerIdProvider?.()?.trim()
        || this.params.machineIdProvider().trim();
      if (!ownerId) {
        await settleStatus();
        armBackoff();
        return;
      }
      if (
        !this.shouldRunQualifiedOperation(
          profile.ref,
          'oauth_refresh',
        )
        || !this.shouldRunQualifiedOperation(
          profile.ref,
          'refresh_lease',
        )
        || !this.shouldRunQualifiedOperation(
          profile.ref,
          'credential_write',
        )
      ) {
        await settleStatus();
        armBackoff();
        return;
      }
      // Expiry is an input to this attempt. Publish only its final outcome,
      // rather than an intermediate health that the same attempt supersedes.
      const settlement = await this.refreshQualifiedAccount({ ...(signal ? { signal } : {}),
        account: profile.ref,
        token: this.params.credentials.token,
        ownerId,
        leaseMs: this.params.refreshLeaseMs,
        operationId: randomBytes(16).toString('hex'),
        expectedCredential,
        establishedRuntimeOwner: runtime.establishedRuntimeOwner,
        resolveV4Support: () =>
          peerClassV4Support(runtime.resolvePeerClass()),
        acquireRefreshLease: runtime.acquireRefreshLease,
        mutateCredential: runtime.mutateCredential,
      });
      settleDeferredHealth = undefined;
      if (settlement.status === 'refreshed') {
        // The credential CAS committed. Its existing distribution transaction
        // retains custody even if this loop stops before adoption completes.
        await this.settleQualifiedConnectedAccountHealth({
          account: profile.ref,
          basis: settlement.basis,
          settledCredentialRevision: settlement.credentialRevision,
          health: buildCredentialHealthFromPluginRefresh(settlement, this.params.now()),
        });
        this.credentialHealthReprobeState.delete(key);
        await this.notifyQualifiedConnectedAccountCredentialUpdated(profile.ref);
        return 'expiresAt' in settlement.result ? settlement.result.expiresAt : expiresAt;
      }
      if (settlement.status === 'unchanged') {
        await this.settleQualifiedConnectedAccountHealth({
          account: profile.ref, basis: settlement.basis,
          health: buildCredentialHealthFromPluginRefresh(settlement, this.params.now()),
        }, signal);
        this.credentialHealthReprobeState.delete(key);
        return 'expiresAt' in settlement.result ? settlement.result.expiresAt : expiresAt;
      }
      const failedHealth = buildCredentialHealthFromPluginRefresh(settlement, this.params.now());
      await this.settleQualifiedConnectedAccountHealth({
        account: profile.ref,
        basis: settlement.basis,
        health: failedHealth,
      }, signal);
      armBackoff();
    } catch (error) {
      signal?.throwIfAborted();
      armBackoff();
      logger.warn(
        '[DAEMON RUN] Qualified Connected Account scheduled refresh did not settle',
        {
          service: profile.ref.service,
          error: sanitizeConnectedServiceDiagnosticError(error, {
            redactedValues: [profile.ref.accountId],
          }),
        },
      );
      throw error;
    } finally {
      // A failed read or lease never superseded the status observation. Publish
      // it once, through the same revision/currentness-fenced settlement.
      await settleDeferredHealth?.();
    }
    return undefined;
  }

  private armQualifiedConnectedAccountHealthBackoff(
    account: QualifiedConnectedAccountRef,
  ): void {
    const key = `qualified:${qualifiedAccountKey(account)}`;
    this.credentialHealthReprobeState.set(key, {
      nextProbeAt: this.params.now() + this.healthProbeIntervalMs,
    });
  }

  private resetQualifiedConnectedAccountHealthBackoff(
    account: QualifiedConnectedAccountRef,
  ): void {
    this.credentialHealthReprobeState.delete(
      `qualified:${qualifiedAccountKey(account)}`,
    );
  }

  async refreshConnectedServiceCredentialForSpawnPreflight(input: Readonly<{
    signal?: AbortSignal;
    serviceId: ConnectedServiceId;
    profileId: string;
    force?: boolean;
  }>): Promise<ConnectedServiceCredentialRefreshResult> {
    input.signal?.throwIfAborted();
    const binding = { serviceId: input.serviceId, profileId: input.profileId };
    const result = await this.refreshOauthBinding(
      binding,
      this.params.now(),
      {
        reason: 'spawn_preflight',
        force: input.force,
        adoptCredentialReadyFromInFlightRefresh: true,
      }, input.signal,
    );
    if (result.status === 'not_needed') {
      const rematerialization = await this.maybeRematerializeStaleMaterializedHomesForFreshStoreBinding(binding, input.signal);
      if (rematerialization && rematerialization.rematerializedTargets.length > 0) {
        await this.notifyAuthUpdatedForRefreshedBinding(binding, rematerialization.rematerializedTargets, input.signal);
      }
    }
    return result;
  }

  async prepareConnectedServiceAuthGroupCandidateForSwitch(input: Readonly<{
    signal?: AbortSignal;
    serviceId: ConnectedServiceId;
    profileId: string;
    reason: string;
  }>): Promise<ConnectedServiceAuthGroupCandidatePreparationResult> {
    input.signal?.throwIfAborted();
    return resolveConnectedServiceAuthGroupCandidatePreparation({
      reason: input.reason,
      refreshResult: await this.refreshConnectedServiceCredentialForSpawnPreflight({ ...(input.signal ? { signal: input.signal } : {}),
        serviceId: input.serviceId,
        profileId: input.profileId,
        // The switch reason belongs to the old active member. Candidate freshness
        // and health are decided by its own preflight, not another member's failure.
      }),
    });
  }

  async refreshConnectedServiceCredentialForQuota(input: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    force?: boolean;
    expectedCredentialRevision?: ConnectedServiceCredentialRevisionV1;
  }>): Promise<ConnectedServiceCredentialRecordV1 | null> {
    const result = await this.refreshOauthBinding(
      { serviceId: input.serviceId, profileId: input.profileId },
      this.params.now(),
      {
        force: input.force,
        reason: 'quota_bridge',
        ...(input.expectedCredentialRevision
          ? { expectedCredentialRevision: input.expectedCredentialRevision }
          : {}),
      },
    );
    return result.status === 'refreshed' ? result.credential : null;
  }

  async refreshConnectedServiceCredentialForRuntimeAuthFailure(input: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    sessionId?: string | null;
  }>): Promise<ConnectedServiceRuntimeAuthCredentialRefreshResult> {
    const binding = { serviceId: input.serviceId, profileId: input.profileId };
    const result = await this.refreshOauthBinding(
      binding,
      this.params.now(),
      { force: true, reason: 'runtime_auth_failure' },
    );
    if (result.status !== 'refreshed') return result;

    // RR-1: the 'refreshed' completion path already rematerialized + notified every registered target
    // by construction. Consume that result to derive this session's outcome instead of running (and
    // notifying) a second distribution — preserving single-materialize under concurrent callers.
    const rematerialization = this.lastRefreshedDistributionByKey.get(bindingKey(binding))
      ?? await this.rematerializeTargetsForBindingAfterRefresh(binding);
    const targetFailures = resolveRuntimeAuthRematerializationFailures({
      result: rematerialization,
      sessionId: input.sessionId ?? null,
    });
    if (targetFailures.length > 0) {
      return await this.finalizeRefreshResult(binding, this.buildMaterializationFailureRefreshResult({
        sourceResult: result,
        failure: targetFailures[0]!,
      }));
    }

    if (didRuntimeAuthSessionAdoptAnotherGroupMember({
      result: rematerialization,
      sessionId: input.sessionId ?? null,
      binding,
    }) || await this.didRegisteredRuntimeAuthSessionAdvanceToAnotherGroupMember({
      sessionId: input.sessionId ?? null,
      binding,
    })) {
      return {
        ...result,
        runtimeAuthDisposition: 'superseded_by_current_group',
      };
    }
    if (!wasRuntimeAuthSessionRematerialized({ result: rematerialization, sessionId: input.sessionId ?? null })) {
      return await this.finalizeRefreshResult(binding, this.buildMissingRuntimeAuthTargetRefreshResult({
        binding,
        sourceResult: result,
      }));
    }

    return result;
  }

  async refreshConnectedServiceCredentialForRuntimeAuthBridge(input: Readonly<{
    target: ConnectedServiceRuntimeTarget;
    isCurrent(): boolean;
    acceptSettledCredentialRevision?(revision: ConnectedServiceCredentialRevisionV1): ConnectedServiceRuntimeTarget | null;
    serviceId: ConnectedAccountServiceKey;
    profileId: string;
    expectedCredentialRevision: ConnectedServiceCredentialRevisionV1;
    refreshAttemptId: string;
    authority: object;
  }>): Promise<ConnectedServiceDaemonAuthBridgeRefreshResult> {
    await this.assertAccountRuntimeCurrent();
    const unavailable = { status: 'unavailable' as const, reason: 'connected_service_runtime_auth_target_unavailable' };
    const serviceId = resolveFirstPartyLegacyConnectedServiceIdForQualifiedServiceKey(input.serviceId);
    let target = input.target;
    const targetIsCurrent = () => input.isCurrent() && this.runtimeRegistry.listTargets().includes(target);
    const selection = input.target.connectedServiceSelections.find((candidate) => candidate.serviceId === input.serviceId);
    if (!serviceId || !targetIsCurrent() || !input.target.boundProfiles.some((binding) =>
      binding.serviceId === input.serviceId && binding.profileId === input.profileId)
      || !selection?.credentialRevision) return unavailable;
    const binding = { serviceId, profileId: input.profileId };
    const attemptKey = JSON.stringify(['runtime_auth', serviceId, input.profileId, input.refreshAttemptId]);
    const existing = this.bridgeRefreshAttemptByBinding.get(attemptKey);
    if (existing?.kind === 'runtime_auth') {
      const { credentialRevision: _oldRevision, ...oldBinding } = existing.targetBinding;
      const { credentialRevision: _currentRevision, ...currentBinding } = selection;
      if (existing.authority !== input.authority || !isDeepStrictEqual(oldBinding, currentBinding)
        || (input.expectedCredentialRevision !== existing.expectedCredentialRevision
          && input.expectedCredentialRevision !== selection.credentialRevision)) return unavailable;
      const proof = await existing.promise;
      if (proof.status !== 'refreshed') return unavailable;
    const persisted = await this.readCredentialForRefresh({ api: this.params.api, credentials: this.params.credentials, binding });
      if (persisted?.revisionSemantics !== 'revisioned' || persisted.credentialRevision !== proof.result.credentialRevision
        || (selection.credentialRevision !== existing.expectedCredentialRevision
          && selection.credentialRevision !== persisted.credentialRevision)) return unavailable;
      if (!targetIsCurrent()) {
        const accepted = input.acceptSettledCredentialRevision?.(persisted.credentialRevision);
        if (!accepted) return unavailable;
        target = accepted;
      }
      return targetIsCurrent() ? proof : unavailable;
    }
    if (selection.credentialRevision !== input.expectedCredentialRevision) return unavailable;
    const promise = this.performRuntimeAuthBridgeRefresh(input, binding);
    const attempt = { kind: 'runtime_auth' as const, refreshAttemptId: input.refreshAttemptId,
      expectedCredentialRevision: input.expectedCredentialRevision, authority: input.authority,
      targetBinding: selection, promise, settlement: 'pending' as 'pending' | 'fulfilled' | 'rejected' };
    this.bridgeRefreshAttemptByBinding.set(attemptKey, attempt);
    void promise.then(() => { attempt.settlement = 'fulfilled'; },
      () => { attempt.settlement = 'rejected'; });
    const result = await promise;
    await this.assertAccountRuntimeCurrent();
    return result;
  }

  private async performRuntimeAuthBridgeRefresh(input: Readonly<{
    target: ConnectedServiceRuntimeTarget;
    isCurrent(): boolean;
    acceptSettledCredentialRevision?(revision: ConnectedServiceCredentialRevisionV1): ConnectedServiceRuntimeTarget | null;
    serviceId: ConnectedAccountServiceKey;
    profileId: string;
    expectedCredentialRevision: ConnectedServiceCredentialRevisionV1;
  }>, binding: BoundProfile): Promise<ConnectedServiceDaemonAuthBridgeRefreshResult> {
    const unavailable = { status: 'unavailable' as const, reason: 'connected_service_runtime_auth_target_unavailable' };
    let target = input.target;
    const targetIsCurrent = () => input.isCurrent() && this.runtimeRegistry.listTargets().includes(target);
    const result = await this.refreshOauthBinding(binding, this.params.now(), {
      force: true, reason: 'provider_auth_bridge', expectedCredentialRevision: input.expectedCredentialRevision,
    });
    if (result.status !== 'refreshed' || !result.credentialRevision) {
      if (!targetIsCurrent()) return unavailable;
      throw new ConnectedServiceCredentialRefreshError(result.diagnostic);
    }
    const distribution = this.lastRefreshedDistributionByKey.get(bindingKey(binding));
    const exactMaterialized = distribution?.rematerializedTargets.some((target) => {
      const selection = target.childSelectionsByServiceId?.get(input.serviceId);
      return selection && runtimeTargetOwnsConnectedServiceRuntimeAuthRefreshSelection({ target: input.target, selection })
      && target.pid === input.target.pid && target.agentId === input.target.agentId
      && target.materializationKey === input.target.materializationKey
      && this.resolveBoundProfiles(target).some((candidate) => candidate.serviceId === binding.serviceId
        && candidate.profileId === input.profileId);
    });
    if (!exactMaterialized) return unavailable;
    const persisted = await this.readCredentialForRefresh({ api: this.params.api, credentials: this.params.credentials, binding });
    if (!persisted || persisted.record.kind !== 'oauth' || persisted.revisionSemantics !== 'revisioned'
      || persisted.credentialRevision !== result.credentialRevision) return unavailable;
    // A genuine Session hot-apply can replace its own registry projection while
    // distributing this exact CAS. Only the request's captured runner authority
    // may accept that one-service revision transition after native-home proof.
    if (!targetIsCurrent()) {
      const accepted = input.acceptSettledCredentialRevision?.(persisted.credentialRevision);
      if (!accepted) return unavailable;
      target = accepted;
    }
    if (!targetIsCurrent()) return unavailable;
    return { status: 'refreshed', result: {
      credentialRevision: persisted.credentialRevision,
      accessToken: persisted.record.oauth.accessToken,
      providerAccountId: persisted.record.oauth.providerAccountId,
    } };
  }

  async enrichQualifiedConnectedAccountCredentialContext(input: Readonly<{
    account: QualifiedConnectedAccountRef;
    expectedCredentialRevision: ConnectedServiceCredentialRevisionV1;
    signal?: AbortSignal;
  }>): Promise<Readonly<{
    status: 'enriched' | 'unchanged' | 'unavailable';
    credentialRevision?: ConnectedServiceCredentialRevisionV1;
    diagnostic?: Readonly<{ code: string; message?: string }>;
  }>> {
    input.signal?.throwIfAborted();
    const runtime = this.params.qualifiedConnectedAccountRuntime;
    if (!runtime
      || !this.shouldRunQualifiedOperation(input.account, 'credential_read')
      || !this.shouldRunQualifiedOperation(input.account, 'refresh_lease')
      || !this.shouldRunQualifiedOperation(input.account, 'credential_write')) {
      return { status: 'unavailable' };
    }
    try {
      const expectedCredential = await runtime.readCredential({ ...(input.signal ? { signal: input.signal } : {}),
        token: this.params.credentials.token, ref: input.account,
        requestPurpose: 'connected-accounts:qualification',
      });
      if (!expectedCredential
        || qualifiedAccountKey(expectedCredential.ref) !== qualifiedAccountKey(input.account)
        || expectedCredential.revisionSemantics !== 'revisioned'
        || expectedCredential.credentialRevision !== input.expectedCredentialRevision) {
        return { status: 'unavailable' };
      }
      const ownerId = this.params.ownerIdProvider?.()?.trim() || this.params.machineIdProvider().trim();
      if (!ownerId) return { status: 'unavailable' };
      const settlement = await this.refreshQualifiedAccount({
        account: input.account,
        token: this.params.credentials.token,
        ownerId,
        leaseMs: this.params.refreshLeaseMs,
        operationId: randomBytes(16).toString('hex'),
        reason: 'provider_context',
        expectedCredential,
        establishedRuntimeOwner: runtime.establishedRuntimeOwner,
        resolveV4Support: () => peerClassV4Support(runtime.resolvePeerClass()),
        acquireRefreshLease: runtime.acquireRefreshLease,
        mutateCredential: runtime.mutateCredential,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      if (!settlement.basis.isCurrent()) return { status: 'unavailable' };
      // A metadata CAS distributes its revision, but proves neither token rotation
      // nor recovered auth health or quota. Those remain with their existing owners.
      if (settlement.status === 'refreshed') {
        await this.notifyQualifiedConnectedAccountCredentialUpdated(input.account, { reason: 'provider_context' });
        return { status: 'enriched', credentialRevision: settlement.credentialRevision,
          ...(settlement.result.diagnostic ? { diagnostic: settlement.result.diagnostic } : {}) };
      }
      if (settlement.status === 'unchanged') {
        return { status: 'unchanged', credentialRevision: settlement.basis.credentialRevision,
          ...(settlement.result.diagnostic ? { diagnostic: settlement.result.diagnostic } : {}) };
      }
      logger.warn('[DAEMON RUN] Qualified Connected Account context enrichment did not settle', {
        service: input.account.service,
        status: settlement.status,
        ...(settlement.result.diagnostic?.code ? {
          diagnosticCode: sanitizeConnectedServiceDiagnosticError(settlement.result.diagnostic.code, {
            redactedValues: [input.account.accountId],
          }),
        } : {}),
      });
      return { status: 'unavailable' };
    } catch (error) {
      input.signal?.throwIfAborted();
      logger.warn('[DAEMON RUN] Qualified Connected Account context enrichment did not settle', {
        service: input.account.service,
        error: sanitizeConnectedServiceDiagnosticError(error, { redactedValues: [input.account.accountId] }),
      });
      return { status: 'unavailable' };
    }
  }

  async refreshQualifiedConnectedAccountCredentialForRequestAuth(input: Readonly<{
    account: QualifiedConnectedAccountRef;
    expectedCredentialRevision: ConnectedServiceCredentialRevisionV1;
    signal?: AbortSignal;
  }>): Promise<boolean> {
    return (await this.refreshQualifiedCredential(input)).status === 'refreshed';
  }

  async refreshQualifiedConnectedAccountCredentialForSpawnPreflight(input: Readonly<{
    profile: QualifiedConnectedAccountProfileV4;
    /** A replaced request-auth token may refresh only after independent expiry. */
    allowEarlyRefresh?: boolean;
  }>): Promise<QualifiedConnectedAccountSpawnPreflightResult> {
    const profile = input.profile;
    if (profile.status === 'needs_reauth') return { status: 'reconnect_required', reconnectCause: 'listed_needs_reauth' };
    if (profile.revisionSemantics !== 'revisioned') return { status: 'refresh_failed' };
    let readyProfile = profile;
    // Qualified metadata drives the same coordinator-owned refresh window as
    // legacy spawn. Never reverse-project a device/OAuth mode into a V2 record.
    const expiresAt = typeof profile.expiresAt === 'number' && Number.isFinite(profile.expiresAt)
      ? profile.expiresAt : null;
    // Non-expiring tokens are delivered as-is. A transient identity/SCM probe
    // failure is not evidence that their credential needs refresh or reconnect.
    if (profile.kind === 'token' && expiresAt === null) {
      return { status: 'ready', profile: { ...profile, status: 'connected' } };
    }
    let refreshNeeded = expiresAt !== null && expiresAt - this.params.now()
      <= (input.allowEarlyRefresh === false ? 0 : this.params.refreshWindowMs);
    if (expiresAt === null || profile.status === 'refresh_failed_retryable') {
      const runtime = this.params.qualifiedConnectedAccountRuntime;
      if (!runtime || !this.shouldRunQualifiedOperation(profile.ref, 'credential_health')) {
        return { status: 'refresh_failed' };
      }
      try {
        if (await observeCurrentConnectedServiceMaterializationPhase('refresh_reconnect_inventory',
          () => this.isQualifiedReconnectRequired(profile.ref, profile.credentialRevision))) {
          return { status: 'reconnect_required', reconnectCause: 'stored_health_rejected' };
        }
        // Native OAuth profiles need not project their expiry into metadata.
        // The established plugin status still observes that exact credential.
        const invocation = await observeCurrentConnectedServiceMaterializationPhase('refresh_status_invocation',
          () => runtime.establishedRuntimeOwner.invokeWithReceipt({
          account: profile.ref,
          expectedCredentialRevision: profile.credentialRevision,
          operation: Object.freeze({ kind: 'status' as const }),
        }));
        if (invocation.basis.credentialRevision !== profile.credentialRevision
          || invocation.basis.credentialConfigurationRevision !== profile.configurationRevision
          || !invocation.basis.isCurrent()) {
          return { status: 'refresh_failed' };
        }
        const health = buildCredentialHealthFromPluginStatus(invocation.result);
        refreshNeeded = refreshNeeded || invocation.result.status === 'expired';
        // Expiry is an input to refresh, not its outcome. An intermediate
        // health write must not prevent the provider exchange from running.
        if (!refreshNeeded) {
          try {
            const settledRevision = await observeCurrentConnectedServiceMaterializationPhase('refresh_health_settlement',
              () => this.settleQualifiedConnectedAccountHealth({ account: profile.ref, basis: invocation.basis, health, healthWritePath: 'status',
                providerIdentity: invocation.result.status === 'connected' ? invocation.result.providerIdentity : undefined }));
            if (settledRevision !== undefined) readyProfile = { ...readyProfile, credentialRevision: settledRevision };
          } catch (error) {
            if (!health.reconnectRequired || !invocation.basis.isCurrent()) throw error;
            logger.warn('[DAEMON RUN] Qualified Connected Account rejection health did not settle', {
              service: profile.ref.service,
              error: sanitizeConnectedServiceDiagnosticError(error, { redactedValues: [profile.ref.accountId] }),
            });
          }
        }
        if (health.reconnectRequired) return { status: 'reconnect_required' };
        if (!refreshNeeded && health.status !== 'connected') return { status: 'refresh_failed' };
        if (!refreshNeeded) readyProfile = { ...readyProfile, status: 'connected' };
      } catch (error) {
        this.armQualifiedConnectedAccountHealthBackoff(profile.ref);
        logger.warn('[DAEMON RUN] Qualified Connected Account spawn status did not settle', {
          service: profile.ref.service,
          error: sanitizeConnectedServiceDiagnosticError(error, { redactedValues: [profile.ref.accountId] }),
        });
        return { status: 'refresh_failed',
          ...(error instanceof QualifiedConnectedAccountCredentialConflictError
            ? { reason: error.diagnosticCode }
            : isPluginError(error) && error.code === 'project_requester_home_unavailable'
              ? { reason: error.code } : {}),
        };
      }
    }
    if (!refreshNeeded) {
      return { status: 'ready', profile: readyProfile };
    }
    const result = await this.refreshQualifiedCredential({
      account: profile.ref,
      expectedCredentialRevision: profile.credentialRevision,
    });
    if (result.status === 'refreshed' || result.status === 'unchanged') {
      return { status: 'ready', profile: { ...profile, ...result.metadata,
        status: 'connected', credentialRevision: result.credentialRevision } };
    }
    return { status: result.status,
      ...('reason' in result && result.reason ? { reason: result.reason } : {}),
      ...('reconnectCause' in result && result.reconnectCause ? { reconnectCause: result.reconnectCause } : {}),
    };
  }

  private async refreshQualifiedCredential(input: Readonly<{
    account: QualifiedConnectedAccountRef;
    expectedCredentialRevision: ConnectedServiceCredentialRevisionV1;
    signal?: AbortSignal;
  }>): Promise<Readonly<{
    status: 'refreshed' | 'unchanged';
    credentialRevision: ConnectedServiceCredentialRevisionV1;
    metadata: QualifiedConnectedAccountCredentialSnapshotV4['metadata'];
  }> | Readonly<{
    status: 'reconnect_required' | 'refresh_failed';
    reason?: QualifiedConnectedAccountRefreshLeaseError['code'];
    reconnectCause?: ConnectedServiceCredentialReconnectCauseV1;
  }>> {
    input.signal?.throwIfAborted();
    const runtime = this.params.qualifiedConnectedAccountRuntime;
    if (
      !runtime
      || !this.shouldRunQualifiedOperation(input.account, 'credential_read')
      || !this.shouldRunQualifiedOperation(input.account, 'oauth_refresh')
      || !this.shouldRunQualifiedOperation(input.account, 'refresh_lease')
      || !this.shouldRunQualifiedOperation(input.account, 'credential_write')
    ) {
      return { status: 'refresh_failed' };
    }
    const expectedCredential = await runtime.readCredential({
      token: this.params.credentials.token,
      ref: input.account,
      requestPurpose: 'connected-accounts:qualification',
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (
      !expectedCredential
      || qualifiedAccountKey(expectedCredential.ref)
        !== qualifiedAccountKey(input.account)
      || expectedCredential.revisionSemantics !== 'revisioned'
      || expectedCredential.credentialRevision
        !== input.expectedCredentialRevision
    ) {
      return { status: 'refresh_failed' };
    }
    const ownerId =
      this.params.ownerIdProvider?.()?.trim()
      || this.params.machineIdProvider().trim();
    if (!ownerId) return { status: 'refresh_failed' };
    try {
      if (await this.isQualifiedReconnectRequired(input.account, input.expectedCredentialRevision, input.signal)) {
        return { status: 'reconnect_required', reconnectCause: 'stored_health_rejected' };
      }
      const settlement = await this.refreshQualifiedAccount({
        account: input.account,
        ...(input.signal ? { signal: input.signal } : {}),
        token: this.params.credentials.token,
        ownerId,
        leaseMs: this.params.refreshLeaseMs,
        operationId: randomBytes(16).toString('hex'),
        expectedCredential,
        establishedRuntimeOwner: runtime.establishedRuntimeOwner,
        resolveV4Support: () =>
          peerClassV4Support(runtime.resolvePeerClass()),
        acquireRefreshLease: runtime.acquireRefreshLease,
        mutateCredential: runtime.mutateCredential,
      });
      if (
        settlement.basis.credentialRevision
          !== input.expectedCredentialRevision
        || (settlement.status !== 'refreshed' && !settlement.basis.isCurrent())
      ) {
        return { status: 'refresh_failed' };
      }
      const health = buildCredentialHealthFromPluginRefresh(settlement, this.params.now());
      const settlementSignal = settlement.status === 'refreshed' ? undefined : input.signal;
      try {
        await this.settleQualifiedConnectedAccountHealth({
          account: input.account,
          basis: settlement.basis,
          health,
          ...(settlement.status === 'refreshed'
            ? { settledCredentialRevision: settlement.credentialRevision } : {}),
        }, settlementSignal);
      } catch (error) {
        settlementSignal?.throwIfAborted();
        // Diagnostic persistence cannot change the observed provider outcome.
        // The health CAS targets the exact revision returned by credential settlement.
        logger.warn('[DAEMON RUN] Qualified Connected Account refresh health did not settle', {
          service: input.account.service,
          error: sanitizeConnectedServiceDiagnosticError(error, { redactedValues: [input.account.accountId] }),
        });
        if (settlement.status !== 'refreshed' && !settlement.basis.isCurrent()) return { status: 'refresh_failed' };
      }
      if (settlement.status === 'refreshed') {
        this.resetQualifiedConnectedAccountHealthBackoff(input.account);
        await this.notifyQualifiedConnectedAccountCredentialUpdated(input.account);
        return { status: 'refreshed', credentialRevision: settlement.credentialRevision, metadata: settlement.metadata };
      }
      if (settlement.status === 'unchanged') {
        this.resetQualifiedConnectedAccountHealthBackoff(input.account);
        return { status: 'unchanged', credentialRevision: input.expectedCredentialRevision, metadata: expectedCredential.metadata };
      }
      this.armQualifiedConnectedAccountHealthBackoff(input.account);
      return { status: health.reconnectRequired ? 'reconnect_required' : 'refresh_failed' };
    } catch (error) {
      input.signal?.throwIfAborted();
      this.armQualifiedConnectedAccountHealthBackoff(input.account);
      if (!(error instanceof QualifiedConnectedAccountRefreshSettlementError)) {
        logger.warn(
          '[DAEMON RUN] Qualified Connected Account request-auth refresh did not settle',
          {
            service: input.account.service,
            error: sanitizeConnectedServiceDiagnosticError(error, {
              redactedValues: [input.account.accountId],
            }),
          },
        );
      }
      return { status: 'refresh_failed',
        ...(error instanceof QualifiedConnectedAccountRefreshLeaseError ? { reason: error.code } : {}),
      };
    }
  }

  private async notifyQualifiedConnectedAccountCredentialUpdated(
    account: QualifiedConnectedAccountRef,
    ...options: [options?: Parameters<NonNullable<QualifiedConnectedAccountRefreshRuntime['onCredentialUpdated']>>[1]]
  ): Promise<void> {
    try {
      await this.params.qualifiedConnectedAccountRuntime?.onCredentialUpdated?.(account, ...options);
    } catch (error) {
      // Credential settlement has committed. Applying it to an existing Session
      // can fail resume continuity without invalidating the credential for new work.
      logger.warn('[DAEMON RUN] Qualified Connected Account credential update application failed', {
        service: account.service,
        error: sanitizeConnectedServiceDiagnosticError(error, { redactedValues: [account.accountId] }),
      });
    }
  }

  private async didRegisteredRuntimeAuthSessionAdvanceToAnotherGroupMember(input: Readonly<{
    sessionId: string | null;
    binding: BoundProfile;
  }>): Promise<boolean> {
    if (!input.sessionId) return false;
    const target = this.runtimeRegistry.getBySessionId(input.sessionId);
    const selection = target?.connectedServiceSelections.find(
      (candidate) => candidate.serviceId === input.binding.serviceId,
    );
    if (selection?.kind !== 'group') return false;
    const canonical = await this.refreshCanonicalGroupStateForRefresh({
      serviceId: input.binding.serviceId,
      groupId: selection.groupId,
    });
    return canonical?.activeProfileId != null
      && canonical.activeProfileId !== input.binding.profileId;
  }

  async refreshOpenAiCodexChatGptTokensForBridge(input: Readonly<{
    refreshAttemptId: string;
    selection: CodexChatGptAuthTokensRefreshSelection;
    chatgptPlanType: string | null;
    forceRefresh?: boolean;
    failingAccessTokenFingerprint?: string | null;
    expectedCredentialRevision: ConnectedServiceCredentialRevisionV1;
  }>): Promise<CodexChatGptAuthTokensRefreshResponse> {
    await this.assertAccountRuntimeCurrent();
    const profileId = input.selection.kind === 'profile'
      ? input.selection.profileId
      : input.selection.activeProfileId;
    const binding: BoundProfile = { serviceId: 'openai-codex', profileId };
    const key = bindingKey(binding);
    const refreshAttemptId = input.refreshAttemptId.trim();
    if (!refreshAttemptId) {
      throw new Error('connected_service_refresh_attempt_identity_unavailable');
    }
    const candidate = this.bridgeRefreshAttemptByBinding.get(key);
    const existing = candidate?.kind === 'codex' ? candidate : undefined;
    if (existing) {
      if (existing.refreshAttemptId === refreshAttemptId
        && existing.expectedCredentialRevision !== input.expectedCredentialRevision) {
        throw new Error('connected_service_refresh_attempt_identity_conflict');
      }
      if (existing.expectedCredentialRevision === input.expectedCredentialRevision) {
        if (existing.settlement === 'rejected' && existing.refreshAttemptId !== refreshAttemptId) {
          this.bridgeRefreshAttemptByBinding.delete(key);
          return await this.refreshOpenAiCodexChatGptTokensForBridge(input);
        }
        return await this.runCurrentAccountOperation(() => existing.promise, true);
      }
      // A different revision is not inherently newer. Fence the caller against current
      // authoritative storage before it is allowed to wait on, replace, or delete the retained
      // settlement. This prevents delayed rev1 replay from evicting a pending/fulfilled rev3 owner.
    const currentSource = await this.readCredentialForRefresh({
        api: this.params.api,
        credentials: this.params.credentials,
        binding,
      });
      if (!currentSource || currentSource.credentialRevision !== input.expectedCredentialRevision) {
        throw new Error('connected_service_credential_revision_mismatch');
      }
      await existing.promise.catch(() => undefined);
      if (this.bridgeRefreshAttemptByBinding.get(key) === existing) {
        this.bridgeRefreshAttemptByBinding.delete(key);
      }
      return await this.refreshOpenAiCodexChatGptTokensForBridge(input);
    }
    const promise = this.performOpenAiCodexChatGptTokensBridgeRefresh(input, binding);
    const attempt: {
      kind: 'codex';
      refreshAttemptId: string;
      expectedCredentialRevision: ConnectedServiceCredentialRevisionV1;
      promise: Promise<CodexChatGptAuthTokensRefreshResponse>;
      settlement: 'pending' | 'fulfilled' | 'rejected';
    } = {
      kind: 'codex',
      refreshAttemptId,
      expectedCredentialRevision: input.expectedCredentialRevision,
      promise,
      settlement: 'pending',
    };
    this.bridgeRefreshAttemptByBinding.set(key, attempt);
    void promise.then(
      () => {
        attempt.settlement = 'fulfilled';
      },
      () => {
        attempt.settlement = 'rejected';
      },
    );
    const result = await promise;
    await this.assertAccountRuntimeCurrent();
    return result;
  }

  private async performOpenAiCodexChatGptTokensBridgeRefresh(
    input: Readonly<{
      refreshAttemptId: string;
      selection: CodexChatGptAuthTokensRefreshSelection;
      chatgptPlanType: string | null;
      forceRefresh?: boolean;
      failingAccessTokenFingerprint?: string | null;
      expectedCredentialRevision: ConnectedServiceCredentialRevisionV1;
    }>,
    binding: BoundProfile,
  ): Promise<CodexChatGptAuthTokensRefreshResponse> {

    // F6 conditional refresh: when not forced, return the CURRENT access token if it is OAuth and not
    // within the refresh window of expiry — NO provider call, NO lease, NO rotation. The single-use
    // OAuth refresh token is rotated only near-expiry or when runtime auth forces a 401 retry.
    const currentSource = await this.readCredentialForRefresh({
      api: this.params.api,
      credentials: this.params.credentials,
      binding,
    });
    const current = currentSource?.record.kind === 'oauth' ? currentSource.record : null;
    if (!currentSource || currentSource.revisionSemantics !== 'revisioned' || (
      input.expectedCredentialRevision !== undefined
      && currentSource.credentialRevision !== input.expectedCredentialRevision
    )) {
      throw new Error('connected_service_credential_revision_mismatch');
    }
    if (current) {
      if (input.forceRefresh !== true && this.isOauthRecordStillValidForBridge(current)) {
    const settledCurrentSource = await this.readCredentialForRefresh({
          api: this.params.api,
          credentials: this.params.credentials,
          binding,
        });
        if (
          !settledCurrentSource
          || settledCurrentSource.credentialRevision !== currentSource.credentialRevision
          || settledCurrentSource.record.kind !== 'oauth'
          || settledCurrentSource.record.oauth.accessToken !== current.oauth.accessToken
        ) {
          throw new Error('connected_service_credential_revision_mismatch');
        }
        return {
          accessToken: current.oauth.accessToken,
          chatgptAccountId: current.oauth.providerAccountId,
          chatgptPlanType: input.chatgptPlanType,
          credentialRevision: currentSource.credentialRevision,
        };
      }
      const forcedAdoptDecision = resolveForcedRefreshFreshnessDecision({
        force: input.forceRefresh === true,
        currentTokenAdoptable: this.isOauthRecordAdoptableForForcedBridgeRefresh(current),
        currentDiffersFromFailingToken: (() => {
          const failing = normalizeConnectedServiceAccessTokenFingerprint(input.failingAccessTokenFingerprint);
          return Boolean(
            failing
            && computeConnectedServiceAccessTokenFingerprint(current.oauth.accessToken) !== failing,
          );
        })(),
      });
      if (forcedAdoptDecision.kind === 'adopt_current') {
    const settledCurrentSource = await this.readCredentialForRefresh({
          api: this.params.api,
          credentials: this.params.credentials,
          binding,
        });
        if (
          !settledCurrentSource
          || settledCurrentSource.credentialRevision !== currentSource.credentialRevision
          || settledCurrentSource.record.kind !== 'oauth'
          || settledCurrentSource.record.oauth.accessToken !== current.oauth.accessToken
        ) {
          throw new Error('connected_service_credential_revision_mismatch');
        }
        return {
          accessToken: current.oauth.accessToken,
          chatgptAccountId: current.oauth.providerAccountId,
          chatgptPlanType: input.chatgptPlanType,
          credentialRevision: currentSource.credentialRevision,
        };
      }
    }

    const result = await this.refreshOauthBinding(
      binding,
      this.params.now(),
      {
        force: true,
        reason: 'provider_auth_bridge',
        expectedCredentialRevision: input.expectedCredentialRevision,
      },
    );
    if (result.status !== 'refreshed' || result.credential?.kind !== 'oauth') {
      throw new ConnectedServiceCredentialRefreshError(result.diagnostic);
    }
    // Distribution happens BY CONSTRUCTION on the 'refreshed' completion path (RR-1).

    const persistedSource = await this.readCredentialForRefresh({
      api: this.params.api,
      credentials: this.params.credentials,
      binding,
    });
    if (
      !persistedSource
      || persistedSource.revisionSemantics !== 'revisioned'
      || persistedSource.record.kind !== 'oauth'
      || persistedSource.record.oauth.accessToken !== result.credential.oauth.accessToken
    ) {
      throw new Error('connected_service_credential_revision_settlement_unavailable');
    }
    return {
      accessToken: persistedSource.record.oauth.accessToken,
      chatgptAccountId: persistedSource.record.oauth.providerAccountId,
      chatgptPlanType: input.chatgptPlanType,
      credentialRevision: persistedSource.credentialRevision,
    };
  }

  async refreshClaudeSubscriptionTokensForBridge(input: Readonly<{
    selection: ClaudeSubscriptionAuthTokensRefreshSelection;
    forceRefresh?: boolean;
    shouldAdoptCurrentAccessToken?: (accessToken: string) => boolean;
    expectedCredentialRevision: ConnectedServiceCredentialRevisionV1;
  }>): Promise<ClaudeSubscriptionAuthTokensRefreshResponse> {
    const profileId = input.selection.kind === 'group'
      ? input.selection.activeProfileId
      : input.selection.profileId;
    const binding: BoundProfile = { serviceId: 'claude-subscription', profileId };

    // Read the current credential to branch on kind. Setup-tokens (kind:'token') are non-rotating and
    // returned as-is; OAuth (kind:'oauth') is refreshed through the canonical single-flight refresher so
    // the daemon stays the sole refresher and the rotated refresh token is persisted ONLY in the store.
    const currentSource = await this.readCredentialForRefresh({
      credentials: this.params.credentials,
      api: this.params.api,
      binding,
    });
    if (!currentSource || currentSource.credentialRevision !== input.expectedCredentialRevision) {
      throw new Error('connected_service_credential_revision_mismatch');
    }
    const current = currentSource.record;
    if (current.serviceId !== 'claude-subscription') {
      throw new Error('connected_service_claude_subscription_refresh_unavailable');
    }

    if (current.kind === 'token') {
      return {
        accessToken: current.token.token,
        anthropicAccountId: current.token.providerAccountId,
        expiresAt: null,
      };
    }

    // F6 conditional refresh: when not forced, return the CURRENT OAuth access token if it is not within
    // the refresh window of expiry — NO provider call, NO lease, NO rotation. The single-use refresh
    // token is rotated only near-expiry or when runtime auth forces a 401 retry.
    if (input.forceRefresh !== true && this.isOauthRecordStillValidForBridge(current)) {
      return {
        accessToken: current.oauth.accessToken,
        anthropicAccountId: current.oauth.providerAccountId,
        expiresAt: current.expiresAt ?? null,
      };
    }

    // Adopt-fresh-first (CLOSE-18): on a forced (reactive) refresh, adopt the current store token
    // instead of burning the refresh token whenever it is still usable AND differs from the failing
    // token. Keyed on the failing-token comparison via the canonical decision owner — NOT the
    // refresh-expiry window — so a store token that already rotated (even if now near, but not past,
    // expiry) is adopted instead of triggering another rotation.
    const forcedAdoptDecision = resolveForcedRefreshFreshnessDecision({
      force: input.forceRefresh === true,
      currentTokenAdoptable: this.isOauthRecordAdoptableForForcedBridgeRefresh(current),
      currentDiffersFromFailingToken: input.shouldAdoptCurrentAccessToken?.(current.oauth.accessToken) ?? false,
    });
    if (forcedAdoptDecision.kind === 'adopt_current') {
      return {
        accessToken: current.oauth.accessToken,
        anthropicAccountId: current.oauth.providerAccountId,
        expiresAt: current.expiresAt ?? null,
      };
    }

    const result = await this.refreshOauthBinding(
      binding,
      this.params.now(),
      { force: true, reason: 'provider_auth_bridge' },
    );
    if (result.status !== 'refreshed' || result.credential?.kind !== 'oauth') {
      throw new ConnectedServiceCredentialRefreshError(result.diagnostic);
    }
    // Distribution happens BY CONSTRUCTION on the 'refreshed' completion path (RR-1).

    return {
      accessToken: result.credential.oauth.accessToken,
      anthropicAccountId: result.credential.oauth.providerAccountId,
      expiresAt: result.credential.expiresAt ?? null,
    };
  }

  /**
   * F6 helper: true when an OAuth credential's access token is still valid for the bridge (a finite
   * expiry strictly outside the refresh window). Mirrors the `force:false` not-needed gate in
   * `refreshOauthBindingUnserialized`. A null/non-finite expiry is treated as NOT safely reusable (the
   * caller falls through to a refresh) so an unknown-expiry token is never served stale.
   */
  private isOauthRecordStillValidForBridge(record: ConnectedServiceCredentialRecordV1): boolean {
    if (record.kind !== 'oauth') return false;
    const expiresAt = record.expiresAt;
    if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return false;
    return expiresAt - this.params.now() > this.params.refreshWindowMs;
  }

  /**
   * Adoptability gate for adopt-fresh-first (CLOSE-18) on the FORCED bridge-refresh path: an OAuth
   * record is adoptable when it is not PAST expiry. Unlike `isOauthRecordStillValidForBridge`, this
   * is intentionally window-independent — a store token that already rotated but sits inside the
   * refresh window is still worth adopting to avoid burning the refresh token on a concurrent 401
   * retry. A truly expired (or unknown-expiry) token is not adoptable and falls through to rotation.
   */
  private isOauthRecordAdoptableForForcedBridgeRefresh(record: ConnectedServiceCredentialRecordV1): boolean {
    if (record.kind !== 'oauth') return false;
    const expiresAt = record.expiresAt;
    if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return false;
    return expiresAt > this.params.now();
  }

  private async maybeRefreshBinding(binding: BoundProfile, now: number, scheduledStatus?: ScheduledStatusInvocation, signal?: AbortSignal): Promise<ConnectedServiceCredentialRefreshResult> {
    signal?.throwIfAborted();
    const result = await this.refreshOauthBinding(binding, now, { reason: 'scheduled', scheduledStatus }, signal);
    if (result.status === 'refresh_failed') {
      throw new Error(`Connected services refresh failed (${binding.serviceId}/${binding.profileId}): ${result.diagnostic.category ?? 'unknown'}`);
    }
    if (result.status !== 'refreshed') {
      if (result.status !== 'not_needed') return result;
      const rematerialization = await this.maybeRematerializeStaleMaterializedHomesForFreshStoreBinding(binding, signal);
      if (!rematerialization || rematerialization.rematerializedTargets.length === 0) return result;
      await this.notifyAuthUpdatedForRefreshedBinding(binding, rematerialization.rematerializedTargets, signal);
      return result;
    }
    // A 'refreshed' result already rematerialized + notified BY CONSTRUCTION on the completion path (RR-1).
    return result;
  }

  private async maybeRematerializeStaleMaterializedHomesForFreshStoreBinding(
    binding: BoundProfile, signal?: AbortSignal,
  ): Promise<RematerializedTargetsResult | null> {
    signal?.throwIfAborted();
    const affected = this.runtimeRegistry.listRefreshTargets().filter((target) =>
      this.resolveBoundProfiles(target).some((candidate) =>
        candidate.serviceId === binding.serviceId && candidate.profileId === binding.profileId,
      ),
    );
    for (const rawTarget of affected) {
      const target = await this.canonicalizeTargetSelectionsForRefresh(rawTarget, signal);
      if (!target) continue;
      const targetBinding = this.resolveBoundProfiles(target).find((candidate) =>
        candidate.serviceId === binding.serviceId,
      ) ?? binding;
    const source = await this.readCredentialForRefresh({
        api: this.params.api,
        credentials: this.params.credentials,
        binding: targetBinding,
      }, signal);
      if (!source || source.record.kind !== 'oauth') continue;
      if (!this.isOauthRecordStillValidForBridge(source.record)) continue;
      const freshness = await getConnectedServiceMaterializedHomeFreshness(target.agentId);
      signal?.throwIfAborted();
      if (!freshness) continue;
      const fallbackMaterializedRootDir = resolveConnectedServiceMaterializedRootDir({
        baseDir: this.params.baseDir,
        agentId: target.agentId,
        materializationKey: target.materializationKey,
      });
      const materializedRootDir = await this.resolveMaterializedHomeRootForTarget({
        target,
        binding: targetBinding,
      }, signal) ?? fallbackMaterializedRootDir;
      let stale = false;
      try {
        stale = await freshness.isMaterializedHomeStale({
          serviceId: targetBinding.serviceId,
          materializedRootDir,
          record: source.record,
          now: this.params.now(),
          refreshWindowMs: this.params.refreshWindowMs,
        });
        signal?.throwIfAborted();
      } catch (error) {
        signal?.throwIfAborted();
        logger.debug('[ConnectedServiceRefreshCoordinator] materialized home freshness check failed; rematerializing target', {
          serviceId: binding.serviceId,
          agentId: target.agentId,
          error: sanitizeConnectedServiceDiagnosticError(error, {
            redactedValues: [binding.profileId],
          }),
        });
        stale = true;
      }
      if (stale) {
        return await this.rematerializeTargetsForBindingAfterRefresh(binding, signal);
      }
    }
    return null;
  }

  private async refreshOauthBinding(
    binding: BoundProfile,
    now: number,
    options: Readonly<{
      force?: boolean;
      reason: ConnectedServiceCredentialRefreshReason;
      expectedCredentialRevision?: ConnectedServiceCredentialRevisionV1;
      adoptCredentialReadyFromInFlightRefresh?: boolean;
      scheduledStatus?: ScheduledStatusInvocation;
    }>, signal?: AbortSignal,
  ): Promise<ConnectedServiceCredentialRefreshResult> {
    signal?.throwIfAborted();
    await this.assertAccountRuntimeCurrent(signal);
    // Coalesce + serialize the credential rotation per `{serviceId, profileId}` binding (NOT split on
    // `force`). Downstream distribution is deliberately tracked as a separate completion: a restarted
    // runner's spawn preflight may need the credential that the owner has already persisted while that
    // same owner is waiting for the runner to respawn before distribution can finish. Making the
    // credential-ready result wait on distribution creates a circular wait and poisons the daemon's
    // global spawn gate. The initiating caller still owns and awaits the one distribution transaction;
    // only a joining spawn preflight may adopt the already-persisted rotation early.
    const key = bindingKey(binding);
    while (true) {
      const existing = this.inFlightRefreshes.get(key);
      if (existing?.kind === 'binding') {
        // A rejecting credential rotation represents an attempt that re-running concurrently would
        // not improve; every joiner adopts the same rejection rather than firing a duplicate refresh.
        const observed = await (signal ? waitForSharedOperation(existing.credentialReady, signal) : existing.credentialReady);
        if (inFlightResultSatisfiesCaller(observed, options)) {
          const result = options.adoptCredentialReadyFromInFlightRefresh === true && observed.status === 'refreshed'
            ? observed
            : await (signal ? waitForSharedOperation(existing.completion, signal) : existing.completion);
          await this.assertAccountRuntimeCurrent(signal);
          return result;
        }
        // Preserve the existing serialized forced-after-non-forced contract: health persistence and
        // any non-rotation completion work settle before the forced retry re-reads canonical state.
        await (signal ? waitForSharedOperation(existing.completion, signal) : existing.completion);
        continue;
      }

      const credentialReady = this.refreshOauthBindingUnserialized(binding, now, options, signal);
      const completion = credentialReady.then(async (result) => await this.finalizeRefreshResult(
        binding,
        result, result.status === 'refreshed' ? undefined : signal,
      ));
      const inFlight = { kind: 'binding', credentialReady, completion } as const;
      this.inFlightRefreshes.set(key, inFlight);
      try {
        const result = await completion;
        await this.assertAccountRuntimeCurrent(signal);
        return result;
      } finally {
        if (this.inFlightRefreshes.get(key) === inFlight) {
          this.inFlightRefreshes.delete(key);
        }
      }
    }
  }

  private async refreshQualifiedAccount(
    input: Parameters<typeof refreshQualifiedConnectedAccount>[0] & Required<Pick<
      Parameters<typeof refreshQualifiedConnectedAccount>[0], 'acquireRefreshLease'
    >>,
  ): Promise<QualifiedConnectedAccountRefreshSettlement> {
    const signal = input.signal;
    signal?.throwIfAborted();
    // Every qualified entry point (including a legacy binding) joins the same
    // provider exchange and CAS. Binding completion still owns distribution;
    // it must not hold up credential-ready spawn preflights that join here.
    const key = JSON.stringify(['qualified', qualifiedAccountKey(input.account), input.expectedCredential.credentialRevision]);
    const existing = this.inFlightRefreshes.get(key);
    if (existing?.kind === 'qualified') {
      if (existing.reason === input.reason) return await (signal ? waitForSharedOperation(existing.completion, signal) : existing.completion);
      await (signal ? waitForSharedOperation(existing.completion, signal) : existing.completion);
      if (this.inFlightRefreshes.get(key) === existing) this.inFlightRefreshes.delete(key);
      // A joined token exchange may already provide context. Re-enter the explicit
      // optional operation against its settled revision; the plugin decides whether
      // provider metadata is still missing. Never count a context CAS as rotation.
      const current = await this.params.qualifiedConnectedAccountRuntime?.readCredential({
        token: input.token, ref: input.account,
        requestPurpose: 'connected-accounts:qualification',
        ...(signal ? { signal } : {}),
      });
      if (!current || current.revisionSemantics !== 'revisioned'
        || (input.reason !== 'provider_context'
          && current.credentialRevision !== input.expectedCredential.credentialRevision)) {
        throw new Error('connected_service_credential_revision_mismatch');
      }
      return await this.refreshQualifiedAccount({ ...(signal ? { signal } : {}), ...input, expectedCredential: current });
    }
    const acquireRefreshLease = input.acquireRefreshLease;
    const completion = refreshQualifiedConnectedAccount({
      ...input,
      ...(acquireRefreshLease ? {
        acquireRefreshLease: async (request: Parameters<typeof acquireRefreshLease>[0]) => {
          const lease = await acquireRefreshLease(request);
          logger.debug('[ConnectedServiceRefreshCoordinator] refresh lease', {
            account: input.account,
            credentialRevision: input.expectedCredential.credentialRevision,
            configurationRevision: input.expectedCredential.configurationRevision,
            machineId: this.params.machineIdProvider(), ownerId: input.ownerId,
            acquired: lease.acquired, leaseOwnerId: lease.ownerId,
            leaseCredentialRevision: lease.credentialRevision,
          });
          return lease;
        },
      } : {}),
    });
    const inFlight = { kind: 'qualified', reason: input.reason, completion } as const;
    this.inFlightRefreshes.set(key, inFlight);
    try {
      return await completion;
    } catch (error) {
      // Observe the shared exchange once, before any caller propagates cancellation.
      if (error instanceof QualifiedConnectedAccountRefreshSettlementError) {
        logger.warn('[DAEMON RUN] Qualified Connected Account refresh did not settle', {
          account: input.account,
          credentialRevision: input.expectedCredential.credentialRevision,
          providerExchange: error.providerExchange,
          persistenceOutcome: error.persistenceOutcome,
          error: sanitizeConnectedServiceDiagnosticError(error, { redactedValues: [input.account.accountId] }),
        });
      }
      throw error;
    } finally {
      if (this.inFlightRefreshes.get(key) === inFlight) {
        this.inFlightRefreshes.delete(key);
      }
    }
  }

  private async isQualifiedReconnectRequired(
    account: QualifiedConnectedAccountRef,
    credentialRevision?: ConnectedServiceCredentialRevisionV1, signal?: AbortSignal,
  ): Promise<boolean> {
    signal?.throwIfAborted();
    const credential = await this.params.qualifiedConnectedAccountRuntime?.readCredential({
      token: this.params.credentials.token,
      ref: account,
      requestPurpose: 'connected-accounts:qualification',
      ...(signal ? { signal } : {}),
    });
    return credential != null
      && qualifiedAccountKey(credential.ref) === qualifiedAccountKey(account)
      && (!credentialRevision || (credential.revisionSemantics === 'revisioned' && credential.credentialRevision === credentialRevision))
      && (credential.health?.reconnectRequired === true || isReconnectRequiredProfileStatus(credential.health?.status));
  }

  private shouldDeferCredentialHealthReprobe(
    binding: BoundProfile,
    now: number,
    options: Readonly<{ force?: boolean; reason: ConnectedServiceCredentialRefreshReason }>,
  ): boolean {
    if (!canReprobeCredentialHealth(options.reason, options)) return true;
    const state = this.credentialHealthReprobeState.get(bindingKey(binding));
    return Boolean(state && now < state.nextProbeAt);
  }

  private resetCredentialHealthReprobe(binding: BoundProfile): void {
    this.credentialHealthReprobeState.delete(bindingKey(binding));
  }

  private armCredentialHealthReprobeBackoff(binding: BoundProfile): void {
    const key = bindingKey(binding);
    this.credentialHealthReprobeState.set(key, {
      nextProbeAt: this.params.now() + this.healthProbeIntervalMs,
    });
  }

  private async probeQualifiedConnectedAccountStatus(
    binding: BoundProfile,
    now: number,
    options: Readonly<{
      force?: boolean;
      reason: ConnectedServiceCredentialRefreshReason;
      expectedCredentialRevision?: ConnectedServiceCredentialRevisionV1;
      scheduledStatus?: ScheduledStatusInvocation;
      refreshPending?: boolean;
    }>, signal?: AbortSignal,
  ): Promise<QualifiedConnectedAccountStatusProbeOutcome> {
    signal?.throwIfAborted();
    const runtime = this.params.qualifiedConnectedAccountRuntime;
    if (!runtime) return { status: 'unavailable' };
    const peerClass = runtime.resolvePeerClass();
    if (
      peerClass === 'exact_v0_2_1'
      || peerClass === 'revisioned_v2_v3'
    ) {
      return { status: 'not_configured' };
    }
    if (peerClass === 'indeterminate') return { status: 'unavailable' };
    if (!shouldReadCredentialHealthForRefresh(options.reason)) {
      return { status: 'not_eligible' };
    }
    if (
      this.credentialHealthReprobeState.has(bindingKey(binding))
      && this.shouldDeferCredentialHealthReprobe(binding, now, options)
    ) {
      return { status: 'deferred' };
    }

    const compatibility =
      BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID[
        binding.serviceId
      ];
    const account = Object.freeze({
      service: compatibility.service,
      accountId: binding.profileId,
    });
    if (!this.shouldRunQualifiedOperation(
      account,
      'credential_health',
    )) {
      return { status: 'unavailable' };
    }
    try {
      if (await this.isQualifiedReconnectRequired(account, options.expectedCredentialRevision, signal)) {
        this.armCredentialHealthReprobeBackoff(binding);
        return { status: 'settled', reconnectRequired: true };
      }
      const invocation = options.scheduledStatus ? await options.scheduledStatus() : await runtime.establishedRuntimeOwner.invokeWithReceipt({ ...(signal ? { signal } : {}),
        account,
        operation: Object.freeze({ kind: 'status' as const }),
      });
      if (
        options.expectedCredentialRevision
        && invocation.basis.credentialRevision
          !== options.expectedCredentialRevision
      ) {
        throw new Error('connected_service_credential_revision_mismatch');
      }
      const health = buildCredentialHealthFromPluginStatus(invocation.result);
      if (!invocation.basis.isCurrent()) {
        throw new Error(
          'Qualified Connected Account status generation is no longer current',
        );
      }
      if (!options.refreshPending || health.reconnectRequired) {
        await this.settleQualifiedConnectedAccountHealth({ account, basis: invocation.basis, health, healthWritePath: 'status',
          providerIdentity: invocation.result.status === 'connected' ? invocation.result.providerIdentity : undefined }, signal);
      }
      if (health.reconnectRequired) {
        this.armCredentialHealthReprobeBackoff(binding);
      } else if (health.status === 'connected') {
        this.resetCredentialHealthReprobe(binding);
      } else {
        this.armCredentialHealthReprobeBackoff(binding);
      }
      return {
        status: 'settled',
        reconnectRequired: health.reconnectRequired,
        ...(options.refreshPending && !health.reconnectRequired ? {
          settleDeferredHealth: async () => { await this.settleQualifiedConnectedAccountHealth({
            account, basis: invocation.basis, health, healthWritePath: 'status',
            providerIdentity: invocation.result.status === 'connected' ? invocation.result.providerIdentity : undefined,
          }, signal); },
        } : {}),
      };
    } catch (error) {
      signal?.throwIfAborted();
      if (
        error instanceof Error
        && error.message === 'connected_service_credential_revision_mismatch'
      ) {
        throw error;
      }
      this.armCredentialHealthReprobeBackoff(binding);
      logger.warn(
        '[DAEMON RUN] Qualified Connected Account status probe did not settle',
        {
          serviceId: binding.serviceId,
          reason: options.reason,
          error: sanitizeConnectedServiceDiagnosticError(error, {
            redactedValues: [binding.profileId],
          }),
        },
      );
      return { status: 'unavailable' };
    }
  }

  private async settleQualifiedConnectedAccountHealth(input: QualifiedHealthSettlementInput, signal?: AbortSignal): Promise<ConnectedServiceCredentialRevisionV1 | undefined> {
    signal?.throwIfAborted();
    const runtime = this.params.qualifiedConnectedAccountRuntime;
    if (
      !runtime
      || (input.settledCredentialRevision === undefined
        && (!input.basis.isCurrent()
          || !this.shouldRunQualifiedOperation(input.account, 'credential_health')))
    ) {
      throw new Error(
        'Qualified Connected Account health settlement basis is no longer current',
      );
    }
    const credentialRevision = await settleQualifiedHealth(input, { runtime, token: this.params.credentials.token }, signal);
    if (credentialRevision !== undefined) {
      const key = `qualified:${qualifiedAccountKey(input.account)}`;
      const scheduled = this.scheduledHealthProbeAtByKey.get(key);
      if (scheduled?.credentialRevision === input.basis.credentialRevision
        && scheduled.configurationRevision === input.basis.credentialConfigurationRevision) {
        this.scheduledHealthProbeAtByKey.set(key, { ...scheduled, credentialRevision });
      }
    }
    if (input.healthWritePath !== 'status'
      && (input.health.status === 'needs_reauth' || input.health.status === 'refresh_failed_retryable')) {
      await this.notifyCredentialHealth({
        serviceId: buildQualifiedPluginContributionKey(input.account.service),
        profileId: input.account.accountId,
        status: input.health.status === 'needs_reauth' ? 'blocked_by_credential_health' : 'refresh_failed',
        category: input.health.lastRefreshFailureKind ?? 'unknown',
        providerStatus: input.health.providerHttpStatus,
        providerErrorCode: input.health.providerErrorCode,
      }, input.health.status === 'needs_reauth' ? 'reconnect_required' : 'refresh_failed_retryable', signal);
    }
    return credentialRevision;
  }

  private async refreshQualifiedLegacyBinding(
    binding: BoundProfile,
    source: RevisionedConnectedServiceCredentialSource,
    now: number,
    options: Readonly<{
      force?: boolean;
      reason: ConnectedServiceCredentialRefreshReason;
      expectedCredentialRevision?: ConnectedServiceCredentialRevisionV1;
      scheduledStatus?: ScheduledStatusInvocation;
    }>, signal?: AbortSignal,
  ): Promise<ConnectedServiceCredentialRefreshResult | null> {
    signal?.throwIfAborted();
    const runtime = this.params.qualifiedConnectedAccountRuntime;
    if (!runtime) {
      return {
        status: 'blocked_by_credential_health',
        credential: null,
        diagnostic: buildRefreshDiagnostic({
          binding,
          reason: options.reason,
          status: 'blocked_by_credential_health',
          expiresAt: source.expiresAt,
          now,
          refreshWindowMs: this.params.refreshWindowMs,
        }),
      };
    }
    const peerClass = runtime.resolvePeerClass();
    if (
      peerClass === 'indeterminate'
      || peerClass === 'exact_v0_2_1'
    ) {
      return {
        status: 'blocked_by_credential_health',
        credential: null,
        diagnostic: buildRefreshDiagnostic({
          binding,
          reason: options.reason,
          status: 'blocked_by_credential_health',
          expiresAt: source.expiresAt,
          now,
          refreshWindowMs: this.params.refreshWindowMs,
        }),
      };
    }
    const refreshNeeded = options.force === true || (
      typeof source.expiresAt === 'number' && Number.isFinite(source.expiresAt)
      && source.expiresAt - now <= this.params.refreshWindowMs
    );
    const qualifiedStatus = await this.probeQualifiedConnectedAccountStatus(
      binding,
      now,
      { ...options, refreshPending: refreshNeeded }, signal,
    );
    if (
      (qualifiedStatus.status !== 'settled' && qualifiedStatus.status !== 'not_eligible')
      || (qualifiedStatus.status === 'settled' && qualifiedStatus.reconnectRequired)
    ) {
      return {
        status: 'blocked_by_credential_health',
        credential: null,
        diagnostic: buildRefreshDiagnostic({
          binding,
          reason: options.reason,
          status: 'blocked_by_credential_health',
          expiresAt: source.expiresAt,
          now,
          refreshWindowMs: this.params.refreshWindowMs,
        }),
      };
    }
    if (!refreshNeeded) {
      return {
        status: 'not_needed',
        credential: null,
        credentialRevision: source.credentialRevision,
        diagnostic: buildRefreshDiagnostic({
          binding,
          reason: options.reason,
          status: 'not_needed',
          expiresAt: source.expiresAt,
          now,
          refreshWindowMs: this.params.refreshWindowMs,
        }),
      };
    }
    let settleDeferredHealth = qualifiedStatus.status === 'settled'
      ? qualifiedStatus.settleDeferredHealth : undefined;
    try {
      const compatibility =
        BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID[
          binding.serviceId
        ];
      const account = Object.freeze({
        service: compatibility.service,
        accountId: binding.profileId,
      });
      const expectedCredential = await runtime.readCredential({ ...(signal ? { signal } : {}),
        token: this.params.credentials.token,
        ref: account,
        requestPurpose: 'connected-accounts:qualification',
      });
      if (!expectedCredential) {
        return {
          status: 'credential_missing',
          credential: null,
          diagnostic: buildRefreshDiagnostic({
            binding,
            reason: options.reason,
            status: 'credential_missing',
            expiresAt: source.expiresAt,
            now,
            refreshWindowMs: this.params.refreshWindowMs,
          }),
        };
      }
      if (
        options.expectedCredentialRevision
        && expectedCredential.credentialRevision
          !== options.expectedCredentialRevision
      ) {
        throw new Error('connected_service_credential_revision_mismatch');
      }
      const ownerId =
        this.params.ownerIdProvider?.()?.trim()
        || this.params.machineIdProvider().trim();
      if (!ownerId) {
        return {
          status: 'lease_not_acquired',
          credential: null,
          ...(expectedCredential.revisionSemantics === 'revisioned'
            ? { credentialRevision: expectedCredential.credentialRevision }
            : {}),
          diagnostic: buildRefreshDiagnostic({
            binding,
            reason: options.reason,
            status: 'lease_not_acquired',
            expiresAt: source.expiresAt,
            now,
            refreshWindowMs: this.params.refreshWindowMs,
          }),
        };
      }
      let settlement: QualifiedConnectedAccountRefreshSettlement | undefined;
      try {
        settlement = await this.refreshQualifiedAccount({ ...(signal ? { signal } : {}),
          account,
          token: this.params.credentials.token,
          ownerId,
          leaseMs: this.params.refreshLeaseMs,
          operationId: randomBytes(16).toString('hex'),
          expectedCredential,
          establishedRuntimeOwner: runtime.establishedRuntimeOwner,
          resolveV4Support: () =>
            peerClassV4Support(runtime.resolvePeerClass()),
          acquireRefreshLease: runtime.acquireRefreshLease,
          mutateCredential: runtime.mutateCredential,
        });
        settleDeferredHealth = undefined;
        if (
          options.expectedCredentialRevision
          && settlement.basis.credentialRevision
            !== options.expectedCredentialRevision
        ) {
          throw new Error('connected_service_credential_revision_mismatch');
        }
        if (settlement.status === 'refreshed') {
          const persisted = await this.readCredentialForRefresh({
            api: this.params.api,
            credentials: this.params.credentials,
            binding,
          });
          if (
            !persisted
            || persisted.revisionSemantics !== 'revisioned'
            || persisted.credentialRevision
              !== settlement.credentialRevision
          ) {
            throw new Error(
              'Qualified Connected Account refreshed credential is unavailable through the compatibility reader',
            );
          }
          this.resetCredentialHealthReprobe(binding);
          return {
            status: 'refreshed',
            credential: persisted.record,
            credentialRevision: persisted.credentialRevision,
            diagnostic: buildRefreshDiagnostic({
              binding,
              reason: options.reason,
              status: 'refreshed',
              expiresAt: persisted.expiresAt,
              now,
              refreshWindowMs: this.params.refreshWindowMs,
            }),
          };
        }
        if (settlement.status === 'unchanged') {
          await this.settleQualifiedConnectedAccountHealth({
            account, basis: settlement.basis,
            health: buildCredentialHealthFromPluginRefresh(settlement, this.params.now()),
          }, signal);
          this.resetCredentialHealthReprobe(binding);
          return {
            status: 'not_needed',
            credential: null,
            credentialRevision: source.credentialRevision,
            diagnostic: buildRefreshDiagnostic({
              binding,
              reason: options.reason,
              status: 'not_needed',
              expiresAt: source.expiresAt,
              now,
              refreshWindowMs: this.params.refreshWindowMs,
            }),
          };
        }
        const health = buildCredentialHealthFromPluginRefresh(settlement, this.params.now());
        if (health.reconnectRequired) {
          await this.settleQualifiedConnectedAccountHealth({ account, basis: settlement.basis, health }, signal);
          this.armCredentialHealthReprobeBackoff(binding);
        }
        const result: ConnectedServiceCredentialRefreshResult = {
          status: health.reconnectRequired
            ? 'blocked_by_credential_health'
            : 'refresh_failed',
          credential: null,
          credentialRevision: source.credentialRevision,
          diagnostic: buildRefreshDiagnostic({
            binding,
            reason: options.reason,
            status: health.reconnectRequired
              ? 'blocked_by_credential_health'
              : 'refresh_failed',
            category: 'unknown',
            providerStatus: health.providerHttpStatus,
            providerErrorCode: health.providerErrorCode,
            expiresAt: source.expiresAt,
            now,
            refreshWindowMs: this.params.refreshWindowMs,
          }),
        };
        return result;
      } catch (error) {
        signal?.throwIfAborted();
        if (
          error instanceof Error
          && error.message === 'connected_service_credential_revision_mismatch'
        ) {
          throw error;
        }
        // Another controller may have consumed the lease basis. Adopt its exact
        // current credential only when this caller did not supply a revision
        // fence and the actual usable access token changed; never replay the
        // predecessor or treat revision-only ABA after our own committed
        // rotation as a successful refresh.
        if (settlement?.status !== 'refreshed'
          && !options.expectedCredentialRevision && source.record.kind === 'oauth') {
          try {
            const current = await this.readCredentialForRefresh({
              api: this.params.api, credentials: this.params.credentials, binding,
            }, signal);
            if (current?.revisionSemantics === 'revisioned'
              && current.credentialRevision !== source.credentialRevision
              && current.record.kind === 'oauth'
              && resolveForcedRefreshFreshnessDecision({
                force: true,
                currentTokenAdoptable: this.isOauthRecordAdoptableForForcedBridgeRefresh(current.record),
                currentDiffersFromFailingToken: current.record.oauth.accessToken !== source.record.oauth.accessToken,
              }).kind === 'adopt_current') {
              settleDeferredHealth = undefined;
              this.resetCredentialHealthReprobe(binding);
              return {
                status: 'refreshed', credential: current.record, credentialRevision: current.credentialRevision,
                diagnostic: buildRefreshDiagnostic({
                  binding, reason: options.reason, status: 'refreshed', expiresAt: current.expiresAt,
                  now, refreshWindowMs: this.params.refreshWindowMs,
                }),
              };
            }
          } catch {
            signal?.throwIfAborted();
            // Secondary adoption is best-effort; original settlement stays failed.
          }
        }
        logger.warn(
          '[DAEMON RUN] Qualified Connected Account refresh did not settle',
          {
            serviceId: binding.serviceId,
            reason: options.reason,
            error: sanitizeConnectedServiceDiagnosticError(error, {
              redactedValues: [binding.profileId],
            }),
          },
        );
        return {
          status: 'lease_not_acquired',
          credential: null,
          credentialRevision: source.credentialRevision,
          diagnostic: buildRefreshDiagnostic({
            binding,
            reason: options.reason,
            status: 'lease_not_acquired',
            expiresAt: source.expiresAt,
            now,
            refreshWindowMs: this.params.refreshWindowMs,
          }),
        };
      }
    } finally {
      await settleDeferredHealth?.();
    }
  }

  private async refreshOauthBindingUnserialized(
    binding: BoundProfile,
    now: number,
    options: Readonly<{
      force?: boolean;
      reason: ConnectedServiceCredentialRefreshReason;
      expectedCredentialRevision?: ConnectedServiceCredentialRevisionV1;
      scheduledStatus?: ScheduledStatusInvocation;
    }>, signal?: AbortSignal,
  ): Promise<ConnectedServiceCredentialRefreshResult> {
    signal?.throwIfAborted();
    if (!this.isOperationAvailable(binding, 'credential_read')) {
      return {
        status: 'lease_not_acquired',
        credential: null,
        diagnostic: buildRefreshDiagnostic({
          binding,
          reason: options.reason,
          status: 'lease_not_acquired',
          now,
          refreshWindowMs: this.params.refreshWindowMs,
        }),
      };
    }
    const source = await this.readCredentialForRefresh({
      api: this.params.api,
      credentials: this.params.credentials,
      binding,
    }, signal);
    if (!source) {
      return {
        status: 'credential_missing',
        credential: null,
        diagnostic: buildRefreshDiagnostic({
          binding,
          reason: options.reason,
          status: 'credential_missing',
          now,
          refreshWindowMs: this.params.refreshWindowMs,
        }),
      };
    }
    // Current reads are revisioned V4. Refuse any unfenced source admitted by an
    // injected historical boundary: neither its lease nor mutation can be fenced.
    if (source.revisionSemantics === 'legacy_unfenced') {
      return {
        status: 'lease_not_acquired',
        credential: null,
        diagnostic: buildRefreshDiagnostic({
          binding,
          reason: options.reason,
          status: 'lease_not_acquired',
          expiresAt: source.expiresAt,
          now,
          refreshWindowMs: this.params.refreshWindowMs,
        }),
      };
    }
    if (
      options.expectedCredentialRevision
      && source.credentialRevision !== options.expectedCredentialRevision
    ) {
      throw new Error('connected_service_credential_revision_mismatch');
    }

    if (source.record.kind !== 'oauth') {
      return {
        status: 'not_oauth', credential: null, credentialRevision: source.credentialRevision,
        diagnostic: buildRefreshDiagnostic({ binding, reason: options.reason, status: 'not_oauth',
          expiresAt: source.expiresAt, now, refreshWindowMs: this.params.refreshWindowMs }),
      };
    }

    const qualifiedRefresh = await this.refreshQualifiedLegacyBinding(
      binding,
      source,
      now,
      options, signal,
    );
    if (qualifiedRefresh) return qualifiedRefresh;

    return {
      status: 'lease_not_acquired',
      credential: null,
      credentialRevision: source.credentialRevision,
      diagnostic: buildRefreshDiagnostic({
        binding,
        reason: options.reason,
        status: 'lease_not_acquired',
        now,
        refreshWindowMs: this.params.refreshWindowMs,
      }),
    };
  }

  private async finalizeRefreshResult(
    binding: BoundProfile,
    result: ConnectedServiceCredentialRefreshResult, signal?: AbortSignal,
  ): Promise<ConnectedServiceCredentialRefreshResult> {
    signal?.throwIfAborted();
    let finalizedResult = result;
    if (result.status === 'refreshed') {
      this.resetCredentialHealthReprobe(binding);
      // RR-1: rotate+distribute is ONE transaction BY CONSTRUCTION. Every rotation funnels through
      // this single completion path (the OAuth refresh leaf calls it exactly once), so no entry point
      // — scheduled, bridge, runtime-auth, quota probe, or spawn preflight — can mint a fresh token
      // and leave a materialized target (group siblings included) holding the superseded one.
      const distributionKey = bindingKey(binding);
      if (!this.distributingRefreshedBindings.has(distributionKey)) {
        this.distributingRefreshedBindings.add(distributionKey);
        try {
          const distribution = await this.distributeRefreshedBinding(binding, signal);
          this.lastRefreshedDistributionByKey.set(distributionKey, distribution);
          const failedTarget = distribution.failedTargets[0] ?? null;
          if (failedTarget) {
            finalizedResult = this.buildMaterializationFailureRefreshResult({
              sourceResult: result,
              failure: failedTarget,
            });
          }
        } finally {
          this.distributingRefreshedBindings.delete(distributionKey);
        }
      }
    }
    if (
      finalizedResult.status === 'refresh_failed'
      && isReauthRequiredFailure(finalizedResult.diagnostic.category ?? 'unknown')
    ) {
      this.armCredentialHealthReprobeBackoff(binding);
    }
    const healthSettled = await this.persistCredentialHealthForRefreshResult(finalizedResult, signal);
    if (healthSettled) {
      await this.notifyCredentialHealthForRefreshResult(finalizedResult, signal);
    }
    return finalizedResult;
  }

  /**
   * Rematerialize every registered target for a freshly rotated binding and notify the runtime so the
   * affected sessions adopt the new token. Both the rematerialize and the auth-updated notify are
   * per-binding single-flighted, so concurrent completion callers coalesce onto one distribution.
   */
  private async distributeRefreshedBinding(binding: BoundProfile, signal?: AbortSignal): Promise<RematerializedTargetsResult> {
    signal?.throwIfAborted();
    const rematerialization = await this.rematerializeTargetsForBindingAfterRefresh(binding, signal);
    if (rematerialization.rematerializedTargets.length > 0) {
      await this.notifyAuthUpdatedForRefreshedBinding(binding, rematerialization.rematerializedTargets, signal);
    }
    return rematerialization;
  }

  private buildFailureCredentialHealth(
    diagnostic: ConnectedServiceCredentialRefreshDiagnostic,
    now: number,
  ): ConnectedServiceCredentialHealthV1 {
    const category = diagnostic.category ?? 'unknown';
    const providerErrorCode = typeof diagnostic.providerErrorCode === 'string'
      && diagnostic.providerErrorCode.trim().length > 0
      && diagnostic.providerErrorCode.trim().length <= 128
      ? diagnostic.providerErrorCode.trim()
      : undefined;
    return {
      v: 1,
      status: isReauthRequiredFailure(category) ? 'needs_reauth' : 'refresh_failed_retryable',
      reconnectRequired: isReauthRequiredFailure(category),
      lastRefreshAttemptAt: now,
      lastRefreshFailureAt: now,
      lastRefreshFailureKind: category,
      ...(typeof diagnostic.providerStatus === 'number' && diagnostic.providerStatus >= 100 && diagnostic.providerStatus <= 599
        ? { providerHttpStatus: diagnostic.providerStatus }
        : {}),
      ...(providerErrorCode ? { providerErrorCode } : {}),
    };
  }

  private async persistCredentialHealthForRefreshResult(
    result: ConnectedServiceCredentialRefreshResult, signal?: AbortSignal,
  ): Promise<boolean> {
    signal?.throwIfAborted();
    if (result.status !== 'refreshed' && result.status !== 'refresh_failed') return false;
    const runtime = this.params.qualifiedConnectedAccountRuntime;
    if (!runtime) return false;
    if (!this.isOperationAvailable({
      serviceId: result.diagnostic.serviceId,
      profileId: result.diagnostic.profileId,
    }, 'credential_health')) {
      return false;
    }
    const diagnostic = result.diagnostic;
    const now = this.params.now();
    const health = result.status === 'refreshed'
      ? {
        v: 1,
        status: 'connected',
        reconnectRequired: false,
        lastRefreshAttemptAt: now,
        lastRefreshSuccessAt: now,
      } satisfies ConnectedServiceCredentialHealthV1
      : this.buildFailureCredentialHealth(diagnostic, now);

    try {
      const basis = await this.readQualifiedCredentialHealthBasis({
        serviceId: diagnostic.serviceId, profileId: diagnostic.profileId,
      }, result.credentialRevision, signal);
      if (!basis) return false;
      const { previousHealth, ...patchBasis } = basis;
      recordCredentialHealthWrite({ path: 'legacy-refresh-result', account: basis.ref,
        credentialRevision: basis.expectedCredentialRevision, configurationRevision: basis.expectedConfigurationRevision,
        before: previousHealth, after: health });
      const settled = await runtime.mutateCredentialHealth({ ...(signal ? { signal } : {}),
        token: this.params.credentials.token, patch: { ...patchBasis, health },
      });
      if (settled.credentialRevision !== basis.expectedCredentialRevision
        || settled.configurationRevision !== basis.expectedConfigurationRevision) {
        throw new Error('Qualified credential health did not settle against its exact snapshot');
      }
      notifyQualifiedHealthSettled({ account: basis.ref, credentialRevision: basis.expectedCredentialRevision,
        previousHealth, health }, runtime);
      return true;
    } catch (error) {
      signal?.throwIfAborted();
      logger.warn('[DAEMON RUN] Failed to update connected-service credential health after refresh', {
        serviceId: diagnostic.serviceId,
        status: diagnostic.status,
        category: diagnostic.category ?? null,
        error: sanitizeConnectedServiceDiagnosticError(error, {
          redactedValues: [diagnostic.profileId],
        }),
      });
      return false;
    }
  }

  async handleExternalCredentialUpdate(input: Readonly<{
    serviceId: ConnectedAccountServiceKey;
    profileId: string;
    credentialPresence: Extract<
      ConnectedServiceProjectedCredentialPresence,
      Readonly<{ status: 'present' }>
    >;
    executionAuthority: ConnectedServiceExecutionAuthorityV1;
  }>): Promise<void> {
    await this.assertAccountRuntimeCurrent();
    const profileId = String(input.profileId ?? '').trim();
    if (!profileId) return;
    const legacyIngress = ConnectedServiceIdSchema.safeParse(input.serviceId);
    const legacyServiceId = resolveFirstPartyLegacyConnectedServiceIdForQualifiedServiceKey(input.serviceId)
      ?? (legacyIngress.success ? legacyIngress.data : null);
    const binding = { serviceId: input.serviceId, profileId };
    const changedTargets = this.runtimeRegistry.listRefreshTargets().filter((target) => target.bindings.some((candidate) =>
      candidate.profileId === profileId
      && (candidate.serviceId === input.serviceId || (legacyServiceId !== null
        && resolveFirstPartyLegacyConnectedServiceIdForQualifiedServiceKey(candidate.serviceId) === legacyServiceId))
      && target.activeBindings.find((active) => active.serviceId === candidate.serviceId
        && active.profileId === candidate.profileId)?.credentialRevision !== input.credentialPresence.credentialRevision));
    if (changedTargets.length === 0) return;
    const affectedTargets = legacyServiceId
      ? (await this.rematerializeTargetsForBindingDetailed({ serviceId: legacyServiceId, profileId }, undefined, changedTargets)).rematerializedTargets
      : changedTargets;
    if (affectedTargets.length === 0) return;
    await this.runCurrentAccountOperation(async () => this.params.onAuthUpdated?.({
      binding,
      affectedTargets,
      trigger: 'reconnect_propagation',
      credentialPresence: input.credentialPresence,
      executionAuthority: input.executionAuthority,
    }));
  }

  private async rematerializeTargetsForBindingAfterRefresh(binding: BoundProfile, signal?: AbortSignal): Promise<RematerializedTargetsResult> {
    signal?.throwIfAborted();
    const key = bindingKey(binding);
    const existing = this.inFlightRefreshRematerializations.get(key);
    if (existing) return await (signal ? waitForSharedOperation(existing, signal) : existing);

    const promise = this.rematerializeTargetsForBindingDetailed(binding, signal);
    this.inFlightRefreshRematerializations.set(key, promise);
    try {
      return await promise;
    } finally {
      if (this.inFlightRefreshRematerializations.get(key) === promise) {
        this.inFlightRefreshRematerializations.delete(key);
      }
    }
  }

  private async notifyAuthUpdatedForRefreshedBinding(
    binding: BoundProfile,
    affectedTargets: ReadonlyArray<SpawnTarget>, signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    if (affectedTargets.length === 0) return;
    const key = bindingKey(binding);
    const existing = this.inFlightRefreshAuthUpdatedNotifications.get(key);
    if (existing) {
      await (signal ? waitForSharedOperation(existing, signal) : existing);
      return;
    }

    const promise = this.runCurrentAccountOperation(async () => this.params.onAuthUpdated?.({ ...(signal ? { signal } : {}),
      binding,
      affectedTargets,
      trigger: 'refresh_triggered_restart',
      executionAuthority: 'runtime_recovery',
    }), undefined, signal);
    this.inFlightRefreshAuthUpdatedNotifications.set(key, promise);
    try {
      await promise;
    } finally {
      queueMicrotask(() => {
        if (this.inFlightRefreshAuthUpdatedNotifications.get(key) === promise) {
          this.inFlightRefreshAuthUpdatedNotifications.delete(key);
        }
      });
    }
  }

  private async rematerializeTargetsForBindingDetailed(
    binding: BoundProfile, signal?: AbortSignal, targets = this.runtimeRegistry.listRefreshTargets(),
  ): Promise<RematerializedTargetsResult> {
    signal?.throwIfAborted();
    await this.assertAccountRuntimeCurrent(signal);
    const affected = targets.filter((target) =>
      this.resolveBoundProfiles(target).some((candidate) =>
        candidate.serviceId === binding.serviceId && candidate.profileId === binding.profileId,
      ),
    );
    const rematerialized: SpawnTarget[] = [];
    const failed: RematerializedTargetFailure[] = [];
    for (const rawTarget of affected) {
      const target = await this.canonicalizeTargetSelectionsForRefresh(rawTarget, signal);
      if (!target) {
        failed.push({
          target: rawTarget,
          binding,
          diagnostic: {
            code: 'canonical_group_state_unavailable',
            providerId: rawTarget.agentId,
            severity: 'blocking',
            serviceId: binding.serviceId,
            reason: 'Canonical connected-service group state was unavailable during credential distribution.',
            credentialRefreshFailure: {
              category: 'unknown',
              providerErrorCode: 'canonical_group_state_unavailable',
            },
          },
        });
        logger.warn('[DAEMON RUN] Skipping connected-service rematerialization; canonical group state unavailable', {
          serviceId: binding.serviceId,
          profileId: binding.profileId,
          agentId: rawTarget.agentId,
          pid: rawTarget.pid,
        });
        continue;
      }
      const targetBindings = this.resolveBoundProfiles(target);
      const resolutions =
        await this.runCurrentAccountOperation(() => resolveConnectedServiceCredentialResolutions({ ...(signal ? { signal } : {}),
          credentials: this.params.credentials,
          api: this.params.api,
          bindings: targetBindings,
          ...(this.params.qualifiedConnectedAccountRuntime
            ? { readCredential: this.params.qualifiedConnectedAccountRuntime.readCredential }
            : {}),
        }), true, signal);
      const unfencedBinding = targetBindings.find((candidate) =>
        resolutions.get(candidate.serviceId)?.revisionSemantics
          !== 'revisioned'
      );
      if (unfencedBinding) {
        failed.push({
          target,
          binding: unfencedBinding,
          diagnostic: {
            code: 'credential_revision_unavailable',
            providerId: target.agentId,
            severity: 'blocking',
            serviceId: unfencedBinding.serviceId,
            reason:
              'Connected service runtime rematerialization requires a revisioned credential.',
          },
        });
        continue;
      }
      const records = new Map(
        [...resolutions].map(([serviceId, resolution]) => [
          serviceId,
          resolution.record,
        ]),
      );
      const qualifiedPurposeBindingSnapshot =
        await this.runCurrentAccountOperation(async () => this.params.resolveQualifiedPurposeBindingSnapshot?.({ ...(signal ? { signal } : {}),
          agentId: target.agentId,
          connectedServicesBindingsRaw: target.connectedServicesBindingsRaw,
        }) ?? null, true, signal);
      try {
        assertQualifiedPurposeAuthorityForSelections({
          selections: parseConnectedServiceBindingSelections(
            target.connectedServicesBindingsRaw,
          ),
          snapshot: qualifiedPurposeBindingSnapshot,
        });
      } catch (error) {
        signal?.throwIfAborted();
        if (!(error instanceof ConnectedServiceQualifiedPurposeAuthorityError)) {
          throw error;
        }
        const targetBinding = targetBindings.find((candidate) =>
          error.missingServiceIds.includes(candidate.serviceId)
        ) ?? binding;
        failed.push({
          target,
          binding: targetBinding,
          diagnostic: {
            code: error.code,
            providerId: target.agentId,
            severity: 'blocking',
            serviceId: targetBinding.serviceId,
            reason: error.message,
          },
        });
        logger.warn('[DAEMON RUN] Skipping connected-service rematerialization; qualified purpose authority unavailable', {
          serviceId: targetBinding.serviceId,
          profileId: targetBinding.profileId,
          agentId: target.agentId,
          reason: error.reason,
          missingServiceIds: error.missingServiceIds,
        });
        continue;
      }
      const requestAuthPurposeBindings =
        resolveQualifiedRequestAuthPurposeBindingsFromSnapshot(
          qualifiedPurposeBindingSnapshot,
        );
      const purposeConsumer = qualifiedPurposeBindingSnapshot?.purposes[0]?.consumer ?? null;
      let rematerializationAuthorityCurrent = true;
      const rematerializationPurposeLease = !target.exactPurposeBindingSubjectId
        && qualifiedPurposeBindingSnapshot
        && purposeConsumer
        && this.params.activatePurposeBindings
        ? this.params.activatePurposeBindings({
            subject: {
              kind: 'operation',
              operationId: `connected-service-rematerialization:${randomUUID()}`,
              consumer: purposeConsumer,
              ...(target.sessionId ? { sessionId: target.sessionId } : {}),
              isCurrent: () => rematerializationAuthorityCurrent
                && this.runtimeRegistry.listRefreshTargets().some((candidate) => (
                  candidate.runtimeIdentityKey === target.runtimeIdentityKey
                  && candidate.revision === target.revision
                )),
            },
            purposes: qualifiedPurposeBindingSnapshot.purposes,
            bindings: qualifiedPurposeBindingSnapshot.bindings,
            ...(qualifiedPurposeBindingSnapshot.directMaterialOrigins
              ? { directMaterialOrigins: qualifiedPurposeBindingSnapshot.directMaterialOrigins }
              : {}),
          })
        : null;
      let rematerializedTarget = target;
      try {
        const materialized = await this.runCurrentAccountOperation(() => materializeConnectedServicesForSpawn({ ...(signal ? { signal } : {}),
          agentId: target.agentId,
          materializationKey: target.materializationKey,
          ...(target.agentLaunchTarget ? { agentLaunchTarget: target.agentLaunchTarget } : {}),
          requesterWorkAttributionV1: target.requesterWorkAttributionV1,
          activeServerDir: this.params.activeServerDir,
          baseDir: this.params.baseDir,
          recordsByServiceId: records,
          accountSettings: this.params.accountSettingsProvider?.() ?? null,
          processEnv: this.params.processEnv ?? process.env,
          allowNativeAccountState: this.params.allowNativeAccountState,
          accountPluginSettingsSource: this.params.accountPluginSettingsSource,
          connectedAccountsOwner: this.params.connectedAccountsOwner,
          isAccountRuntimeCurrent: this.params.isAccountRuntimeCurrent
            ? () => this.params.isAccountRuntimeCurrent!(signal) : undefined,
          connectedAccountMaterializationAuthority: {
            kind: 'qualified',
            purposeBindings:
              qualifiedPurposeBindingSnapshot?.bindings ?? Object.freeze([]),
            requestAuthPurposeBindings,
          },
          qualifiedPurposeBindingSnapshot,
          ...(target.exactPurposeBindingSubjectId || rematerializationPurposeLease
            ? { exactPurposeBindingSubjectId: target.exactPurposeBindingSubjectId
                ?? rematerializationPurposeLease!.subjectId }
            : target.sessionId
            ? { purposeBindingSessionId: target.sessionId }
            : {}),
          ...(target.childSelectionsByServiceId
            ? { selectionsByServiceId: this.buildResolvedSelectionsByServiceId(target.childSelectionsByServiceId) }
            : {}),
        }), true, signal);
        if (target.agentLaunchTarget) {
          const current = this.runtimeRegistry.replaceAgentLaunchMaterials(target, materialized?.agentLaunchMaterials ?? null);
          if (!current) continue;
          rematerializedTarget = { ...target, ...current, agentId: target.agentId, materializationKey: target.materializationKey };
        }
      } catch (error) {
        signal?.throwIfAborted();
        if (!(error instanceof ConnectedServiceMaterializationBlockedError)) throw error;
        const primaryDiagnostic = error.diagnostics[0];
        if (!primaryDiagnostic) throw error;
        const targetBinding = this.resolveBoundProfiles(target).find((candidate) => candidate.serviceId === primaryDiagnostic.serviceId)
          ?? this.resolveBoundProfiles(target).find((candidate) => candidate.serviceId === binding.serviceId)
          ?? binding;
        const resolution = resolutions.get(targetBinding.serviceId);
        await this.persistCredentialHealthForMaterializationFailure(targetBinding, primaryDiagnostic,
          resolution?.revisionSemantics === 'revisioned' ? resolution.credentialRevision : undefined, signal);
        failed.push({
          target,
          binding: targetBinding,
          diagnostic: primaryDiagnostic,
        });
        logger.warn('[DAEMON RUN] Connected-service rematerialization blocked; skipping auth-update restart', {
          serviceId: targetBinding.serviceId,
          agentId: target.agentId,
          materializationCode: boundConnectedServiceMaterializationDiagnosticValue(primaryDiagnostic.code),
          reason: boundConnectedServiceMaterializationDiagnosticValue(primaryDiagnostic.reason),
        });
        continue;
      } finally {
        rematerializationAuthorityCurrent = false;
        rematerializationPurposeLease?.dispose();
      }
      rematerialized.push(rematerializedTarget);
    }
    return {
      affectedTargets: affected,
      rematerializedTargets: rematerialized,
      failedTargets: failed,
    };
  }

  private async persistCredentialHealthForMaterializationFailure(
    binding: BoundProfile,
    diagnostic: ConnectedServicesMaterializationDiagnostic,
    expectedCredentialRevision?: ConnectedServiceCredentialRevisionV1, signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const basis = await this.readQualifiedCredentialHealthBasis(binding, expectedCredentialRevision, signal);
    if (!basis) return;
    await persistConnectedServiceCredentialHealthForMaterializationFailure({ ...(signal ? { signal } : {}),
      binding,
      diagnostic,
      now: this.params.now(),
      qualifiedCredential: { token: this.params.credentials.token, ...basis },
      mutateCredentialHealth: this.params.qualifiedConnectedAccountRuntime?.mutateCredentialHealth,
      onReauthRequired: this.params.qualifiedConnectedAccountRuntime?.onReauthRequired,
      onCredentialHealthChanged: this.params.qualifiedConnectedAccountRuntime?.onCredentialHealthChanged,
    });
  }

  private async readQualifiedCredentialHealthBasis(binding: BoundProfile, expectedCredentialRevision?: ConnectedServiceCredentialRevisionV1, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const runtime = this.params.qualifiedConnectedAccountRuntime;
    if (!runtime || !expectedCredentialRevision) return null;
    const service = resolveFirstPartyQualifiedConnectedAccountServiceForLegacyServiceInput(binding.serviceId);
    if (!service) return null;
    const material = await readQualifiedConnectedAccountCredentialMaterial({ ...(signal ? { signal } : {}),
      credentials: this.params.credentials, account: { service, accountId: binding.profileId },
      requestPurpose: 'connected-accounts:qualification',
      getAccountEncryptionMode: readSignal => resolveConnectedServiceAccountMode(this.params.api, { signal: readSignal }),
      readCredential: runtime.readCredential,
    });
    if (!material || material.snapshot.credentialRevision !== expectedCredentialRevision) return null;
    return {
      ref: material.snapshot.ref,
      expectedCredentialRevision: material.snapshot.credentialRevision,
      expectedConfigurationRevision: material.snapshot.configurationRevision,
      previousHealth: material.snapshot.health ?? null,
    };
  }

  private buildMaterializationFailureRefreshResult(input: Readonly<{
    sourceResult: ConnectedServiceCredentialRefreshResult;
    failure: RematerializedTargetFailure;
  }>): ConnectedServiceCredentialRefreshResult {
    const classification = classifyConnectedServiceMaterializationDiagnosticForCredentialRefresh(input.failure.diagnostic);
    return {
      status: 'refresh_failed',
      credential: input.sourceResult.credential,
      ...(input.failure.binding.serviceId === input.sourceResult.diagnostic.serviceId
        && input.failure.binding.profileId === input.sourceResult.diagnostic.profileId
        && input.sourceResult.credentialRevision
        ? { credentialRevision: input.sourceResult.credentialRevision } : {}),
      diagnostic: buildRefreshDiagnostic({
        binding: input.failure.binding,
        reason: 'runtime_auth_failure',
        status: 'refresh_failed',
        category: classification.category,
        providerStatus: classification.providerStatus,
        providerErrorCode: classification.providerErrorCode ?? 'materialization_failed',
        expiresAt: input.sourceResult.diagnostic.expiresAt ?? input.sourceResult.credential?.expiresAt ?? null,
        now: this.params.now(),
        refreshWindowMs: this.params.refreshWindowMs,
      }),
    };
  }

  private buildMissingRuntimeAuthTargetRefreshResult(input: Readonly<{
    binding: BoundProfile;
    sourceResult: ConnectedServiceCredentialRefreshResult;
  }>): ConnectedServiceCredentialRefreshResult {
    return {
      status: 'refresh_failed',
      credential: input.sourceResult.credential,
      ...(input.binding.serviceId === input.sourceResult.diagnostic.serviceId
        && input.binding.profileId === input.sourceResult.diagnostic.profileId
        && input.sourceResult.credentialRevision
        ? { credentialRevision: input.sourceResult.credentialRevision } : {}),
      diagnostic: buildRefreshDiagnostic({
        binding: input.binding,
        reason: 'runtime_auth_failure',
        status: 'refresh_failed',
        category: 'unknown',
        providerErrorCode: 'runtime_auth_target_not_registered',
        expiresAt: input.sourceResult.diagnostic.expiresAt ?? input.sourceResult.credential?.expiresAt ?? null,
        now: this.params.now(),
        refreshWindowMs: this.params.refreshWindowMs,
      }),
    };
  }

  private async notifyCredentialHealthForRefreshResult(
    result: ConnectedServiceCredentialRefreshResult,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    if (result.status !== 'refresh_failed') return;
    await this.notifyCredentialHealth(result.diagnostic,
      isReauthRequiredFailure(result.diagnostic.category ?? 'unknown')
        ? 'reconnect_required' : 'refresh_failed_retryable', signal);
  }

  private async notifyCredentialHealth(
    diagnostic: ConnectedServiceCredentialHealthNotificationDiagnostic,
    healthStatus: ConnectedServiceCredentialHealthNotificationStatus,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const notify = this.params.onCredentialHealthNotification;
    if (!notify) return;
    const affectedTargets = this.resolveNotificationTargetsForBinding({
      serviceId: diagnostic.serviceId,
      profileId: diagnostic.profileId,
    });
    try {
      await this.runCurrentAccountOperation(async () => notify({ ...(signal ? { signal } : {}),
        diagnostic,
        healthStatus,
        affectedTargets,
      }), undefined, signal);
    } catch (error) {
      signal?.throwIfAborted();
      logger.warn('[DAEMON RUN] Failed to dispatch connected-service credential health notification', {
        serviceId: diagnostic.serviceId,
        status: diagnostic.status,
        category: diagnostic.category ?? null,
        error: sanitizeConnectedServiceDiagnosticError(error, {
          redactedValues: [diagnostic.profileId],
        }),
      });
    }
  }

  private resolveNotificationTargetsForBinding(
    binding: Readonly<{ serviceId: string; profileId: string }>,
  ): ReadonlyArray<ConnectedServiceCredentialHealthNotificationTarget> {
    const serviceId = readBuiltInLegacyConnectedAccountServiceKeyIngress(binding.serviceId) ?? binding.serviceId;
    return this.runtimeRegistry.listTargets().flatMap((target) => {
      const sessionId = target.sessionId ?? target.materializationKey;
      if (!sessionId || !target.boundProfiles.some((candidate) =>
        candidate.serviceId === serviceId && candidate.profileId === binding.profileId,
      )) return [];
      return [{
        pid: target.pid,
        agentId: target.agentId,
        sessionId,
      }];
    });
  }

  private async resolveMaterializedHomeRootForTarget(input: Readonly<{
    target: SpawnTarget;
    binding: BoundProfile;
  }>, signal?: AbortSignal): Promise<string | null> {
    signal?.throwIfAborted();
    const selection = [...(input.target.childSelectionsByServiceId?.values() ?? [])]
      .find((candidate) => (
        resolveFirstPartyLegacyConnectedServiceIdForQualifiedServiceKey(
          candidate.serviceId,
        ) === input.binding.serviceId
      )) ?? null;
    const root = await readCurrentCatalogHook(input.target.agentId, entry => resolveConnectedServiceMaterializedHomeRoot(input.target.agentId, {
      activeServerDir: this.params.activeServerDir,
      serviceId: input.binding.serviceId,
      profileId: input.binding.profileId,
      selection,
    }, entry));
    signal?.throwIfAborted();
    return root;
  }

  private async refreshCanonicalGroupStateForRefresh(
    input: Readonly<{ serviceId: ConnectedServiceId; groupId: string }>,
    signal?: AbortSignal,
  ): Promise<CanonicalGroupStateForRefresh | null> {
    signal?.throwIfAborted();
    let group: CanonicalGroupStateForRefresh | null = null;
    const runtime = this.params.qualifiedConnectedAccountRuntime;
    const service =
      resolveFirstPartyQualifiedConnectedAccountServiceForLegacyServiceInput(
        input.serviceId,
      );
    try {
      if (
        runtime
        && runtime.resolvePeerClass() === 'advertised_v4'
        && runtime.readGroup
        && service
      ) {
        const value = await runtime.readGroup({ ...(signal ? { signal } : {}),
          service,
          groupId: input.groupId,
        });
        if (
          value
          && value.ref.groupId === input.groupId
          && value.ref.service.pluginId === service.pluginId
          && value.ref.service.localId === service.localId
        ) {
          const activeConnectedAccountId = value.activeConnectedAccountId;
          const activeMember = activeConnectedAccountId
            ? value.members.find((member) => (
                member.connectedAccountId === activeConnectedAccountId
                && member.enabled
              ))
            : null;
          group = activeMember
            ? {
                activeProfileId: activeMember.connectedAccountId,
                generation: value.generation,
              }
            : null;
        }
      }
    } catch {
      signal?.throwIfAborted();
      group = null;
    }
    return group;
  }

  private async canonicalizeTargetSelectionsForRefresh(
    target: SpawnTarget,
    signal?: AbortSignal,
  ): Promise<SpawnTarget | null> {
    signal?.throwIfAborted();
    if (!target.childSelectionsByServiceId || target.childSelectionsByServiceId.size === 0) {
      return target;
    }

    let changed = false;
    let nextBindings = target.bindings;
    const nextSelections = new Map<ConnectedAccountServiceKey, ConnectedServiceChildSelection>();
    for (const [serviceId, selection] of target.childSelectionsByServiceId.entries()) {
      if (selection.kind !== 'group') {
        nextSelections.set(serviceId, selection);
        continue;
      }
      const legacyServiceId =
        resolveFirstPartyLegacyConnectedServiceIdForQualifiedServiceKey(serviceId);
      if (!legacyServiceId) return null;
      const groupIdentity = { serviceId: legacyServiceId, groupId: selection.groupId };
      const canonical = await this.refreshCanonicalGroupStateForRefresh(groupIdentity, signal);
      if (!canonical?.activeProfileId) return null;
      const canonicalActiveProfileId = canonical.activeProfileId;

      const nextSelection: ConnectedServiceChildSelection =
        canonicalActiveProfileId === selection.activeProfileId && canonical.generation === selection.generation
          ? selection
          : {
              ...selection,
              activeProfileId: canonicalActiveProfileId,
              generation: canonical.generation,
            };
      nextSelections.set(serviceId, nextSelection);

      const rewrittenBindings = nextBindings.map((candidate) =>
        candidate.serviceId === serviceId && candidate.profileId !== canonicalActiveProfileId
          ? { ...candidate, profileId: canonicalActiveProfileId }
          : candidate,
      );
      if (rewrittenBindings.some((candidate, index) => candidate !== nextBindings[index])) {
        nextBindings = rewrittenBindings;
        changed = true;
      }
      if (nextSelection !== selection) changed = true;
    }

    if (!changed) return target;
    return {
      ...target,
      bindings: nextBindings,
      childSelectionsByServiceId: nextSelections,
    };
  }

  private resolveBoundProfiles(target: SpawnTarget): ReadonlyArray<BoundProfile> {
    return target.bindings.flatMap((binding) => {
      const serviceId =
        resolveFirstPartyLegacyConnectedServiceIdForQualifiedServiceKey(
          binding.serviceId,
        );
      return serviceId ? [{ ...binding, serviceId }] : [];
    });
  }

  private buildResolvedSelectionsByServiceId(
    childSelectionsByServiceId: NonNullable<SpawnTarget['childSelectionsByServiceId']>,
  ): ReadonlyMap<ConnectedAccountServiceKey, ConnectedServiceResolvedSelection> {
    const selectionsByServiceId = new Map<ConnectedAccountServiceKey, ConnectedServiceResolvedSelection>();
    for (const [serviceId, selection] of childSelectionsByServiceId.entries()) {
      if (selection.kind === 'profile') {
        selectionsByServiceId.set(serviceId, {
          kind: 'profile',
          serviceId,
          profileId: selection.profileId,
          ...(selection.credentialRevision
            ? { credentialRevision: selection.credentialRevision }
            : {}),
        });
        continue;
      }
      selectionsByServiceId.set(serviceId, {
        kind: 'group',
        serviceId,
        groupId: selection.groupId,
        activeProfileId: selection.activeProfileId,
        fallbackProfileId: selection.fallbackProfileId ?? selection.activeProfileId,
        generation: selection.generation,
        policy: selection.policy,
        ...(selection.credentialRevision
          ? { credentialRevision: selection.credentialRevision }
          : {}),
      });
    }
    return selectionsByServiceId;
  }
}
