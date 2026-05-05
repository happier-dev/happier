import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
  type ActionExecuteResult,
  type ActionId,
  DirectSessionAttachRequestSchema,
  DirectSessionDetachRequestSchema,
  DirectSessionFollowPolicySetRequestSchema,
  DirectSessionLinkEnsureRequestSchema,
  DirectSessionStatusGetRequestSchema,
  DirectSessionTakeoverPersistRequestSchema,
  DirectSessionTakeoverRequestSchema,
  DirectSessionsCandidatesListRequestSchema,
  type DirectSessionsProviderId,
  DirectTranscriptPageRequestSchema,
  DirectTranscriptReadAfterRequestSchema,
  normalizeCodexBackendMode,
  type DirectSessionAttachResponse,
  type DirectSessionDetachResponse,
  type DirectSessionFollowPolicySetResponse,
  type DirectSessionLinkEnsureResponse,
  type DirectSessionStatusGetResponse,
  type DirectSessionTakeoverPersistResponse,
  type DirectSessionTakeoverResponse,
  type DirectSessionsCandidatesListResponse,
  type DirectTranscriptPageResponse,
  type DirectTranscriptReadAfterResponse,
  type DirectSessionTranscriptDeltaEphemeral,
} from '@happier-dev/protocol';
import {
  ExternalSessionTakeoverInputV1Schema,
  ExternalSessionTakeoverResultV1Schema,
  mapDirectSessionsTakeoverPersistToExternalSessionTakeoverInputV1,
  mapDirectSessionsTakeoverToExternalSessionTakeoverInputV1,
  type ExternalSessionTakeoverErrorCodeV1,
  type ExternalSessionTakeoverResultV1,
} from '@happier-dev/protocol/sessions';

import { readCredentials } from '@/persistence';
import { listSessionMarkers } from '@/daemon/sessionRegistry';
import type { DirectSessionProviderOps } from '@/session/directSessions/providerOps';
import { logger } from '@/ui/logger';

import { importDirectSessionTranscript } from '@/api/directSessions/import/importDirectSessionTranscript';
import { createManagedDirectSessionFollowLease } from '@/api/directSessions/backgroundFollow/createManagedDirectSessionFollowLease';
import { updateSessionMetadataWithDirectSessionFollowPolicy } from '@/api/directSessions/backgroundFollow/directSessionBackgroundFollowMetadata';
import { createDirectSessionFollowLeaseManager } from '@/api/directSessions/leases/createDirectSessionFollowLeaseManager';
import { ensureDirectSessionLink } from '@/api/directSessions/linking/ensureDirectSessionLink';
import { validateDirectMachineSource } from '@/api/directSessions/security/validateDirectMachineSource';
import { findTrustedDirectSessionOwner } from '@/api/directSessions/takeover/findTrustedDirectSessionOwner';
import { loadLinkedDirectSession } from '@/api/directSessions/takeover/loadLinkedDirectSession';
import { resolveDirectTakeoverSpawnOptions } from '@/api/directSessions/takeover/resolveDirectTakeoverSpawnOptions';
import { updateSessionMetadataWithRetry } from '@/session/metadata/updateSessionMetadataWithRetry';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import { resolveBackendExecutionSurfaces } from '@/agent/runtime/registry/engineRegistry';
import { dispatchActionFromRpc, type RpcActionExecutor } from '@/rpc/handlers/_actionDispatchAdapter';

