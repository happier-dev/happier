import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
  DirectSessionAttachRequestSchema,
  DirectSessionDetachRequestSchema,
  DirectSessionFollowPolicySetRequestSchema,
  DirectSessionLinkEnsureRequestSchema,
  DirectSessionStatusGetRequestSchema,
  DirectSessionTakeoverPersistRequestSchema,
  DirectSessionTakeoverRequestSchema,
  DirectSessionsCandidatesListRequestSchema,
  DirectTranscriptPageRequestSchema,
  DirectTranscriptReadAfterRequestSchema,
  normalizeCodexBackendMode,
  type DirectSessionAttachResponse,
  type DirectSessionDetachResponse,
  type DirectSessionFollowPolicySetResponse,
  type DirectSessionTranscriptDeltaEphemeral,
  type DirectSessionLinkEnsureResponse,
  type DirectSessionStatusGetResponse,
  type DirectSessionTakeoverPersistResponse,
  type DirectSessionTakeoverResponse,
  type DirectSessionsCandidatesListResponse,
  type DirectTranscriptPageResponse,
  type DirectTranscriptReadAfterResponse,
} from '@happier-dev/protocol';

import { readCredentials } from '@/persistence';
import { listSessionMarkers } from '@/daemon/sessionRegistry';
import { getDirectSessionProviderOps } from '@/backends/catalog';

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

