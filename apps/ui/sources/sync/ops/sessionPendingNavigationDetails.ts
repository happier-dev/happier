import type { Message } from '@happier-dev/session-core/messages';
import { createReducer, reducer } from '@happier-dev/session-core/reducer';
import { buildSessionMessagesPath } from '@happier-dev/protocol/sessions/messages/sessionMessagesPageV1';
import type { Session } from '@/sync/domains/state/storageTypes';
import { normalizeSessionAddress, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import { listPendingSessionRequests, type SessionPendingRequest } from '@/sync/domains/session/pending/listPendingSessionRequests';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { captureActiveServerAccountScopeCurrentness } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { isSessionContentReadable, readSessionContentAvailability } from '@/sync/domains/session/encryptedContentAvailability';
import { subscribeHomeCredentialChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { runWithServerRequestAuthorityForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { readSessionSnapshotForAuthority, SessionSnapshotReadError } from '@/sync/runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority';
import type { ServerAccountRequestAuthority } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { runSessionMessagesPagePipeline } from '@/sync/engine/sessions/sessionMessagesPagePipeline';

export type PendingNavigationDetailsResult =
    | Readonly<{ kind: 'available'; session: Session; messages: readonly Message[]; requests: readonly SessionPendingRequest[] }>
    | Readonly<{ kind: 'unavailable'; reason: string }>;

/** Reuses a caller's admitted batched snapshot without a second Session read. */
export async function readPendingNavigationDetailsForAuthority(
    authority: ServerAccountRequestAuthority,
    session: Session,
    options: Readonly<{ signal?: AbortSignal; isCurrent(): boolean }>,
): Promise<PendingNavigationDetailsResult> {
    const isCurrent = options.isCurrent;
    const unavailableReason = () => options.signal?.aborted ? 'cancelled' : 'scope_changed';
    const request: ServerAccountRequestAuthority['request'] = (path, init, requestOptions) => authority.request(
        path, { ...init, ...(options.signal ? { signal: options.signal } : {}) }, requestOptions,
    );
    const availability = readSessionContentAvailability(session);
    if (!isSessionContentReadable(availability)) {
        return { kind: 'unavailable', reason: availability ?? 'content_unavailable' };
    }

    // Pending state is the cheapest canonical identity source. A full
    // request snapshot avoids transcript paging independent of its size.
    const stateRequests = listPendingSessionRequests(session, []);
    const projectedCount = (session.pendingPermissionRequestCount ?? 0) + (session.pendingUserActionRequestCount ?? 0);
    const stateComplete = (stateRequests.length > 0 && stateRequests.length >= projectedCount)
        || (session.metadataLayoutVersion === 1 && projectedCount === 0);
    if (stateComplete) {
        return { kind: 'available', session, messages: [], requests: stateRequests };
    }
    const reduction = createReducer();
    const messagesById = new Map<string, Message>();
    const received = new Map<string, Map<string, number>>();
    let requests = stateRequests;
    let beforeSeq: number | undefined;
    for (;;) {
        if (!isCurrent()) return { kind: 'unavailable', reason: unavailableReason() };
        const page = await runSessionMessagesPagePipeline({
            sessionId: session.id,
            serverId: authority.scope.serverId,
            purpose: 'older',
            page: {
                direction: 'older', scope: 'all',
                requestPath: buildSessionMessagesPath({ sessionId: session.id, scope: 'all', ...(beforeSeq !== undefined ? { beforeSeq } : {}) }),
                ...(beforeSeq !== undefined ? { beforeSeq } : {}),
            },
            lifecyclePolicy: 'suppress',
            sessionEncryptionMode: session.encryptionMode === 'plain' ? 'plain' : 'e2ee',
            getSessionEncryption: (id) => authority.context.encryption?.getSessionEncryption(id) ?? null,
            isCurrent,
            request,
            sessionReceivedMessages: received,
            applyMessages: () => {},
            log: { log: () => {} },
        });
        if (!isCurrent()) return { kind: 'unavailable', reason: unavailableReason() };
        for (const message of reducer(reduction, [...page.normalizedMessages], session.agentState).messages) {
            messagesById.set(message.id, message);
        }
        requests = listPendingSessionRequests(session, Array.from(messagesById.values()));
        // Known incomplete snapshots need only their missing identities;
        // legacy snapshots without a count still exhaust the fallback.
        if (projectedCount > stateRequests.length && requests.length >= projectedCount) break;
        if (page.page.hasMore !== true) break;
        const next = page.page.nextBeforeSeq;
        if (typeof next !== 'number' || next <= 0 || (beforeSeq !== undefined && next >= beforeSeq)) {
            return { kind: 'unavailable', reason: 'invalid_page_cursor' };
        }
        beforeSeq = next;
    }
    const messages = Array.from(messagesById.values());
    if (!isCurrent()) return { kind: 'unavailable', reason: unavailableReason() };
    return { kind: 'available', session, messages,
        requests: stateComplete ? stateRequests : requests };
}

/** Fresh, transient details: a foreign Home never borrows the active Home's bare-ID store. */
export async function readPendingNavigationDetails(
    address: SessionAddress,
    expectedScope?: ServerAccountScope,
    options: Readonly<{ signal?: AbortSignal }> = {},
): Promise<PendingNavigationDetailsResult> {
    if (options.signal?.aborted) return { kind: 'unavailable', reason: 'cancelled' };
    const target = normalizeSessionAddress(address.serverId, address.sessionId);
    if (!target || (expectedScope && !areServerProfileIdentifiersEquivalent(expectedScope.serverId, target.serverId))) {
        return { kind: 'unavailable', reason: 'invalid_scope' };
    }
    const lifetime = captureActiveServerAccountScopeCurrentness();
    let credentialCurrent = true;
    const unsubscribe = subscribeHomeCredentialChange(({ serverId }) => {
        if (areServerProfileIdentifiersEquivalent(serverId, target.serverId)) credentialCurrent = false;
    });
    const isCurrent = () => credentialCurrent && lifetime.isCurrent() && !options.signal?.aborted;
    const unavailableReason = () => options.signal?.aborted ? 'cancelled' : 'scope_changed';
    try {
        const details = await runWithServerRequestAuthorityForServerAccountScope({
            ...(expectedScope ? { scope: expectedScope } : { serverId: target.serverId }),
            // Capturing an explicit authority always selects scoped credentials. An
            // unexpected active context must not silently borrow another Home.
            activeRequest: async () => { throw new Error('Pending navigation requires scoped authority'); },
        }, async (authority): Promise<PendingNavigationDetailsResult> => {
            if (!isCurrent()) return { kind: 'unavailable', reason: unavailableReason() };
            const request: ServerAccountRequestAuthority['request'] = (path, init, requestOptions) => authority.request(
                path, { ...init, ...(options.signal ? { signal: options.signal } : {}) }, requestOptions,
            );
            const snapshot = await readSessionSnapshotForAuthority({
                authority: { ...authority, request }, sessionId: target.sessionId, isCurrent,
            });
            if (!isCurrent()) return { kind: 'unavailable', reason: unavailableReason() };
            const session = snapshot.session;
            return readPendingNavigationDetailsForAuthority({ ...authority, request }, session, {
                signal: options.signal, isCurrent,
            });
        });
        // Releasing a leased carrier is asynchronous too; Account retirement
        // during release must not turn a stale read into a navigable result.
        return isCurrent() ? details : { kind: 'unavailable', reason: unavailableReason() };
    } catch (error) {
        return { kind: 'unavailable', reason: !isCurrent() ? unavailableReason()
            : error instanceof SessionSnapshotReadError ? error.errorCode : 'details_unavailable' };
    } finally {
        unsubscribe();
    }
}
