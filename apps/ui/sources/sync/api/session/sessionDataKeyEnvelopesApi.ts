import {
    PatchSessionDataKeyEnvelopesResultV1Schema,
    SessionDataKeyEnvelopeErrorCodeV1Schema,
    SessionDataKeyEnvelopePageV1Schema,
    type SessionDataKeyEnvelopeItemV1,
    type SessionDataKeyEnvelopeSummaryV1,
    runSessionDataKeyPreparationDetached,
} from '@happier-dev/protocol';

import { serverAccountScopedResourceKey } from '@/sync/domains/scope/serverAccountScope';
import {
    prepareCurrentSessionDataKeyEnvelopes,
    type CurrentSessionDataKeyEnvelopeTransport,
    type CurrentSessionPreparationOutcome,
    type CurrentSessionPreparationProgress,
} from '@/sync/encryption/prepareCurrentSessionDataKeyEnvelopes';
import { readTransferableSessionDataKey } from '@/sync/encryption/readTransferableSessionDataKey';
import { captureEncryptionGenerationCurrentness } from '@/sync/encryption/encryption';
import {
    runWithServerRequestAuthorityForServerAccountScope,
    type ServerAccountRequestAuthority,
} from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import {
    readSessionSnapshotForAuthority,
    SessionSnapshotReadError,
} from '@/sync/runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority';
import {
    runWithServerAccountScopeRequestGuard,
    type ServerAccountScopeRequestGuard,
} from '@/sync/runtime/orchestration/serverScopedRpc/serverAccountScopeRequestGuard';

import { SessionAccessApiError, type SessionAccessRequestOptions } from './sessionAccessApi';

/**
 * The exact-Account transport for one Session's recipient data-key envelope
 * collection, and the production host that drives the canonical preparation pass
 * over it.
 *
 * The collection is domain-native rather than an Action: it is the internal page
 * an already-authorized manager works through, not a user-invocable operation,
 * so it carries no Action catalog entry and no per-page approval policy. What it
 * does share with the Collaboration surface beside it is the authority contract —
 * one captured Home/Account authority spans the Session snapshot, the local key
 * opening, and every GET/PATCH of the pass, so a page can never be sealed under
 * one Account and committed under another.
 */

export type SessionDataKeyEnvelopeRequestOptions = SessionAccessRequestOptions & Readonly<{
    sessionId: string;
}>;

/**
 * Which slice of the authorized audience a caller wants.
 *
 * `action_required` is the default everywhere: discovery, refresh and preparation
 * only ever need the exceptions. `all` is the explicit `Show all recipients`
 * diagnostic — the same resource and the same summary, with healthy rows included
 * — and is never fetched merely to render the aggregate.
 */
export type SessionDataKeyEnvelopeCollectionState = 'action_required' | 'all';

function envelopeCollectionPath(sessionId: string): string {
    return `/v2/sessions/${encodeURIComponent(sessionId)}/data-key/envelopes`;
}

/**
 * Only the working page is requested. `limit` is deliberately omitted so the one
 * Protocol owner of the page bound stays the server-side default rather than a
 * second copy of that measurement here.
 */
function envelopePageQuery(cursor: string | null, state: SessionDataKeyEnvelopeCollectionState = 'action_required'): string {
    const query = new URLSearchParams({ state });
    if (cursor) query.set('cursor', cursor);
    return `?${query.toString()}`;
}

type BoundEnvelopeCollection = Readonly<{
    authority: ServerAccountRequestAuthority;
    guard: ServerAccountScopeRequestGuard;
    sessionId: string;
}>;

async function requestEnvelopeCollection(
    bound: BoundEnvelopeCollection,
    params: Readonly<{ path: string; init?: RequestInit }>,
): Promise<unknown> {
    bound.guard.check();
    const response = await bound.authority.request(params.path, {
        ...params.init,
        signal: bound.guard.signal,
    });
    bound.guard.check();
    const payload: unknown = await response.json();
    bound.guard.check();
    if (!response.ok) {
        const record = typeof payload === 'object' && payload !== null
            ? payload as Record<string, unknown>
            : {};
        const code = SessionDataKeyEnvelopeErrorCodeV1Schema.safeParse(record.error);
        throw new SessionAccessApiError(
            code.success ? code.data : 'session_data_key_envelope_request_failed',
            response.status,
        );
    }
    return payload;
}

