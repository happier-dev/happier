import type { StoredCredentials } from '@/persistence';
import type { SessionSnapshotRefreshReason } from '@/api/session/sessionSnapshotRefreshReason';
import type { AccountEncryptionCurrentnessResponse } from '@happier-dev/protocol';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { fetchAccountEncryptionCurrentness } from '@/api/client/connectedServiceCredentialApi';
import { classifyServerEndpointError } from '@/api/client/classifyServerEndpointError';
import type {
    SessionEncryptionContext,
    SessionStoredContentEncryptionMode,
} from '@/session/transport/encryption/sessionEncryptionContext';
import {
    resolveSessionEncryptionContextFromCredentials,
    resolveSessionStoredContentEncryptionMode,
} from '@/session/transport/encryption/sessionEncryptionContext';
import { type ResolveSessionIdResult, resolveSessionIdOrPrefix } from '@/session/query/resolveSessionId';
import { fetchSessionById, type RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { logger } from '@/ui/logger';

export type ResolveSessionTransportContextResult =
    | {
          ok: true;
          sessionId: string;
          rawSession: RawSessionRecord;
          accountEncryptionCurrentness: AccountEncryptionCurrentnessResponse;
          ctx: null;
          mode: 'plain';
      }
    | {
          ok: true;
          sessionId: string;
          rawSession: RawSessionRecord;
          accountEncryptionCurrentness: AccountEncryptionCurrentnessResponse;
          ctx: SessionEncryptionContext;
          mode: 'e2ee';
      }
    | {
          ok: false;
          code:
              | Extract<ResolveSessionIdResult, { ok: false }>['code']
              | 'encryption_material_unavailable';
          candidates?: string[];
          sessionId?: string;
      };

async function fetchSessionTransportRecord(params: Readonly<{
    reason: SessionSnapshotRefreshReason;
    credentials: StoredCredentials;
    sessionId: string;
    resolveAuthorizationHeaders?: (request: Readonly<{
        method: 'GET' | 'POST'; path: string; body?: unknown;
    }>) => Readonly<Record<string, string>> | null;
    signal?: AbortSignal;
    serverFeaturesSnapshot?: CliServerFeaturesSnapshot;
}>): Promise<RawSessionRecord | null> {
    params.signal?.throwIfAborted();
    return await fetchSessionById({
        reason: params.reason,
        token: params.credentials.token,
        sessionId: params.sessionId,
        ...(params.resolveAuthorizationHeaders
            ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders }
            : {}),
        ...(params.signal ? { signal: params.signal } : {}),
        ...(params.serverFeaturesSnapshot ? { serverFeaturesSnapshot: params.serverFeaturesSnapshot } : {}),
    });
}

