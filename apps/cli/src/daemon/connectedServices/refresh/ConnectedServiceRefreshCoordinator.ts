import {
  BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID,
  type AccountSettings,
  type BuiltInLegacyConnectedAccountOperation,
  type ConnectedServiceCredentialHealthV1,
  ConnectedServiceCredentialRecordV1Schema,
  openConnectedServiceCredentialCiphertext,
  sealConnectedServiceCredentialCiphertext,
  type ConnectedServiceCredentialRecordV1,
  type ConnectedServiceCredentialMutationResponseV1,
  type ConnectedServiceCredentialRevisionBoundaryV1,
  type ConnectedServiceCredentialRevisionV1,
  type ConnectedServiceExecutionAuthorityV1,
  type ConnectedServiceId,
  type ConnectedServiceOauthCredentialRawMetadata,
  type QualifiedConnectedAccountCredentialSnapshotV4,
  type QualifiedConnectedAccountProfileV4,
  type QualifiedConnectedAccountRef,
} from '@happier-dev/protocol';
import type { PluginConnectedAccountHealthResult } from '@happier-dev/plugin-sdk/runtime';
import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import type { ApiClient } from '@/api/api';
import type {
  QualifiedConnectedAccountPeerClass,
  QualifiedConnectedAccountPeerOperationTransport,
} from '@/api/client/qualifiedConnectedAccountApi';
import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import type { CatalogAgentId } from '@/agent/catalog/ids';
import type { Credentials } from '@/persistence';
import { logger } from '@/ui/logger';

import {
  assertConnectedServiceCredentialRecordBinding,
  ConnectedServiceCredentialBindingMismatchError,
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
import {
  isRevisionedLegacyOauthRefreshService,
  refreshReleasedPeerLegacyConnectedAccountOauthTokens,
} from './serviceRefreshers';
import { resolveForcedRefreshFreshnessDecision } from './credentialFreshness/adoptFreshFirst';
import {
  computeConnectedServiceAccessTokenFingerprint,
  normalizeConnectedServiceAccessTokenFingerprint,
} from './credentialFreshness/tokenFingerprint';
import {
  canReprobeCredentialHealth,
  credentialHealthReprobeDelayMs,
  readCredentialHealthStatusForRefresh,
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
import type { ConnectedServiceProjectedCredentialPresence } from '../accountGroups/generation/connectedServiceProjectionSnapshot';
import type {
  QualifiedConnectedAccountEstablishedRuntimeOwner,
} from '../qualifiedConnectedAccountEstablishedRuntimeOwner';
import type {
  QualifiedConnectedAccountV4Support,
} from '../qualifiedConnectedAccountV4Support';
import {
  refreshQualifiedConnectedAccount,
} from './refreshQualifiedConnectedAccount';

type BoundProfile = Readonly<{ serviceId: ConnectedServiceId; profileId: string }>;

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
  }>): Promise<Readonly<{
    credentialRevision: string;
    configurationRevision: string | null;
  }>>;
  readCredential(input: Readonly<{
    token: string;
    ref: QualifiedConnectedAccountRef;
  }>): Promise<QualifiedConnectedAccountCredentialSnapshotV4 | null>;
  acquireRefreshLease(input: Readonly<{
    token: string;
    lease: unknown;
  }>): Promise<Readonly<{
    acquired: boolean;
    leaseUntil: number;
    ownerId: string;
    credentialRevision: string;
  }>>;
  mutateCredential(input: Readonly<{
    token: string;
    mutation: unknown;
  }>): Promise<Readonly<{
    success: true;
    credentialRevision: string;
    configurationRevision: string | null;
  }>>;
  listScheduledAccounts?(): Promise<
    readonly QualifiedConnectedAccountProfileV4[]
  >;
  onCredentialUpdated?(
    account: QualifiedConnectedAccountRef,
  ): void | Promise<void>;
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
  | Readonly<{ status: 'settled'; reconnectRequired: boolean }>;

export type ConnectedServiceCredentialHealthUpdateApi = Readonly<{
  updateConnectedServiceCredentialHealth?: (params: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    health: ConnectedServiceCredentialHealthV1;
  }>) => Promise<void>;
}>;
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

export type ConnectedServiceRuntimeAuthCredentialRefreshResult =
  ConnectedServiceCredentialRefreshResult & Readonly<{
    runtimeAuthDisposition?: 'superseded_by_current_group';
  }>;

export type ConnectedServiceCredentialHealthNotificationStatus =
  | 'reconnect_required'
  | 'refresh_failed_retryable';

