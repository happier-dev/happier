import {
  type AccountSettings,
  type ConnectedServiceCredentialHealthV1,
  ConnectedServiceCredentialRecordV1Schema,
  getConnectedAccountDescriptor,
  openConnectedServiceCredentialCiphertext,
  sealConnectedServiceCredentialCiphertext,
  type ConnectedServiceCredentialRecordV1,
  type ConnectedServiceId,
} from '@happier-dev/protocol';
import { randomBytes } from 'node:crypto';

import type { ApiClient } from '@/api/api';
import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import type { CatalogAgentId } from '@/agent/catalog/ids';
import type { Credentials } from '@/persistence';
import { logger } from '@/ui/logger';

import { resolveConnectedServiceCredentials } from '@/cloud/connectedServices/resolveConnectedServiceCredentials';
import {
  resolveConnectedServiceAccountMode,
  type ConnectedServiceAccountMode,
} from '@/cloud/connectedServices/resolveConnectedServiceAccountMode';
import {
  ConnectedServiceMaterializationBlockedError,
  materializeConnectedServicesForSpawn,
} from '../materialize/materializeConnectedServicesForSpawn';
import { resolveConnectedServiceMaterializedRootDir } from '../materialize/resolveConnectedServiceMaterializedRootDir';
import { refreshConnectedAccountOauthTokens } from './serviceRefreshers';
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

type BoundProfile = Readonly<{ serviceId: ConnectedServiceId; profileId: string }>;
type BrokerRefreshSelection<TServiceId extends ConnectedServiceId> = Readonly<
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

type CodexChatGptAuthTokensRefreshSelection = BrokerRefreshSelection<'openai-codex'>;
type CodexChatGptAuthTokensRefreshResponse = Readonly<{
  accessToken: string;
  chatgptAccountId: string | null;
  chatgptPlanType: string | null;
}>;
type ClaudeSubscriptionAuthTokensRefreshSelection = BrokerRefreshSelection<'claude-subscription'>;
type ClaudeSubscriptionAuthTokensRefreshResponse = Readonly<{
  accessToken: string;
  anthropicAccountId: string | null;
  expiresAt: number | null;
}>;
type ConnectedServiceCredentialSource = Readonly<{
  storageMode: 'plain' | 'sealed';
  record: ConnectedServiceCredentialRecordV1;
  expiresAt: number | null;
}>;

export type ConnectedServiceRefreshFailureCategory =
  ConnectedServiceMaterializationCredentialRefreshFailureCategory;

type ConnectedServiceCredentialRefreshReason =
  | 'scheduled'
  | 'spawn_preflight'
  | 'runtime_auth_failure'
  | 'provider_auth_bridge'
  | 'quota_bridge';

export type ConnectedServiceCredentialRefreshStatus =
  | 'refreshed'
  | 'not_needed'
  | 'not_oauth'
  | 'lease_not_acquired'
  | 'credential_missing'
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

function shouldBlockRefreshForCredentialHealth(reason: ConnectedServiceCredentialRefreshReason): boolean {
  return reason === 'scheduled'
    || reason === 'spawn_preflight'
    || reason === 'runtime_auth_failure'
    || reason === 'quota_bridge';
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
    },
  });
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
  api: ApiClient;
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
        const record = ConnectedServiceCredentialRecordV1Schema.parse(plain.content.v);
        return {
          storageMode: 'plain',
          record,
          expiresAt: typeof record.expiresAt === 'number' && Number.isFinite(record.expiresAt) ? record.expiresAt : null,
        };
      }
      if (accountMode === 'plain') return null;
    } catch (error) {
      if (accountMode !== 'unknown') throw error;
    }
  }

  const sealed = await params.api.getConnectedServiceCredentialSealed({
    serviceId: params.binding.serviceId,
    profileId: params.binding.profileId,
  });
  if (!sealed) return null;
  if (sealed.metadata?.kind !== 'oauth') return null;

  return {
    storageMode: 'sealed',
    record: openConnectedServiceRecord({
      credentials: params.credentials,
      ciphertext: sealed.sealed.ciphertext,
    }),
    expiresAt: sealed.metadata.expiresAt ?? null,
  };
}