function createEnvelopeTransport(bound: BoundEnvelopeCollection, state: SessionDataKeyEnvelopeCollectionState = 'action_required'): CurrentSessionDataKeyEnvelopeTransport {
    const path = envelopeCollectionPath(bound.sessionId);
    return {
        fetchPage: async (cursor) => SessionDataKeyEnvelopePageV1Schema.parse(
            await requestEnvelopeCollection(bound, { path: `${path}${envelopePageQuery(cursor, state)}` }),
        ),
        patchPage: async (request) => PatchSessionDataKeyEnvelopesResultV1Schema.parse(
            await requestEnvelopeCollection(bound, {
                path,
                init: {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(request),
                },
            }),
        ),
    };
}

async function runWithEnvelopeCollectionAuthority<TResult>(
    options: SessionDataKeyEnvelopeRequestOptions,
    operation: (bound: BoundEnvelopeCollection) => Promise<TResult>,
): Promise<TResult> {
    // A Home that does not share Sessions has no v2 envelope collection.
    // Failing the operation is the whole contract: probing for the resource
    // would invent a capability the Home's own decision withholds.
    if (options.availability !== 'available') {
        throw new SessionAccessApiError('session_access_sharing_unavailable');
    }
    return await runWithServerAccountScopeRequestGuard({
        scope: options.scope,
        isCurrent: options.isCurrent,
        signal: options.signal,
        staleError: () => new SessionAccessApiError('scope_changed'),
    }, async guard => {
        guard.check();
        return await runWithServerRequestAuthorityForServerAccountScope({
            scope: options.scope,
            activeRequest: async () => { throw new SessionAccessApiError('scope_changed'); },
        }, async authority => await operation({ authority, guard, sessionId: options.sessionId }));
    });
}

/**
 * The collection alone: the one transport for default discovery, the explicit
 * `state=all` diagnostic, and the preparation pass. Each call captures and
 * releases its own exact authority.
 */
export function createSessionDataKeyEnvelopeClient(
    options: SessionDataKeyEnvelopeRequestOptions & Readonly<{
        state?: SessionDataKeyEnvelopeCollectionState;
    }>,
): CurrentSessionDataKeyEnvelopeTransport {
    return {
        fetchPage: async (cursor) => await runWithEnvelopeCollectionAuthority(
            options,
            async bound => await createEnvelopeTransport(bound, options.state).fetchPage(cursor),
        ),
        patchPage: async (request) => await runWithEnvelopeCollectionAuthority(
            options,
            async bound => await createEnvelopeTransport(bound).patchPage(request),
        ),
    };
}

/**
 * One page of the Home-owned Session audience, read without opening or sealing
 * any key.
 *
 * Both the mounted editor's default discovery and its `Show all recipients`
 * expansion come through here, so the aggregate the manager reads and the
 * worklist the pass walks can never disagree about what the Home said.
 */
export type SessionDataKeyEnvelopeCollectionPage =
    | Readonly<{
        status: 'not_required';
        summary: null;
        items: readonly [];
        nextCursor: null;
    }>
    | Readonly<{
        status: 'required';
        /** Continuation pages omit the aggregate; a cursorless page must provide it. */
        summary: SessionDataKeyEnvelopeSummaryV1 | null;
        items: readonly SessionDataKeyEnvelopeItemV1[];
        nextCursor: string | null;
    }>;

const NOT_REQUIRED_PAGE: SessionDataKeyEnvelopeCollectionPage = Object.freeze({
    status: 'not_required', summary: null, items: [] as const, nextCursor: null,
});

export async function readSessionDataKeyEnvelopeCollectionPage(
    options: SessionDataKeyEnvelopeRequestOptions & Readonly<{
        state?: SessionDataKeyEnvelopeCollectionState;
        cursor?: string | null;
    }>,
): Promise<SessionDataKeyEnvelopeCollectionPage> {
    try {
        const cursor = options.cursor ?? null;
        const page = await createSessionDataKeyEnvelopeClient(options).fetchPage(cursor);
        if (page.status === 'not_required') return NOT_REQUIRED_PAGE;
        if (cursor === null && page.summary === null) {
            throw new Error('Cursorless Session data-key discovery omitted its summary');
        }
        return { status: 'required', summary: page.summary, items: page.items, nextCursor: page.nextCursor };
    } catch (error) {
        // A Home that rejects the whole collection as not required is saying the same
        // thing the plain page says: there is nothing here to prepare.
        if (error instanceof SessionAccessApiError && error.code === 'data_key_not_required') {
            return NOT_REQUIRED_PAGE;
        }
        throw error;
    }
}

/**
 * One preparation pass for the current Session, under one captured authority.
 *
 * The Session snapshot supplies both facts this client cannot infer: the storage
 * mode, and the caller's own envelope. Neither is derived from the other — an
 * E2EE Session whose envelope this device cannot open must stay distinguishable
 * from a plain Session that never had one.
 */