import type { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import type { SpawnSessionOptions, SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';

type DirectSessionsErrorCode = 'invalid_request' | 'machine_offline' | 'provider_unavailable' | 'internal_error';
type ExternalSessionTakeoverActionInput = Readonly<{
  linkedSessionId: string;
  targetRuntimeMode: 'terminal' | 'remote';
  storageMode: 'external-linked' | 'persisted';
  forceStop?: boolean;
  machineId?: string;
}>;
type DirectSessionsRpcHandler<TResponse> = (raw: unknown) => Promise<TResponse>;
type DirectSessionsActionResultMapper<TResponse> = (result: unknown) => TResponse;

function err(
  errorCode: DirectSessionsErrorCode,
  error?: string,
): { ok: false; errorCode: DirectSessionsErrorCode; error: string } {
  return { ok: false, errorCode, error: typeof error === 'string' && error.trim() ? error : errorCode };
}

function mapActionFailureToDirectSessionsError(
  result: Extract<ActionExecuteResult, { ok: false }>,
): { ok: false; errorCode: DirectSessionsErrorCode; error: string } {
  const errorCode = result.errorCode === 'machine_offline'
    ? 'machine_offline'
    : result.errorCode === 'provider_unavailable'
      ? 'provider_unavailable'
      : result.errorCode === 'invalid_request' || result.errorCode === 'invalid_parameters'
        ? 'invalid_request'
        : 'internal_error';
  return err(errorCode, result.error);
}

function mapExternalTakeoverErrorCodeToDirectSessionsErrorCode(
  errorCode: ExternalSessionTakeoverErrorCodeV1,
  error?: string,
): DirectSessionsErrorCode {
  if (errorCode === 'machine_offline') return 'machine_offline';
  if (errorCode === 'transcript_import_failed' || errorCode === 'spawn_failed') return 'internal_error';
  if (errorCode === 'capability_unsupported') {
    return 'provider_unavailable';
  }
  if (
    errorCode === 'takeover_not_available'
    && (error === 'takeover_not_supported' || error === 'not_authenticated')
  ) {
    return 'provider_unavailable';
  }
  if (errorCode === 'invalid_external_source' && error === 'session_metadata_unavailable') {
    return 'provider_unavailable';
  }
  return 'invalid_request';
}

function mapExternalTakeoverFailureToDirectSessionsError(
  result: Extract<ExternalSessionTakeoverResultV1, { ok: false }>,
): { ok: false; errorCode: DirectSessionsErrorCode; error: string } {
  return err(mapExternalTakeoverErrorCodeToDirectSessionsErrorCode(result.errorCode, result.error), result.error);
}

function mapLinkedDirectSessionErrorToExternalTakeoverError(
  errorCode: 'invalid_request' | 'provider_unavailable',
  error: string,
): ExternalSessionTakeoverResultV1 {
  const externalErrorCode: ExternalSessionTakeoverErrorCodeV1 =
    errorCode === 'invalid_request' && error === 'session_not_found'
      ? 'session_not_found'
      : 'invalid_external_source';
  return { ok: false, errorCode: externalErrorCode, error };
}

function mapExternalTakeoverResultToDirectTakeoverResponse(
  value: unknown,
): DirectSessionTakeoverResponse {
  const parsed = ExternalSessionTakeoverResultV1Schema.safeParse(value);
  if (!parsed.success) return err('internal_error', 'takeover_action_result_invalid') satisfies DirectSessionTakeoverResponse;
  if (!parsed.data.ok) return mapExternalTakeoverFailureToDirectSessionsError(parsed.data) satisfies DirectSessionTakeoverResponse;
  return { ok: true } satisfies DirectSessionTakeoverResponse;
}

function mapExternalTakeoverResultToDirectTakeoverPersistResponse(
  value: unknown,
): DirectSessionTakeoverPersistResponse {
  const parsed = ExternalSessionTakeoverResultV1Schema.safeParse(value);
  if (!parsed.success) return err('internal_error', 'takeover_action_result_invalid') satisfies DirectSessionTakeoverPersistResponse;
  if (!parsed.data.ok) return mapExternalTakeoverFailureToDirectSessionsError(parsed.data) satisfies DirectSessionTakeoverPersistResponse;
  return { ok: true, converted: parsed.data.converted } satisfies DirectSessionTakeoverPersistResponse;
}

function stripErrorMessageFromStack(stack: string | undefined): string | undefined {
  if (typeof stack !== 'string' || stack.trim().length === 0) return undefined;
  const lines = stack.split('\n');
  if (lines.length === 0) return stack;
  const first = lines[0] ?? '';
  const colon = first.indexOf(':');
  lines[0] = colon >= 0 ? first.slice(0, colon) : first;
  return lines.join('\n');
}

function logDirectSessionsInternalError(context: string, error: unknown): void {
  if (process.env.DEBUG) {
    if (error instanceof Error) {
      logger.debug('[directSessions][internal_error]', {
        context,
        name: error.name,
        stack: stripErrorMessageFromStack(error.stack),
      });
      return;
    }
    logger.debug('[directSessions][internal_error]', { context, errorType: typeof error, error });
    return;
  }

  if (error instanceof Error) {
    logger.debug('[directSessions][internal_error]', { context, name: error.name });
    return;
  }
  logger.debug('[directSessions][internal_error]', { context, errorType: typeof error });
}

function internalErrorResponse(
  context: string,
  error: unknown,
  safeError: string,
): { ok: false; errorCode: DirectSessionsErrorCode; error: string } {
  logDirectSessionsInternalError(context, error);
  return err('internal_error', safeError);
}

function resolveDefaultMaxBytes(): number {
  const raw = Number.parseInt(String(process.env.HAPPIER_DIRECT_SESSIONS_PAGE_MAX_BYTES ?? ''), 10);
  const configured = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 512_000;
  return Math.max(1024, Math.min(10 * 1024 * 1024, configured));
}

function resolveDefaultMaxItems(): number {
  const raw = Number.parseInt(String(process.env.HAPPIER_DIRECT_SESSIONS_PAGE_MAX_ITEMS ?? ''), 10);
  const configured = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 200;
  return Math.max(1, Math.min(5000, configured));
}

function resolveDefaultCandidatesLimit(): number {
  const raw = Number.parseInt(String(process.env.HAPPIER_DIRECT_SESSIONS_CANDIDATES_DEFAULT_LIMIT ?? ''), 10);
  const configured = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 50;
  return Math.max(1, Math.min(500, configured));
}

function resolveRecentActivityWindowMs(): number {
  const raw = Number.parseInt(String(process.env.HAPPIER_DIRECT_SESSIONS_RECENT_ACTIVITY_WINDOW_MS ?? ''), 10);
  const configured = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 15_000;
  return Math.max(1000, Math.min(60 * 60 * 1000, configured));
}

function resolveTakeoverReadinessCacheMs(): number {
  const raw = Number.parseInt(String(process.env.HAPPIER_DIRECT_SESSIONS_STATUS_TAKEOVER_CACHE_MS ?? ''), 10);
  const configured = Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : 5_000;
  return Math.max(0, Math.min(10 * 60 * 1000, configured));
}

function resolveDirectSessionAttachLeaseTtlMs(requestedTtlMs: number | undefined): number {
  const envRaw = Number.parseInt(String(process.env.HAPPIER_DIRECT_SESSIONS_ATTACH_LEASE_TTL_MS ?? ''), 10);
  const defaultTtlMs = Number.isFinite(envRaw) && envRaw > 0 ? Math.trunc(envRaw) : 45_000;
  const candidate = typeof requestedTtlMs === 'number' && Number.isFinite(requestedTtlMs) && requestedTtlMs > 0
    ? Math.trunc(requestedTtlMs)
    : defaultTtlMs;
  return Math.max(1_000, Math.min(15 * 60_000, candidate));
}

async function getDirectSessionProviderOps(providerId: DirectSessionsProviderId): Promise<DirectSessionProviderOps> {
  const providerOps = (await resolveBackendExecutionSurfaces(providerId)).directSessions;
  if (!providerOps) {
    throw new Error(`Missing direct-session provider ops for ${providerId}`);
  }
  return providerOps;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function registerMachineDirectSessionsRpcHandlers(params: Readonly<{
  rpcHandlerManager: RpcHandlerManager;
  spawnSession?: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  stopSession?: (sessionId: string) => Promise<boolean>;
  emitDirectSessionTranscriptUpdate?: (payload: DirectSessionTranscriptDeltaEphemeral) => void;
  actionExecutor?: RpcActionExecutor;
}>): void {
  const { rpcHandlerManager, emitDirectSessionTranscriptUpdate } = params;
  const takeoverReadinessCacheMs = resolveTakeoverReadinessCacheMs();
  const takeoverReadinessBySessionId = new Map<string, Readonly<{ value: boolean; expiresAtMs: number }>>();
  const followLeaseManager = createDirectSessionFollowLeaseManager();

  const readCachedTakeoverReadiness = (sessionId: string): boolean | null => {
    if (takeoverReadinessCacheMs <= 0) return null;
    const cached = takeoverReadinessBySessionId.get(sessionId) ?? null;
    if (!cached) return null;
    if (cached.expiresAtMs <= Date.now()) {
      takeoverReadinessBySessionId.delete(sessionId);
      return null;
    }
    return cached.value;
  };

  const writeCachedTakeoverReadiness = (sessionId: string, value: boolean): void => {
    if (takeoverReadinessCacheMs <= 0) return;
    takeoverReadinessBySessionId.set(sessionId, {
      value,
      expiresAtMs: Date.now() + takeoverReadinessCacheMs,
    });
  };

  const invalidateTakeoverReadiness = (sessionId: string): void => {
    takeoverReadinessBySessionId.delete(sessionId);
  };

  const registerExternalSessionActionBackedRpcHandler = <TResponse>(
    rpcMethod: string,
    actionId: ActionId,
    directHandler: DirectSessionsRpcHandler<TResponse>,
    mapResult?: DirectSessionsActionResultMapper<TResponse>,
  ): void => {
    rpcHandlerManager.registerHandler(rpcMethod, async (raw: unknown) => {
      const localExecutor: RpcActionExecutor = {
        execute: async (requestedActionId) => {
          if (requestedActionId !== actionId) {
            return {
              ok: false,
              errorCode: 'unsupported_action',
              error: `unsupported_action:${requestedActionId}`,
            };
          }
          return { ok: true, result: await directHandler(raw) };
        },
      };
      const dispatched = await dispatchActionFromRpc({
        actionId,
        input: raw,
        executor: params.actionExecutor ?? localExecutor,
      });
      if (!dispatched.ok) {
        return mapActionFailureToDirectSessionsError(dispatched) as TResponse;
      }
      return mapResult ? mapResult(dispatched.result) : dispatched.result as TResponse;
    });
  };

  registerExternalSessionActionBackedRpcHandler(RPC_METHODS.DAEMON_DIRECT_SESSION_ATTACH, 'sessions.external.attach', async (raw: unknown) => {
    const parsed = DirectSessionAttachRequestSchema.safeParse(raw);
    if (!parsed.success) return err('invalid_request') satisfies DirectSessionAttachResponse;
    const validatedSource = await validateDirectMachineSource({
      providerId: parsed.data.providerId,
      source: parsed.data.source,
      env: process.env,
    });
    if (!validatedSource.ok) {
      return err('invalid_request', validatedSource.error) satisfies DirectSessionAttachResponse;
    }
    try {
      const providerOps = await getDirectSessionProviderOps(parsed.data.providerId);
      const attached = await followLeaseManager.attach({
        sessionId: parsed.data.sessionId,
        leaseId: parsed.data.leaseId,
        ttlMs: resolveDirectSessionAttachLeaseTtlMs(parsed.data.ttlMs),
        acquireFollowLease: providerOps.acquireFollowLease
          ? async () => {
            return createManagedDirectSessionFollowLease({
              sessionId: parsed.data.sessionId,
              reason: 'attached_view',
              acquireProviderFollowLease: () => providerOps.acquireFollowLease!({
                source: validatedSource.source,
                remoteSessionId: parsed.data.remoteSessionId,
                reason: 'attached_view',
              }),
              emitDirectSessionTranscriptUpdate,
              shouldProcessBackgroundFollowEffects: () => false,
            });
          }
          : undefined,
      });
      return {
        ok: true,
        leaseId: attached.leaseId,
        expiresAtMs: attached.expiresAtMs,
        renewed: attached.renewed,
      } satisfies DirectSessionAttachResponse;
    } catch (error) {
      return internalErrorResponse('direct_session_attach', error, 'direct_session_attach_failed') satisfies DirectSessionAttachResponse;
    }
  });

  registerExternalSessionActionBackedRpcHandler(RPC_METHODS.DAEMON_DIRECT_SESSION_DETACH, 'sessions.external.detach', async (raw: unknown) => {
    const parsed = DirectSessionDetachRequestSchema.safeParse(raw);
    if (!parsed.success) return err('invalid_request') satisfies DirectSessionDetachResponse;
    const detached = await followLeaseManager.detach({
      sessionId: parsed.data.sessionId,
      leaseId: parsed.data.leaseId,
    });
    return {
      ok: true,
      detached: detached.detached,
    } satisfies DirectSessionDetachResponse;
  });

  registerExternalSessionActionBackedRpcHandler(RPC_METHODS.DAEMON_DIRECT_SESSION_FOLLOW_POLICY_SET, 'sessions.external.followPolicy.set', async (raw: unknown) => {
    const parsed = DirectSessionFollowPolicySetRequestSchema.safeParse(raw);
    if (!parsed.success) return err('invalid_request') satisfies DirectSessionFollowPolicySetResponse;
    const validatedSource = await validateDirectMachineSource({
      providerId: parsed.data.providerId,
      source: parsed.data.source,
      env: process.env,
    });
    if (!validatedSource.ok) {
      return err('invalid_request', validatedSource.error) satisfies DirectSessionFollowPolicySetResponse;
    }

    let providerOps: Awaited<ReturnType<typeof getDirectSessionProviderOps>>;
    try {
      providerOps = await getDirectSessionProviderOps(parsed.data.providerId);
    } catch (error) {
      return internalErrorResponse(
        'direct_session_follow_policy_set.provider_ops',
        error,
        'follow_policy_set_failed',
      ) satisfies DirectSessionFollowPolicySetResponse;
    }

    if (parsed.data.enabled && !providerOps.acquireFollowLease) {
      return err('provider_unavailable', 'background_follow_not_supported') satisfies DirectSessionFollowPolicySetResponse;
    }

    const credentials = await readCredentials().catch(() => null);
    if (!credentials) {
      return err('provider_unavailable', 'not_authenticated') satisfies DirectSessionFollowPolicySetResponse;
    }

    try {
      const rawSession = await fetchSessionById({
        token: credentials.token,
        sessionId: parsed.data.sessionId,
      }).catch(() => null);
      const updatedAtMs = Date.now();
      const persistFollowPolicy = async (): Promise<DirectSessionFollowPolicySetResponse | null> => {
        if (!rawSession) {
          return null;
        }
        try {
          await updateSessionMetadataWithDirectSessionFollowPolicy({
            token: credentials.token,
            credentials,
            sessionId: parsed.data.sessionId,
            rawSession,
            policy: parsed.data.enabled ? 'background_follow' : 'attached_only',
            updatedAtMs,
          });
          return null;
        } catch (error) {
          return internalErrorResponse(
            'direct_session_follow_policy_set.persist',
            error,
            'follow_policy_persist_failed',
          ) satisfies DirectSessionFollowPolicySetResponse;
        }
      };

      if (!parsed.data.enabled) {
        const persistError = await persistFollowPolicy();
        if (persistError) {
          return persistError;
        }
      }

      const backgroundFollow = await followLeaseManager.setBackgroundFollowEnabled({
        sessionId: parsed.data.sessionId,
        enabled: parsed.data.enabled,
        acquireFollowLease: parsed.data.enabled && providerOps.acquireFollowLease
          ? async () => createManagedDirectSessionFollowLease({
            sessionId: parsed.data.sessionId,
            reason: 'background_follow',
            acquireProviderFollowLease: () => providerOps.acquireFollowLease!({
              source: validatedSource.source,
              remoteSessionId: parsed.data.remoteSessionId,
              reason: 'background_follow',
            }),
            emitDirectSessionTranscriptUpdate,
            shouldProcessBackgroundFollowEffects: () =>
              followLeaseManager.isBackgroundFollowEnabled(parsed.data.sessionId)
              && followLeaseManager.countActiveLeases(parsed.data.sessionId) === 0,
          })
          : undefined,
      });

      if (parsed.data.enabled) {
        const persistError = await persistFollowPolicy();
        if (persistError) {
          await followLeaseManager.setBackgroundFollowEnabled({
            sessionId: parsed.data.sessionId,
            enabled: false,
          }).catch(() => {});
          return persistError;
        }
      }

      return {
        ok: true,
        enabled: parsed.data.enabled,
        leaseActive: followLeaseManager.hasBackgroundFollowLease(parsed.data.sessionId) || followLeaseManager.countActiveLeases(parsed.data.sessionId) > 0,
        updatedAtMs,
      } satisfies DirectSessionFollowPolicySetResponse;
    } catch (error) {
      return internalErrorResponse(
        'direct_session_follow_policy_set',
        error,
        'follow_policy_set_failed',
      ) satisfies DirectSessionFollowPolicySetResponse;
    }
  });

  registerExternalSessionActionBackedRpcHandler(RPC_METHODS.DAEMON_DIRECT_SESSIONS_CANDIDATES_LIST, 'sessions.external.candidates.list', async (raw: unknown) => {
    const parsed = DirectSessionsCandidatesListRequestSchema.safeParse(raw);
    if (!parsed.success) return err('invalid_request') satisfies DirectSessionsCandidatesListResponse;
    try {
      const validatedSource = await validateDirectMachineSource({
        providerId: parsed.data.providerId,
        source: parsed.data.source,
        env: process.env,
      });
      if (!validatedSource.ok) {
        return err('invalid_request', validatedSource.error) satisfies DirectSessionsCandidatesListResponse;
      }
      const { providerId, cursor, searchTerm } = parsed.data;
      const source = validatedSource.source;
      const limit = parsed.data.limit ?? resolveDefaultCandidatesLimit();
      const res = await (await getDirectSessionProviderOps(providerId)).listCandidates({ source, cursor, limit, searchTerm });
      return { ok: true, candidates: res.candidates, nextCursor: res.nextCursor } satisfies DirectSessionsCandidatesListResponse;
    } catch (error) {
      return internalErrorResponse(
        'direct_sessions_candidates_list',
        error,
        'direct_sessions_candidates_list_failed',
      ) satisfies DirectSessionsCandidatesListResponse;
    }
  });

  registerExternalSessionActionBackedRpcHandler(RPC_METHODS.DAEMON_DIRECT_SESSION_LINK_ENSURE, 'sessions.external.link.ensure', async (raw: unknown) => {
    const parsed = DirectSessionLinkEnsureRequestSchema.safeParse(raw);
    if (!parsed.success) return err('invalid_request') satisfies DirectSessionLinkEnsureResponse;
    const validatedSource = await validateDirectMachineSource({
      providerId: parsed.data.providerId,
      source: parsed.data.source,
      env: process.env,
    });
    if (!validatedSource.ok) {
      return err('invalid_request', validatedSource.error) satisfies DirectSessionLinkEnsureResponse;
    }

    const credentials = await readCredentials().catch(() => null);
    if (!credentials) {
      return err('provider_unavailable', 'not_authenticated') satisfies DirectSessionLinkEnsureResponse;
    }

    try {
      const codexBackendMode = normalizeCodexBackendMode(parsed.data.codexBackendMode) ?? undefined;
      const res = await ensureDirectSessionLink({
        credentials,
        machineId: parsed.data.machineId,
        providerId: parsed.data.providerId,
        remoteSessionId: parsed.data.remoteSessionId,
        codexBackendMode,
        runtimeDescriptor: parsed.data.runtimeDescriptorV1,
        titleHint: parsed.data.titleHint,
        directoryHint: parsed.data.directoryHint,
        source: validatedSource.source,
      });
      return { ok: true, sessionId: res.sessionId, created: res.created } satisfies DirectSessionLinkEnsureResponse;
    } catch (error) {
      return internalErrorResponse(
        'direct_session_link_ensure',
        error,
        'direct_session_link_ensure_failed',
      ) satisfies DirectSessionLinkEnsureResponse;
    }
  });

  registerExternalSessionActionBackedRpcHandler(RPC_METHODS.DAEMON_DIRECT_SESSION_STATUS_GET, 'sessions.external.status.get', async (raw: unknown) => {
    const parsed = DirectSessionStatusGetRequestSchema.safeParse(raw);
    if (!parsed.success) return err('invalid_request') satisfies DirectSessionStatusGetResponse;
    const validatedSource = await validateDirectMachineSource({
      providerId: parsed.data.providerId,
      source: parsed.data.source,
      env: process.env,
    });
    if (!validatedSource.ok) {
      return err('invalid_request', validatedSource.error) satisfies DirectSessionStatusGetResponse;
    }
    const nowMs = Date.now();
    const recentWindowMs = resolveRecentActivityWindowMs();
    let activityValue: 'running' | 'active_recently' | 'idle' | 'unknown' = 'unknown';
    let lastKnownActivityAtMs: number | undefined = undefined;
    let runnerActive = false;
    let trustedPid: number | null = null;
    let canForceStop = false;

    const markers = await listSessionMarkers().catch(() => []);
    const liveMarkers = markers.filter((m) => Number.isFinite(m.pid) && m.pid > 0 && isPidAlive(m.pid));

    runnerActive = liveMarkers.some((m) => m.happySessionId === parsed.data.sessionId);

    if (!runnerActive) {
      const owner = findTrustedDirectSessionOwner({
        markers: liveMarkers,
        providerId: parsed.data.providerId,
        remoteSessionId: parsed.data.remoteSessionId,
        isPidAlive,
      });
      if (owner) {
        trustedPid = owner.pid;
        canForceStop = true;
      }
    }

    try {
      const res = await (await getDirectSessionProviderOps(parsed.data.providerId)).getActivity({
        source: validatedSource.source,
        remoteSessionId: parsed.data.remoteSessionId,
      });
      if (typeof res.lastActivityAtMs === 'number' && Number.isFinite(res.lastActivityAtMs) && res.lastActivityAtMs >= 0) {
        lastKnownActivityAtMs = res.lastActivityAtMs;
        const ageMs = nowMs - res.lastActivityAtMs;
        activityValue = Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= recentWindowMs ? 'active_recently' : 'idle';
      }
      if (res.isRunning) {
        activityValue = 'running';
      }
    } catch {
      activityValue = 'unknown';
    }

    if (runnerActive) {
      activityValue = 'running';
    }

    const cachedTakeoverReadiness = readCachedTakeoverReadiness(parsed.data.sessionId);
    let canTakeOverPersist = cachedTakeoverReadiness ?? true;
    if (cachedTakeoverReadiness === null) {
      try {
        const credentials = await readCredentials().catch(() => null);
        if (!credentials) {
          canTakeOverPersist = false;
        } else {
          const linked = await loadLinkedDirectSession({
            credentials,
            sessionId: parsed.data.sessionId,
            machineId: parsed.data.machineId,
          });
          if (!linked.ok) {
            canTakeOverPersist = false;
          } else {
            const takeoverOptions = await resolveDirectTakeoverSpawnOptions({
              linked: linked.session,
              sessionId: parsed.data.sessionId,
            });
            canTakeOverPersist = takeoverOptions !== null;
          }
        }
      } catch {
        canTakeOverPersist = false;
      }
      writeCachedTakeoverReadiness(parsed.data.sessionId, canTakeOverPersist);
    }

    return {
      ok: true,
      machineOnline: true,
      runnerActive,
      activity: activityValue,
      canTakeOverDirect: !runnerActive,
      canTakeOverPersist,
      canForceStop,
      trustedPid,
      ...(lastKnownActivityAtMs !== undefined ? { lastKnownActivityAtMs } : {}),
    } satisfies DirectSessionStatusGetResponse;
  });

  registerExternalSessionActionBackedRpcHandler(RPC_METHODS.DAEMON_DIRECT_SESSION_TRANSCRIPT_PAGE, 'sessions.external.transcript.page', async (raw: unknown) => {
    const parsed = DirectTranscriptPageRequestSchema.safeParse(raw);
    if (!parsed.success) return err('invalid_request') satisfies DirectTranscriptPageResponse;
    const validatedSource = await validateDirectMachineSource({
      providerId: parsed.data.providerId,
      source: parsed.data.source,
      env: process.env,
    });
    if (!validatedSource.ok) {
      return err('invalid_request', validatedSource.error) satisfies DirectTranscriptPageResponse;
    }
    const { providerId, remoteSessionId, direction, cursor } = parsed.data;
    const source = validatedSource.source;
    const maxBytes = parsed.data.maxBytes ?? resolveDefaultMaxBytes();
    const maxItems = parsed.data.maxItems ?? resolveDefaultMaxItems();

    try {
      const res = await (await getDirectSessionProviderOps(providerId)).pageTranscript({
        source,
        remoteSessionId,
        direction,
        cursor,
        maxBytes,
        maxItems,
      });
      return {
        ok: true,
        items: res.items,
        nextCursor: res.nextCursor,
        tailCursor: res.tailCursor,
        hasMore: res.hasMore,
        truncated: res.truncated,
      } satisfies DirectTranscriptPageResponse;
    } catch (error) {
      return internalErrorResponse(
        'direct_session_transcript_page',
        error,
        'direct_session_transcript_page_failed',
      ) satisfies DirectTranscriptPageResponse;
    }
  });

  registerExternalSessionActionBackedRpcHandler(RPC_METHODS.DAEMON_DIRECT_SESSION_TRANSCRIPT_READ_AFTER, 'sessions.external.transcript.readAfter', async (raw: unknown) => {
    const parsed = DirectTranscriptReadAfterRequestSchema.safeParse(raw);
    if (!parsed.success) return err('invalid_request') satisfies DirectTranscriptReadAfterResponse;
    const validatedSource = await validateDirectMachineSource({
      providerId: parsed.data.providerId,
      source: parsed.data.source,
      env: process.env,
    });
    if (!validatedSource.ok) {
      return err('invalid_request', validatedSource.error) satisfies DirectTranscriptReadAfterResponse;
    }
    const { providerId, remoteSessionId, cursor } = parsed.data;
    const source = validatedSource.source;

    const maxBytes = parsed.data.maxBytes ?? resolveDefaultMaxBytes();
    const maxItems = parsed.data.maxItems ?? resolveDefaultMaxItems();

    try {
      const res = await (await getDirectSessionProviderOps(providerId)).readAfterTranscript({
        source,
        remoteSessionId,
        cursor,
        maxBytes,
        maxItems,
      });
      return { ok: true, items: res.items, nextCursor: res.nextCursor, truncated: res.truncated } satisfies DirectTranscriptReadAfterResponse;
    } catch (error) {
      return internalErrorResponse(
        'direct_session_transcript_read_after',
        error,
        'direct_session_transcript_read_after_failed',
      ) satisfies DirectTranscriptReadAfterResponse;
    }
  });

  const executeExternalSessionTakeoverAction = async (raw: unknown): Promise<ExternalSessionTakeoverResultV1> => {
    const parsed = ExternalSessionTakeoverInputV1Schema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, errorCode: 'takeover_not_available', error: 'invalid_request' };
    }
    const actionInput = parsed.data as ExternalSessionTakeoverActionInput;
    const machineId = typeof actionInput.machineId === 'string' && actionInput.machineId.trim().length > 0
      ? actionInput.machineId.trim()
      : null;
    if (!machineId) {
      return { ok: false, errorCode: 'machine_offline', error: 'machine_id_required' };
    }
    if (actionInput.targetRuntimeMode !== 'terminal') {
      return { ok: false, errorCode: 'capability_unsupported', error: 'target_runtime_mode_unsupported' };
    }
    if (!params.spawnSession || !params.stopSession) {
      return { ok: false, errorCode: 'capability_unsupported', error: 'takeover_not_supported' };
    }
    invalidateTakeoverReadiness(actionInput.linkedSessionId);

    const credentials = await readCredentials().catch(() => null);
    if (!credentials) {
      return { ok: false, errorCode: 'takeover_not_available', error: 'not_authenticated' };
    }

    const linked = await loadLinkedDirectSession({
      credentials,
      sessionId: actionInput.linkedSessionId,
      machineId,
    });
    if (!linked.ok) {
      return mapLinkedDirectSessionErrorToExternalTakeoverError(linked.errorCode, linked.error);
    }
    const validatedSource = await validateDirectMachineSource({
      providerId: linked.session.providerId,
      source: linked.session.source,
      env: process.env,
    });
    if (!validatedSource.ok) {
      return { ok: false, errorCode: 'invalid_external_source', error: validatedSource.error };
    }
    const validatedLinkedSession = {
      ...linked.session,
      source: validatedSource.source,
    };

    const markers = await listSessionMarkers().catch(() => []);
    const trustedOwner = findTrustedDirectSessionOwner({
      markers,
      providerId: validatedLinkedSession.providerId,
      remoteSessionId: validatedLinkedSession.remoteSessionId,
      isPidAlive,
    });

    if (trustedOwner && trustedOwner.happySessionId === actionInput.linkedSessionId && actionInput.storageMode === 'external-linked') {
      return {
        ok: true,
        sessionId: actionInput.linkedSessionId,
        targetRuntimeMode: actionInput.targetRuntimeMode,
        storageMode: actionInput.storageMode,
        converted: false,
      };
    }

    if (trustedOwner && trustedOwner.happySessionId !== actionInput.linkedSessionId && actionInput.forceStop !== true) {
      return {
        ok: false,
        errorCode: 'force_stop_required',
        error: 'force_stop_required',
        trustedPid: trustedOwner.pid,
      };
    }

    if (trustedOwner && trustedOwner.happySessionId !== actionInput.linkedSessionId && actionInput.forceStop === true) {
      const stopped = await params.stopSession(trustedOwner.happySessionId);
      if (!stopped) {
        return { ok: false, errorCode: 'spawn_failed', error: 'trusted_process_stop_failed' };
      }
    }

    const spawnOptions = await resolveDirectTakeoverSpawnOptions({
      linked: validatedLinkedSession,
      sessionId: actionInput.linkedSessionId,
    });
    if (!spawnOptions) {
      return { ok: false, errorCode: 'takeover_not_available', error: 'direct_session_directory_unavailable' };
    }

    if (actionInput.storageMode === 'persisted') {
      try {
        await importDirectSessionTranscript({
          linked: validatedLinkedSession,
          credentials,
          sessionId: actionInput.linkedSessionId,
        });
      } catch (error) {
        logDirectSessionsInternalError('external_session_takeover.import_transcript', error);
        return { ok: false, errorCode: 'transcript_import_failed', error: 'direct_session_import_failed' };
      }
    }

    const spawnResult = await params.spawnSession({
      ...spawnOptions,
      ...(actionInput.storageMode === 'persisted' ? { transcriptStorage: 'persisted' as const } : {}),
    });
    if (spawnResult.type !== 'success') {
      return {
        ok: false,
        errorCode: 'spawn_failed',
        error: spawnResult.type === 'error' ? spawnResult.errorMessage : 'directory_approval_required',
      };
    }

    if (actionInput.storageMode === 'persisted') {
      try {
        await updateSessionMetadataWithRetry({
          token: credentials.token,
          credentials,
          sessionId: actionInput.linkedSessionId,
          rawSession: linked.session.rawSession,
          updater: (current) => {
            const next: Record<string, unknown> = { ...current };
            delete next.directSessionV1;
            if (typeof next.path !== 'string' || !next.path.trim()) {
              next.path = spawnOptions.directory;
            }
            next.externalHistoryImportV1 = {
              v: 1,
              providerId: validatedLinkedSession.providerId,
              remoteSessionId: validatedLinkedSession.remoteSessionId,
              importedAtMs: Date.now(),
              source: validatedLinkedSession.source,
            };
            return next;
          },
        });
      } catch (error) {
        logDirectSessionsInternalError('external_session_takeover.persist_metadata', error);
        return { ok: false, errorCode: 'transcript_import_failed', error: 'direct_session_persist_failed' };
      }
    }

    return {
      ok: true,
      sessionId: actionInput.linkedSessionId,
      targetRuntimeMode: actionInput.targetRuntimeMode,
      storageMode: actionInput.storageMode,
      converted: actionInput.storageMode === 'persisted',
    };
  };

  const dispatchExternalSessionTakeoverAction = async (
    actionInput: ExternalSessionTakeoverActionInput,
  ): Promise<ActionExecuteResult> => {
    const localExecutor: RpcActionExecutor = {
      execute: async (requestedActionId, input) => {
        if (requestedActionId !== 'sessions.external.takeover') {
          return {
            ok: false,
            errorCode: 'unsupported_action',
            error: `unsupported_action:${requestedActionId}`,
          };
        }
        return { ok: true, result: await executeExternalSessionTakeoverAction(input) };
      },
    };
    return await dispatchActionFromRpc({
      actionId: 'sessions.external.takeover',
      input: actionInput,
      executor: params.actionExecutor ?? localExecutor,
    });
  };

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER, async (raw: unknown) => {
    const parsed = DirectSessionTakeoverRequestSchema.safeParse(raw);
    if (!parsed.success) return err('invalid_request') satisfies DirectSessionTakeoverResponse;
    const actionInput = {
      ...mapDirectSessionsTakeoverToExternalSessionTakeoverInputV1({
        linkedSessionId: parsed.data.sessionId,
        ...(parsed.data.forceStop === undefined ? {} : { forceStop: parsed.data.forceStop }),
      }),
      machineId: parsed.data.machineId,
    };
    const dispatched = await dispatchExternalSessionTakeoverAction(actionInput);
    if (!dispatched.ok) {
      return mapActionFailureToDirectSessionsError(dispatched) satisfies DirectSessionTakeoverResponse;
    }
    return mapExternalTakeoverResultToDirectTakeoverResponse(dispatched.result);
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_PERSIST, async (raw: unknown) => {
    const parsed = DirectSessionTakeoverPersistRequestSchema.safeParse(raw);
    if (!parsed.success) return err('invalid_request') satisfies DirectSessionTakeoverPersistResponse;
    const actionInput = {
      ...mapDirectSessionsTakeoverPersistToExternalSessionTakeoverInputV1({
        linkedSessionId: parsed.data.sessionId,
        ...(parsed.data.forceStop === undefined ? {} : { forceStop: parsed.data.forceStop }),
      }),
      machineId: parsed.data.machineId,
    };
    const dispatched = await dispatchExternalSessionTakeoverAction(actionInput);
    if (!dispatched.ok) {
      return mapActionFailureToDirectSessionsError(dispatched) satisfies DirectSessionTakeoverPersistResponse;
    }
    return mapExternalTakeoverResultToDirectTakeoverPersistResponse(dispatched.result);
  });
}
