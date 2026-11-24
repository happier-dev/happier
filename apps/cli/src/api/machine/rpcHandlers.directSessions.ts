import type { DirectSessionTakeoverRequest, DirectSessionTakeoverPersistRequest } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
  DIRECT_SESSION_TAKEOVER_ACTION_IDS,
  DirectSessionAttachRequestSchema,
  DirectSessionCandidateDeleteRequestSchema,
  DirectSessionDetachRequestSchema,
  DirectSessionFollowPolicySetRequestSchema,
  DirectSessionLinkEnsureRequestSchema,
  DirectSessionStatusGetRequestSchema,
  DirectSessionTakeoverPersistRequestSchema,
  DirectSessionTakeoverRequestSchema,
  DirectSessionsAcpSessionListCapabilityRequestSchema,
  DirectSessionsCandidatesListRequestSchema,
  DirectTranscriptPageRequestSchema,
  DirectTranscriptReadAfterRequestSchema,
  normalizeCodexBackendMode,
  type DirectSessionAttachResponse,
  type DirectSessionCandidateDeleteResponse,
  type DirectSessionDetachResponse,
  type DirectSessionFollowPolicySetResponse,
  type DirectSessionTranscriptDeltaEphemeral,
  type DirectSessionLinkEnsureResponse,
  type DirectSessionStatusGetResponse,
  type DirectSessionTakeoverPersistResponse,
  type DirectSessionTakeoverResponse,
  type DirectSessionsAcpSessionListCapabilityResponse,
  type DirectSessionsCandidatesListResponse,
  type DirectTranscriptPageResponse,
  type DirectTranscriptReadAfterResponse,
} from '@happier-dev/protocol';

import { readCredentials } from '@/persistence';
import { listSessionMarkers } from '@/daemon/sessionRegistry';
import { getDirectSessionProviderOps } from '@/backends/catalog';
import { DirectSessionsProviderUnavailableError } from '@/backends/directSessions/providerOps';

import type { ActionOperationRunner } from '@/daemon/actionOperations/actionOperationRunner';
import type { ActionOperationAccessScope } from '@/daemon/actionOperations/actionOperationTypes';

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
import { logger } from '@/utils/logger';