export async function resolveSessionTransportContext(params: Readonly<{
    reason: SessionSnapshotRefreshReason;
    credentials: StoredCredentials;
    idOrPrefix: string;
    resolveAuthorizationHeaders?: (request: Readonly<{
        method: 'GET' | 'POST'; path: string; body?: unknown;
    }>) => Readonly<Record<string, string>> | null;
    signal?: AbortSignal;
    /** Snapshot already bound to this exact Home; this owner never probes for one. */
    serverFeaturesSnapshot?: CliServerFeaturesSnapshot;
}>): Promise<ResolveSessionTransportContextResult> {
    const resolutionStartedAt = performance.now();
    let phaseStartedAt = resolutionStartedAt;
    const phase = (name: 'account_currentness' | 'session_lookup' | 'session_record' | 'encryption_material', startedAt = phaseStartedAt) => {
        const now = performance.now();
        logger.debug('[SessionTransport] Resolution phase', { phase: name,
            durationMs: Math.round(now - startedAt), elapsedMs: Math.round(now - resolutionStartedAt) });
        phaseStartedAt = now;
    };
    params.signal?.throwIfAborted();
    const currentnessAuthorizationHeaders = params.resolveAuthorizationHeaders?.({
        method: 'GET', path: '/v1/account/encryption/currentness',
    });
    if (params.resolveAuthorizationHeaders && !currentnessAuthorizationHeaders) {
        throw new Error('External Action authorization unavailable');
    }
    const accountEncryptionCurrentnessRead = fetchAccountEncryptionCurrentness({
        token: params.credentials.token,
        ...(currentnessAuthorizationHeaders
            ? { authorizationHeaders: currentnessAuthorizationHeaders }
            : {}),
        ...(params.signal ? { signal: params.signal } : {}),
    }).catch(error => {
        if (params.signal?.aborted) throw error;
        // The reader retains the transport cause. Translate it once at this
        // shared adapter so CLI, signed Actions and direct Session operations
        // expose the established control codes before generic normalization.
        const { kind } = classifyServerEndpointError(error);
        if (kind === 'auth_failed') {
            throw Object.assign(new Error('Account encryption currentness authentication failed', { cause: error }), {
                code: 'not_authenticated',
            });
        }
        if (kind === 'network' || kind === 'timeout' || kind === 'server_error'
            || kind === 'dependency_unavailable' || kind === 'rate_limited') {
            throw Object.assign(new Error('Account encryption currentness Home is unavailable', { cause: error }), {
                code: 'server_unreachable',
            });
        }
        // Invalid successful responses and domain refusals retain their own
        // evidence; they do not establish Home unreachability or missing keys.
        throw error;
    }).then(currentness => { phase('account_currentness', resolutionStartedAt); return currentness; });
    const lookupStartedAt = performance.now();
    const sessionLookup = resolveSessionIdOrPrefix({
        reason: params.reason,
        credentials: params.credentials,
        idOrPrefix: params.idOrPrefix,
        ...(params.resolveAuthorizationHeaders
            ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders }
            : {}),
        ...(params.signal ? { signal: params.signal } : {}),
        ...(params.serverFeaturesSnapshot ? { serverFeaturesSnapshot: params.serverFeaturesSnapshot } : {}),
        accountEncryptionMode: async () => (await accountEncryptionCurrentnessRead).mode,
    }).then(resolved => { phase('session_lookup', lookupStartedAt); return resolved; });
    // Both reads stay fresh. No transport or encryption material is published
    // until the Account witness and the canonical selector have both settled.
    const [accountEncryptionCurrentness, resolved] = await Promise.all([accountEncryptionCurrentnessRead, sessionLookup]);
    params.signal?.throwIfAborted();
    if (!resolved.ok) {
        return {
            ok: false,
            code: resolved.code,
            ...(resolved.candidates ? { candidates: resolved.candidates } : {}),
        };
    }

    const rawSessionPromise = resolved.rawSession
        ? Promise.resolve(resolved.rawSession)
        : fetchSessionTransportRecord({
            reason: params.reason,
            credentials: params.credentials,
            sessionId: resolved.sessionId,
            ...(params.resolveAuthorizationHeaders
                ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders }
                : {}),
            ...(params.signal ? { signal: params.signal } : {}),
            ...(params.serverFeaturesSnapshot ? { serverFeaturesSnapshot: params.serverFeaturesSnapshot } : {}),
        });
    const rawSession = await rawSessionPromise;
    phase('session_record');
    params.signal?.throwIfAborted();
    if (!rawSession) {
        return {
            ok: false,
            code: 'session_not_found',
            sessionId: resolved.sessionId,
        };
    }

    const mode = resolveSessionStoredContentEncryptionMode(rawSession);
    if (mode === 'plain') {
        return {
            ok: true,
            sessionId: resolved.sessionId,
            rawSession,
            accountEncryptionCurrentness,
            ctx: null,
            mode,
        };
    }
    const ctx = resolveSessionEncryptionContextFromCredentials(
        params.credentials,
        rawSession,
    );
    phase('encryption_material');
    if (!ctx) {
        return {
            ok: false,
            code: 'encryption_material_unavailable',
            sessionId: resolved.sessionId,
        };
    }

    return {
        ok: true,
        sessionId: resolved.sessionId,
        rawSession,
        accountEncryptionCurrentness,
        ctx,
        mode,
    };
}