import type { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import type { SpawnSessionOptions, SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';

type DirectSessionsErrorCode = 'invalid_request' | 'machine_offline' | 'provider_unavailable' | 'internal_error';

function err(
  errorCode: DirectSessionsErrorCode,
  error?: string,
): { ok: false; errorCode: DirectSessionsErrorCode; error: string } {
  return { ok: false, errorCode, error: typeof error === 'string' && error.trim() ? error : errorCode };
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
  rpcHandlerManager: RpcHandlerManager;
  spawnSession?: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  stopSession?: (sessionId: string) => Promise<boolean>;
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
    const { providerId, cursor, searchTerm } = parsed.data;
    const source = validatedSource.source;

    const limit = parsed.data.limit ?? resolveDefaultCandidatesLimit();
    try {
      const res = await (await getDirectSessionProviderOps(providerId)).listCandidates({ source, cursor, limit, searchTerm });
      return { ok: true, candidates: res.candidates, nextCursor: res.nextCursor } satisfies DirectSessionsCandidatesListResponse;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return err('internal_error', message) satisfies DirectSessionsCandidatesListResponse;
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
        source: validatedSource.source,
      });
      return { ok: true, sessionId: res.sessionId, created: res.created } satisfies DirectSessionLinkEnsureResponse;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return err('internal_error', message) satisfies DirectSessionLinkEnsureResponse;
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
      const message = error instanceof Error ? error.message : 'Unknown error';
      return err('internal_error', message) satisfies DirectTranscriptPageResponse;
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
      const res = await (await getDirectSessionProviderOps(providerId)).readAfterTranscript({
        source,
        remoteSessionId,
        cursor,
        maxBytes,
        maxItems,
      });
      return { ok: true, items: res.items, nextCursor: res.nextCursor, truncated: res.truncated } satisfies DirectTranscriptReadAfterResponse;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return err('internal_error', message) satisfies DirectTranscriptReadAfterResponse;
    }
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER, async (raw: unknown) => {
    const parsed = DirectSessionTakeoverRequestSchema.safeParse(raw);
    if (!parsed.success) return err('invalid_request') satisfies DirectSessionTakeoverResponse;
    if (!params.spawnSession || !params.stopSession) {
      return err('provider_unavailable', 'takeover_not_supported') satisfies DirectSessionTakeoverResponse;
    }

    const credentials = await readCredentials().catch(() => null);
    if (!credentials) {
      return err('provider_unavailable', 'not_authenticated') satisfies DirectSessionTakeoverResponse;
    }

    const linked = await loadLinkedDirectSession({
      credentials,
      sessionId: parsed.data.sessionId,
      machineId: parsed.data.machineId,
    });
    if (!linked.ok) {
      return err(linked.errorCode, linked.error) satisfies DirectSessionTakeoverResponse;
    }
    const validatedSource = validateDirectMachineSource({
      providerId: linked.session.providerId,
      source: linked.session.source,
      env: process.env,
    });
    if (!validatedSource.ok) {
      return err('invalid_request', validatedSource.error) satisfies DirectSessionTakeoverResponse;
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

    if (trustedOwner && trustedOwner.happySessionId === parsed.data.sessionId) {
      return { ok: true } satisfies DirectSessionTakeoverResponse;
    }

    if (trustedOwner && parsed.data.forceStop !== true) {
      return err('invalid_request', 'force_stop_required') satisfies DirectSessionTakeoverResponse;
    }

    if (trustedOwner && parsed.data.forceStop === true) {
      const stopped = await params.stopSession(trustedOwner.happySessionId);
      if (!stopped) {
        return err('internal_error', 'trusted_process_stop_failed') satisfies DirectSessionTakeoverResponse;
      }
    }

    const spawnOptions = await resolveDirectTakeoverSpawnOptions({
      linked: validatedLinkedSession,
      sessionId: parsed.data.sessionId,
    });
    if (!spawnOptions) {
      return err('invalid_request', 'direct_session_directory_unavailable') satisfies DirectSessionTakeoverResponse;
    }

    const spawnResult = await params.spawnSession(spawnOptions);
    if (spawnResult.type !== 'success') {
      return err(
        'internal_error',
        spawnResult.type === 'error' ? spawnResult.errorMessage : 'directory_approval_required',
      ) satisfies DirectSessionTakeoverResponse;
    }

    return { ok: true } satisfies DirectSessionTakeoverResponse;
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_PERSIST, async (raw: unknown) => {
    const parsed = DirectSessionTakeoverPersistRequestSchema.safeParse(raw);
    if (!parsed.success) return err('invalid_request') satisfies DirectSessionTakeoverPersistResponse;
    if (!params.spawnSession || !params.stopSession) {
      return err('provider_unavailable', 'takeover_not_supported') satisfies DirectSessionTakeoverPersistResponse;
    }

    const credentials = await readCredentials().catch(() => null);
    if (!credentials) {
      return err('provider_unavailable', 'not_authenticated') satisfies DirectSessionTakeoverPersistResponse;
    }

    const linked = await loadLinkedDirectSession({
      credentials,
      sessionId: parsed.data.sessionId,
      machineId: parsed.data.machineId,
    });
    if (!linked.ok) {
      return err(linked.errorCode, linked.error) satisfies DirectSessionTakeoverPersistResponse;
    }
    const validatedSource = validateDirectMachineSource({
      providerId: linked.session.providerId,
      source: linked.session.source,
      env: process.env,
    });
    if (!validatedSource.ok) {
      return err('invalid_request', validatedSource.error) satisfies DirectSessionTakeoverPersistResponse;
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

    if (trustedOwner && trustedOwner.happySessionId !== parsed.data.sessionId && parsed.data.forceStop !== true) {
      return err('invalid_request', 'force_stop_required') satisfies DirectSessionTakeoverPersistResponse;
    }

    if (trustedOwner && trustedOwner.happySessionId !== parsed.data.sessionId && parsed.data.forceStop === true) {
      const stopped = await params.stopSession(trustedOwner.happySessionId);
      if (!stopped) {
        return err('internal_error', 'trusted_process_stop_failed') satisfies DirectSessionTakeoverPersistResponse;
      }
    }

    const directSpawnOptions = await resolveDirectTakeoverSpawnOptions({
      linked: validatedLinkedSession,
      sessionId: parsed.data.sessionId,
    });
    if (!directSpawnOptions) {
      return err('invalid_request', 'direct_session_directory_unavailable') satisfies DirectSessionTakeoverPersistResponse;
    }

    try {
      await importDirectSessionTranscript({
        linked: validatedLinkedSession,
        credentials,
        sessionId: parsed.data.sessionId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'direct_session_import_failed';
      return err('internal_error', message) satisfies DirectSessionTakeoverPersistResponse;
    }

    const persistedSpawnOptions: SpawnSessionOptions = {
      ...directSpawnOptions,
      transcriptStorage: 'persisted',
    };
    const spawnResult = await params.spawnSession(persistedSpawnOptions);
    if (spawnResult.type !== 'success') {
      return err(
        'internal_error',
        spawnResult.type === 'error' ? spawnResult.errorMessage : 'directory_approval_required',
      ) satisfies DirectSessionTakeoverPersistResponse;
    }

    await updateSessionMetadataWithRetry({
      token: credentials.token,
      credentials,
      sessionId: parsed.data.sessionId,
      rawSession: linked.session.rawSession,
      updater: (current) => {
        const next: Record<string, unknown> = { ...current };
        delete next.directSessionV1;
        if (typeof next.path !== 'string' || !next.path.trim()) {
          next.path = directSpawnOptions.directory;
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

    return { ok: true, converted: true } satisfies DirectSessionTakeoverPersistResponse;
  });
}