import type { RpcHandlerRegistrar } from '../rpc/types';
import type { SpawnSessionOptions, SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';

type DirectSessionImportControl = Readonly<{
  signal: AbortSignal;
  update: (progress: Readonly<{ phase: 'preparing' | 'reading' | 'importing' | 'starting' | 'converting'; importedCount?: number; totalCount?: number }>) => void;
}>;

type DirectSessionsErrorCode = 'invalid_request' | 'machine_offline' | 'provider_unavailable' | 'internal_error';

function err(
  errorCode: DirectSessionsErrorCode,
  error?: string,
): { ok: false; errorCode: DirectSessionsErrorCode; error: string } {
  return { ok: false, errorCode, error: typeof error === 'string' && error.trim() ? error : errorCode };
}

/**
 * A provider that genuinely cannot perform the operation for this source is reported as
 * `provider_unavailable`, never as an internal error and never as an empty success.
 */
function errFromProviderFailure(error: unknown, fallback: DirectSessionsErrorCode = 'internal_error'): {
  ok: false;
  errorCode: DirectSessionsErrorCode;
  error: string;
} {
  if (error instanceof DirectSessionsProviderUnavailableError) {
    return err('provider_unavailable', error.message);
  }
  return err(fallback, error instanceof Error ? error.message : 'Unknown error');
}

function requireProviderOp<TOp>(
  op: TOp | undefined,
  providerId: string,
  operation: string,
): TOp {
  if (!op) {
    throw new DirectSessionsProviderUnavailableError(
      `Agent '${providerId}' does not support direct-session ${operation} for this source.`,
    );
  }
  return op;
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

function resolveDirectSessionAttachLeaseTtlMs(requestedTtlMs: number | undefined): number {
  const raw = Number.parseInt(String(process.env.HAPPIER_DIRECT_SESSIONS_ATTACH_LEASE_TTL_MS ?? ''), 10);
  const defaultTtlMs = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 45_000;
  const configured = typeof requestedTtlMs === 'number' && Number.isFinite(requestedTtlMs) && requestedTtlMs > 0
    ? Math.trunc(requestedTtlMs)
    : defaultTtlMs;
  return Math.max(1_000, Math.min(15 * 60_000, configured));
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
  rpcHandlerManager: RpcHandlerRegistrar;
  spawnSession?: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  stopSession?: (sessionId: string) => Promise<boolean>;
  actionOperations?: Readonly<{ runner: ActionOperationRunner; getScope: () => Promise<ActionOperationAccessScope> }>;
  emitDirectSessionTranscriptUpdate?: (payload: DirectSessionTranscriptDeltaEphemeral) => void;
}>): void {
  const { rpcHandlerManager, emitDirectSessionTranscriptUpdate } = params;
  const followLeaseManager = createDirectSessionFollowLeaseManager();

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_DIRECT_SESSION_ATTACH, async (raw: unknown) => {
    const parsed = DirectSessionAttachRequestSchema.safeParse(raw);
    if (!parsed.success) return err('invalid_request') satisfies DirectSessionAttachResponse;
    const validatedSource = validateDirectMachineSource({
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
          ? async () => createManagedDirectSessionFollowLease({
            sessionId: parsed.data.sessionId,
            reason: 'attached_view',
            acquireProviderFollowLease: () => providerOps.acquireFollowLease!({
              source: validatedSource.source,
              remoteSessionId: parsed.data.remoteSessionId,
              reason: 'attached_view',
            }),
            emitDirectSessionTranscriptUpdate,
            shouldProcessBackgroundFollowEffects: () => false,
          })
          : undefined,
      });
      return {
        ok: true,
        leaseId: attached.leaseId,
        expiresAtMs: attached.expiresAtMs,
        renewed: attached.renewed,
      } satisfies DirectSessionAttachResponse;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return err('internal_error', message) satisfies DirectSessionAttachResponse;
    }
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_DIRECT_SESSION_DETACH, async (raw: unknown) => {
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

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_DIRECT_SESSION_FOLLOW_POLICY_SET, async (raw: unknown) => {
    const parsed = DirectSessionFollowPolicySetRequestSchema.safeParse(raw);
    if (!parsed.success) return err('invalid_request') satisfies DirectSessionFollowPolicySetResponse;
    const validatedSource = validateDirectMachineSource({
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
      const message = error instanceof Error ? error.message : 'follow_policy_set_failed';
      return err('internal_error', message) satisfies DirectSessionFollowPolicySetResponse;
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
          const message = error instanceof Error ? error.message : 'follow_policy_persist_failed';
          return err('internal_error', message) satisfies DirectSessionFollowPolicySetResponse;
        }
      };

      if (!parsed.data.enabled) {
        const persistError = await persistFollowPolicy();
        if (persistError) {
          return persistError;
        }
      }

      await followLeaseManager.setBackgroundFollowEnabled({
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
          }).catch(() => undefined);
          return persistError;
        }
      }

      return {
        ok: true,
        enabled: parsed.data.enabled,
        leaseActive:
          followLeaseManager.hasBackgroundFollowLease(parsed.data.sessionId)
          || followLeaseManager.countActiveLeases(parsed.data.sessionId) > 0,
        updatedAtMs,
      } satisfies DirectSessionFollowPolicySetResponse;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return err('internal_error', message) satisfies DirectSessionFollowPolicySetResponse;
    }
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_DIRECT_SESSIONS_ACP_SESSION_LIST_CAPABILITY_GET, async (raw: unknown) => {
    const parsed = DirectSessionsAcpSessionListCapabilityRequestSchema.safeParse(raw);
    if (!parsed.success) return err('invalid_request');
    return {
      ok: true,
      capability: 'acp_session_list_v1',
      protocolVersion: 1,
      sourceKind: 'acpSessionList',
      resumeOnly: true,
    } satisfies DirectSessionsAcpSessionListCapabilityResponse;
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_DIRECT_SESSIONS_CANDIDATES_LIST, async (raw: unknown) => {
    const parsed = DirectSessionsCandidatesListRequestSchema.safeParse(raw);
    if (!parsed.success) return err('invalid_request') satisfies DirectSessionsCandidatesListResponse;
    const validatedSource = validateDirectMachineSource({
      providerId: parsed.data.providerId,
      source: parsed.data.source,
      env: process.env,
    });
    if (!validatedSource.ok) {
      return err('invalid_request', validatedSource.error) satisfies DirectSessionsCandidatesListResponse;
    }
    const { providerId, cursor, searchTerm, searchMode } = parsed.data;
    const source = validatedSource.source;

    const limit = parsed.data.limit ?? resolveDefaultCandidatesLimit();
    const startedAtMs = Date.now();
    const startMemory = process.memoryUsage();
    try {
      const res = await (await getDirectSessionProviderOps(providerId)).listCandidates({ source, cursor, limit, searchTerm, searchMode });
      logger.debug('[directSessions.rpc.candidates] list finished', {
        providerId,
        elapsedMs: Date.now() - startedAtMs,
        searchTermLength: typeof searchTerm === 'string' ? searchTerm.trim().length : 0,
        searchMode: searchMode ?? 'default',
        cursorPresent: Boolean(cursor),
        limit,
        returnedCandidates: res.candidates.length,
        hasNextCursor: Boolean(res.nextCursor),
        searchIncomplete: Boolean(res.searchIncomplete),
        heapDeltaBytes: process.memoryUsage().heapUsed - startMemory.heapUsed,
        rssBytes: process.memoryUsage().rss,
      });
      return {
        ok: true,
        candidates: res.candidates,
        nextCursor: res.nextCursor,
        ...(res.searchIncomplete ? { searchIncomplete: true } : {}),
        ...(res.capabilities ? { capabilities: res.capabilities } : {}),
      } satisfies DirectSessionsCandidatesListResponse;
    } catch (error) {
      return errFromProviderFailure(error) satisfies DirectSessionsCandidatesListResponse;
    }
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_DIRECT_SESSION_CANDIDATE_DELETE, async (raw: unknown) => {
    const parsed = DirectSessionCandidateDeleteRequestSchema.safeParse(raw);
    if (!parsed.success) return err('invalid_request') satisfies DirectSessionCandidateDeleteResponse;
    const validatedSource = validateDirectMachineSource({
      providerId: parsed.data.providerId,
      source: parsed.data.source,
      env: process.env,
    });
    if (!validatedSource.ok) {
      return err('invalid_request', validatedSource.error) satisfies DirectSessionCandidateDeleteResponse;
    }

    try {
      const providerOps = await getDirectSessionProviderOps(parsed.data.providerId);
      await requireProviderOp(providerOps.deleteCandidate, parsed.data.providerId, 'candidate deletion')({
        source: validatedSource.source,
        remoteSessionId: parsed.data.remoteSessionId,
      });
      return { ok: true, deleted: true } satisfies DirectSessionCandidateDeleteResponse;
    } catch (error) {
      return errFromProviderFailure(error) satisfies DirectSessionCandidateDeleteResponse;
    }
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_DIRECT_SESSION_LINK_ENSURE, async (raw: unknown) => {
    const parsed = DirectSessionLinkEnsureRequestSchema.safeParse(raw);
    if (!parsed.success) return err('invalid_request') satisfies DirectSessionLinkEnsureResponse;
    const validatedSource = validateDirectMachineSource({
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
      // A linked direct session is rendered from the provider's transcript; a resume-only source
      // (ACP session/list) has none, so linking it would create a session Happier cannot show.
      const linkOps = await getDirectSessionProviderOps(parsed.data.providerId);
      requireProviderOp(linkOps.pageTranscript, parsed.data.providerId, 'linking');
      const codexBackendMode = normalizeCodexBackendMode(parsed.data.codexBackendMode) ?? undefined;
      const res = await ensureDirectSessionLink({
        credentials,
        machineId: parsed.data.machineId,
        providerId: parsed.data.providerId,
        remoteSessionId: parsed.data.remoteSessionId,
        codexBackendMode,
        runtimeDescriptor: parsed.data.runtimeDescriptor,
        titleHint: parsed.data.titleHint,
        directoryHint: parsed.data.directoryHint,
        sourceCreatedAtMs: parsed.data.sourceCreatedAtMs,
        sourceUpdatedAtMs: parsed.data.sourceUpdatedAtMs,
        source: validatedSource.source,
      });
      return { ok: true, sessionId: res.sessionId, created: res.created } satisfies DirectSessionLinkEnsureResponse;
    } catch (error) {
      return errFromProviderFailure(error) satisfies DirectSessionLinkEnsureResponse;
    }
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_DIRECT_SESSION_STATUS_GET, async (raw: unknown) => {
    const parsed = DirectSessionStatusGetRequestSchema.safeParse(raw);
    if (!parsed.success) return err('invalid_request') satisfies DirectSessionStatusGetResponse;
    const validatedSource = validateDirectMachineSource({
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
      const activityOps = await getDirectSessionProviderOps(parsed.data.providerId);
      const res = await requireProviderOp(activityOps.getActivity, parsed.data.providerId, 'activity')({
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

    let canTakeOverPersist = true;
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
            credentials,
            transcriptStorage: 'persisted',
          });
          canTakeOverPersist = takeoverOptions !== null;
        }
      }
    } catch {
      canTakeOverPersist = false;
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

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_DIRECT_SESSION_TRANSCRIPT_PAGE, async (raw: unknown) => {
    const parsed = DirectTranscriptPageRequestSchema.safeParse(raw);
    if (!parsed.success) return err('invalid_request') satisfies DirectTranscriptPageResponse;
    const validatedSource = validateDirectMachineSource({
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
      const pageOps = await getDirectSessionProviderOps(providerId);
      const res = await requireProviderOp(pageOps.pageTranscript, providerId, 'transcript paging')({
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
        ...(res.truncationReason ? { truncationReason: res.truncationReason } : {}),
      } satisfies DirectTranscriptPageResponse;
    } catch (error) {
      return errFromProviderFailure(error) satisfies DirectTranscriptPageResponse;
    }
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_DIRECT_SESSION_TRANSCRIPT_READ_AFTER, async (raw: unknown) => {
    const parsed = DirectTranscriptReadAfterRequestSchema.safeParse(raw);
    if (!parsed.success) return err('invalid_request') satisfies DirectTranscriptReadAfterResponse;
    const validatedSource = validateDirectMachineSource({
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
      const readAfterOps = await getDirectSessionProviderOps(providerId);
      const res = await requireProviderOp(readAfterOps.readAfterTranscript, providerId, 'transcript paging')({
        source,
        remoteSessionId,
        cursor,
        maxBytes,
        maxItems,
      });
      return { ok: true, ...res } satisfies DirectTranscriptReadAfterResponse;
    } catch (error) {
      return errFromProviderFailure(error) satisfies DirectTranscriptReadAfterResponse;
    }
  });

  // Direct and persisted takeover share admission, source/auth resolution and writer ownership.
  const prepareTakeover = async (request: DirectSessionTakeoverRequest, transcriptStorage: 'direct' | 'persisted', control: DirectSessionImportControl) => {
    control.signal.throwIfAborted();
    if (!params.spawnSession || !params.stopSession) return err('provider_unavailable', 'takeover_not_supported');
    const credentials = await readCredentials().catch(() => null);
    if (!credentials) return err('provider_unavailable', 'not_authenticated');
    const loaded = await loadLinkedDirectSession({ credentials, sessionId: request.sessionId, machineId: request.machineId });
    if (!loaded.ok) return err(loaded.errorCode, loaded.error);
    const source = validateDirectMachineSource({ providerId: loaded.session.providerId, source: loaded.session.source, env: process.env });
    if (!source.ok) return err('invalid_request', source.error);
    const linked = { ...loaded.session, source: source.source };
    const trustedOwner = findTrustedDirectSessionOwner({
      markers: await listSessionMarkers().catch(() => []),
      providerId: linked.providerId, remoteSessionId: linked.remoteSessionId, isPidAlive,
    });
    if (transcriptStorage === 'direct' && trustedOwner?.happySessionId === request.sessionId) {
      return { ok: true as const, alreadyRunning: true as const };
    }
    if (trustedOwner && trustedOwner.happySessionId !== request.sessionId) {
      if (request.forceStop !== true) return err('invalid_request', 'force_stop_required');
      control.signal.throwIfAborted();
      if (!await params.stopSession(trustedOwner.happySessionId)) return err('internal_error', 'trusted_process_stop_failed');
    }
    control.signal.throwIfAborted();
    const spawnOptions = await resolveDirectTakeoverSpawnOptions({
      linked, sessionId: request.sessionId, credentials, transcriptStorage, terminal: request.terminal,
    });
    if (!spawnOptions) return err('invalid_request', 'direct_session_directory_unavailable');
    return { ok: true as const, alreadyRunning: false as const, linked, credentials, spawnOptions };
  };

  const executeDirectTakeover = async (request: DirectSessionTakeoverRequest, control: DirectSessionImportControl): Promise<DirectSessionTakeoverResponse> => {
    const prepared = await prepareTakeover(request, 'direct', control);
    if (!prepared.ok) return prepared;
    if (prepared.alreadyRunning) return { ok: true };
    control.update({ phase: 'starting' });
    const result = await params.spawnSession!(prepared.spawnOptions);
    return result.type === 'success' ? { ok: true } : err('internal_error', result.type === 'error' ? result.errorMessage : 'directory_approval_required');
  };
  const executePersistedTakeover = async (request: DirectSessionTakeoverPersistRequest, control: DirectSessionImportControl): Promise<DirectSessionTakeoverPersistResponse> => {
    const prepared = await prepareTakeover(request, 'persisted', control);
    if (!prepared.ok) return prepared;
    if (prepared.alreadyRunning) return { ok: true };
    const { linked, credentials, spawnOptions: directSpawnOptions } = prepared;
    control.signal.throwIfAborted();
    control.update({ phase: 'reading' });
    try {
      await importDirectSessionTranscript({
        linked,
        credentials,
        sessionId: request.sessionId,
        workingDirectory: directSpawnOptions.directory,
        signal: control.signal,
        onProgress: (progress) => control.update({ phase: 'importing', ...progress }),
      });
    } catch (error) {
      if (control.signal.aborted && error instanceof Error && error.name === 'AbortError') throw error;
      return err('internal_error', 'direct_session_import_failed') satisfies DirectSessionTakeoverPersistResponse;
    }

    control.update({ phase: 'starting' });
    const persistedSpawnOptions: SpawnSessionOptions = {
      ...directSpawnOptions,
      transcriptStorage: 'persisted',
    };
    const spawnResult = await params.spawnSession!(persistedSpawnOptions);
    if (spawnResult.type !== 'success') {
      return err(
        'internal_error',
        spawnResult.type === 'error' ? spawnResult.errorMessage : 'directory_approval_required',
      ) satisfies DirectSessionTakeoverPersistResponse;
    }

    control.update({ phase: 'converting' });
    await updateSessionMetadataWithRetry({
      token: credentials.token,
      credentials,
      sessionId: request.sessionId,
      rawSession: linked.rawSession,
      updater: (current) => {
        const next: Record<string, unknown> = { ...current };
        delete next.directSessionV1;
        if (typeof next.path !== 'string' || !next.path.trim()) {
          next.path = directSpawnOptions.directory;
        }
        next.externalHistoryImportV1 = {
          v: 1,
          providerId: linked.providerId,
          remoteSessionId: linked.remoteSessionId,
          importedAtMs: Date.now(),
          source: linked.source,
        };
        return next;
      },
    });

    return { ok: true, converted: true } satisfies DirectSessionTakeoverPersistResponse;
  };

  const startTakeover = async (raw: unknown, mode: 'direct' | 'persisted') => {
    const parsed = (mode === 'persisted' ? DirectSessionTakeoverPersistRequestSchema : DirectSessionTakeoverRequestSchema).safeParse(raw);
    if (!parsed.success) return err('invalid_request');
    const runtime = params.actionOperations;
    if (!runtime) return err('provider_unavailable', 'action_operations_unavailable');
    const request = parsed.data;
    const scope = await runtime.getScope();
    if (scope.machineId !== request.machineId) return err('invalid_request', 'direct_session_machine_mismatch');
    const started = runtime.runner.startHistorical<DirectSessionTakeoverPersistResponse>({
      request: {
        actionId: DIRECT_SESSION_TAKEOVER_ACTION_IDS[mode],
        input: request, requestId: request.requestId, scope: { sessionId: request.sessionId },
      },
      scope, scopeSessionId: request.sessionId,
      exclusiveKey: JSON.stringify(['direct-session-takeover', request.sessionId]),
      title: mode === 'persisted' ? 'Import session history' : 'Take over session',
      cancellation: mode === 'persisted' ? 'supported' : 'unsupported',
      execute: async ({ signal, update }) => {
        const control: DirectSessionImportControl = {
          signal,
          update: (progress) => {
            if (progress.phase === 'starting') signal.throwIfAborted();
            update({
              ...(progress.phase === 'starting' || progress.phase === 'converting' ? { cancellation: 'unsupported' as const } : {}),
              progress: progress.phase === 'importing' && progress.totalCount !== undefined && progress.totalCount > 0
                ? { kind: 'determinate', current: progress.importedCount ?? 0, total: progress.totalCount, label: 'Importing history' }
                : { kind: 'phase', phase: progress.phase, label: {
                  preparing: 'Preparing import', reading: 'Reading history', importing: 'Importing history',
                  starting: 'Starting session', converting: 'Converting session',
                }[progress.phase] },
            });
          },
        };
        control.update({ phase: 'preparing' });
        return await (mode === 'persisted' ? executePersistedTakeover(request, control) : executeDirectTakeover(request, control));
      },
      projectResult: (result) => result.ok
        ? { ok: true, result }
        : { ok: false, errorCode: result.errorCode, error: result.errorCode === 'internal_error' ? 'direct_session_takeover_failed' : result.error },
    });
    return started.kind === 'started' ? { ok: true as const, started } : err('invalid_request', mode === 'persisted' ? 'direct_session_takeover_in_progress' : 'direct_session_import_in_progress');
  };
  const completeTakeover = async (raw: unknown, mode: 'direct' | 'persisted') => {
    const admission = await startTakeover(raw, mode);
    if (!admission.ok) return admission;
    try {
      return await admission.started.completion;
    } catch (error) {
      return err('internal_error', error instanceof Error && error.name === 'AbortError' ? 'direct_session_import_cancelled' : 'direct_session_takeover_failed');
    }
  };
  // Released synchronous methods wait on the same owner used by asynchronous start.
  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER, async (raw: unknown) => completeTakeover(raw, 'direct'));
  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_PERSIST, async (raw: unknown) => completeTakeover(raw, 'persisted'));
  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_PERSIST_START, async (raw: unknown) => {
    const admission = await startTakeover(raw, 'persisted');
    return admission.ok ? { ok: true, operation: admission.started.operation } : admission;
  });
}
