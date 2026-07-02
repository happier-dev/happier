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
import {
  type CodexChatGptAuthTokensRefreshResponse,
  type CodexChatGptAuthTokensRefreshSelection,
} from '@happier-dev/plugins-codex/agent/auth/services/openai/cloud/refreshBridge';
import type { CatalogAgentId } from '@/backends/types';
import type { Credentials } from '@/persistence';
import { logger } from '@/ui/logger';

import {
  HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY,
  readConnectedServiceChildSelectionsFromEnv,
} from '../connectedServiceChildEnvironment';
import {
  parseConnectedServiceBindingSelections,
  type ConnectedServiceBindingSelection,
} from '../parseConnectedServicesBindings';
import { resolveConnectedServiceCredentials } from '@/cloud/connectedServices/resolveConnectedServiceCredentials';
import {
  resolveConnectedServiceAccountMode,
  type ConnectedServiceAccountMode,
} from '@/cloud/connectedServices/resolveConnectedServiceAccountMode';
import {
  ConnectedServiceMaterializationBlockedError,
  materializeConnectedServicesForSpawn,
} from '../materialize/materializeConnectedServicesForSpawn';
import { refreshConnectedAccountOauthTokens } from './serviceRefreshers';
import type { ConnectedServiceResolvedSelection } from '../materialization/materializer';
import type { ConnectedServicesMaterializationDiagnostic } from '../materialization/materializer';

type BoundProfile = Readonly<{ serviceId: ConnectedServiceId; profileId: string }>;
type ChildSelectionsByServiceId = NonNullable<ReturnType<typeof readConnectedServiceChildSelectionsFromEnv>>;
type ConnectedServiceCredentialSource = Readonly<{
  storageMode: 'plain' | 'sealed';
  record: ConnectedServiceCredentialRecordV1;
  expiresAt: number | null;
}>;

export type ConnectedServiceRefreshFailureCategory =
  | 'invalid_grant'
  | 'invalid_client'
  | 'provider_401'
  | 'provider_403'
  | 'network_error'
  | 'malformed_response'
  | 'missing_access_token'
  | 'missing_refresh_token'
  | 'unknown';

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

type SpawnTarget = Readonly<{
  pid: number;
  agentId: CatalogAgentId;
  sessionId: string | null;
  materializationKey: string;
  bindings: ReadonlyArray<ConnectedServiceBindingSelection>;
  childSelectionsByServiceId: ChildSelectionsByServiceId | null;
}>;

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