export async function prepareSessionDataKeyEnvelopesForScope(
    options: SessionDataKeyEnvelopeRequestOptions & Readonly<{
        reprepareRecipientAccountId?: string;
        onProgress?: ((progress: CurrentSessionPreparationProgress) => void) | undefined;
    }>,
): Promise<CurrentSessionPreparationOutcome> {
    return await runWithEnvelopeCollectionAuthority(options, async bound => {
        const encryption = bound.authority.context.encryption;
        // The snapshot carries the envelope bytes, so bind the Account-encryption generation
        // before asking for it. Capturing after this await could bless a retired envelope under a
        // newer generation of the same Account owner.
        const encryptionCurrentness = captureEncryptionGenerationCurrentness(encryption, {
            serverId: bound.authority.scope.serverId,
        });
        const isCurrent = () => bound.guard.isCurrent() && encryptionCurrentness.isCurrent();
        let snapshot: Awaited<ReturnType<typeof readSessionSnapshotForAuthority>>;
        try {
            snapshot = await readSessionSnapshotForAuthority({
                authority: bound.authority,
                sessionId: bound.sessionId,
                isCurrent,
            });
        } catch (error) {
            if (error instanceof SessionSnapshotReadError && error.errorCode === 'stale_response') {
                return {
                    status: 'scope_changed',
                    preparedCount: 0,
                    skippedCount: 0,
                    summary: null,
                    recipientsNeedingSetup: [],
                    invalidBindingRecipients: [],
                };
            }
            throw error;
        }
        if (!isCurrent()) {
            return {
                status: 'scope_changed',
                preparedCount: 0,
                skippedCount: 0,
                summary: null,
                recipientsNeedingSetup: [],
                invalidBindingRecipients: [],
            };
        }
        const sessionEncryptionMode = snapshot.session.encryptionMode ?? 'e2ee';
        const capturedEncryptionScope = sessionEncryptionMode === 'e2ee'
            ? encryptionCurrentness.capturedScope
            : null;
        // A keyless plain Session opens nothing at all. A stale envelope on a Session the Home now
        // reports as plain is not a reason to run recipient cryptography, so this is decided from
        // the mode rather than from whether some bytes happen to be present.
        const sessionDataKey = sessionEncryptionMode === 'plain'
            ? null
            : await readTransferableSessionDataKey({
                callerDataKeyEnvelope: snapshot.callerDataKeyEnvelope,
                encryption,
            });
        if (!isCurrent()) {
            return {
                status: 'scope_changed',
                preparedCount: 0,
                skippedCount: 0,
                summary: null,
                recipientsNeedingSetup: [],
                invalidBindingRecipients: [],
            };
        }
        return await prepareCurrentSessionDataKeyEnvelopes({
            sessionEncryptionMode,
            scope: {
                session: { serverId: bound.authority.scope.serverId, sessionId: bound.sessionId },
            },
            transport: createEnvelopeTransport(bound, options.reprepareRecipientAccountId === undefined ? 'action_required' : 'all'),
            ...(options.reprepareRecipientAccountId === undefined ? {} : { reprepareRecipientAccountId: options.reprepareRecipientAccountId }),
            sessionDataKey,
            isHostScopeCurrent: bound.guard.isCurrent,
            // The same Account encryption owner that opened the key above decides whether that key
            // is still current when the page is committed.
            ...(encryption ? {
                encryption,
                ...(capturedEncryptionScope ? { capturedEncryptionScope } : {}),
            } : {}),
            ...(options.onProgress ? { onProgress: options.onProgress } : {}),
        });
    });
}


/**
 * Reuse one exact-scope pass and deliberately detach it from a mounted editor.
 * The underlying authority guard still stops credential/Home changes; closing a
 * popover merely stops that view from observing progress and never cancels work.
 */
export function prepareSessionDataKeyEnvelopesDetached(
    options: Omit<SessionDataKeyEnvelopeRequestOptions, 'isCurrent' | 'signal'> & Readonly<{
        reprepareRecipientAccountId?: string;
        onProgress?: ((progress: CurrentSessionPreparationProgress) => void) | undefined;
    }>,
): Promise<CurrentSessionPreparationOutcome> {
    const key = serverAccountScopedResourceKey(options.scope, 'session-envelope-preparation',
        JSON.stringify([options.sessionId, options.reprepareRecipientAccountId ?? null]));
    return runSessionDataKeyPreparationDetached(key, async () => await prepareSessionDataKeyEnvelopesForScope({
        scope: options.scope,
        sessionId: options.sessionId,
        availability: options.availability,
        ...(options.reprepareRecipientAccountId === undefined ? {} : { reprepareRecipientAccountId: options.reprepareRecipientAccountId }),
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    }));
}