async function persistUpdatedCredential(params: Readonly<{
  api: ApiClient;
  credentials: Credentials;
  binding: BoundProfile;
  source: ConnectedServiceCredentialSource;
  updated: ConnectedServiceCredentialRecordV1;
}>): Promise<void> {
  if (params.source.storageMode === 'plain') {
    await params.api.registerConnectedServiceCredentialPlain({
      serviceId: params.binding.serviceId,
      profileId: params.binding.profileId,
      content: { t: 'plain', v: params.updated },
    });
    return;
  }

  const sealedCiphertext = sealConnectedServiceCredentialCiphertext({
    material:
      params.credentials.encryption.type === 'legacy'
        ? { type: 'legacy', secret: params.credentials.encryption.secret }
        : { type: 'dataKey', machineKey: params.credentials.encryption.machineKey },
    payload: params.updated,
    randomBytes: (length) => randomBytes(length),
  });

  await params.api.registerConnectedServiceCredentialSealed({
    serviceId: params.binding.serviceId,
    profileId: params.binding.profileId,
    sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
    metadata: {
      kind: params.updated.kind,
      providerEmail: params.updated.kind === 'oauth' ? params.updated.oauth.providerEmail : null,
      providerAccountId: params.updated.kind === 'oauth' ? params.updated.oauth.providerAccountId : null,
      expiresAt: params.updated.expiresAt,
    },
  });
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
    onAuthUpdated?: (event: Readonly<{
      binding: BoundProfile;
      affectedTargets: ReadonlyArray<SpawnTarget>;
      trigger: 'refresh_triggered_restart' | 'reconnect_propagation';
    }>) => void | Promise<void>;
    onCredentialHealthNotification?: (event: Readonly<{
      diagnostic: ConnectedServiceCredentialRefreshDiagnostic;
      healthStatus: ConnectedServiceCredentialHealthNotificationStatus;
      affectedTargets: ReadonlyArray<ConnectedServiceCredentialHealthNotificationTarget>;
    }>) => void | Promise<void>;
  }>) {
    this.runtimeRegistry = params.runtimeRegistry ?? new ConnectedServiceRuntimeRegistry();
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

  /**
   * R3-6: resolve a LIVE runtime target (session or execution run) by its baked broker
   * selection-identity string, for broker bridge authorization (broker callers present a
   * synthetic sessionId that can never match a tracked session).
   */
  getRuntimeTargetByBrokerSelectionIdentity(identity: string): ConnectedServiceRuntimeTarget | null {
    return this.runtimeRegistry.getByBrokerSelectionIdentity(identity);
  }

  // Execution-run targets share their runner's pid with the session target, so they live in the
  // registry's run keyspace (keyed by runKey) instead of the pid map. Refresh distribution and
  // canonical group-home ownership cover them via the shared listRefreshTargets() view.
  registerExecutionRunTarget(params: Readonly<{
    runKey: string;
    runnerPid: number;
    agentId: CatalogAgentId;
    materializationKey: string;
    connectedServicesBindingsRaw: unknown;
    connectedServiceSelectionsEnv?: Pick<NodeJS.ProcessEnv, string> | null;
  }>): void {
    this.runtimeRegistry.registerRunTarget({
      runKey: params.runKey,
      pid: params.runnerPid,
      agentId: params.agentId,
      materializationKey: params.materializationKey,
      connectedServicesBindingsRaw: params.connectedServicesBindingsRaw,
      ...(params.connectedServiceSelectionsEnv
        ? { connectedServiceSelectionsEnv: params.connectedServiceSelectionsEnv }
        : {}),
    });
  }

  unregisterExecutionRunTarget(runKey: string): void {
    this.runtimeRegistry.unregisterRunKey(runKey);
  }

  transferPid(fromPid: number, toPid: number): void {
    this.runtimeRegistry.transferPid(fromPid, toPid);
  }

  async tickOnce(): Promise<void> {
    const now = this.params.now();
    const unique = new Map<string, BoundProfile>();
    const errors: unknown[] = [];

    for (const target of this.runtimeRegistry.listRefreshTargets()) {
      for (const binding of this.resolveBoundProfiles(target)) {
        unique.set(bindingKey(binding), binding);
      }
    }

    for (const binding of unique.values()) {
      try {
        await this.maybeRefreshBinding(binding, now);
      } catch (error) {
        errors.push(error);
      }
    }

    if (errors.length > 0) {
      throw new AggregateError(errors, 'Connected services refresh tick failed');
    }
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
    await this.notifyCredentialHealthForRefreshResult(result);
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
  }>): Promise<ConnectedServiceCredentialRecordV1 | null> {
    const result = await this.refreshOauthBinding(
      { serviceId: input.serviceId, profileId: input.profileId },
      this.params.now(),
      { force: input.force, reason: 'quota_bridge' },
    );
    return result.status === 'refreshed' ? result.credential : null;
  }

  async refreshConnectedServiceCredentialForRuntimeAuthFailure(input: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    sessionId?: string | null;
  }>): Promise<ConnectedServiceCredentialRefreshResult> {
    const binding = { serviceId: input.serviceId, profileId: input.profileId };
    const result = await this.refreshOauthBinding(
      binding,
      this.params.now(),
      { force: true, reason: 'runtime_auth_failure' },
    );
    await this.notifyCredentialHealthForRefreshResult(result);
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
      return this.buildMaterializationFailureRefreshResult({
        sourceResult: result,
        failure: targetFailures[0]!,
      });
    }

    if (!wasRuntimeAuthSessionRematerialized({ result: rematerialization, sessionId: input.sessionId ?? null })) {
      return await this.finalizeRefreshResult(binding, this.buildMissingRuntimeAuthTargetRefreshResult({
        binding,
        sourceResult: result,
      }));
    }

    return result;
  }

  async refreshOpenAiCodexChatGptTokensForBridge(input: Readonly<{
    selection: CodexChatGptAuthTokensRefreshSelection;
    chatgptPlanType: string | null;
    forceRefresh?: boolean;
  }>): Promise<CodexChatGptAuthTokensRefreshResponse> {
    const profileId = input.selection.kind === 'profile'
      ? input.selection.profileId
      : input.selection.activeProfileId;
    const binding: BoundProfile = { serviceId: 'openai-codex', profileId };

    // F6 conditional refresh: when not forced, return the CURRENT access token if it is OAuth and not
    // within the refresh window of expiry — NO provider call, NO lease, NO rotation. The single-use
    // OAuth refresh token is rotated only near-expiry or when the broker forces it (its 401 retry).
    if (input.forceRefresh !== true) {
      const current = await this.readValidOauthAccessTokenForBridge(binding);
      if (current) {
        return {
          accessToken: current.accessToken,
          chatgptAccountId: current.providerAccountId,
          chatgptPlanType: input.chatgptPlanType,
        };
      }
    }

    const result = await this.refreshOauthBinding(
      binding,
      this.params.now(),
      { force: true, reason: 'provider_auth_bridge' },
    );
    if (result.status !== 'refreshed' || result.credential?.kind !== 'oauth') {
      throw new Error('connected_service_chatgpt_refresh_unavailable');
    }
    // Distribution happens BY CONSTRUCTION on the 'refreshed' completion path (RR-1).

    return {
      accessToken: result.credential.oauth.accessToken,
      chatgptAccountId: result.credential.oauth.providerAccountId,
      chatgptPlanType: input.chatgptPlanType,
    };
  }

  async refreshClaudeSubscriptionTokensForBridge(input: Readonly<{
    selection: ClaudeSubscriptionAuthTokensRefreshSelection;
    forceRefresh?: boolean;
    shouldAdoptCurrentAccessToken?: (accessToken: string) => boolean;
  }>): Promise<ClaudeSubscriptionAuthTokensRefreshResponse> {
    const profileId = input.selection.kind === 'group'
      ? input.selection.activeProfileId
      : input.selection.profileId;
    const binding: BoundProfile = { serviceId: 'claude-subscription', profileId };

    // Read the current credential to branch on kind. Setup-tokens (kind:'token') are non-rotating and
    // returned as-is; OAuth (kind:'oauth') is refreshed through the canonical single-flight refresher so
    // the daemon stays the sole refresher and the rotated refresh token is persisted ONLY in the store.
    const records = await resolveConnectedServiceCredentials({
      credentials: this.params.credentials,
      api: this.params.api,
      bindings: [binding],
    });
    const current = records.get('claude-subscription');
    if (!current) {
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
    // token is rotated only near-expiry or when the broker forces it (its 401 retry).
    if (input.forceRefresh !== true && this.isOauthRecordStillValidForBridge(current)) {
      return {
        accessToken: current.oauth.accessToken,
        anthropicAccountId: current.oauth.providerAccountId,
        expiresAt: current.expiresAt ?? null,
      };
    }

    if (
      input.forceRefresh === true
      && input.shouldAdoptCurrentAccessToken
      && this.isOauthRecordStillValidForBridge(current)
    ) {
      if (input.shouldAdoptCurrentAccessToken(current.oauth.accessToken)) {
        return {
          accessToken: current.oauth.accessToken,
          anthropicAccountId: current.oauth.providerAccountId,
          expiresAt: current.expiresAt ?? null,
        };
      }
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
   * F6 helper for the Codex bridge: read the current credential via the canonical refresh reader (no
   * parallel read path) and return its access token + account id IFF it is OAuth and still valid. Null
   * otherwise (the caller then runs a forced refresh).
   */
  private async readValidOauthAccessTokenForBridge(
    binding: BoundProfile,
  ): Promise<Readonly<{ accessToken: string; providerAccountId: string | null }> | null> {
    const source = await readCredentialForRefresh({
      api: this.params.api,
      credentials: this.params.credentials,
      binding,
    });
    if (!source || source.record.kind !== 'oauth') return null;
    if (!this.isOauthRecordStillValidForBridge(source.record)) return null;
    return {
      accessToken: source.record.oauth.accessToken,
      providerAccountId: source.record.oauth.providerAccountId,
    };
  }

  private async maybeRefreshBinding(binding: BoundProfile, now: number): Promise<void> {
    const result = await this.refreshOauthBinding(binding, now, { reason: 'scheduled' });
    if (result.status === 'refresh_failed') {
      await this.notifyCredentialHealthForRefreshResult(result);
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
    options: Readonly<{ force?: boolean; reason: ConnectedServiceCredentialRefreshReason }>,
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

  private async refreshOauthBindingUnserialized(
    binding: BoundProfile,
    now: number,
    options: Readonly<{ force?: boolean; reason: ConnectedServiceCredentialRefreshReason }>,
  ): Promise<ConnectedServiceCredentialRefreshResult> {
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
    if (await this.isRefreshBlockedByCredentialHealth(binding, options.reason)) {
      const status = options.reason === 'spawn_preflight' || options.reason === 'runtime_auth_failure'
        ? 'refresh_failed'
        : 'not_needed';
      return {
        status,
        credential: null,
        diagnostic: buildRefreshDiagnostic({
          binding,
          reason: options.reason,
          status,
          ...(status === 'refresh_failed'
            ? {
              category: 'invalid_grant',
              providerErrorCode: 'invalid_grant',
            }
            : {}),
          expiresAt: source.expiresAt,
          now,
          refreshWindowMs: this.params.refreshWindowMs,
        }),
      };
    }
    if (options.force !== true) {
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
    if (!machineId) {
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

    if (!getConnectedAccountDescriptor(binding.serviceId)?.oauth) {
      return {
        status: 'refresh_failed',
        credential: null,
        diagnostic: buildRefreshDiagnostic({
          binding,
          reason: options.reason,
          status: 'refresh_failed',
          category: 'unknown',
          expiresAt: source.expiresAt,
          now,
          refreshWindowMs: this.params.refreshWindowMs,
        }),
      };
    }

    if (!source.record.oauth.refreshToken.trim()) {
      return {
        status: 'refresh_failed',
        credential: null,
        diagnostic: buildRefreshDiagnostic({
          binding,
          reason: options.reason,
          status: 'refresh_failed',
          category: 'missing_refresh_token',
          expiresAt: source.expiresAt,
          now,
          refreshWindowMs: this.params.refreshWindowMs,
        }),
      };
    }

    let next: Awaited<ReturnType<typeof refreshConnectedAccountOauthTokens>>;
    try {
      next = await refreshConnectedAccountOauthTokens({
        serviceId: binding.serviceId,
        refreshToken: source.record.oauth.refreshToken,
        now,
      });
    } catch (error) {
      const classified = classifyRefreshFailure(error);
      return {
        status: 'refresh_failed',
        credential: null,
        diagnostic: buildRefreshDiagnostic({
          binding,
          reason: options.reason,
          status: 'refresh_failed',
          category: classified.category,
          providerStatus: classified.providerStatus,
          providerErrorCode: classified.providerErrorCode,
          expiresAt: source.expiresAt,
          now,
          refreshWindowMs: this.params.refreshWindowMs,
        }),
      };
    }

    const updated = buildUpdatedOauthRecord({
      now,
      record: source.record,
      next,
    });

    await persistUpdatedCredential({
      api: this.params.api,
      credentials: this.params.credentials,
      binding,
      source,
      updated,
    });

    return {
      status: 'refreshed',
      credential: updated,
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
    await this.persistCredentialHealthForRefreshResult(result);
    if (result.status === 'refreshed') {
      // RR-1: rotate+distribute is ONE transaction BY CONSTRUCTION. Every rotation funnels through
      // this single completion path (the OAuth refresh leaf calls it exactly once), so no entry point
      // — scheduled, bridge, runtime-auth, quota probe, or spawn preflight — can mint a fresh token
      // and leave a materialized target (group siblings included) holding the superseded one.
      const distributionKey = bindingKey(binding);
      if (!this.distributingRefreshedBindings.has(distributionKey)) {
        this.distributingRefreshedBindings.add(distributionKey);
        try {
          this.lastRefreshedDistributionByKey.set(distributionKey, await this.distributeRefreshedBinding(binding));
        } finally {
          this.distributingRefreshedBindings.delete(distributionKey);
        }
      }
    }
    return result;
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
  ): Promise<void> {
    if (result.status !== 'refreshed' && result.status !== 'refresh_failed') return;
    const updateHealth = this.params.api.updateConnectedServiceCredentialHealth;
    if (typeof updateHealth !== 'function') return;

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
      });
    } catch (error) {
      logger.warn('[DAEMON RUN] Failed to update connected-service credential health after refresh', {
        serviceId: diagnostic.serviceId,
        profileId: diagnostic.profileId,
        status: diagnostic.status,
        category: diagnostic.category ?? null,
        error: serializeAxiosErrorForLog(error),
      });
    }
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
      const target = await this.canonicalizeTargetSelectionsForRefresh(rawTarget);
      if (!target) {
        logger.warn('[DAEMON RUN] Skipping connected-service rematerialization; canonical group state unavailable', {
          serviceId: binding.serviceId,
          profileId: binding.profileId,
          agentId: rawTarget.agentId,
          pid: rawTarget.pid,
        });
        continue;
      }
      const records = await resolveConnectedServiceCredentials({
        credentials: this.params.credentials,
        api: this.params.api,
        bindings: this.resolveBoundProfiles(target),
      });
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

  private async isRefreshBlockedByCredentialHealth(
    binding: BoundProfile,
    reason: ConnectedServiceCredentialRefreshReason,
  ): Promise<boolean> {
    if (!shouldBlockRefreshForCredentialHealth(reason)) return false;
    const listProfiles = this.params.api.listConnectedServiceProfiles;
    if (typeof listProfiles !== 'function') return false;
    try {
      const result = await listProfiles.call(this.params.api, { serviceId: binding.serviceId });
      return result.profiles.some((profile) =>
        profile.profileId === binding.profileId && isReconnectRequiredProfileStatus(profile.status),
      );
    } catch (error) {
      logger.warn('[DAEMON RUN] Failed to read connected-service profile health before refresh', {
        serviceId: binding.serviceId,
        profileId: binding.profileId,
        reason,
        error: serializeAxiosErrorForLog(error),
      });
      return false;
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
      const canonical = await this.resolveCanonicalGroupStateForRefresh(
        { serviceId, groupId: selection.groupId },
        this.params.now(),
      );
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