function readRefreshFailureHttpStatus(message: string): number | null {
  const match = message.match(/,\s*(\d{3})\):/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isInteger(value) ? value : null;
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
  private readonly targetsByPid = new Map<number, SpawnTarget>();
  private readonly inFlightRefreshes = new Map<string, Promise<ConnectedServiceCredentialRefreshResult>>();

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
  }>) {}

  registerSpawnTarget(params: Readonly<{
    pid: number;
    agentId: CatalogAgentId;
    sessionId?: string | null;
    materializationKey: string;
    connectedServicesBindingsRaw: unknown;
    connectedServiceSelectionsEnvRaw?: string;
  }>): void {
    const bindings = parseConnectedServiceBindingSelections(params.connectedServicesBindingsRaw);
    if (bindings.length === 0) return;
    this.targetsByPid.set(params.pid, {
      pid: params.pid,
      agentId: params.agentId,
      sessionId: typeof params.sessionId === 'string' && params.sessionId.trim().length > 0
        ? params.sessionId.trim()
        : null,
      materializationKey: params.materializationKey,
      bindings,
      childSelectionsByServiceId: typeof params.connectedServiceSelectionsEnvRaw === 'string'
        ? readConnectedServiceChildSelectionsFromEnv({
          [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: params.connectedServiceSelectionsEnvRaw,
        })
        : null,
    });
  }

  unregisterPid(pid: number): void {
    this.targetsByPid.delete(pid);
  }

  transferPid(fromPid: number, toPid: number): void {
    const target = this.targetsByPid.get(fromPid);
    if (!target) return;
    this.targetsByPid.delete(fromPid);
    this.targetsByPid.set(toPid, {
      ...target,
      pid: toPid,
    });
  }

  async tickOnce(): Promise<void> {
    const now = this.params.now();
    const unique = new Map<string, BoundProfile>();
    const errors: unknown[] = [];

    for (const target of this.targetsByPid.values()) {
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
    const result = await this.refreshOauthBinding(
      { serviceId: input.serviceId, profileId: input.profileId },
      this.params.now(),
      { reason: 'spawn_preflight' },
    );
    await this.notifyCredentialHealthForRefreshResult(result);
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
  }>): Promise<ConnectedServiceCredentialRefreshResult> {
    const result = await this.refreshOauthBinding(
      { serviceId: input.serviceId, profileId: input.profileId },
      this.params.now(),
      { force: true, reason: 'runtime_auth_failure' },
    );
    await this.notifyCredentialHealthForRefreshResult(result);
    return result;
  }

  async refreshOpenAiCodexChatGptTokensForBridge(input: Readonly<{
    selection: CodexChatGptAuthTokensRefreshSelection;
    chatgptPlanType: string | null;
  }>): Promise<CodexChatGptAuthTokensRefreshResponse> {
    const profileId = input.selection.kind === 'profile'
      ? input.selection.profileId
      : input.selection.activeProfileId;
    const result = await this.refreshOauthBinding(
      { serviceId: 'openai-codex', profileId },
      this.params.now(),
      { force: true, reason: 'provider_auth_bridge' },
    );
    if (result.status !== 'refreshed' || result.credential?.kind !== 'oauth') {
      throw new Error('connected_service_chatgpt_refresh_unavailable');
    }

    const affectedTargets = await this.rematerializeTargetsForBinding({
      serviceId: 'openai-codex',
      profileId,
    });
    if (affectedTargets.length > 0) {
      await this.params.onAuthUpdated?.({
        binding: { serviceId: 'openai-codex', profileId },
        affectedTargets,
        trigger: 'refresh_triggered_restart',
      });
    }

    return {
      accessToken: result.credential.oauth.accessToken,
      chatgptAccountId: result.credential.oauth.providerAccountId,
      chatgptPlanType: input.chatgptPlanType,
    };
  }

  private async maybeRefreshBinding(binding: BoundProfile, now: number): Promise<void> {
    const result = await this.refreshOauthBinding(binding, now, { reason: 'scheduled' });
    if (result.status === 'refresh_failed') {
      await this.notifyCredentialHealthForRefreshResult(result);
      throw new Error(`Connected services refresh failed (${binding.serviceId}/${binding.profileId}): ${result.diagnostic.category ?? 'unknown'}`);
    }
    if (result.status !== 'refreshed') return;

    const affectedTargets = await this.rematerializeTargetsForBinding(binding);
    if (affectedTargets.length === 0) return;
    await this.params.onAuthUpdated?.({
      binding,
      affectedTargets,
      trigger: 'refresh_triggered_restart',
    });
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
    result: ConnectedServiceCredentialRefreshResult,
  ): Promise<ConnectedServiceCredentialRefreshResult> {
    await this.persistCredentialHealthForRefreshResult(result);
    return result;
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

  private async rematerializeTargetsForBinding(binding: BoundProfile): Promise<ReadonlyArray<SpawnTarget>> {
    const affected = Array.from(this.targetsByPid.values()).filter((target) =>
      this.resolveBoundProfiles(target).some((candidate) =>
        candidate.serviceId === binding.serviceId && candidate.profileId === binding.profileId,
      ),
    );
    const rematerialized: SpawnTarget[] = [];
    for (const target of affected) {
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
    return rematerialized;
  }

  private async persistCredentialHealthForMaterializationFailure(
    binding: BoundProfile,
    diagnostic: ConnectedServicesMaterializationDiagnostic,
  ): Promise<void> {
    const updateHealth = this.params.api.updateConnectedServiceCredentialHealth;
    if (typeof updateHealth !== 'function') return;

    const now = this.params.now();
    const providerErrorCode = typeof diagnostic.code === 'string'
      && diagnostic.code.trim().length > 0
      && diagnostic.code.trim().length <= 128
      ? diagnostic.code.trim()
      : undefined;
    const health = {
      v: 1,
      status: 'needs_reauth',
      reconnectRequired: true,
      lastRefreshAttemptAt: now,
      lastRefreshFailureAt: now,
      lastRefreshFailureKind: 'provider_403',
      providerHttpStatus: 403,
      ...(providerErrorCode ? { providerErrorCode } : {}),
    } satisfies ConnectedServiceCredentialHealthV1;

    try {
      await updateHealth.call(this.params.api, {
        serviceId: binding.serviceId,
        profileId: binding.profileId,
        health,
      });
    } catch (error) {
      logger.warn('[DAEMON RUN] Failed to update connected-service credential health after materialization failure', {
        serviceId: binding.serviceId,
        profileId: binding.profileId,
        materializationCode: diagnostic.code,
        reason: diagnostic.reason ?? null,
        error: serializeAxiosErrorForLog(error),
      });
    }
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
    return Array.from(this.targetsByPid.values())
      .filter((target) => this.resolveBoundProfiles(target).some((candidate) =>
        candidate.serviceId === binding.serviceId && candidate.profileId === binding.profileId,
      ))
      .map((target) => ({
        pid: target.pid,
        agentId: target.agentId,
        sessionId: target.sessionId ?? target.materializationKey,
      }));
  }

  private resolveBoundProfiles(target: SpawnTarget): ReadonlyArray<BoundProfile> {
    return target.bindings.flatMap((binding) => {
      if (binding.kind === 'profile') {
        return [{ serviceId: binding.serviceId, profileId: binding.profileId }];
      }
      const selection = target.childSelectionsByServiceId?.get(binding.serviceId);
      if (selection?.kind === 'group' && selection.groupId === binding.groupId) {
        return [{ serviceId: binding.serviceId, profileId: selection.activeProfileId }];
      }
      return binding.fallbackProfileId
        ? [{ serviceId: binding.serviceId, profileId: binding.fallbackProfileId }]
        : [];
    });
  }

  private buildResolvedSelectionsByServiceId(
    childSelectionsByServiceId: ChildSelectionsByServiceId,
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
