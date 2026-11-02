import { type SessionDataKeyEnvelopeItemV1, type SessionDataKeyEnvelopeSummaryV1 } from '@happier-dev/protocol/sessions/encryption/sessionDataKeyEnvelopes';
import { runSessionDataKeyPreparationDetached } from '@happier-dev/protocol/sessions/encryption/sessionDataKeyPreparationPass';

import { serverAccountScopedResourceKey } from '@/sync/domains/scope/serverAccountScope';
import {
    prepareCurrentSessionDataKeyEnvelopes,
    type CurrentSessionDataKeyEnvelopeTransport,
    type CurrentSessionPreparationOutcome,
    type CurrentSessionPreparationProgress,
} from '@/sync/encryption/prepareCurrentSessionDataKeyEnvelopes';
import { captureEncryptionGenerationCurrentness } from '@/sync/encryption/encryption';
import { readTransferableSessionDataKey } from '@/sync/encryption/readTransferableSessionDataKey';
import { readSessionMetadataLayoutVersion } from '@/sync/engine/sessions/parsePlainSessionPayload';
import { migrateSessionForSharing } from '@/sync/ops/sessions/migrateSessionForSharing';
import {
    runWithServerRequestAuthorityForServerAccountScope,
} from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import {
    SessionSnapshotReadError,
} from '@/sync/runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority';
import { createOperationAccountCurrentnessSource, fetchSessionByIdWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/fetchSessionByIdWithServerScope';
import { isTerminalAuthError } from '@/sync/runtime/connectivity/authErrors';
import {
    runWithServerAccountScopeRequestGuard,
} from '@/sync/runtime/orchestration/serverScopedRpc/serverAccountScopeRequestGuard';

import type { SessionAccessRequestOptions } from './sessionAccessApi';
import { SessionAccessApiError } from './sessionAccessHttpFailure';
import { createEnvelopeTransport, type BoundEnvelopeCollection, type SessionDataKeyEnvelopeCollectionState } from './sessionDataKeyEnvelopeTransport';
import { readServedSessionKeyRow } from './servedSessionKeyRow';
export type { SessionDataKeyEnvelopeCollectionState } from './sessionDataKeyEnvelopeTransport';

/**
 * The exact-Account transport for one Session's recipient data-key envelope
 * collection, and the production host that drives the canonical preparation pass
 * over it.
 *
 * The collection is the internal page an already-authorized manager works
 * through. Manual preparation enters the Session-access Action family once;
 * committed grants continue here without another approval. Pages have no
 * independent Action or per-page approval policy. What this collection
 * does share with the Collaboration surface beside it is the authority contract —
 * one captured Home/Account authority spans the Session snapshot, the local key
 * opening, and every GET/PATCH of the pass, so a page can never be sealed under
 * one Account and committed under another.
 */

export type SessionDataKeyEnvelopeRequestOptions = SessionAccessRequestOptions & Readonly<{
    sessionId: string;
}>;

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
 * The Session key this pass may reseal: opened from the served row and proven to be this
 * Session's by its own shared metadata, never taken from the hydrated key map, which proves
 * nothing about which resource the Home named. Layout 0 proves nothing either, so the first
 * share of a historical Session moves it to layout 1 once through the tuple owner
 * (`session.access.layout.update`) and reads the row again.
 */
async function openBoundSessionDataKey(
    bound: BoundEnvelopeCollection,
    encryption: Parameters<typeof readTransferableSessionDataKey>[0]['encryption'],
    isCurrent: () => boolean,
): Promise<Uint8Array | null> {
    const readRow = () => readServedSessionKeyRow({ authority: bound.authority, sessionId: bound.sessionId, check: () => {} });
    let row = await readRow();
    if (!isCurrent()) return null;
    // Only a Session this device holds an envelope for can be moved; without one there is nothing to share.
    if (row && typeof row.dataEncryptionKey === 'string' && readSessionMetadataLayoutVersion(row.metadataLayoutVersion) === 0) {
        await migrateSessionForSharing({ scope: bound.authority.scope, sessionId: bound.sessionId, isCurrent });
        if (!isCurrent()) return null;
        row = await readRow();
        if (!isCurrent()) return null;
    }
    return await readTransferableSessionDataKey({ session: row, encryption });
}

/**
 * One preparation pass for the current Session, under one captured authority.
 *
 * The admitted Session context supplies the storage mode, and the served row supplies the
 * caller's own envelope with the metadata that proves it is this Session's. Neither is derived
 * from the other — an E2EE Session whose envelope this device cannot open must stay
 * distinguishable from a plain Session that never had one.
 */
export async function prepareSessionDataKeyEnvelopesForScope(
    options: SessionDataKeyEnvelopeRequestOptions & Readonly<{
        reprepareRecipientAccountId?: string;
        onProgress?: ((progress: CurrentSessionPreparationProgress) => void) | undefined;
    }>,
): Promise<CurrentSessionPreparationOutcome> {
    return await runWithEnvelopeCollectionAuthority(options, async bound => {
        const encryption = bound.authority.context.encryption;
        // The context carries the envelope bytes, so bind the Account-encryption generation
        // before asking for it. Capturing after this await could bless a retired envelope under a
        // newer generation of the same Account owner.
        const encryptionCurrentness = captureEncryptionGenerationCurrentness(encryption, {
            serverId: bound.authority.scope.serverId,
        });
        const isCurrent = () => bound.guard.isCurrent() && encryptionCurrentness.isCurrent();
        const credentials = bound.authority.context.credentials;
        if (!credentials) throw new Error('Session request requires credentials');
        const currentness = createOperationAccountCurrentnessSource({ credentials,
            request: bound.authority.request, serverId: bound.authority.scope.serverId });
        let context: Awaited<ReturnType<typeof fetchSessionByIdWithServerScope>>;
        try {
            context = await fetchSessionByIdWithServerScope({
                authority: bound.authority, serverId: bound.authority.scope.serverId, sessionId: bound.sessionId,
                contentDemand: 'encryption-context', activeCredentials: credentials,
                activeEncryption: encryption, activeRequest: bound.authority.request,
                sessionDataKeys: new Map(), sessionDataKeyEnvelopes: new Map(),
                accountCurrentnessSource: currentness, isCurrent, signal: bound.guard.signal,
                applySessions: () => {}, log: { log() {} },
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
            if (isTerminalAuthError(error)) throw new SessionSnapshotReadError('unauthorized');
            throw error;
        } finally {
            currentness.dispose();
        }
        if (!isCurrent() || context.errorCode === 'stale_response') {
            return {
                status: 'scope_changed',
                preparedCount: 0,
                skippedCount: 0,
                summary: null,
                recipientsNeedingSetup: [],
                invalidBindingRecipients: [],
            };
        }
        const keyUnavailable = context.errorCode === 'session_key_unavailable' || context.errorCode === 'session_key_invalid';
        if (!context.ok && !keyUnavailable) throw new SessionSnapshotReadError(context.errorCode ?? 'unavailable', context.httpStatus);
        // These two admitted context outcomes identify E2EE material that cannot
        // be transferred; a legacy Account reader likewise contributes no standalone key.
        const sessionEncryptionMode = keyUnavailable ? 'e2ee' : context.encryptionMode;
        if (sessionEncryptionMode !== 'plain' && sessionEncryptionMode !== 'e2ee') throw new SessionSnapshotReadError('invalid_response');
        const capturedEncryptionScope = sessionEncryptionMode === 'e2ee'
            ? encryptionCurrentness.capturedScope
            : null;
        // A keyless plain Session opens nothing at all. A stale envelope on a Session the Home now
        // reports as plain is not a reason to run recipient cryptography, so this is decided from
        // the mode rather than from whether some bytes happen to be present.
        const sessionDataKey = sessionEncryptionMode === 'plain' || keyUnavailable
            ? null
            : await openBoundSessionDataKey(bound, encryption ?? null, isCurrent);
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
