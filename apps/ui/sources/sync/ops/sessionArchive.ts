import { maybeParseJson } from '@happier-dev/protocol/activity/parseJson';
import { SessionStopOutcomeSchema, type SessionStopOutcome } from '@happier-dev/protocol/sessions/control/contract';
import { apiSocket } from '../api/session/apiSocket';
import { storage } from '../domains/state/storage';
import { nowServerMs } from '../runtime/time';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { resolveSessionArchiveAddress } from '@/sync/domains/session/listing/sessionArchiveState';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';
import { resolveServerAccountRequestContext } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerAccountRequestContext';
import { createServerRequestForResolvedServerScope, type ServerAccountRequestAuthority } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { readTransientAvailabilityFailure } from '@/utils/errors/transientAvailability';
import { throwIfAborted } from '@/utils/runtime/abortSignals';
import { SessionArchiveTimeoutError, withSessionArchiveDeadline } from './sessionArchiveLifecycle';

export interface SessionArchiveResponse {
    success: boolean;
    archivedAt?: number | null;
    stopOutcome?: SessionStopOutcome;
    message?: string;
    code?: string;
}

const SESSION_ACTIVE_ARCHIVE_MESSAGE = 'Cannot archive an active session';

type ArchiveRequestParams = Readonly<{
    sessionId: string;
    serverId?: string | null;
    action: 'archive' | 'unarchive';
    signal?: AbortSignal;
    authority?: Pick<ServerAccountRequestAuthority, 'scope' | 'request'>;
}>;
type ArchiveRequestResult<T> = Readonly<{ response: T; address: SessionAddress; release: () => Promise<void> }>;
function archiveRequestWithContext(params: ArchiveRequestParams): Promise<ArchiveRequestResult<Response>>;
function archiveRequestWithContext<T>(params: ArchiveRequestParams, consumeResponse: (response: Response) => Promise<T>): Promise<ArchiveRequestResult<T>>;
async function archiveRequestWithContext<T>(params: ArchiveRequestParams, consumeResponse?: (response: Response) => Promise<T>): Promise<ArchiveRequestResult<Response | T>> {
    const address = resolveSessionArchiveAddress({
        serverId: params.authority?.scope.serverId ?? params.serverId ?? resolvePreferredServerIdForSessionId(params.sessionId) ?? getActiveServerSnapshot().serverId,
        sessionId: params.sessionId,
    });
    if (!address) throw new Error('Archive requires an exact Home-qualified Session');
    const path = `/v2/sessions/${params.sessionId}/${params.action}`;
    if (params.authority) {
        // The enclosing Action already owns the Account request and its lifetime.
        const response = await params.authority.request(path, { method: 'POST', ...(params.signal ? { signal: params.signal } : {}) });
        return { response: consumeResponse ? await consumeResponse(response) : response, address, release: async () => {} };
    }
    const context = await resolveServerAccountRequestContext({ serverId: address.serverId, signal: params.signal });

    try {
        throwIfAborted(params.signal);
        const request = createServerRequestForResolvedServerScope({
            context,
            activeRequest: apiSocket.request.bind(apiSocket),
        });
        const init = { method: 'POST', ...(params.signal ? { signal: params.signal } : {}) };
        const response = consumeResponse ? await request(path, init, undefined, consumeResponse)
            : await request(path, init);
        return {
            response,
            address,
            release: context.scope === 'scoped' ? (context.release ?? (async () => undefined)) : async () => undefined,
        };
    } catch (error) {
        if (context.scope === 'scoped') await context.release?.();
        throw error;
    }
}

async function applyArchivedAtToLocalSession(capturedAddress: SessionAddress, archivedAt: number | null): Promise<void> {
    const address = resolveSessionArchiveAddress(capturedAddress);
    if (!address) return;
    const updatedAt = nowServerMs();
    storage.getState().applyServerScopedSessionListRowPatches(address.serverId, [
        { sessionId: address.sessionId, patch: { archivedAt, updatedAt } },
    ]);
    const state = storage.getState();
    const session = state.sessions[address.sessionId];
    if (!session || !areServerProfileIdentifiersEquivalent(address.serverId, getActiveServerSnapshot().serverId)
        || (session.serverId && !areServerProfileIdentifiersEquivalent(session.serverId, address.serverId))) return;
    state.applySessions([{ ...session, archivedAt, updatedAt }], 'projection');
}

async function readArchiveFailure(response: Response, fallbackMessage: string): Promise<SessionArchiveResponse> {
    const message = await response.text().catch(() => '');
    const payload = maybeParseJson(message);
    const code = payload && typeof payload === 'object' && 'error' in payload ? payload.error : undefined;
    const transient = readTransientAvailabilityFailure(code, { safeToRetry: true });
    return transient ? { success: false, code: transient.code, message: transient.message }
        : { success: false, message: message || fallbackMessage };
}

export async function sessionArchiveWithServerScope(
    sessionId: string,
    opts?: Readonly<{ serverId?: string | null; signal?: AbortSignal }>,
): Promise<SessionArchiveResponse> {
    try {
        return await withSessionArchiveDeadline(opts?.signal, async signal => {
            const request = await archiveRequestWithContext({ sessionId, serverId: opts?.serverId ?? null, action: 'archive', signal }, async (response): Promise<SessionArchiveResponse> => {
                if (!response.ok) {
                    const failure = await readArchiveFailure(response, 'Failed to archive session');
                    throwIfAborted(signal);
                    if (response.status === 409) return { success: false, message: SESSION_ACTIVE_ARCHIVE_MESSAGE, code: 'session_active' };
                    return failure;
                }
                const json: unknown = await response.json().catch(() => null);
                throwIfAborted(signal);
                const archivedAt = json && typeof json === 'object' && 'archivedAt' in json && typeof json.archivedAt === 'number'
                    ? json.archivedAt : null;
                const stopOutcome = json && typeof json === 'object' && 'stopOutcome' in json
                    ? SessionStopOutcomeSchema.safeParse(json.stopOutcome) : undefined;
                return { success: true, archivedAt, ...(stopOutcome?.success ? { stopOutcome: stopOutcome.data } : {}) };
            });
            try {
                throwIfAborted(signal);
                if (request.response.success) await applyArchivedAtToLocalSession(request.address, request.response.archivedAt ?? null);
                return request.response;
            } finally { await request.release(); }
        });
    } catch (error) {
        if (error instanceof SessionArchiveTimeoutError) return { success: false, code: 'session_archive_timeout' };
        return { success: false, message: error instanceof Error ? error.message : 'Unknown error' };
    }
}

export async function sessionUnarchiveWithServerScope(
    sessionId: string,
    opts?: Readonly<{ serverId?: string | null; authority?: Pick<ServerAccountRequestAuthority, 'scope' | 'request'> }>,
): Promise<SessionArchiveResponse> {
    try {
        const request = await archiveRequestWithContext({ sessionId, serverId: opts?.serverId ?? null, authority: opts?.authority, action: 'unarchive' });
        try {
            const { response } = request;
            if (!response.ok) return await readArchiveFailure(response, 'Failed to unarchive session');
            await response.json().catch(() => null);
            await applyArchivedAtToLocalSession(request.address, null);
            return { success: true, archivedAt: null };
        } finally {
            await request.release();
        }
    } catch (error) {
        return { success: false, message: error instanceof Error ? error.message : 'Unknown error' };
    }
}