export type ConnectedServiceCredentialHealthNotificationTarget = Readonly<{
  pid: number;
  agentId: CatalogAgentId;
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
const MAX_RETAINED_BRIDGE_REFRESH_ATTEMPTS = 256;

function bindingKey(binding: BoundProfile): string {
  return `${binding.serviceId}/${binding.profileId}`;
}

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

function qualifiedAccountKey(account: QualifiedConnectedAccountRef): string {
  return JSON.stringify([
    account.service.pluginId,
    account.service.localId,
    account.accountId,
  ]);
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

function isReauthRequiredFailure(category: ConnectedServiceRefreshFailureCategory): boolean {
  return category === 'invalid_grant'
    || category === 'invalid_client'
    || category === 'provider_401'
    || category === 'provider_403'
    || category === 'missing_refresh_token';
}

function isReconnectRequiredProfileStatus(status: unknown): boolean {
  return status === 'needs_reauth';
}

function readBoundedPluginDiagnosticCode(
  result: PluginConnectedAccountHealthResult,
): string | undefined {
  const code = 'diagnostic' in result
    ? result.diagnostic?.code.trim()
    : undefined;
  return code && code.length <= 128 ? code : undefined;
}

function buildCredentialHealthFromPluginStatus(
  result: PluginConnectedAccountHealthResult,
): ConnectedServiceCredentialHealthV1 {
  const providerErrorCode = readBoundedPluginDiagnosticCode(result);
  if (result.status === 'connected') {
    return {
      v: 1,
      status: 'connected',
      reconnectRequired: false,
    };
  }
  if (
    result.status === 'expired'
    || result.status === 'reconnectRequired'
    || result.status === 'rejected'
  ) {
    return {
      v: 1,
      status: 'needs_reauth',
      reconnectRequired: true,
      ...(providerErrorCode ? { providerErrorCode } : {}),
    };
  }
  return {
    v: 1,
    status: 'refresh_failed_retryable',
    reconnectRequired: false,
    ...(providerErrorCode ? { providerErrorCode } : {}),
  };
}

function openConnectedServiceRecord(params: Readonly<{
  credentials: Credentials;
  ciphertext: string;
}>): ConnectedServiceCredentialRecordV1 {
  const opened = openConnectedServiceCredentialCiphertext({
    material:
      params.credentials.encryption.type === 'legacy'
        ? { type: 'legacy', secret: params.credentials.encryption.secret }
        : { type: 'dataKey', machineKey: params.credentials.encryption.machineKey },
    ciphertext: params.ciphertext,
  });
  if (!opened || !opened.value) {
    throw new Error('Failed to decrypt connected service credential');
  }
  return ConnectedServiceCredentialRecordV1Schema.parse(opened.value);
}

function buildUpdatedOauthRecord(params: Readonly<{
  now: number;
  record: ConnectedServiceCredentialRecordV1 & { kind: 'oauth' };
  next: Readonly<{
    accessToken: string;
    refreshToken: string;
    idToken: string | null;
    scope: string | null;
    tokenType: string | null;
    expiresAt: number | null;
    raw?: ConnectedServiceOauthCredentialRawMetadata | null;
  }>;
}>): ConnectedServiceCredentialRecordV1 {
  return ConnectedServiceCredentialRecordV1Schema.parse({
    ...params.record,
    updatedAt: params.now,
    expiresAt: params.next.expiresAt,
    oauth: {
      ...params.record.oauth,
      accessToken: params.next.accessToken,
      refreshToken: params.next.refreshToken,
      idToken: params.next.idToken ?? params.record.oauth.idToken,
      scope: params.next.scope ?? params.record.oauth.scope,
      tokenType: params.next.tokenType ?? params.record.oauth.tokenType,
      raw: params.next.raw ?? params.record.oauth.raw,
    },
  });
}

function hasObservedOauthCredentialChanged(
  before: ConnectedServiceCredentialRecordV1 & { kind: 'oauth' },
  after: ConnectedServiceCredentialRecordV1 & { kind: 'oauth' },
): boolean {
  return before.updatedAt !== after.updatedAt
    || before.expiresAt !== after.expiresAt
    || before.oauth.accessToken !== after.oauth.accessToken
    || before.oauth.refreshToken !== after.oauth.refreshToken
    || before.oauth.idToken !== after.oauth.idToken
    || before.oauth.scope !== after.oauth.scope
    || before.oauth.tokenType !== after.oauth.tokenType;
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

function readRefreshFailureHttpStatus(message: string): number | null {
  const match = message.match(/,\s*(\d{3})\):/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isInteger(value) ? value : null;
}

function providerHttpStatusForHealth(status: number | null | undefined): number | undefined {
  if (typeof status !== 'number' || !Number.isInteger(status)) return undefined;
  return status >= 100 && status <= 599 ? status : undefined;
}

function providerErrorCodeForHealth(code: string | null | undefined): string | undefined {
  const trimmed = typeof code === 'string' ? code.trim() : '';
  return trimmed.length > 0 ? trimmed.slice(0, 128) : undefined;
}

function readConnectedServiceRefreshFailureCategory(
  value: unknown,
): ConnectedServiceRefreshFailureCategory | null {
  switch (value) {
    case 'invalid_grant':
    case 'invalid_client':
    case 'provider_401':
    case 'provider_403':
    case 'network_error':
    case 'malformed_response':
    case 'missing_access_token':
    case 'missing_refresh_token':
    case 'unknown':
      return value;
    default:
      return null;
  }
}

export type ConnectedServiceMaterializationCredentialRefreshClassification = Readonly<{
  category: ConnectedServiceRefreshFailureCategory;
  providerStatus?: number;
  providerErrorCode?: string;
}>;

export function classifyConnectedServiceMaterializationDiagnosticForCredentialRefresh(
  diagnostic: ConnectedServicesMaterializationDiagnostic,
): ConnectedServiceMaterializationCredentialRefreshClassification {
  const refreshFailure = diagnostic.credentialRefreshFailure;
  const category = readConnectedServiceRefreshFailureCategory(refreshFailure?.category) ?? 'unknown';
  const providerStatus = providerHttpStatusForHealth(refreshFailure?.providerStatus);
  const providerErrorCode = providerErrorCodeForHealth(refreshFailure?.providerErrorCode)
    ?? providerErrorCodeForHealth(diagnostic.code);

  return {
    category,
    ...(providerStatus !== undefined ? { providerStatus } : {}),
    ...(providerErrorCode !== undefined ? { providerErrorCode } : {}),
  };
}

/**
 * Single canonical owner for materialization-failure credential-health writes. Classifies the
 * diagnostic via the shared taxonomy and only latches `needs_reauth` for genuinely auth/permission
 * failure categories; every other blocking reason keeps its true category as a non-latching
 * `refresh_failed_retryable` status. Reused by the coordinator's rematerialize path AND the spawn
 * preflight path (`resolveConnectedServiceAuthForSpawn`) so no caller can fabricate an auth latch.
 */
export async function persistConnectedServiceCredentialHealthForMaterializationFailure(input: Readonly<{
  api: ConnectedServiceCredentialHealthUpdateApi;
  binding: BoundProfile;
  diagnostic: ConnectedServicesMaterializationDiagnostic;
  now: number;
}>): Promise<void> {
  const updateHealth = input.api.updateConnectedServiceCredentialHealth;
  if (typeof updateHealth !== 'function') return;

  const classification = classifyConnectedServiceMaterializationDiagnosticForCredentialRefresh(input.diagnostic);
  const health = {
    v: 1,
    status: isReauthRequiredFailure(classification.category) ? 'needs_reauth' : 'refresh_failed_retryable',
    reconnectRequired: isReauthRequiredFailure(classification.category),
    lastRefreshAttemptAt: input.now,
    lastRefreshFailureAt: input.now,
    lastRefreshFailureKind: classification.category,
    ...(providerHttpStatusForHealth(classification.providerStatus) !== undefined
      ? { providerHttpStatus: providerHttpStatusForHealth(classification.providerStatus) }
      : {}),
    ...(classification.providerErrorCode ? { providerErrorCode: classification.providerErrorCode } : {}),
  } satisfies ConnectedServiceCredentialHealthV1;

  try {
    await updateHealth.call(input.api, {
      serviceId: input.binding.serviceId,
      profileId: input.binding.profileId,
      health,
    });
  } catch (error) {
    logger.warn('[DAEMON RUN] Failed to update connected-service credential health after materialization failure', {
      serviceId: input.binding.serviceId,
      profileId: input.binding.profileId,
      materializationCode: input.diagnostic.code,
      reason: input.diagnostic.reason ?? null,
      error: serializeAxiosErrorForLog(error),
    });
  }
}

function classifyRefreshFailure(error: unknown): Readonly<{
  category: ConnectedServiceRefreshFailureCategory;
  providerStatus: number | null;
  providerErrorCode: string | null;
}> {
  const message = error instanceof Error ? error.message : String(error);
  const providerStatus = readRefreshFailureHttpStatus(message);
  const providerErrorCode =
    message.includes('invalid_grant') ? 'invalid_grant'
      : message.includes('invalid_client') ? 'invalid_client'
        : null;
  const category: ConnectedServiceRefreshFailureCategory =
    providerErrorCode === 'invalid_grant' ? 'invalid_grant'
      : providerErrorCode === 'invalid_client' ? 'invalid_client'
        : providerStatus === 401 ? 'provider_401'
          : providerStatus === 403 ? 'provider_403'
            : message.includes('missing access_token') ? 'missing_access_token'
              : 'unknown';
  return { category, providerStatus, providerErrorCode };
}

async function readCredentialForRefresh(params: Readonly<{
  api: ApiClient;
  credentials: Credentials;
  binding: BoundProfile;
}>): Promise<ConnectedServiceCredentialSource | null> {
  const accountMode = await resolveConnectedServiceAccountMode(params.api);
  if (accountMode !== 'e2ee' && typeof params.api.getConnectedServiceCredentialPlain === 'function') {
    try {
      const plain = await params.api.getConnectedServiceCredentialPlain({
        serviceId: params.binding.serviceId,
        profileId: params.binding.profileId,
      });
      if (plain?.content.t === 'plain') {
        const record = assertConnectedServiceCredentialRecordBinding({
          binding: params.binding,
          record: ConnectedServiceCredentialRecordV1Schema.parse(plain.content.v),
        });
        const source = {
          storageMode: 'plain',
          record,
          expiresAt: typeof record.expiresAt === 'number' && Number.isFinite(record.expiresAt) ? record.expiresAt : null,
        } as const;
        return plain.revisionSemantics === 'revisioned' ? {
          ...source,
          revisionSemantics: 'revisioned',
          credentialRevision: plain.credentialRevision,
        } : {
          ...source,
          revisionSemantics: 'legacy_unfenced',
          credentialRevision: null,
        };
      }
      if (accountMode === 'plain') return null;
    } catch (error) {
      if (error instanceof ConnectedServiceCredentialBindingMismatchError) throw error;
      if (accountMode !== 'unknown') throw error;
    }
  }

  const sealed = await params.api.getConnectedServiceCredentialSealed({
    serviceId: params.binding.serviceId,
    profileId: params.binding.profileId,
  });
  if (!sealed) return null;
  if (sealed.metadata?.kind !== 'oauth') return null;

  const source = {
    storageMode: 'sealed',
    record: assertConnectedServiceCredentialRecordBinding({
      binding: params.binding,
      record: openConnectedServiceRecord({
        credentials: params.credentials,
        ciphertext: sealed.sealed.ciphertext,
      }),
    }),
    expiresAt: sealed.metadata.expiresAt ?? null,
  } as const;
  return sealed.revisionSemantics === 'revisioned' ? {
    ...source,
    revisionSemantics: 'revisioned',
    credentialRevision: sealed.credentialRevision,
  } : {
    ...source,
    revisionSemantics: 'legacy_unfenced',
    credentialRevision: null,
  };
}

async function persistUpdatedCredential(params: Readonly<{
  api: ApiClient;
  credentials: Credentials;
  binding: BoundProfile;
  source: RevisionedConnectedServiceCredentialSource;
  updated: ConnectedServiceCredentialRecordV1;
  expectedCredentialRevision?: ConnectedServiceCredentialRevisionV1;
  refreshLeaseOwnerId?: string;
}>): Promise<ConnectedServiceCredentialMutationResponseV1> {
  if (params.source.storageMode === 'plain') {
    const result = await params.api.registerConnectedServiceCredentialPlain({
      serviceId: params.binding.serviceId,
      profileId: params.binding.profileId,
      content: { t: 'plain', v: params.updated },
      ...(params.expectedCredentialRevision
        ? { expectedCredentialRevision: params.expectedCredentialRevision }
        : {}),
      ...(params.refreshLeaseOwnerId ? { refreshLeaseOwnerId: params.refreshLeaseOwnerId } : {}),
    });
    if ('success' in result && !('credentialRevision' in result)) {
      throw new Error('Connected service credential refresh received an unfenced mutation response');
    }
    return result;
  }

  const sealedCiphertext = sealConnectedServiceCredentialCiphertext({
    material:
      params.credentials.encryption.type === 'legacy'
        ? { type: 'legacy', secret: params.credentials.encryption.secret }
        : { type: 'dataKey', machineKey: params.credentials.encryption.machineKey },
    payload: params.updated,
    randomBytes: (length) => randomBytes(length),
  });

  const result = await params.api.registerConnectedServiceCredentialSealed({
    serviceId: params.binding.serviceId,
    profileId: params.binding.profileId,
    sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
    metadata: {
      kind: params.updated.kind,
      providerEmail: params.updated.kind === 'oauth' ? params.updated.oauth.providerEmail : null,
      providerAccountId: params.updated.kind === 'oauth' ? params.updated.oauth.providerAccountId : null,
      expiresAt: params.updated.expiresAt,
    },
    ...(params.expectedCredentialRevision
      ? { expectedCredentialRevision: params.expectedCredentialRevision }
      : {}),
    ...(params.refreshLeaseOwnerId ? { refreshLeaseOwnerId: params.refreshLeaseOwnerId } : {}),
  });
  if ('success' in result && !('credentialRevision' in result)) {
    throw new Error('Connected service credential refresh received an unfenced mutation response');
  }
  return result;
}

export class ConnectedServiceRefreshCoordinator {
  private readonly runtimeRegistry: ConnectedServiceRuntimeRegistry;
  private readonly inFlightRefreshes = new Map<string, Promise<ConnectedServiceCredentialRefreshResult>>();
  private readonly inFlightRefreshRematerializations = new Map<string, Promise<RematerializedTargetsResult>>();
  private readonly inFlightRefreshAuthUpdatedNotifications = new Map<string, Promise<void>>();
  // RR-1: rotate+distribute is ONE transaction on the single 'refreshed' completion path. This guard
  // stops a distribution-triggered nested refresh from recursing back into another distribution.
  private readonly distributingRefreshedBindings = new Set<string>();
  // The rematerialization result produced by the by-construction distribution of the LAST 'refreshed'
  // completion for a binding. Runtime-auth reads it to derive per-session materialization outcomes
  // WITHOUT a second rematerialize/notify (preserving single-materialize under concurrent callers).
  private readonly lastRefreshedDistributionByKey = new Map<string, RematerializedTargetsResult>();
  private readonly canonicalGroupStateCache = new Map<string, Readonly<{
    atMs: number;
    group: CanonicalGroupStateForRefresh | null;
  }>>();
  private readonly credentialHealthReprobeState = new Map<string, CredentialHealthReprobeState>();
  private readonly bridgeRefreshAttemptByBinding = new Map<string, {
    refreshAttemptId: string;
    expectedCredentialRevision?: ConnectedServiceCredentialRevisionV1;
    promise: Promise<CodexChatGptAuthTokensRefreshResponse>;
    settlement: 'pending' | 'fulfilled' | 'rejected';
  }>();

  constructor(private readonly params: Readonly<{
    api: ApiClient;
    credentials: Credentials;
    machineIdProvider: () => string;
    ownerIdProvider?: () => string | null | undefined;
    activeServerDir: string;
    baseDir: string;
    refreshWindowMs: number;
    refreshLeaseMs: number;
    now: () => number;
    accountSettingsProvider?: () => AccountSettings | Readonly<Record<string, unknown>> | null | undefined;
    processEnv?: NodeJS.ProcessEnv;
    runtimeRegistry?: ConnectedServiceRuntimeRegistry;
    qualifiedConnectedAccountRuntime?: QualifiedConnectedAccountRefreshRuntime;
    onAuthUpdated?: (event: Readonly<{
      binding: BoundProfile;
      affectedTargets: ReadonlyArray<SpawnTarget>;
      trigger: 'refresh_triggered_restart' | 'reconnect_propagation';
      credentialPresence?: ConnectedServiceProjectedCredentialPresence;
    }>) => void | Promise<void>;
    onCredentialHealthNotification?: (event: Readonly<{
      diagnostic: ConnectedServiceCredentialRefreshDiagnostic;
      healthStatus: ConnectedServiceCredentialHealthNotificationStatus;
      affectedTargets: ReadonlyArray<ConnectedServiceCredentialHealthNotificationTarget>;
    }>) => void | Promise<void>;
  }>) {
    this.runtimeRegistry = params.runtimeRegistry ?? new ConnectedServiceRuntimeRegistry();
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
    if (!runtime?.resolveOperationTransport) return null;
    try {
      return runtime.resolveOperationTransport({
        service: compatibility.service,
        operation,
      });
    } catch {
      return null;
    }
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
    agentId: CatalogAgentId;
    sessionId?: string | null;
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
        const mutation = await runtime.mutateCredentialHealth({
          token: this.params.credentials.token,
          patch: Object.freeze({
            ref: input.account,
            expectedCredentialRevision:
              expectedCredential.credentialRevision,
            expectedConfigurationRevision:
              expectedCredential.configurationRevision,
            health: Object.freeze({
              v: 1 as const,
              status: 'needs_reauth' as const,
              reconnectRequired: true,
              providerErrorCode:
                'connected_account_configuration_changed',
            }),
          }),
        });
        const current = await runtime.readCredential({
          token: this.params.credentials.token,
          ref: input.account,
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
        this.armQualifiedConnectedAccountHealthBackoff(input.account);
        await runtime.onCredentialUpdated?.(input.account);
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
      settlement = await refreshQualifiedConnectedAccount({
        account: input.account,
        token: this.params.credentials.token,
        ownerId:
          `${ownerBase.slice(0, 208)}:configuration:${randomBytes(16).toString('hex')}`,
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
      || !settlement.basis.isCurrent()
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
      const health = settlement.status === 'outcome_unknown'
        ? {
            v: 1 as const,
            status: 'refresh_failed_retryable' as const,
            reconnectRequired: false,
            providerErrorCode:
              settlement.result.diagnostic.code.trim().slice(0, 128),
          }
        : buildCredentialHealthFromPluginStatus(settlement.result);
      await this.settleQualifiedConnectedAccountHealth({
        account: input.account,
        basis: settlement.basis,
        health,
      });
      this.armQualifiedConnectedAccountHealthBackoff(input.account);
      await runtime.onCredentialUpdated?.(input.account);
      return;
    }
    const current = await runtime.readCredential({
      token: this.params.credentials.token,
      ref: input.account,
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
    await runtime.onCredentialUpdated?.(input.account);
  }

  transferPid(fromPid: number, toPid: number): void {
    this.runtimeRegistry.transferPid(fromPid, toPid);
  }

  async tickOnce(): Promise<void> {
    const now = this.params.now();
    const unique = new Map<string, BoundProfile>();
    const qualified = new Map<string, QualifiedConnectedAccountProfileV4>();
    const errors: unknown[] = [];

    for (const target of this.runtimeRegistry.listRefreshTargets()) {
      for (const binding of this.resolveBoundProfiles(target)) {
        unique.set(bindingKey(binding), binding);
      }
    }

    const qualifiedRuntime = this.params.qualifiedConnectedAccountRuntime;
    if (
      qualifiedRuntime?.resolvePeerClass() === 'advertised_v4'
      && qualifiedRuntime.listScheduledAccounts
    ) {
      try {
        for (const profile of await qualifiedRuntime.listScheduledAccounts()) {
          qualified.set(qualifiedAccountKey(profile.ref), profile);
        }
      } catch (error) {
        errors.push(error);
      }
    }

    for (const binding of unique.values()) {
      try {
        await this.maybeRefreshBinding(binding, now);
        const compatibility =
          BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID[
            binding.serviceId
          ];
        qualified.delete(qualifiedAccountKey({
          service: compatibility.service,
          accountId: binding.profileId,
        }));
      } catch (error) {
        errors.push(error);
      }
    }

    for (const profile of qualified.values()) {
      try {
        await this.maybeRefreshScheduledQualifiedAccount(profile, now);
      } catch (error) {
        errors.push(error);
      }
    }

    if (errors.length > 0) {
      throw new AggregateError(errors, 'Connected services refresh tick failed');
    }
  }

  private async maybeRefreshScheduledQualifiedAccount(
    profile: QualifiedConnectedAccountProfileV4,
    now: number,
  ): Promise<void> {
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
      this.armQualifiedConnectedAccountHealthBackoff(profile.ref, now);
    };
    try {
      const statusInvocation =
        await runtime.establishedRuntimeOwner.invokeWithReceipt({
          account: profile.ref,
          operation: Object.freeze({ kind: 'status' as const }),
        });
      const health = buildCredentialHealthFromPluginStatus(
        statusInvocation.result,
      );
      await this.settleQualifiedConnectedAccountHealth({
        account: profile.ref,
        basis: statusInvocation.basis,
        health,
      });
      if (health.status !== 'connected') {
        armBackoff();
        return;
      }
      this.credentialHealthReprobeState.delete(key);
      const expiresAt = profile.expiresAt;
      const shouldRefresh =
        profile.kind === 'oauth'
        && (
          profile.status === 'refresh_failed_retryable'
          || (
            typeof expiresAt === 'number'
            && Number.isFinite(expiresAt)
            && expiresAt - now <= this.params.refreshWindowMs
          )
      );
      if (!shouldRefresh) return;
      if (
        !this.shouldRunQualifiedOperation(
          profile.ref,
          'credential_read',
        )
      ) {
        return;
      }
      const expectedCredential = await runtime.readCredential({
        token: this.params.credentials.token,
        ref: profile.ref,
      });
      if (!expectedCredential) return;
      const ownerId =
        this.params.ownerIdProvider?.()?.trim()
        || this.params.machineIdProvider().trim();
      if (!ownerId) {
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
        armBackoff();
        return;
      }
      const settlement = await refreshQualifiedConnectedAccount({
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
      if (settlement.status === 'refreshed') {
        this.credentialHealthReprobeState.delete(key);
        await runtime.onCredentialUpdated?.(profile.ref);
        return;
      }
      if (settlement.status === 'unchanged') {
        this.credentialHealthReprobeState.delete(key);
        return;
      }
      const failedHealth = settlement.status === 'outcome_unknown'
        ? {
            v: 1 as const,
            status: 'refresh_failed_retryable' as const,
            reconnectRequired: false,
            providerErrorCode:
              settlement.result.diagnostic.code.trim().slice(0, 128),
          }
        : buildCredentialHealthFromPluginStatus(settlement.result);
      await this.settleQualifiedConnectedAccountHealth({
        account: profile.ref,
        basis: settlement.basis,
        health: failedHealth,
      });
      armBackoff();
    } catch (error) {
      armBackoff();
      logger.warn(
        '[DAEMON RUN] Qualified Connected Account scheduled refresh did not settle',
        {
          service: profile.ref.service,
          accountId: profile.ref.accountId,
          error: serializeAxiosErrorForLog(error),
        },
      );
      throw error;
    }
  }

  private armQualifiedConnectedAccountHealthBackoff(
    account: QualifiedConnectedAccountRef,
    now = this.params.now(),
  ): void {
    const key = `qualified:${qualifiedAccountKey(account)}`;
    const failureCount =
      (this.credentialHealthReprobeState.get(key)?.failureCount ?? 0) + 1;
    this.credentialHealthReprobeState.set(key, {
      failureCount,
      nextProbeAt: now + credentialHealthReprobeDelayMs(failureCount - 1),
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
    serviceId: ConnectedServiceId;
    profileId: string;
  }>): Promise<ConnectedServiceCredentialRefreshResult> {
    const binding = { serviceId: input.serviceId, profileId: input.profileId };
    const result = await this.refreshOauthBinding(
      binding,
      this.params.now(),
      { reason: 'spawn_preflight' },
    );
    if (result.status === 'not_needed') {
      const rematerialization = await this.maybeRematerializeStaleMaterializedHomesForFreshStoreBinding(binding);
      if (rematerialization && rematerialization.rematerializedTargets.length > 0) {
        await this.notifyAuthUpdatedForRefreshedBinding(binding, rematerialization.rematerializedTargets);
      }
    }
    return result;
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
    }, this.params.now());
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
    const profileId = input.selection.kind === 'profile'
      ? input.selection.profileId
      : input.selection.activeProfileId;
    const binding: BoundProfile = { serviceId: 'openai-codex', profileId };
    const key = bindingKey(binding);
    const refreshAttemptId = input.refreshAttemptId.trim();
    if (!refreshAttemptId) {
      throw new Error('connected_service_refresh_attempt_identity_unavailable');
    }
    const existing = this.bridgeRefreshAttemptByBinding.get(key);
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
        return await existing.promise;
      }
      // A different revision is not inherently newer. Fence the caller against current
      // authoritative storage before it is allowed to wait on, replace, or delete the retained
      // settlement. This prevents delayed rev1 replay from evicting a pending/fulfilled rev3 owner.
      const currentSource = await readCredentialForRefresh({
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
      refreshAttemptId: string;
      expectedCredentialRevision: ConnectedServiceCredentialRevisionV1;
      promise: Promise<CodexChatGptAuthTokensRefreshResponse>;
      settlement: 'pending' | 'fulfilled' | 'rejected';
    } = {
      refreshAttemptId,
      expectedCredentialRevision: input.expectedCredentialRevision,
      promise,
      settlement: 'pending',
    };
    this.bridgeRefreshAttemptByBinding.set(key, attempt);
    void promise.then(
      () => {
        attempt.settlement = 'fulfilled';
        this.pruneSettledBridgeRefreshAttempts();
      },
      () => {
        attempt.settlement = 'rejected';
        this.pruneSettledBridgeRefreshAttempts();
      },
    );
    return await promise;
  }

  private pruneSettledBridgeRefreshAttempts(): void {
    if (this.bridgeRefreshAttemptByBinding.size <= MAX_RETAINED_BRIDGE_REFRESH_ATTEMPTS) return;
    for (const [key, attempt] of this.bridgeRefreshAttemptByBinding) {
      if (this.bridgeRefreshAttemptByBinding.size <= MAX_RETAINED_BRIDGE_REFRESH_ATTEMPTS) return;
      if (attempt.settlement !== 'pending') this.bridgeRefreshAttemptByBinding.delete(key);
    }
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
    const currentSource = await readCredentialForRefresh({
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
        const settledCurrentSource = await readCredentialForRefresh({
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
        const settledCurrentSource = await readCredentialForRefresh({
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
      throw new Error('connected_service_chatgpt_refresh_unavailable');
    }
    // Distribution happens BY CONSTRUCTION on the 'refreshed' completion path (RR-1).

    const persistedSource = await readCredentialForRefresh({
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
    const currentSource = await readCredentialForRefresh({
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
      throw new Error('connected_service_claude_subscription_refresh_unavailable');
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

  private async maybeRefreshBinding(binding: BoundProfile, now: number): Promise<void> {
    const result = await this.refreshOauthBinding(binding, now, { reason: 'scheduled' });
    if (result.status === 'refresh_failed') {
      throw new Error(`Connected services refresh failed (${binding.serviceId}/${binding.profileId}): ${result.diagnostic.category ?? 'unknown'}`);
    }
    if (result.status !== 'refreshed') {
      if (result.status !== 'not_needed') return;
      const rematerialization = await this.maybeRematerializeStaleMaterializedHomesForFreshStoreBinding(binding);
      if (!rematerialization || rematerialization.rematerializedTargets.length === 0) return;
      await this.notifyAuthUpdatedForRefreshedBinding(binding, rematerialization.rematerializedTargets);
      return;
    }
    // A 'refreshed' result already rematerialized + notified BY CONSTRUCTION on the completion path (RR-1).
  }

  private async maybeRematerializeStaleMaterializedHomesForFreshStoreBinding(
    binding: BoundProfile,
  ): Promise<RematerializedTargetsResult | null> {
    const affected = this.runtimeRegistry.listRefreshTargets().filter((target) =>
      this.resolveBoundProfiles(target).some((candidate) =>
        candidate.serviceId === binding.serviceId && candidate.profileId === binding.profileId,
      ),
    );
    for (const rawTarget of affected) {
      const target = await this.canonicalizeTargetSelectionsForRefresh(rawTarget);
      if (!target) continue;
      const targetBinding = this.resolveBoundProfiles(target).find((candidate) =>
        candidate.serviceId === binding.serviceId,
      ) ?? binding;
      const source = await readCredentialForRefresh({
        api: this.params.api,
        credentials: this.params.credentials,
        binding: targetBinding,
      });
      if (!source || source.record.kind !== 'oauth') continue;
      if (!this.isOauthRecordStillValidForBridge(source.record)) continue;
      const freshness = await getConnectedServiceMaterializedHomeFreshness(target.agentId);
      if (!freshness) continue;
      const fallbackMaterializedRootDir = resolveConnectedServiceMaterializedRootDir({
        baseDir: this.params.baseDir,
        agentId: target.agentId,
        materializationKey: target.materializationKey,
      });
      const materializedRootDir = this.resolveMaterializedHomeRootForTarget({
        target,
        binding: targetBinding,
      }) ?? fallbackMaterializedRootDir;
      let stale = false;
      try {
        stale = await freshness.isMaterializedHomeStale({
          serviceId: targetBinding.serviceId,
          materializedRootDir,
          record: source.record,
          now: this.params.now(),
          refreshWindowMs: this.params.refreshWindowMs,
        });
      } catch (error) {
        logger.debug('[ConnectedServiceRefreshCoordinator] materialized home freshness check failed; rematerializing target', {
          serviceId: binding.serviceId,
          profileId: binding.profileId,
          agentId: target.agentId,
          error: error instanceof Error ? error.message : String(error),
        });
        stale = true;
      }
      if (stale) {
        return await this.rematerializeTargetsForBindingAfterRefresh(binding);
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
    }>,
  ): Promise<ConnectedServiceCredentialRefreshResult> {
    // Coalesce + serialize per `{serviceId, profileId}` binding (NOT split on `force`). A rotation
    // consumes the refresh token server-side, so two concurrent refreshes for one binding could each
    // present the same record and mint a superseded (401-bound) token. Any caller that arrives while a
    // refresh is in flight awaits it; a forced caller adopts that result when it rotated, otherwise it
    // runs its own refresh chained strictly after (never concurrently) so it reads the freshly
    // persisted record.
    const key = bindingKey(binding);
    const existing = this.inFlightRefreshes.get(key);
    if (existing) {
      // A rejecting in-flight refresh represents an attempt that re-running concurrently would not
      // improve; every joiner adopts the same rejection rather than firing a duplicate refresh.
      const observed = await existing;
      if (inFlightResultSatisfiesCaller(observed, options)) {
        return observed;
      }
      // Forced caller behind a non-rotating `not_needed`: run a fresh refresh, serialized after it.
    }

    const previous = this.inFlightRefreshes.get(key);
    const promise = (async () => {
      if (previous) {
        // Serialize behind any refresh already running for this binding before reading/rotating so a
        // chained refresh reads the freshly persisted (rotated) record instead of racing it.
        await previous.catch(() => undefined);
      }
      return await this.finalizeRefreshResult(
        binding,
        await this.refreshOauthBindingUnserialized(binding, now, options),
      );
    })();
    this.inFlightRefreshes.set(key, promise);
    try {
      return await promise;
    } finally {
      if (this.inFlightRefreshes.get(key) === promise) {
        this.inFlightRefreshes.delete(key);
      }
    }
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

  private armCredentialHealthReprobeBackoff(binding: BoundProfile, now: number): void {
    const key = bindingKey(binding);
    const previous = this.credentialHealthReprobeState.get(key);
    const failureCount = (previous?.failureCount ?? 0) + 1;
    this.credentialHealthReprobeState.set(key, {
      failureCount,
      nextProbeAt: now + credentialHealthReprobeDelayMs(failureCount - 1),
    });
  }

  private async probeQualifiedConnectedAccountStatus(
    binding: BoundProfile,
    now: number,
    options: Readonly<{
      force?: boolean;
      reason: ConnectedServiceCredentialRefreshReason;
      expectedCredentialRevision?: ConnectedServiceCredentialRevisionV1;
    }>,
  ): Promise<QualifiedConnectedAccountStatusProbeOutcome> {
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
      const invocation = await runtime.establishedRuntimeOwner.invokeWithReceipt({
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
      const expectedConfigurationRevision =
        invocation.basis.credentialConfigurationRevision;
      if (!invocation.basis.isCurrent()) {
        throw new Error(
          'Qualified Connected Account status generation is no longer current',
        );
      }
      const mutation = await runtime.mutateCredentialHealth({
        token: this.params.credentials.token,
        patch: Object.freeze({
          ref: account,
          expectedCredentialRevision: invocation.basis.credentialRevision,
          expectedConfigurationRevision,
          health,
        }),
      });
      if (
        mutation.credentialRevision !== invocation.basis.credentialRevision
        || mutation.configurationRevision !== expectedConfigurationRevision
        || !invocation.basis.isCurrent()
      ) {
        throw new Error(
          'Qualified Connected Account health mutation settled against a different invocation basis',
        );
      }
      if (health.reconnectRequired) {
        this.armCredentialHealthReprobeBackoff(binding, now);
      } else if (health.status === 'connected') {
        this.resetCredentialHealthReprobe(binding);
      } else {
        this.armCredentialHealthReprobeBackoff(binding, now);
      }
      return {
        status: 'settled',
        reconnectRequired: health.reconnectRequired,
      };
    } catch (error) {
      if (
        error instanceof Error
        && error.message === 'connected_service_credential_revision_mismatch'
      ) {
        throw error;
      }
      this.armCredentialHealthReprobeBackoff(binding, now);
      logger.warn(
        '[DAEMON RUN] Qualified Connected Account status probe did not settle',
        {
          serviceId: binding.serviceId,
          profileId: binding.profileId,
          reason: options.reason,
          error: serializeAxiosErrorForLog(error),
        },
      );
      return { status: 'unavailable' };
    }
  }

  private async settleQualifiedConnectedAccountHealth(input: Readonly<{
    account: QualifiedConnectedAccountRef;
    basis: Awaited<
      ReturnType<
        QualifiedConnectedAccountEstablishedRuntimeOwner['invokeWithReceipt']
      >
    >['basis'];
    health: ConnectedServiceCredentialHealthV1;
  }>): Promise<void> {
    const runtime = this.params.qualifiedConnectedAccountRuntime;
    if (
      !runtime
      || !input.basis.isCurrent()
      || !this.shouldRunQualifiedOperation(
        input.account,
        'credential_health',
      )
    ) {
      throw new Error(
        'Qualified Connected Account health settlement basis is no longer current',
      );
    }
    const expectedConfigurationRevision =
      input.basis.credentialConfigurationRevision;
    const mutation = await runtime.mutateCredentialHealth({
      token: this.params.credentials.token,
      patch: Object.freeze({
        ref: input.account,
        expectedCredentialRevision: input.basis.credentialRevision,
        expectedConfigurationRevision,
        health: input.health,
      }),
    });
    if (
      mutation.credentialRevision !== input.basis.credentialRevision
      || mutation.configurationRevision !== expectedConfigurationRevision
      || !input.basis.isCurrent()
    ) {
      throw new Error(
        'Qualified Connected Account health mutation settled against a different invocation basis',
      );
    }
  }

  private async refreshQualifiedLegacyBinding(
    binding: BoundProfile,
    source: RevisionedConnectedServiceCredentialSource,
    now: number,
    options: Readonly<{
      force?: boolean;
      reason: ConnectedServiceCredentialRefreshReason;
      expectedCredentialRevision?: ConnectedServiceCredentialRevisionV1;
    }>,
  ): Promise<ConnectedServiceCredentialRefreshResult | null> {
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
    if (peerClass === 'revisioned_v2_v3') {
      if (source.record.kind !== 'oauth') {
        return {
          status: 'not_oauth',
          credential: null,
          credentialRevision: source.credentialRevision,
          diagnostic: buildRefreshDiagnostic({
            binding,
            reason: options.reason,
            status: 'not_oauth',
            expiresAt: source.expiresAt,
            now,
            refreshWindowMs: this.params.refreshWindowMs,
          }),
        };
      }
      if (isRevisionedLegacyOauthRefreshService(binding.serviceId)) {
        return null;
      }
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
    const qualifiedStatus = await this.probeQualifiedConnectedAccountStatus(
      binding,
      now,
      options,
    );
    if (
      qualifiedStatus.status !== 'settled'
      || qualifiedStatus.reconnectRequired
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
    if (options.force !== true) {
      if (
        typeof source.expiresAt !== 'number'
        || !Number.isFinite(source.expiresAt)
        || source.expiresAt - now > this.params.refreshWindowMs
      ) {
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
    }
    const compatibility =
      BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID[
        binding.serviceId
      ];
    const account = Object.freeze({
      service: compatibility.service,
      accountId: binding.profileId,
    });
    const expectedCredential = await runtime.readCredential({
      token: this.params.credentials.token,
      ref: account,
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
        credentialRevision: expectedCredential.credentialRevision,
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
    try {
      const settlement = await refreshQualifiedConnectedAccount({
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
      if (
        options.expectedCredentialRevision
        && settlement.basis.credentialRevision
          !== options.expectedCredentialRevision
      ) {
        throw new Error('connected_service_credential_revision_mismatch');
      }
      if (settlement.status === 'refreshed') {
        const persisted = await readCredentialForRefresh({
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
      const health = settlement.status === 'outcome_unknown'
        ? {
            v: 1 as const,
            status: 'refresh_failed_retryable' as const,
            reconnectRequired: false,
            providerErrorCode:
              settlement.result.diagnostic.code.trim().slice(0, 128),
          }
        : buildCredentialHealthFromPluginStatus(settlement.result);
      await this.settleQualifiedConnectedAccountHealth({
        account,
        basis: settlement.basis,
        health,
      });
      this.armCredentialHealthReprobeBackoff(binding, now);
      return {
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
          expiresAt: source.expiresAt,
          now,
          refreshWindowMs: this.params.refreshWindowMs,
        }),
      };
    } catch (error) {
      if (
        error instanceof Error
        && error.message === 'connected_service_credential_revision_mismatch'
      ) {
        throw error;
      }
      this.armCredentialHealthReprobeBackoff(binding, now);
      logger.warn(
        '[DAEMON RUN] Qualified Connected Account refresh did not settle',
        {
          serviceId: binding.serviceId,
          profileId: binding.profileId,
          reason: options.reason,
          error: serializeAxiosErrorForLog(error),
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
  }

  private async refreshOauthBindingUnserialized(
    binding: BoundProfile,
    now: number,
    options: Readonly<{
      force?: boolean;
      reason: ConnectedServiceCredentialRefreshReason;
      expectedCredentialRevision?: ConnectedServiceCredentialRevisionV1;
    }>,
  ): Promise<ConnectedServiceCredentialRefreshResult> {
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
    const source = await readCredentialForRefresh({
      api: this.params.api,
      credentials: this.params.credentials,
      binding,
    });
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
    // Server v0.2.1 (4913c1e533c872a0712ba1c25b3104fd470aacc2) exposed readable
    // credentials without a revision. They remain usable for compatibility reads, but refresh
    // rotation must fail closed because neither lease acquisition nor persistence can be fenced.
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

    const qualifiedRefresh = await this.refreshQualifiedLegacyBinding(
      binding,
      source,
      now,
      options,
    );
    if (qualifiedRefresh) return qualifiedRefresh;

    const qualifiedStatus = await this.probeQualifiedConnectedAccountStatus(
      binding,
      now,
      options,
    );
    if (
      qualifiedStatus.status === 'deferred'
      || qualifiedStatus.status === 'unavailable'
      || (
        qualifiedStatus.status === 'settled'
        && qualifiedStatus.reconnectRequired
      )
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

    if (source.record.kind !== 'oauth') {
      return {
        status: 'not_oauth',
        credential: null,
        diagnostic: buildRefreshDiagnostic({
          binding,
          reason: options.reason,
          status: 'not_oauth',
          expiresAt: source.expiresAt,
          now,
          refreshWindowMs: this.params.refreshWindowMs,
        }),
      };
    }
    let isCredentialHealthReprobe = false;
    if (
      shouldReadCredentialHealthForRefresh(options.reason)
      && isReconnectRequiredProfileStatus(await readCredentialHealthStatusForRefresh({
        api: this.params.api,
        binding,
        reason: options.reason,
      }))
    ) {
      if (this.shouldDeferCredentialHealthReprobe(binding, now, options)) {
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
      isCredentialHealthReprobe = true;
    }
    if (options.force !== true && !isCredentialHealthReprobe) {
      if (typeof source.expiresAt !== 'number' || !Number.isFinite(source.expiresAt)) {
        return {
          status: 'not_needed',
          credential: null,
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
      if (source.expiresAt - now > this.params.refreshWindowMs) {
        return {
          status: 'not_needed',
          credential: null,
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
    }

    const machineId = this.params.machineIdProvider();
    if (
      !machineId
      || !this.isOperationAvailable(binding, 'refresh_lease')
    ) {
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

    const ownerId = this.params.ownerIdProvider?.()?.trim();
    const lease = await this.params.api.acquireConnectedServiceRefreshLease({
      serviceId: binding.serviceId,
      profileId: binding.profileId,
      machineId,
      ...(ownerId ? { ownerId } : {}),
      leaseMs: this.params.refreshLeaseMs,
      expectedCredentialRevision: source.credentialRevision,
    });
    if (!lease.acquired) {
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
    const refreshLeaseOwnerId = lease.ownerId;

    // The first read precedes the cross-daemon lease. Re-read after acquisition so this lease owner
    // never rotates, persists, or projects health from a credential revision another daemon already
    // replaced while this controller was waiting.
    if (!this.isOperationAvailable(binding, 'credential_read')) {
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
    const leasedSource = await readCredentialForRefresh({
      api: this.params.api,
      credentials: this.params.credentials,
      binding,
    });
    if (!leasedSource) {
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
    if (leasedSource.revisionSemantics === 'legacy_unfenced') {
      return {
        status: 'lease_not_acquired',
        credential: null,
        diagnostic: buildRefreshDiagnostic({
          binding,
          reason: options.reason,
          status: 'lease_not_acquired',
          expiresAt: leasedSource.expiresAt,
          now,
          refreshWindowMs: this.params.refreshWindowMs,
        }),
      };
    }
    if (
      options.expectedCredentialRevision
      && leasedSource.credentialRevision !== options.expectedCredentialRevision
    ) {
      throw new Error('connected_service_credential_revision_mismatch');
    }
    if (leasedSource.record.kind !== 'oauth') {
      return {
        status: 'not_oauth',
        credential: null,
        diagnostic: buildRefreshDiagnostic({
          binding,
          reason: options.reason,
          status: 'not_oauth',
          expiresAt: leasedSource.expiresAt,
          now,
          refreshWindowMs: this.params.refreshWindowMs,
        }),
      };
    }
    if (
      hasObservedOauthCredentialChanged(source.record, leasedSource.record)
      && leasedSource.record.oauth.accessToken.trim()
      && typeof leasedSource.expiresAt === 'number'
      && Number.isFinite(leasedSource.expiresAt)
      && leasedSource.expiresAt > now
    ) {
      return {
        status: 'refreshed',
        credential: leasedSource.record,
        credentialRevision: leasedSource.credentialRevision,
        diagnostic: buildRefreshDiagnostic({
          binding,
          reason: options.reason,
          status: 'refreshed',
          expiresAt: leasedSource.expiresAt,
          now,
          refreshWindowMs: this.params.refreshWindowMs,
        }),
      };
    }

    if (!isRevisionedLegacyOauthRefreshService(binding.serviceId)) {
      return {
        status: 'refresh_failed',
        credential: null,
        credentialRevision: leasedSource.credentialRevision,
        diagnostic: buildRefreshDiagnostic({
          binding,
          reason: options.reason,
          status: 'refresh_failed',
          category: 'unknown',
          expiresAt: leasedSource.expiresAt,
          now,
          refreshWindowMs: this.params.refreshWindowMs,
        }),
      };
    }

    if (!leasedSource.record.oauth.refreshToken.trim()) {
      return {
        status: 'refresh_failed',
        credential: null,
        credentialRevision: leasedSource.credentialRevision,
        diagnostic: buildRefreshDiagnostic({
          binding,
          reason: options.reason,
          status: 'refresh_failed',
          category: 'missing_refresh_token',
          expiresAt: leasedSource.expiresAt,
          now,
          refreshWindowMs: this.params.refreshWindowMs,
        }),
      };
    }

    let next: Awaited<
      ReturnType<
        typeof refreshReleasedPeerLegacyConnectedAccountOauthTokens
      >
    >;
    if (!this.isOperationAvailable(binding, 'oauth_refresh')) {
      return {
        status: 'refresh_failed',
        credential: null,
        credentialRevision: leasedSource.credentialRevision,
        diagnostic: buildRefreshDiagnostic({
          binding,
          reason: options.reason,
          status: 'refresh_failed',
          category: 'unknown',
          expiresAt: leasedSource.expiresAt,
          now,
          refreshWindowMs: this.params.refreshWindowMs,
        }),
      };
    }
    let leaseAuthority = true;
    let renewalInFlight: Promise<void> = Promise.resolve();
    const renewalEveryMs = Math.max(1_000, Math.trunc(this.params.refreshLeaseMs / 2));
    const renewalTimer = setInterval(() => {
      renewalInFlight = renewalInFlight.then(async () => {
        if (!this.isOperationAvailable(binding, 'refresh_lease')) {
          leaseAuthority = false;
          return;
        }
        const renewed = await this.params.api.acquireConnectedServiceRefreshLease({
          serviceId: binding.serviceId,
          profileId: binding.profileId,
          machineId,
          ownerId: refreshLeaseOwnerId,
          leaseMs: this.params.refreshLeaseMs,
          expectedCredentialRevision: leasedSource.credentialRevision,
        });
        if (
          !renewed.acquired
          || renewed.credentialRevision !== leasedSource.credentialRevision
          || renewed.ownerId !== refreshLeaseOwnerId
        ) {
          leaseAuthority = false;
        }
      }).catch(() => {
        leaseAuthority = false;
      });
    }, renewalEveryMs);
    (renewalTimer as unknown as { unref?: () => void }).unref?.();
    try {
      next = await refreshReleasedPeerLegacyConnectedAccountOauthTokens({
        serviceId: binding.serviceId,
        refreshToken: leasedSource.record.oauth.refreshToken,
        now,
      });
    } catch (error) {
      const classified = classifyRefreshFailure(error);
      return {
        status: 'refresh_failed',
        credential: null,
        credentialRevision: leasedSource.credentialRevision,
        diagnostic: buildRefreshDiagnostic({
          binding,
          reason: options.reason,
          status: 'refresh_failed',
          category: classified.category,
          providerStatus: classified.providerStatus,
          providerErrorCode: classified.providerErrorCode,
          expiresAt: leasedSource.expiresAt,
          now,
          refreshWindowMs: this.params.refreshWindowMs,
        }),
      };
    } finally {
      clearInterval(renewalTimer);
      await renewalInFlight;
    }
    if (!leaseAuthority) {
      return {
        status: 'lease_not_acquired',
        credential: null,
        credentialRevision: leasedSource.credentialRevision,
        diagnostic: buildRefreshDiagnostic({
          binding,
          reason: options.reason,
          status: 'lease_not_acquired',
          expiresAt: leasedSource.expiresAt,
          now: this.params.now(),
          refreshWindowMs: this.params.refreshWindowMs,
        }),
      };
    }

    const updated = buildUpdatedOauthRecord({
      now,
      record: leasedSource.record,
      next,
    });

    if (!this.isOperationAvailable(binding, 'credential_write')) {
      return {
        status: 'lease_not_acquired',
        credential: null,
        credentialRevision: leasedSource.credentialRevision,
        diagnostic: buildRefreshDiagnostic({
          binding,
          reason: options.reason,
          status: 'lease_not_acquired',
          expiresAt: leasedSource.expiresAt,
          now: this.params.now(),
          refreshWindowMs: this.params.refreshWindowMs,
        }),
      };
    }
    const persisted = await persistUpdatedCredential({
      api: this.params.api,
      credentials: this.params.credentials,
      binding,
      source: leasedSource,
      updated,
      expectedCredentialRevision: leasedSource.credentialRevision,
      refreshLeaseOwnerId,
    });

    if ('error' in persisted) {
      const current = await readCredentialForRefresh({
        api: this.params.api,
        credentials: this.params.credentials,
        binding,
      });
      return {
        status: 'lease_not_acquired',
        credential: current?.record ?? null,
        ...(current?.revisionSemantics === 'revisioned'
          ? { credentialRevision: current.credentialRevision }
          : {}),
        diagnostic: buildRefreshDiagnostic({
          binding,
          reason: options.reason,
          status: 'lease_not_acquired',
          expiresAt: current?.expiresAt ?? null,
          now: this.params.now(),
          refreshWindowMs: this.params.refreshWindowMs,
        }),
      };
    }

    const persistedSource = await readCredentialForRefresh({
      api: this.params.api,
      credentials: this.params.credentials,
      binding,
    });
    if (
      !persistedSource
      || persistedSource.credentialRevision !== persisted.credentialRevision
      || persistedSource.record.kind !== 'oauth'
      || !isDeepStrictEqual(persistedSource.record, updated)
    ) {
      return {
        status: 'lease_not_acquired',
        credential: persistedSource?.record ?? null,
        ...(persistedSource?.revisionSemantics === 'revisioned'
          ? { credentialRevision: persistedSource.credentialRevision }
          : {}),
        diagnostic: buildRefreshDiagnostic({
          binding,
          reason: options.reason,
          status: 'lease_not_acquired',
          expiresAt: persistedSource?.expiresAt ?? null,
          now: this.params.now(),
          refreshWindowMs: this.params.refreshWindowMs,
        }),
      };
    }

    return {
      status: 'refreshed',
      credential: persistedSource.record,
      credentialRevision: persistedSource.credentialRevision,
      diagnostic: buildRefreshDiagnostic({
        binding,
        reason: options.reason,
        status: 'refreshed',
        expiresAt: updated.expiresAt,
        now,
        refreshWindowMs: this.params.refreshWindowMs,
      }),
    };
  }

  private async finalizeRefreshResult(
    binding: BoundProfile,
    result: ConnectedServiceCredentialRefreshResult,
  ): Promise<ConnectedServiceCredentialRefreshResult> {
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
          const distribution = await this.distributeRefreshedBinding(binding);
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
      this.armCredentialHealthReprobeBackoff(binding, this.params.now());
    }
    const healthSettled = await this.persistCredentialHealthForRefreshResult(finalizedResult);
    if (healthSettled) {
      await this.notifyCredentialHealthForRefreshResult(finalizedResult);
    }
    return finalizedResult;
  }

  /**
   * Rematerialize every registered target for a freshly rotated binding and notify the runtime so the
   * affected sessions adopt the new token. Both the rematerialize and the auth-updated notify are
   * per-binding single-flighted, so concurrent completion callers coalesce onto one distribution.
   */
  private async distributeRefreshedBinding(binding: BoundProfile): Promise<RematerializedTargetsResult> {
    const rematerialization = await this.rematerializeTargetsForBindingAfterRefresh(binding);
    if (rematerialization.rematerializedTargets.length > 0) {
      await this.notifyAuthUpdatedForRefreshedBinding(binding, rematerialization.rematerializedTargets);
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
    result: ConnectedServiceCredentialRefreshResult,
  ): Promise<boolean> {
    if (result.status !== 'refreshed' && result.status !== 'refresh_failed') return false;
    if (!this.isOperationAvailable({
      serviceId: result.diagnostic.serviceId,
      profileId: result.diagnostic.profileId,
    }, 'credential_health')) {
      return false;
    }
    const updateHealth = this.params.api.updateConnectedServiceCredentialHealth;
    if (typeof updateHealth !== 'function') return false;

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
      await updateHealth.call(this.params.api, {
        serviceId: diagnostic.serviceId,
        profileId: diagnostic.profileId,
        health,
        ...(result.credentialRevision ? { expectedCredentialRevision: result.credentialRevision } : {}),
      });
      return true;
    } catch (error) {
      logger.warn('[DAEMON RUN] Failed to update connected-service credential health after refresh', {
        serviceId: diagnostic.serviceId,
        profileId: diagnostic.profileId,
        status: diagnostic.status,
        category: diagnostic.category ?? null,
        error: serializeAxiosErrorForLog(error),
      });
      return false;
    }
  }

  async handleExternalCredentialUpdate(input: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    credentialPresence: Extract<
      ConnectedServiceProjectedCredentialPresence,
      Readonly<{ status: 'present' }>
    >;
    executionAuthority: ConnectedServiceExecutionAuthorityV1;
  }>): Promise<void> {
    const profileId = String(input.profileId ?? '').trim();
    if (!profileId) return;
    const binding = { serviceId: input.serviceId, profileId } satisfies BoundProfile;
    const affectedTargets = (await this.rematerializeTargetsForBindingDetailed(binding)).rematerializedTargets;
    if (affectedTargets.length === 0 || input.executionAuthority === 'passive_projection') return;
    await this.params.onAuthUpdated?.({
      binding,
      affectedTargets,
      trigger: 'reconnect_propagation',
      credentialPresence: input.credentialPresence,
    });
  }

  private async rematerializeTargetsForBindingAfterRefresh(binding: BoundProfile): Promise<RematerializedTargetsResult> {
    const key = bindingKey(binding);
    const existing = this.inFlightRefreshRematerializations.get(key);
    if (existing) return await existing;

    const promise = this.rematerializeTargetsForBindingDetailed(binding);
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
    affectedTargets: ReadonlyArray<SpawnTarget>,
  ): Promise<void> {
    if (affectedTargets.length === 0) return;
    const key = bindingKey(binding);
    const existing = this.inFlightRefreshAuthUpdatedNotifications.get(key);
    if (existing) {
      await existing;
      return;
    }

    const promise = Promise.resolve(this.params.onAuthUpdated?.({
      binding,
      affectedTargets,
      trigger: 'refresh_triggered_restart',
    }));
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

  private async rematerializeTargetsForBindingDetailed(binding: BoundProfile): Promise<RematerializedTargetsResult> {
    const affected = this.runtimeRegistry.listRefreshTargets().filter((target) =>
      this.resolveBoundProfiles(target).some((candidate) =>
        candidate.serviceId === binding.serviceId && candidate.profileId === binding.profileId,
      ),
    );
    const rematerialized: SpawnTarget[] = [];
    const failed: RematerializedTargetFailure[] = [];
    for (const rawTarget of affected) {
      const target = await this.canonicalizeTargetSelectionsForRefresh(rawTarget, {
        requireFreshGroupState: true,
      });
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
        await resolveConnectedServiceCredentialResolutions({
        credentials: this.params.credentials,
        api: this.params.api,
        bindings: targetBindings,
      });
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
      try {
        await materializeConnectedServicesForSpawn({
          agentId: target.agentId,
          materializationKey: target.materializationKey,
          activeServerDir: this.params.activeServerDir,
          baseDir: this.params.baseDir,
          recordsByServiceId: records,
          accountSettings: this.params.accountSettingsProvider?.() ?? null,
          processEnv: this.params.processEnv ?? process.env,
          ...(target.childSelectionsByServiceId
            ? { selectionsByServiceId: this.buildResolvedSelectionsByServiceId(target.childSelectionsByServiceId, records) }
            : {}),
        });
      } catch (error) {
        if (!(error instanceof ConnectedServiceMaterializationBlockedError)) throw error;
        const primaryDiagnostic = error.diagnostics[0];
        if (!primaryDiagnostic) throw error;
        const targetBinding = this.resolveBoundProfiles(target).find((candidate) => candidate.serviceId === primaryDiagnostic.serviceId)
          ?? this.resolveBoundProfiles(target).find((candidate) => candidate.serviceId === binding.serviceId)
          ?? binding;
        await this.persistCredentialHealthForMaterializationFailure(targetBinding, primaryDiagnostic);
        failed.push({
          target,
          binding: targetBinding,
          diagnostic: primaryDiagnostic,
        });
        logger.warn('[DAEMON RUN] Connected-service rematerialization blocked; skipping auth-update restart', {
          serviceId: targetBinding.serviceId,
          profileId: targetBinding.profileId,
          agentId: target.agentId,
          materializationCode: primaryDiagnostic.code,
          reason: primaryDiagnostic.reason ?? null,
        });
        continue;
      }
      rematerialized.push(target);
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
  ): Promise<void> {
    await persistConnectedServiceCredentialHealthForMaterializationFailure({
      api: this.params.api,
      binding,
      diagnostic,
      now: this.params.now(),
    });
  }

  private buildMaterializationFailureRefreshResult(input: Readonly<{
    sourceResult: ConnectedServiceCredentialRefreshResult;
    failure: RematerializedTargetFailure;
  }>): ConnectedServiceCredentialRefreshResult {
    const classification = classifyConnectedServiceMaterializationDiagnosticForCredentialRefresh(input.failure.diagnostic);
    return {
      status: 'refresh_failed',
      credential: input.sourceResult.credential,
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
  ): Promise<void> {
    if (result.status !== 'refresh_failed') return;
    const notify = this.params.onCredentialHealthNotification;
    if (!notify) return;
    const diagnostic = result.diagnostic;
    const category = diagnostic.category ?? 'unknown';
    const affectedTargets = this.resolveNotificationTargetsForBinding({
      serviceId: diagnostic.serviceId,
      profileId: diagnostic.profileId,
    });
    try {
      await notify({
        diagnostic,
        healthStatus: isReauthRequiredFailure(category) ? 'reconnect_required' : 'refresh_failed_retryable',
        affectedTargets,
      });
    } catch (error) {
      logger.warn('[DAEMON RUN] Failed to dispatch connected-service credential health notification', {
        serviceId: diagnostic.serviceId,
        profileId: diagnostic.profileId,
        status: diagnostic.status,
        category: diagnostic.category ?? null,
        error: serializeAxiosErrorForLog(error),
      });
    }
  }

  private resolveNotificationTargetsForBinding(
    binding: BoundProfile,
  ): ReadonlyArray<ConnectedServiceCredentialHealthNotificationTarget> {
    return this.runtimeRegistry.listRefreshTargets()
      .filter((target) => this.resolveBoundProfiles(target).some((candidate) =>
        candidate.serviceId === binding.serviceId && candidate.profileId === binding.profileId,
      ))
      .map((target) => ({
        pid: target.pid,
        agentId: target.agentId,
        sessionId: target.sessionId ?? target.materializationKey,
      }));
  }

  private resolveMaterializedHomeRootForTarget(input: Readonly<{
    target: SpawnTarget;
    binding: BoundProfile;
  }>): string | null {
    return resolveConnectedServiceMaterializedHomeRoot(input.target.agentId, {
      activeServerDir: this.params.activeServerDir,
      serviceId: input.binding.serviceId,
      profileId: input.binding.profileId,
      selection: input.target.childSelectionsByServiceId?.get(input.binding.serviceId) ?? null,
    });
  }

  private async resolveCanonicalGroupStateForRefresh(
    input: Readonly<{ serviceId: ConnectedServiceId; groupId: string }>,
    now: number,
  ): Promise<CanonicalGroupStateForRefresh | null> {
    const key = `${input.serviceId}::${input.groupId}`;
    const cached = this.canonicalGroupStateCache.get(key);
    if (cached && now - cached.atMs < 15_000) return cached.group;
    return await this.refreshCanonicalGroupStateForRefresh(input, now);
  }

  private async refreshCanonicalGroupStateForRefresh(
    input: Readonly<{ serviceId: ConnectedServiceId; groupId: string }>,
    now: number,
  ): Promise<CanonicalGroupStateForRefresh | null> {
    const key = `${input.serviceId}::${input.groupId}`;
    let group: CanonicalGroupStateForRefresh | null = null;
    const reader = this.params.api.getConnectedServiceAuthGroup;
    if (typeof reader === 'function') {
      try {
        const value = await reader.call(this.params.api, {
          serviceId: input.serviceId,
          groupId: input.groupId,
        });
        group = value
          ? {
              activeProfileId: typeof value.activeProfileId === 'string' && value.activeProfileId.trim().length > 0
                ? value.activeProfileId
                : null,
              generation: typeof value.generation === 'number' && Number.isFinite(value.generation)
                ? Math.trunc(value.generation)
                : 0,
            }
          : null;
      } catch {
        group = null;
      }
    }
    this.canonicalGroupStateCache.set(key, { atMs: now, group });
    return group;
  }

  private async canonicalizeTargetSelectionsForRefresh(
    target: SpawnTarget,
    options: Readonly<{ requireFreshGroupState?: boolean }> = {},
  ): Promise<SpawnTarget | null> {
    if (!target.childSelectionsByServiceId || target.childSelectionsByServiceId.size === 0) {
      return target;
    }

    let changed = false;
    let nextBindings = target.bindings;
    const nextSelections = new Map<ConnectedServiceId, ConnectedServiceChildSelection>();
    for (const [serviceId, selection] of target.childSelectionsByServiceId.entries()) {
      if (selection.kind !== 'group') {
        nextSelections.set(serviceId, selection);
        continue;
      }
      const groupIdentity = { serviceId, groupId: selection.groupId };
      const canonical = options.requireFreshGroupState === true
        ? await this.refreshCanonicalGroupStateForRefresh(groupIdentity, this.params.now())
        : await this.resolveCanonicalGroupStateForRefresh(groupIdentity, this.params.now());
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
    return target.bindings;
  }

  private buildResolvedSelectionsByServiceId(
    childSelectionsByServiceId: NonNullable<SpawnTarget['childSelectionsByServiceId']>,
    recordsByServiceId: ReadonlyMap<ConnectedServiceId, ConnectedServiceCredentialRecordV1>,
  ): ReadonlyMap<ConnectedServiceId, ConnectedServiceResolvedSelection> {
    const selectionsByServiceId = new Map<ConnectedServiceId, ConnectedServiceResolvedSelection>();
    for (const [serviceId, selection] of childSelectionsByServiceId.entries()) {
      const record = recordsByServiceId.get(serviceId);
      if (!record) continue;
      if (selection.kind === 'profile') {
        selectionsByServiceId.set(serviceId, {
          kind: 'profile',
          serviceId,
          profileId: selection.profileId,
          record,
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
        record,
      });
    }
    return selectionsByServiceId;
  }
}
