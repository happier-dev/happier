import { storage } from '@/sync/domains/state/storage';
import {
    assertSafePendingIdPathSegment,
    findPendingOutboxMessage,
    loadPendingOutboxForSession,
    markPendingOutboxMessageCancelRequested,
    removePendingOutboxMessage,
    savePendingOutboxMessage,
    type PersistedPendingOutboxMessage,
} from '@/sync/domains/state/pendingOutboxPersistence';
import {
    areServerAccountScopesEqual,
    serverAccountScopeKeySuffix,
    type ServerAccountScope,
} from '@/sync/domains/scope/serverAccountScope';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { nowServerMs } from '@/sync/runtime/time';
import { RawRecordSchema, type RawRecord } from '@/sync/typesRaw';
import { randomUUID } from '@/platform/randomUUID';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import type {
    DiscardedPendingMessage,
    PendingDeliveryStatus,
    PendingMessage,
} from '@/sync/domains/state/storageTypes';
import { resolveAgentIdFromFlavor } from '@/agents/catalog/catalog';
import {
    collectCommittedTranscriptLocalIds,
    resolveCommittedTranscriptSeqHighWaterMark,
} from '@/sync/domains/pending/pendingTranscriptProjection';
import { settleReceivedSessionMessages } from '@/sync/engine/sessions/sessionMessageMaterializationBarrier';
import { buildOutgoingUserTextRecord } from '@/sync/domains/messages/outgoingUserMessage';
import { resolveSentFrom } from '@/sync/domains/messages/sentFrom';
import { throwAuthenticationResponseErrorIfNeeded } from '@/sync/runtime/connectivity/authErrors';
import { isTransientConnectivityError } from '@/sync/runtime/connectivity/transientConnectivityErrors';
import {
    normalizePendingDeliveryBlockedReason,
    parsePendingDeliveryStatusV1,
    shouldExposePendingDeliveryInDiscardedHistoryV1,
    PendingRequestedActionV1Schema,
    readPendingLocalId,
    SessionStoredMessageContentSchema,
    type PendingDeliveryBlockedReason,
    type PendingDeliveryStatusV1 as ProtocolPendingDeliveryStatusV1,
    type PendingRequestedActionV1,
    type SessionStoredMessageContent,
} from '@happier-dev/protocol';
import { t } from '@/text';
import {
    isPendingOutboxProjectionForIdentity,
    isPendingOutboxProjectionInScope,
    isPendingOutboxQuarantineProjectionForIdentity,
    pendingOutboxProjectionIdentityKey,
    type PendingOutboxProjectionIdentity,
} from './pendingOutboxProjectionIdentity';
import type { PendingInputServerWireMode } from './pendingInputServerWireContract';

function assertServerRequestedActionAcknowledged(payload: unknown, requestedAction: PendingRequestedActionV1): void {
    const acknowledged = isPlainObject(payload)
        ? PendingRequestedActionV1Schema.safeParse(payload.requestedAction)
        : null;
    if (!acknowledged?.success || acknowledged.data.kind !== requestedAction.kind) {
        throw new Error('Server did not acknowledge the persisted Pending requested action');
    }
}

type PendingStatus = 'queued' | 'delivering' | 'external_handoff' | 'blocked' | 'discarded' | 'unknown';

export type PendingMessageEnqueueResultV2 = Readonly<{
    localId: string;
    accepted: boolean;
    cancelled?: true;
    settled?: true;
    terminal?: true;
    externalHandoffClaimed?: true;
    waitingForWireMode?: true;
}>;

type PendingRow = {
    localId: string;
    messageRole: 'user' | 'non_user' | null;
    content: SessionStoredMessageContent | null;
    requestedAction?: PendingRequestedActionV1;
    requestedActionMalformed?: true;
    status: PendingStatus;
    statusRaw: string;
    deliveryStateRaw: string | null;
    deliveryStatus: ProtocolPendingDeliveryStatusV1 | null;
    position: number;
    createdAt: number;
    updatedAt: number;
    discardedAt: number | null;
    discardedReason: string | null;
    deliveryBlockedReason: string | null;
    authorAccountId: string | null;
};

type PendingDecryptFailure = Readonly<{
    kind: 'decrypt_failed';
}>;

export type PendingQueueEncryption = Readonly<{
    getSessionEncryption: (sessionId: string) => Readonly<{
        encryptRawRecord: (record: RawRecord) => Promise<string>;
    }> | null | undefined | Promise<Readonly<{
        encryptRawRecord: (record: RawRecord) => Promise<string>;
    }> | null | undefined>;
}>;

export type PendingQueueReadEncryption = Readonly<{
    getSessionEncryption: (sessionId: string) => Readonly<{
        decryptRaw: (payload: string) => Promise<unknown>;
    }> | null | undefined;
}>;

function assertPendingResponseOk(response: Response, message: string): void {
    if (response.ok) return;
    throwAuthenticationResponseErrorIfNeeded(response.status);
    throw new Error(`${message} (${response.status})`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
    const actual = Object.keys(value).sort();
    const expected = [...expectedKeys].sort();
    return actual.length === expected.length
        && actual.every((key, index) => key === expected[index]);
}

function isSafeNonNegativeInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function createPendingServerUpgradeRequiredError(): Error & { code: 'server-upgrade-required' } {
    return Object.assign(
        new Error('This Pending action requires a newer server'),
        { code: 'server-upgrade-required' as const },
    );
}

function serializePendingEnqueueBodyForWire(params: Readonly<{
    canonicalBody: string;
    wireMode: Exclude<PendingInputServerWireMode, 'indeterminate'>;
    requestedAction: PendingRequestedActionV1;
    deliveryMode?: 'external_handoff';
}>): string {
    if (params.wireMode === 'pending_input_v1') return params.canonicalBody;
    if (params.requestedAction.kind !== 'enqueue' || params.deliveryMode !== undefined) {
        throw createPendingServerUpgradeRequiredError();
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(params.canonicalBody) as unknown;
    } catch {
        throw new Error('Persisted pending outbox envelope is invalid');
    }
    if (!isPlainObject(parsed) || readPendingLocalId(parsed.localId) === null) {
        throw new Error('Persisted pending outbox envelope is invalid');
    }
    const content = SessionStoredMessageContentSchema.safeParse(parsed.content);
    const ciphertext = typeof parsed.ciphertext === 'string' && parsed.ciphertext.length > 0
        ? parsed.ciphertext
        : null;
    if (content.success === Boolean(ciphertext)) {
        throw new Error('Persisted pending outbox envelope must contain exactly one content carrier');
    }
    return JSON.stringify(content.success
        ? { localId: parsed.localId, content: content.data }
        : { localId: parsed.localId, ciphertext: ciphertext! });
}

function assertPendingEnqueueAcknowledgedForWire(params: Readonly<{
    payload: unknown;
    wireMode: Exclude<PendingInputServerWireMode, 'indeterminate'>;
    localId: string;
    requestedAction: PendingRequestedActionV1;
}>): void {
    if (params.wireMode === 'pending_input_v1') {
        assertServerRequestedActionAcknowledged(params.payload, params.requestedAction);
        const payload = isPlainObject(params.payload) ? params.payload : null;
        if (payload?.terminal === true) {
            const message = isPlainObject(payload.message) ? payload.message : null;
            if (
                !message
                || typeof message.id !== 'string'
                || message.id.trim().length === 0
                || !isSafeNonNegativeInteger(message.seq)
                || readPendingLocalId(message.localId) !== params.localId
            ) {
                throw new Error('Server did not prove the exact committed Pending message');
            }
        } else {
            const pending = payload && isPlainObject(payload.pending) ? payload.pending : null;
            if (!pending || readPendingLocalId(pending.localId) !== params.localId) {
                throw new Error('Server did not prove the exact persisted Pending row');
            }
        }
        return;
    }

    if (!isPlainObject(params.payload) || !hasExactKeys(params.payload, [
        'didWrite',
        'pending',
        'pendingCount',
        'pendingVersion',
    ])) {
        throw new Error('Released server returned an invalid Pending enqueue acknowledgement');
    }
    if (
        typeof params.payload.didWrite !== 'boolean'
        || !isSafeNonNegativeInteger(params.payload.pendingCount)
        || !isSafeNonNegativeInteger(params.payload.pendingVersion)
        || !isPlainObject(params.payload.pending)
    ) {
        throw new Error('Released server returned an invalid Pending enqueue acknowledgement');
    }
    const pending = params.payload.pending;
    if (!hasExactKeys(pending, [
        'localId',
        'content',
        'status',
        'position',
        'createdAt',
        'updatedAt',
        'discardedAt',
        'discardedReason',
        'authorAccountId',
    ])) {
        throw new Error('Released server returned an invalid Pending enqueue acknowledgement');
    }
    const parsedContent = SessionStoredMessageContentSchema.safeParse(pending.content);
    const validDiscardedAt = pending.discardedAt === null || isSafeNonNegativeInteger(pending.discardedAt);
    const validDiscardedReason = pending.discardedReason === null || typeof pending.discardedReason === 'string';
    if (
        pending.localId !== params.localId
        || !parsedContent.success
        || (pending.status !== 'queued' && pending.status !== 'discarded')
        || !isSafeNonNegativeInteger(pending.position)
        || !isSafeNonNegativeInteger(pending.createdAt)
        || !isSafeNonNegativeInteger(pending.updatedAt)
        || !validDiscardedAt
        || !validDiscardedReason
        || typeof pending.authorAccountId !== 'string'
        || pending.authorAccountId.trim().length === 0
    ) {
        throw new Error('Released server returned an invalid Pending enqueue acknowledgement');
    }
}

function assertPendingEnqueueAcknowledgedAndRefreshOnMismatch(params: Readonly<{
    payload: unknown;
    wireMode: Exclude<PendingInputServerWireMode, 'indeterminate'>;
    localId: string;
    requestedAction: PendingRequestedActionV1;
    onWireContractMismatch?: () => void | Promise<void>;
}>): void {
    try {
        assertPendingEnqueueAcknowledgedForWire(params);
    } catch (error) {
        try {
            void Promise.resolve(params.onWireContractMismatch?.()).catch(() => {});
        } catch {
            // A refresh failure cannot replace the original response-contract failure.
        }
        throw error;
    }
}

function readPendingEnqueueDeliveryMode(body: string): 'external_handoff' | undefined {
    try {
        const parsed = JSON.parse(body) as unknown;
        return isPlainObject(parsed) && parsed.deliveryMode === 'external_handoff'
            ? 'external_handoff'
            : undefined;
    } catch {
        return undefined;
    }
}

function readPendingEnqueueRequestedAction(body: string): PendingRequestedActionV1 | null {
    try {
        const parsed = JSON.parse(body) as unknown;
        if (!isPlainObject(parsed)) return null;
        if (!("requestedAction" in parsed)) return { v: 1, kind: 'enqueue' };
        const action = PendingRequestedActionV1Schema.safeParse(parsed.requestedAction);
        return action.success ? action.data : null;
    } catch {
        return null;
    }
}

function readPendingEnqueueFrozenEnvelope(body: string): Readonly<{
    content: SessionStoredMessageContent;
    requestedAction: PendingRequestedActionV1;
    deliveryMode?: 'external_handoff';
}> | null {
    try {
        const parsed = JSON.parse(body) as unknown;
        if (!isPlainObject(parsed) || parsed.messageRole !== 'user') return null;
        const requestedAction = readPendingEnqueueRequestedAction(body);
        if (!requestedAction) return null;
        const parsedContent = SessionStoredMessageContentSchema.safeParse(parsed.content);
        const ciphertext = typeof parsed.ciphertext === 'string' && parsed.ciphertext.length > 0
            ? parsed.ciphertext
            : null;
        if (parsedContent.success === Boolean(ciphertext)) return null;
        return {
            content: parsedContent.success ? parsedContent.data : { t: 'encrypted', c: ciphertext! },
            requestedAction,
            ...(readPendingEnqueueDeliveryMode(body) === 'external_handoff'
                ? { deliveryMode: 'external_handoff' as const }
                : {}),
        };
    } catch {
        return null;
    }
}

function mapTypedPendingStatusToUiStatus(status: ProtocolPendingDeliveryStatusV1): PendingStatus {
    if (status.status === 'queued' || status.status === 'delivering' || status.status === 'external_handoff' || status.status === 'blocked' || status.status === 'discarded') {
        return status.status;
    }
    return 'unknown';
}

function parsePendingRows(raw: unknown): PendingRow[] | null {
    if (!isPlainObject(raw)) return null;
    const pending = raw.pending;
    if (!Array.isArray(pending)) return null;

    const out: PendingRow[] = [];
    for (const item of pending) {
        if (!isPlainObject(item)) continue;
        const localId = item.localId;
        const messageRole = item.messageRole;
        const content = item.content;
        const parsedRequestedAction = item.requestedAction == null
            ? PendingRequestedActionV1Schema.safeParse({ v: 1, kind: 'enqueue' })
            : PendingRequestedActionV1Schema.safeParse(item.requestedAction);
        const requestedActionMalformed = item.requestedActionMalformed === true || !parsedRequestedAction.success;
        const status = item.status;
        const deliveryState = item.deliveryState;
        const typedDeliveryStatus = parsePendingDeliveryStatusV1(item.deliveryStatus);
        const position = item.position;
        const createdAt = item.createdAt;
        const updatedAt = item.updatedAt;
        const discardedAt = item.discardedAt;
        const discardedReason = item.discardedReason;
        const deliveryBlockedReason = item.deliveryBlockedReason;
        const authorAccountId = item.authorAccountId;

        const parsedLocalId = readPendingLocalId(localId);
        if (parsedLocalId === null) continue;
        const contentParsed = SessionStoredMessageContentSchema.safeParse(content);
        const statusRaw = typeof status === 'string' && status.length > 0 ? status : 'unknown';
        const legacyStatus: PendingStatus =
            statusRaw === 'queued' || statusRaw === 'delivering' || statusRaw === 'blocked' || statusRaw === 'discarded'
                ? statusRaw
                : 'unknown';
        const deliveryStateRaw = typeof deliveryState === 'string' && deliveryState.length > 0
            ? deliveryState
            : null;
        const parsedStatus: PendingStatus = legacyStatus !== 'discarded' && deliveryStateRaw
            ? (
                deliveryStateRaw === 'queued' || deliveryStateRaw === 'delivering' || deliveryStateRaw === 'external_handoff' || deliveryStateRaw === 'blocked'
                    ? deliveryStateRaw
                    : 'unknown'
            )
            : legacyStatus;
        const effectiveStatus = requestedActionMalformed && legacyStatus !== 'discarded'
            ? 'blocked'
            : typedDeliveryStatus
            ? mapTypedPendingStatusToUiStatus(typedDeliveryStatus)
            : parsedStatus;
        const effectiveStatusRaw = requestedActionMalformed && legacyStatus !== 'discarded'
            ? 'blocked'
            : typedDeliveryStatus
            ? typedDeliveryStatus.status
            : legacyStatus !== 'discarded' && deliveryStateRaw ? deliveryStateRaw : statusRaw;
        const parsedCreatedAt = typeof createdAt === 'number' && Number.isFinite(createdAt) ? createdAt : 0;

        out.push({
            localId: parsedLocalId,
            messageRole: messageRole === 'user' ? 'user' : messageRole == null ? null : 'non_user',
            content: contentParsed.success ? contentParsed.data : null,
            ...(parsedRequestedAction.success && !requestedActionMalformed
                ? { requestedAction: parsedRequestedAction.data }
                : {}),
            ...(requestedActionMalformed ? { requestedActionMalformed: true as const } : {}),
            status: effectiveStatus,
            statusRaw: effectiveStatusRaw,
            deliveryStateRaw,
            deliveryStatus: requestedActionMalformed && legacyStatus !== 'discarded'
                ? { status: 'blocked', reason: 'unsupported_action' }
                : typedDeliveryStatus,
            position: typeof position === 'number' && Number.isFinite(position) ? position : Number.MAX_SAFE_INTEGER,
            createdAt: parsedCreatedAt,
            updatedAt: typeof updatedAt === 'number' && Number.isFinite(updatedAt) ? updatedAt : parsedCreatedAt,
            discardedAt: typeof discardedAt === 'number' && Number.isFinite(discardedAt) ? discardedAt : null,
            discardedReason: typeof discardedReason === 'string' && discardedReason.length > 0 ? discardedReason : null,
            deliveryBlockedReason: requestedActionMalformed && legacyStatus !== 'discarded'
                ? 'unsupported_action'
                : typedDeliveryStatus?.status === 'blocked'
                ? typedDeliveryStatus.reason
                : typeof deliveryBlockedReason === 'string' && deliveryBlockedReason.length > 0
                    ? deliveryBlockedReason
                    : null,
            authorAccountId: typeof authorAccountId === 'string' && authorAccountId.length > 0 ? authorAccountId : null,
        });
    }
    return out;
}

/**
 * Update the local send-acknowledgment state of an optimistic (`local_outbound`) pending row.
 * `unconfirmed` = the write is being retried after a stall/transient failure; `failed` = automatic
 * retries gave up; `undefined` = confirmed/normal. This is the single owner of the visible outbox
 * marker so the derived visual state (`send_unconfirmed`/`send_failed`) stays consistent. No-op if
 * the row is gone or already accepted.
 */
export function setPendingMessageSendState(
    sessionId: string,
    localId: string,
    sendState: 'unconfirmed' | 'failed' | undefined,
    outboxScope: ServerAccountScope,
): void {
    if (sendState !== undefined) {
        const durable = findPendingOutboxMessage(sessionId, localId, outboxScope);
        if (!durable || durable.operation === 'quarantined') return;
    }
    const identity = { sessionId, localId, outboxScope } satisfies PendingOutboxProjectionIdentity;
    const existing = storage.getState().sessionPending[sessionId]?.messages?.find((message) =>
        isPendingOutboxProjectionForIdentity(message, identity)
    );
    if (!existing) return;
    if (existing.deliveryStatus === 'accepted' && sendState !== undefined) return;
    if (existing.sendState === sendState) return;
    storage.getState().upsertPendingMessage(sessionId, { ...existing, sendState });
}

function findPendingOutboxProjection(
    sessionId: string,
    localId: string,
    outboxScope: ServerAccountScope,
): PendingMessage | null {
    const identity = { sessionId, localId, outboxScope } satisfies PendingOutboxProjectionIdentity;
    return storage.getState().sessionPending[sessionId]?.messages?.find((message) =>
        isPendingOutboxProjectionForIdentity(message, identity)
    ) ?? null;
}

function findPendingOutboxQuarantineProjection(
    sessionId: string,
    localId: string,
    outboxScope: ServerAccountScope,
): PendingMessage | null {
    const identity = { sessionId, localId, outboxScope } satisfies PendingOutboxProjectionIdentity;
    return storage.getState().sessionPending[sessionId]?.messages?.find((message) =>
        isPendingOutboxQuarantineProjectionForIdentity(message, identity)
    ) ?? null;
}

function findCanonicalServerPendingProjection(
    sessionId: string,
    localId: string,
    outboxScope: ServerAccountScope,
): PendingMessage | null {
    return storage.getState().sessionPending[sessionId]?.messages?.find((message) =>
        message.source === 'server_pending'
        && (message.localId ?? message.id) === localId
        && (!message.pendingOutboxScope || areServerAccountScopesEqual(message.pendingOutboxScope, outboxScope))
    ) ?? null;
}

function findPendingProjectionForServerMutation(
    sessionId: string,
    pendingId: string,
    outboxScope: ServerAccountScope,
): PendingMessage | null {
    const messages = storage.getState().sessionPending[sessionId]?.messages ?? [];
    const isEligible = (message: PendingMessage): boolean =>
        message.pendingOutboxQuarantineReason === undefined
        && (!message.pendingOutboxScope || areServerAccountScopesEqual(message.pendingOutboxScope, outboxScope));
    const exactScopedProjection = messages.find((message) =>
        message.id === pendingId
        && message.pendingOutboxScope !== undefined
        && areServerAccountScopesEqual(message.pendingOutboxScope, outboxScope)
        && message.pendingOutboxQuarantineReason === undefined
    );
    if (exactScopedProjection) return exactScopedProjection;
    const exactScopedIdentity = messages.find((message) =>
        (message.localId ?? message.id) === pendingId
        && message.pendingOutboxScope !== undefined
        && areServerAccountScopesEqual(message.pendingOutboxScope, outboxScope)
        && message.pendingOutboxQuarantineReason === undefined
    );
    if (exactScopedIdentity) return exactScopedIdentity;
    const canonicalServerProjection = messages.find((message) =>
        message.source === 'server_pending'
        && message.localId === pendingId
        && isEligible(message)
    );
    if (canonicalServerProjection) return canonicalServerProjection;
    const exactId = messages.find((message) => message.id === pendingId && isEligible(message));
    if (exactId) return exactId;
    const identity = { sessionId, localId: pendingId, outboxScope } satisfies PendingOutboxProjectionIdentity;
    return messages.find((message) => isPendingOutboxProjectionForIdentity(message, identity)) ?? null;
}

function resolvePendingServerMutationTarget(
    sessionId: string,
    callerPendingId: string,
    outboxScope: ServerAccountScope,
): Readonly<{ projection: PendingMessage | null; localId: string }> {
    const projection = findPendingProjectionForServerMutation(sessionId, callerPendingId, outboxScope);
    return {
        projection,
        localId: projection?.localId ?? projection?.id ?? callerPendingId,
    };
}

function findCurrentPendingServerMutationProjection(
    sessionId: string,
    mutationTarget: Readonly<{ projection: PendingMessage | null; localId: string }>,
    outboxScope: ServerAccountScope,
): PendingMessage | null {
    if (!mutationTarget.projection) return null;
    return storage.getState().sessionPending[sessionId]?.messages?.find((message) =>
        message.id === mutationTarget.projection!.id
        && (message.localId ?? message.id) === mutationTarget.localId
        && message.pendingOutboxQuarantineReason === undefined
        && (!message.pendingOutboxScope || areServerAccountScopesEqual(message.pendingOutboxScope, outboxScope))
    ) ?? null;
}

function removePendingOutboxProjectionIfOwned(
    sessionId: string,
    localId: string,
    outboxScope: ServerAccountScope,
): void {
    const existing = findPendingOutboxProjection(sessionId, localId, outboxScope);
    if (existing) storage.getState().removePendingMessage(sessionId, existing.id);
}

function removeSettledPendingOutboxLocalProjectionIfOwned(
    sessionId: string,
    localId: string,
    outboxScope: ServerAccountScope,
): void {
    const identity = { sessionId, localId, outboxScope } satisfies PendingOutboxProjectionIdentity;
    const existing = storage.getState().sessionPending[sessionId]?.messages?.find((message) =>
        message.source === 'local_outbound'
        && isPendingOutboxProjectionForIdentity(message, identity)
    );
    if (existing) storage.getState().removePendingMessage(sessionId, existing.id);
}

function markPendingProjectionAcknowledgedIfOwned(
    sessionId: string,
    localId: string,
    outboxScope: ServerAccountScope,
): void {
    const identity = { sessionId, localId, outboxScope } satisfies PendingOutboxProjectionIdentity;
    const currentProjection = findPendingProjectionForServerMutation(sessionId, localId, outboxScope);
    if (currentProjection?.source !== 'local_outbound'
        || currentProjection.pendingOutboxOperation === 'cancel'
        || !isPendingOutboxProjectionForIdentity(currentProjection, identity)) return;
    storage.getState().upsertPendingMessage(sessionId, {
        ...currentProjection,
        deliveryStatus: 'accepted',
        pendingOutboxOperation: undefined,
        sendState: undefined,
    });
}

function removeProjectionsAfterConfirmedCancellation(
    sessionId: string,
    localId: string,
    outboxScope: ServerAccountScope,
): void {
    const identity = { sessionId, localId, outboxScope } satisfies PendingOutboxProjectionIdentity;
    for (const message of storage.getState().sessionPending[sessionId]?.messages ?? []) {
        if (message.id !== localId && message.localId !== localId) continue;
        if (message.pendingDeliveryStatus === 'external_handoff') continue;
        const scopedCanonicalServerProjection = message.source === 'server_pending'
            && (!message.pendingOutboxScope || areServerAccountScopesEqual(message.pendingOutboxScope, outboxScope));
        if (scopedCanonicalServerProjection || isPendingOutboxProjectionForIdentity(message, identity)) {
            storage.getState().removePendingMessage(sessionId, message.id);
        }
    }
}

function markPendingOutboxProjectionAcceptedIfOwned(
    sessionId: string,
    localId: string,
    outboxScope: ServerAccountScope,
    rawRecord: RawRecord,
    pendingDeliveryStatus?: PendingDeliveryStatus,
): boolean {
    const existing = findPendingOutboxProjection(sessionId, localId, outboxScope);
    if (!existing) return false;
    storage.getState().upsertPendingMessage(sessionId, {
        ...existing,
        updatedAt: nowServerMs(),
        deliveryStatus: 'accepted',
        pendingDeliveryStatus,
        sendState: undefined,
        pendingOutboxOperation: undefined,
        rawRecord,
    });
    return true;
}

function preserveInvalidExternalHandoffProjection(params: Readonly<{
    sessionId: string;
    persisted: PersistedPendingOutboxMessage;
    outboxScope: ServerAccountScope;
}>): false {
    const localId = params.persisted.localId;
    const existing = findPendingOutboxProjection(params.sessionId, localId, params.outboxScope);
    if (!existing) return false;
    const pendingDecryptFailure: PendingDecryptFailure = { kind: 'decrypt_failed' };
    storage.getState().upsertPendingMessage(params.sessionId, {
        ...existing,
        source: 'server_pending',
        deliveryStatus: 'accepted',
        pendingDeliveryStatus: 'external_handoff',
        pendingOutboxScope: params.outboxScope,
        pendingOutboxOperation: undefined,
        sendState: undefined,
        text: params.persisted.text,
        displayText: undefined,
        rawRecord: { pendingDecryptFailure },
        pendingDecryptFailure,
    });
    return false;
}

function markConfirmedExternalHandoffProjection(params: Readonly<{
    sessionId: string;
    persisted: PersistedPendingOutboxMessage;
    outboxScope: ServerAccountScope;
    rawRecord: RawRecord | null;
}>): void {
    const canonicalServerProjection = findCanonicalServerPendingProjection(
        params.sessionId,
        params.persisted.localId,
        params.outboxScope,
    );
    if (canonicalServerProjection) {
        storage.getState().upsertPendingMessage(params.sessionId, {
            ...canonicalServerProjection,
            deliveryStatus: 'accepted',
            pendingDeliveryStatus: 'external_handoff',
            pendingOutboxScope: params.outboxScope,
            pendingOutboxOperation: undefined,
            sendState: undefined,
        });
        return;
    }
    if (params.rawRecord) {
        markPendingOutboxProjectionAcceptedIfOwned(
            params.sessionId,
            params.persisted.localId,
            params.outboxScope,
            params.rawRecord,
            'external_handoff',
        );
        return;
    }
    preserveInvalidExternalHandoffProjection(params);
}

function resolvePendingDeliveryStatus(row: Pick<PendingRow, 'status'>): PendingDeliveryStatus {
    if (row.status === 'delivering') return 'server_delivering';
    if (row.status === 'external_handoff') return 'external_handoff';
    if (row.status === 'blocked' || row.status === 'unknown') return 'blocked';
    return 'server_queued';
}

function resolvePendingDeliveryBlockedReason(row: Pick<PendingRow, 'status' | 'deliveryBlockedReason'>): {
    reason?: PendingDeliveryBlockedReason;
    rawReason?: string;
} {
    if (row.status !== 'blocked' && row.status !== 'unknown') return {};
    if (!row.deliveryBlockedReason) return { reason: 'unknown' };
    const reason = normalizePendingDeliveryBlockedReason(row.deliveryBlockedReason);
    return reason ? { reason } : { reason: 'unknown', rawReason: row.deliveryBlockedReason };
}

function coerceDiscardReason(value: string | null): string | null {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    return trimmed.length > 0 ? trimmed : null;
}

function coercePendingUserTextRecord(decrypted: unknown): { rawRecord: RawRecord; text: string; displayText?: string } | null {
    const parsed = RawRecordSchema.safeParse(decrypted);
    if (!parsed.success) return null;
    const record = parsed.data;
    if (record.role !== 'user') return null;

    const text = record.content.text;
    if (typeof text !== 'string' || text.trim().length === 0) return null;

    const displayTextRaw = record.meta?.displayText;
    const displayText = typeof displayTextRaw === 'string' && displayTextRaw.trim().length > 0 ? displayTextRaw : undefined;

    return { rawRecord: record, text, displayText };
}

const enqueueCommitTailsByScopedSession = new Map<string, Promise<void>>();
const deletedPendingLocalIdsByScopedSession = new Map<string, Set<string>>();
const pendingCancellationRequestedLocalIdsByScopedSession = new Map<string, Set<string>>();
type PendingSnapshotRefreshToken = {
    readonly acceptedLocalIdsAfterCapture: Set<string>;
    /**
     * The highest session sequence this client could already have observed when the snapshot
     * request was ISSUED — the server's own monotone per-session counter. A commit ABOVE it is
     * newer than the snapshot's server read; a commit at or below it is old news this client may
     * simply not have loaded yet.
     *
     * `null` when the client held no loaded committed message at that point — a marked-loaded but
     * empty transcript included — i.e. no basis to call anything newer than the read (see
     * `resolveCommittedTranscriptSeqHighWaterMark`).
     */
    readonly committedTranscriptSeqAtCapture: number | null;
    /**
     * Set when a local write (a pending PATCH) has moved the projection past any read older than
     * itself, so THIS refresh may no longer apply — see
     * {@link supersedePendingSnapshotRefreshForLocalWrite}. It is the refresh's AUTHORITY that the
     * write invalidates, not the two capture-time facts above: those describe the response's own
     * read, which a local write does not move, and a successor answered by that same still
     * outstanding read still needs them.
     */
    isSupersededByLocalWrite: boolean;
};
const latestPendingSnapshotRefreshByScopedSession = new Map<string, PendingSnapshotRefreshToken>();
const inFlightPendingEnqueueByProjectionIdentity = new Map<
    string,
    ReturnType<typeof enqueuePendingMessageV2Owned>
>();

function pendingScopedSessionKey(scope: ServerAccountScope, sessionId: string): string {
    const normalizedSessionId = sessionId.trim();
    return `${serverAccountScopeKeySuffix(scope)}:${normalizedSessionId.length}:${normalizedSessionId}`;
}

/**
 * Records that the SERVER has confirmed it holds a pending row for `localId`, so a snapshot response
 * read before that confirmation may no longer be applied — see
 * {@link pendingSnapshotContainsEveryAcceptedLocalIdAfterCapture}.
 *
 * THE INVARIANT: every point at which this client learns the server took custody of a localId must
 * reach this function, or an in-flight snapshot can delete the message. Acknowledgement is a
 * property of the HTTP RESPONSE, while every store-mutation choke point in this module is shared
 * with anti-acknowledgement retirements (cancel, discard, delivery-handled, delete, definitive
 * rejection), so no downstream owner can discriminate — which is why each acknowledging response
 * records here directly, immediately after its own success check and before any branch. The
 * converse is equally load-bearing: recording a localId the server has STOPPED listing would make
 * the guard refuse every snapshot for the remainder of the in-flight refresh chain.
 * `pendingQueueV2.acknowledgementBoundaries.test.ts` holds both directions for every export.
 */
function markPendingLocalIdAcceptedAfterSnapshotCapture(
    scope: ServerAccountScope,
    sessionId: string,
    localId: string,
): void {
    latestPendingSnapshotRefreshByScopedSession
        .get(pendingScopedSessionKey(scope, sessionId))
        ?.acceptedLocalIdsAfterCapture.add(localId);
}

/**
 * A pending PATCH has written a projection that every read older than it is now stale against, so
 * the refresh currently registered for this scoped session must not apply its response.
 *
 * The invalidation is the refresh's AUTHORITY only. Deleting the map entry used to express it, but
 * that also erased the entry's capture-time facts — the accepted-localId fence and the session
 * sequence mark — which belong to the still-outstanding GET rather than to the refresh that issued
 * it. `apiSocket.request` can answer a refresh registered AFTER this write from that same GET, and
 * such a successor inherits from this entry; with the entry gone it took a fresh EMPTY accepted set,
 * the trivially-passing state of {@link pendingSnapshotContainsEveryAcceptedLocalIdAfterCapture},
 * and applied a pre-ACK response over a row the server already owned — message loss. The superseded
 * token stays owned by its own refresh, so the `finally` in {@link fetchAndApplyPendingMessagesV2}
 * still clears it and the inheritance window is unchanged.
 */
function supersedePendingSnapshotRefreshForLocalWrite(
    scope: ServerAccountScope,
    sessionId: string,
): void {
    const refreshToken = latestPendingSnapshotRefreshByScopedSession.get(pendingScopedSessionKey(scope, sessionId));
    if (refreshToken) refreshToken.isSupersededByLocalWrite = true;
}

function pendingSnapshotContainsEveryAcceptedLocalIdAfterCapture(
    refreshToken: PendingSnapshotRefreshToken,
    rows: ReadonlyArray<Pick<PendingRow, 'localId'>>,
): boolean {
    if (refreshToken.acceptedLocalIdsAfterCapture.size === 0) return true;
    const rowLocalIds = new Set(rows.map((row) => row.localId));
    return [...refreshToken.acceptedLocalIdsAfterCapture].every((localId) => rowLocalIds.has(localId));
}

function captureCommittedTranscriptSeqForSession(sessionId: string): number | null {
    const state = storage.getState();
    const sessionMessages = state.sessionMessages[sessionId];
    if (!sessionMessages) return null;
    return resolveCommittedTranscriptSeqHighWaterMark({
        isLoaded: sessionMessages.isLoaded === true,
        sessionSeq: state.sessions[sessionId]?.seq,
        messageIdsOldestFirst: sessionMessages.messageIdsOldestFirst ?? [],
        messagesById: sessionMessages.messagesById ?? {},
    });
}

function collectCommittedTranscriptLocalIdsAboveSeq(sessionId: string, aboveSeq: number): ReadonlySet<string> {
    const sessionMessages = storage.getState().sessionMessages[sessionId];
    if (!sessionMessages) return new Set<string>();
    return collectCommittedTranscriptLocalIds(
        sessionMessages.messageIdsOldestFirst ?? [],
        sessionMessages.messagesById ?? {},
        { aboveSeq },
    );
}

/**
 * A pending snapshot is a READ, and a read may not overwrite state that is newer than it.
 *
 * The server settles a materialization in one transaction — it deletes the pending row and writes
 * the committed message — and publishes the committed message first
 * (`apps/server/sources/app/session/pending/acceptedPendingSettlementCoordinator.ts`). A snapshot
 * request issued BEFORE that transaction still answers with the row; if its response is applied
 * after this client has committed the twin, republishing the row takes the transcript slot back
 * from a committed message the reader has already seen. Measured on this build: the send flaps
 * pending → committed → pending → committed, moving the transcript's content height three times
 * for one utterance (`.project/reviews/2026-08-06-simplify-and-native/C3-void-writer.md`).
 *
 * The fence is the capture point of the RESPONSE being applied — see the token construction in
 * {@link fetchAndApplyPendingMessagesV2}, which inherits an in-flight refresh's capture because the
 * transport may answer both from one GET.
 *
 * The discriminator is the server's own monotone per-session `seq`, NOT membership in the loaded
 * transcript. A pending row and a committed message for one localId can coexist PERMANENTLY: the
 * server writes exactly that when a provider claim goes stale after the utterance was committed
 * (`apps/server/sources/app/session/pending/providerDeliveryClaimStaleness.ts`), and the user's live
 * database carries 7 such rows, 3 of them `queued`/`blocked`/`delivery_outcome_uncertain`. Asking
 * "is this localId in my loaded transcript now but not at capture?" conflates *the twin did not
 * exist yet* (flap — withhold) with *I had not loaded the twin yet* (durable coexistence —
 * withholding is message loss, which is strictly worse than the flap). Asking "was this commit
 * SEQUENCED above everything I could already have observed?" separates them: the settlement writes
 * the twin inside the transaction that deletes the row, so a flap twin is always above the mark,
 * while a durable twin never is (measured on all 7 live rows: `twin.seq <= Session.seq`, and
 * `Session.seq == max(SessionMessage.seq)` on each of their sessions).
 *
 * A `null` mark means the client held no loaded committed message when the request was issued and
 * therefore no basis to call anything newer than its read — session open has no warm transcript
 * cache, so this is the ordinary first-open state, and a transcript that is marked loaded while
 * still empty is the same absence of basis dressed as a completed load — and nothing is withheld
 * there.
 *
 * Withheld rows are omitted only from the PUBLISHED bucket, after
 * {@link reconcileServerPendingSnapshotWithLocalOutbound} has consumed the complete server truth,
 * so durable outbox retirement and local-projection reconciliation still see every server row. The
 * `shouldPreservePendingProjectionAfterCommittedUserLocalId` rule (a durable row the client already
 * holds keeps its slot across the commit) is untouched.
 */
function withholdPendingRowsCommittedAfterSnapshotCapture(
    sessionId: string,
    refreshToken: PendingSnapshotRefreshToken,
    reconciled: Readonly<{ messages: PendingMessage[]; discarded: DiscardedPendingMessage[] }>,
): Readonly<{ messages: PendingMessage[]; discarded: DiscardedPendingMessage[] }> {
    if (reconciled.messages.length === 0) return reconciled;
    const seqAtCapture = refreshToken.committedTranscriptSeqAtCapture;
    if (seqAtCapture === null) return reconciled;
    const committedAfterCapture = collectCommittedTranscriptLocalIdsAboveSeq(sessionId, seqAtCapture);
    if (committedAfterCapture.size === 0) return reconciled;
    const messages = reconciled.messages.filter((message) => {
        const localId = message.localId ?? message.id;
        if (!localId) return true;
        return !committedAfterCapture.has(localId);
    });
    if (messages.length === reconciled.messages.length) return reconciled;
    return { messages, discarded: reconciled.discarded };
}

function pendingMessagePath(sessionId: string, pendingId: string): string {
    assertSafePendingIdPathSegment(pendingId);
    return `/v2/sessions/${sessionId}/pending/${encodeURIComponent(pendingId)}`;
}

function assertPendingOutboxTransportAllowed(
    sessionId: string,
    localId: string,
    outboxScope: ServerAccountScope,
): void {
    assertSafePendingIdPathSegment(localId);
    if (findCanonicalServerPendingProjection(sessionId, localId, outboxScope)) return;
    const exactScopeQuarantine = storage.getState().sessionPending[sessionId]?.messages.find((message) =>
        message.id === localId
        && message.pendingOutboxQuarantineReason !== undefined
        && areServerAccountScopesEqual(message.pendingOutboxScope, outboxScope)
    );
    if (exactScopeQuarantine) {
        throw new Error('Persisted Pending outbox row is quarantined');
    }
    if (findPendingOutboxMessage(sessionId, localId, outboxScope)?.operation === 'quarantined') {
        throw new Error('Persisted Pending outbox row is quarantined');
    }
}

function runPendingEnqueueCommitInOrder<T>(
    scope: ServerAccountScope,
    sessionId: string,
    op: () => Promise<T>,
): Promise<T> {
    const key = pendingScopedSessionKey(scope, sessionId);
    const prev = enqueueCommitTailsByScopedSession.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(op);
    const settled = next.then(
        () => undefined,
        () => undefined,
    );
    const tail = settled.finally(() => {
        if (enqueueCommitTailsByScopedSession.get(key) === tail) {
            enqueueCommitTailsByScopedSession.delete(key);
        }
    });
    enqueueCommitTailsByScopedSession.set(key, tail);
    return next;
}

function markPendingLocalIdDeleted(scope: ServerAccountScope, sessionId: string, localId: string): void {
    const key = pendingScopedSessionKey(scope, sessionId);
    const deleted = deletedPendingLocalIdsByScopedSession.get(key) ?? new Set<string>();
    deleted.add(localId);
    deletedPendingLocalIdsByScopedSession.set(key, deleted);
}

function markPendingCancellationRequested(scope: ServerAccountScope, sessionId: string, localId: string): void {
    const key = pendingScopedSessionKey(scope, sessionId);
    const requested = pendingCancellationRequestedLocalIdsByScopedSession.get(key) ?? new Set<string>();
    requested.add(localId);
    pendingCancellationRequestedLocalIdsByScopedSession.set(key, requested);
}

function isPendingCancellationRequested(scope: ServerAccountScope, sessionId: string, localId: string): boolean {
    return pendingCancellationRequestedLocalIdsByScopedSession.get(pendingScopedSessionKey(scope, sessionId))?.has(localId) === true;
}

function clearDeletedPendingLocalId(scope: ServerAccountScope, sessionId: string, localId: string): void {
    const key = pendingScopedSessionKey(scope, sessionId);
    const deleted = deletedPendingLocalIdsByScopedSession.get(key);
    if (!deleted) return;
    deleted.delete(localId);
    if (deleted.size === 0) {
        deletedPendingLocalIdsByScopedSession.delete(key);
    }
}

function clearPendingCancellationRequested(scope: ServerAccountScope, sessionId: string, localId: string): void {
    const key = pendingScopedSessionKey(scope, sessionId);
    const requested = pendingCancellationRequestedLocalIdsByScopedSession.get(key);
    if (!requested) return;
    requested.delete(localId);
    if (requested.size === 0) pendingCancellationRequestedLocalIdsByScopedSession.delete(key);
}

function filterDeletedPendingRows<T extends Pick<PendingRow, 'localId'>>(
    scope: ServerAccountScope | undefined,
    sessionId: string,
    rows: T[],
): T[] {
    if (!scope) return rows;
    const deleted = deletedPendingLocalIdsByScopedSession.get(pendingScopedSessionKey(scope, sessionId));
    if (!deleted || deleted.size === 0) return rows;
    return rows.filter((row) => !deleted.has(row.localId));
}

function pruneDeletedPendingLocalIdsProvenAbsent(
    scope: ServerAccountScope | undefined,
    sessionId: string,
    rows: ReadonlyArray<Pick<PendingRow, 'localId'>>,
): void {
    if (!scope) return;
    const key = pendingScopedSessionKey(scope, sessionId);
    const deleted = deletedPendingLocalIdsByScopedSession.get(key);
    if (!deleted || deleted.size === 0) return;
    const presentLocalIds = new Set(rows.map((row) => row.localId));
    for (const localId of deleted) {
        const projectionKey = pendingOutboxProjectionIdentityKey({ sessionId, localId, outboxScope: scope });
        if (!presentLocalIds.has(localId) && !inFlightPendingEnqueueByProjectionIdentity.has(projectionKey)) {
            deleted.delete(localId);
        }
    }
    if (deleted.size === 0) deletedPendingLocalIdsByScopedSession.delete(key);
}

async function deletePendingOutboxMessageAtServer(params: {
    sessionId: string;
    localId: string;
    request: (path: string, init?: RequestInit) => Promise<Response>;
}): Promise<void> {
    const response = await params.request(pendingMessagePath(params.sessionId, params.localId), { method: 'DELETE' });
    if (!response.ok && response.status !== 404) {
        assertPendingResponseOk(response, 'Failed to delete pending message');
    }
}

async function completePendingOutboxCancellationIfRequested(params: {
    sessionId: string;
    localId: string;
    outboxScope: ServerAccountScope;
    request: (path: string, init?: RequestInit) => Promise<Response>;
}): Promise<boolean> {
    const row = findPendingOutboxMessage(params.sessionId, params.localId, params.outboxScope);
    if (row?.operation !== 'cancel') return false;
    try {
        await deletePendingOutboxMessageAtServer(params);
        markPendingLocalIdDeleted(params.outboxScope, params.sessionId, params.localId);
        removePendingOutboxMessage(params.sessionId, params.localId, params.outboxScope);
        clearPendingCancellationRequested(params.outboxScope, params.sessionId, params.localId);
        return true;
    } catch (error) {
        clearPendingCancellationRequested(params.outboxScope, params.sessionId, params.localId);
        throw error;
    }
}

function buildPendingDecryptFailureMessage(params: {
    row: Pick<PendingRow, 'localId' | 'createdAt' | 'updatedAt'>;
}): {
    id: string;
    localId: string;
    createdAt: number;
    updatedAt: number;
    source: 'server_pending';
    text: string;
    displayText: string;
    rawRecord: { pendingDecryptFailure: PendingDecryptFailure };
    pendingDecryptFailure: PendingDecryptFailure;
} {
    const pendingDecryptFailure: PendingDecryptFailure = { kind: 'decrypt_failed' };

    return {
        id: params.row.localId,
        localId: params.row.localId,
        createdAt: params.row.createdAt,
        updatedAt: params.row.updatedAt,
        source: 'server_pending',
        text: '',
        displayText: t('session.pendingMessages.decryptFailed'),
        rawRecord: { pendingDecryptFailure },
        pendingDecryptFailure,
    };
}

function withPendingDeliveryState<T extends PendingMessage>(
    row: PendingRow,
    message: T,
    outboxScope: ServerAccountScope,
): T {
    const pendingDeliveryStatus = resolvePendingDeliveryStatus(row);
    const { reason: pendingDeliveryBlockedReason, rawReason: pendingDeliveryBlockedReasonRaw } = resolvePendingDeliveryBlockedReason(row);
    return {
        ...message,
        messageRole: row.messageRole,
        ...(pendingDeliveryStatus === 'external_handoff' ? { pendingOutboxScope: outboxScope } : {}),
        ...(row.requestedAction ? { requestedAction: row.requestedAction } : {}),
        ...(row.requestedActionMalformed ? { requestedActionMalformed: true as const } : {}),
        pendingDeliveryStatus,
        ...(row.deliveryStatus?.status === 'delivering' && row.deliveryStatus.detail
            ? { pendingDeliveryDetail: row.deliveryStatus.detail }
            : {}),
        ...(pendingDeliveryBlockedReason ? { pendingDeliveryBlockedReason } : {}),
        ...(pendingDeliveryBlockedReasonRaw ? { pendingDeliveryBlockedReasonRaw } : {}),
        ...(row.status === 'unknown' ? { pendingDeliveryStatusRaw: row.statusRaw } : {}),
    };
}

function arePendingEnvelopeValuesEqual(left: unknown, right: unknown): boolean {
    if (Object.is(left, right)) return true;
    if (left == null || right == null) return left === right;
    if (Array.isArray(left) || Array.isArray(right)) {
        return Array.isArray(left)
            && Array.isArray(right)
            && left.length === right.length
            && left.every((value, index) => arePendingEnvelopeValuesEqual(value, right[index]));
    }
    if (typeof left !== 'object' || typeof right !== 'object') return false;
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord);
    const rightKeys = Object.keys(rightRecord);
    return leftKeys.length === rightKeys.length
        && leftKeys.every((key) => key in rightRecord
            && arePendingEnvelopeValuesEqual(leftRecord[key], rightRecord[key]));
}

function isCompatibleCommittedPendingEnvelope(
    outbox: PersistedPendingOutboxMessage,
    serverRow: PendingRow,
): boolean {
    if (outbox.operation !== 'enqueue') return false;
    if (serverRow.requestedActionMalformed === true) return false;
    const frozen = readPendingEnqueueFrozenEnvelope(outbox.request.body);
    const serverRequestedAction = serverRow.requestedAction ?? { v: 1, kind: 'enqueue' as const };
    if (!frozen || (serverRow.messageRole !== null && serverRow.messageRole !== 'user')) return false;
    const serverDeliveryMode = serverRow.status === 'external_handoff' ? 'external_handoff' : undefined;
    if (frozen.deliveryMode !== serverDeliveryMode) return false;
    return arePendingEnvelopeValuesEqual(frozen.content, serverRow.content)
        && arePendingEnvelopeValuesEqual(frozen.requestedAction, serverRequestedAction);
}

type PendingProjectionIdOccupant = Pick<
    PendingMessage,
    'id' | 'localId' | 'pendingOutboxScope' | 'pendingOutboxQuarantineReason'
>;

function allocatePendingOutboxProjectionId(params: Readonly<{
    identity: PendingOutboxProjectionIdentity;
    quarantined: boolean;
    occupiedMessages: readonly PendingProjectionIdOccupant[];
    preferredProjectionId?: string;
}>): string {
    if (params.preferredProjectionId !== undefined
        && !params.occupiedMessages.some((message) => message.id === params.preferredProjectionId)) {
        return params.preferredProjectionId;
    }
    let projectionId = params.quarantined
        ? `pending-outbox-quarantine:${pendingOutboxProjectionIdentityKey(params.identity)}`
        : params.identity.localId;
    const isSameProjection = params.quarantined
        ? isPendingOutboxQuarantineProjectionForIdentity
        : isPendingOutboxProjectionForIdentity;
    const isOccupiedByAnotherProjection = (candidateId: string): boolean =>
        params.occupiedMessages.some((message) =>
            message.id === candidateId && !isSameProjection(message, params.identity)
        );
    if (!isOccupiedByAnotherProjection(projectionId)) return projectionId;
    const baseId = `pending-outbox${params.quarantined ? '-quarantine' : ''}:${pendingOutboxProjectionIdentityKey(params.identity)}`;
    projectionId = baseId;
    for (let suffix = 1; isOccupiedByAnotherProjection(projectionId); suffix += 1) {
        projectionId = `${baseId}:${suffix}`;
    }
    return projectionId;
}

function buildPendingOutboxProjection(
    row: PersistedPendingOutboxMessage,
    outboxScope: ServerAccountScope,
    occupiedMessages: readonly PendingProjectionIdOccupant[] = [
        ...(storage.getState().sessionPending[row.sessionId]?.messages ?? []),
        ...(storage.getState().sessionPending[row.sessionId]?.discarded ?? []),
    ],
    preferredProjectionId?: string,
): PendingMessage {
    const requestedAction = readPendingEnqueueRequestedAction(row.request.body);
    const quarantined = row.operation === 'quarantined';
    const requestedActionMalformed = !quarantined && requestedAction === null;
    const identity = {
        sessionId: row.sessionId,
        localId: row.localId,
        outboxScope,
    } satisfies PendingOutboxProjectionIdentity;
    const projectionId = allocatePendingOutboxProjectionId({
        identity,
        quarantined,
        occupiedMessages,
        preferredProjectionId,
    });
    const parsedRawRecord = RawRecordSchema.safeParse(row.rawRecord);
    const projectionRawRecord: RawRecord = parsedRawRecord.success && parsedRawRecord.data.role === 'user'
        ? parsedRawRecord.data
        : {
            role: 'user',
            content: { type: 'text', text: row.text },
            meta: {},
        };
    return {
        id: projectionId,
        localId: row.localId,
        createdAt: row.createdAt,
        updatedAt: row.createdAt,
        source: 'local_outbound',
        deliveryStatus: 'queued',
        pendingOutboxScope: outboxScope,
        ...(quarantined
            ? {
                pendingOutboxQuarantineReason: row.pendingOutboxQuarantineReason,
                pendingDeliveryStatus: 'blocked' as const,
                pendingDeliveryBlockedReason: 'unknown' as const,
            }
            : {
                pendingOutboxOperation: row.operation,
                sendState: 'unconfirmed' as const,
            }),
        ...(requestedAction ? { requestedAction } : {}),
        ...(requestedActionMalformed
            ? {
                requestedActionMalformed: true as const,
                pendingDeliveryStatus: 'blocked' as const,
                pendingDeliveryBlockedReason: 'unsupported_action' as const,
                sendState: undefined,
            }
            : {}),
        text: row.text,
        displayText: row.displayText,
        rawRecord: projectionRawRecord,
    };
}

function ensurePendingOutboxQuarantineProjection(
    row: PersistedPendingOutboxMessage,
    outboxScope: ServerAccountScope,
): PendingMessage {
    const existing = findPendingOutboxQuarantineProjection(row.sessionId, row.localId, outboxScope);
    if (existing) return existing;
    const projection = buildPendingOutboxProjection(row, outboxScope);
    storage.getState().upsertPendingMessage(row.sessionId, projection);
    return projection;
}

function isAcknowledgedScopedPendingProjection(message: PendingMessage): boolean {
    return message.deliveryStatus === 'accepted'
        || (message.source === 'server_pending' && message.pendingDeliveryStatus === 'external_handoff');
}

function isCanonicalServerExternalHandoffProjection(message: PendingMessage): boolean {
    return message.source === 'server_pending' && message.pendingDeliveryStatus === 'external_handoff';
}

function reconcileServerPendingSnapshotWithLocalOutbound(params: Readonly<{
    sessionId: string;
    outboxScope: ServerAccountScope;
    serverPendingRows: PendingRow[];
    serverPendingMessages: PendingMessage[];
    serverDiscardedMessages: DiscardedPendingMessage[];
}>): Readonly<{
    messages: PendingMessage[];
    discarded: DiscardedPendingMessage[];
}> {
    const existing = storage.getState().sessionPending[params.sessionId]?.messages ?? [];
    const serverPendingRowsByLocalId = new Map(params.serverPendingRows.map((row) => [row.localId, row]));
    const outboxRows = loadPendingOutboxForSession(params.sessionId, params.outboxScope);
    const outboxRowsByProjectionKey = new Map(outboxRows.map((row) => [
        pendingOutboxProjectionIdentityKey({
            sessionId: params.sessionId,
            localId: row.localId,
            outboxScope: params.outboxScope,
        }),
        row,
    ]));
    const projectionKeyForServerMessage = (message: Pick<PendingMessage, 'id' | 'localId'>): string =>
        pendingOutboxProjectionIdentityKey({
            sessionId: params.sessionId,
            localId: message.localId ?? message.id,
            outboxScope: params.outboxScope,
        });

    // Any same-scope server row proves persistence for this identity and retires executable enqueue
    // custody. Envelope mismatches remain diagnostic on the authoritative server projection; they
    // never preserve a replayable local writer that could resurrect after the server row disappears.
    const conflictingServerLocalIds = new Set<string>();
    for (const message of params.serverPendingMessages) {
        const outbox = outboxRowsByProjectionKey.get(projectionKeyForServerMessage(message));
        const serverRow = serverPendingRowsByLocalId.get(message.localId ?? message.id);
        if (outbox?.operation === 'enqueue' && serverRow) {
            if (!isCompatibleCommittedPendingEnvelope(outbox, serverRow)) {
                conflictingServerLocalIds.add(outbox.localId);
            }
            removePendingOutboxMessage(params.sessionId, outbox.localId, params.outboxScope);
        }
    }
    for (const message of params.serverDiscardedMessages) {
        const outbox = outboxRowsByProjectionKey.get(projectionKeyForServerMessage(message));
        if (outbox?.operation === 'enqueue') {
            removePendingOutboxMessage(params.sessionId, outbox.localId, params.outboxScope);
        }
    }

    const serverPendingMessages = params.serverPendingMessages.map((message) =>
        conflictingServerLocalIds.has(message.localId ?? message.id)
            ? { ...message, pendingOutboxConflict: true as const }
            : message
    );
    const retainedOutboxRows = loadPendingOutboxForSession(params.sessionId, params.outboxScope);
    const retainedOutboxRowsByProjectionKey = new Map(retainedOutboxRows.map((row) => [
        pendingOutboxProjectionIdentityKey({
            sessionId: params.sessionId,
            localId: row.localId,
            outboxScope: params.outboxScope,
        }),
        row,
    ]));
    const serverLocalIds = new Set<string>();
    for (const message of params.serverPendingMessages) {
        if (message.localId) serverLocalIds.add(message.localId);
    }
    for (const message of params.serverDiscardedMessages) {
        if (message.localId) serverLocalIds.add(message.localId);
    }
    const serverProjectionIds = new Set([
        ...serverPendingMessages.map((message) => message.id),
        ...params.serverDiscardedMessages.map((message) => message.id),
    ]);
    const scopedLocalOutbound = existing.filter((message) => {
        if (message.source !== 'local_outbound' || !isPendingOutboxProjectionInScope(message, params.outboxScope)) {
            return false;
        }
        if (message.pendingOutboxQuarantineReason !== undefined) return false;
        if (message.localId && serverLocalIds.has(message.localId)) return false;
        if (serverProjectionIds.has(message.id)) return false;
        const localId = message.localId ?? message.id;
        const projectionKey = pendingOutboxProjectionIdentityKey({
            sessionId: params.sessionId,
            localId,
            outboxScope: params.outboxScope,
        });
        const durableRow = retainedOutboxRowsByProjectionKey.get(projectionKey);
        return (durableRow !== undefined && durableRow.operation !== 'quarantined')
            || (
                isPendingCancellationRequested(params.outboxScope, params.sessionId, localId)
                && inFlightPendingEnqueueByProjectionIdentity.has(projectionKey)
            );
    });

    const preservedUnscopedLocalOutbound = existing.filter((message) => {
        if (message.pendingOutboxScope) return false;
        if (message.localId && serverLocalIds.has(message.localId)) return false;
        return message.source === 'local_outbound'
            || (message.source == null && message.deliveryStatus === 'accepted');
    });
    const preservedUnresolvedExternalHandoffs = existing.filter((message) => {
        const localId = message.localId ?? message.id;
        return message.pendingDeliveryStatus === 'external_handoff'
            && isPendingOutboxProjectionInScope(message, params.outboxScope)
            && !serverLocalIds.has(localId);
    });
    const preservedLocalOutboundCandidates = [
        ...scopedLocalOutbound,
        ...preservedUnscopedLocalOutbound,
        ...preservedUnresolvedExternalHandoffs,
    ];
    const preservedLocalOutbound: PendingMessage[] = [];
    const retainedScopedProjectionIndexes = new Map<string, number>();
    for (const message of preservedLocalOutboundCandidates) {
        if (message.pendingOutboxScope) {
            const projectionKey = pendingOutboxProjectionIdentityKey({
                sessionId: params.sessionId,
                localId: message.localId ?? message.id,
                outboxScope: message.pendingOutboxScope,
            });
            const retainedIndex = retainedScopedProjectionIndexes.get(projectionKey);
            if (retainedIndex !== undefined) {
                const retained = preservedLocalOutbound[retainedIndex]!;
                if ((!isAcknowledgedScopedPendingProjection(retained)
                    && isAcknowledgedScopedPendingProjection(message))
                    || (!isCanonicalServerExternalHandoffProjection(retained)
                        && isCanonicalServerExternalHandoffProjection(message))) {
                    preservedLocalOutbound[retainedIndex] = message;
                }
                continue;
            }
            retainedScopedProjectionIndexes.set(projectionKey, preservedLocalOutbound.length);
        }
        preservedLocalOutbound.push(message);
    }
    const preservedProjectionKeys = new Set<string>();
    for (const [index, message] of preservedLocalOutbound.entries()) {
        if (!message.pendingOutboxScope) continue;
        const projectionKey = pendingOutboxProjectionIdentityKey({
            sessionId: params.sessionId,
            localId: message.localId ?? message.id,
            outboxScope: message.pendingOutboxScope,
        });
        preservedProjectionKeys.add(projectionKey);
        const retainedOutbox = retainedOutboxRowsByProjectionKey.get(projectionKey);
        if (retainedOutbox?.operation === 'enqueue' && isAcknowledgedScopedPendingProjection(message)) {
            removePendingOutboxMessage(params.sessionId, retainedOutbox.localId, params.outboxScope);
            preservedLocalOutbound[index] = {
                ...message,
                source: 'server_pending',
                pendingOutboxOperation: undefined,
                sendState: undefined,
            };
        }
    }
    for (const [projectionKey, row] of retainedOutboxRowsByProjectionKey) {
        if (row.operation !== 'quarantined'
            && (serverLocalIds.has(row.localId) || preservedProjectionKeys.has(projectionKey))) continue;
        const existingProjection = row.operation === 'quarantined'
            ? findPendingOutboxQuarantineProjection(params.sessionId, row.localId, params.outboxScope)
            : findPendingOutboxProjection(params.sessionId, row.localId, params.outboxScope);
        const projection = buildPendingOutboxProjection(row, params.outboxScope, [
            ...serverPendingMessages,
            ...params.serverDiscardedMessages,
            ...preservedLocalOutbound,
        ], existingProjection?.id);
        preservedLocalOutbound.push(projection);
        preservedProjectionKeys.add(projectionKey);
    }
    if (preservedLocalOutbound.length === 0) {
        return { messages: serverPendingMessages, discarded: params.serverDiscardedMessages };
    }

    const merged = [...serverPendingMessages];
    for (const [retainedIndex, message] of preservedLocalOutbound.entries()) {
        const localId = message.localId ?? message.id;
        const projectionId = allocatePendingOutboxProjectionId({
            identity: {
                sessionId: params.sessionId,
                localId,
                outboxScope: params.outboxScope,
            },
            quarantined: message.pendingOutboxQuarantineReason !== undefined,
            occupiedMessages: [
                ...merged,
                ...params.serverDiscardedMessages,
                ...preservedLocalOutbound.filter((_, candidateIndex) => candidateIndex !== retainedIndex),
            ],
            preferredProjectionId: message.id,
        });
        const collisionSafeMessage = projectionId === message.id
            ? message
            : { ...message, id: projectionId };
        merged.push(collisionSafeMessage);
    }
    return { messages: merged, discarded: params.serverDiscardedMessages };
}

async function readPendingRowDecryptedContent(params: {
    row: Pick<PendingRow, 'content' | 'localId' | 'createdAt' | 'updatedAt'>;
    sessionEncryption: ReturnType<PendingQueueReadEncryption['getSessionEncryption']>;
}): Promise<
    | { kind: 'ok'; value: unknown }
    | { kind: 'decrypt_failed'; message: ReturnType<typeof buildPendingDecryptFailureMessage> }
> {
    if (params.row.content === null) {
        return {
            kind: 'decrypt_failed',
            message: buildPendingDecryptFailureMessage({ row: params.row }),
        };
    }
    if (params.row.content.t !== 'encrypted') {
        return { kind: 'ok', value: params.row.content.v };
    }

    if (!params.sessionEncryption) {
        return {
            kind: 'decrypt_failed',
            message: buildPendingDecryptFailureMessage({ row: params.row }),
        };
    }

    try {
        const decrypted = await params.sessionEncryption.decryptRaw(params.row.content.c);
        if (decrypted == null) {
            return {
                kind: 'decrypt_failed',
                message: buildPendingDecryptFailureMessage({ row: params.row }),
            };
        }

        return {
            kind: 'ok',
            value: decrypted,
        };
    } catch {
        return {
            kind: 'decrypt_failed',
            message: buildPendingDecryptFailureMessage({ row: params.row }),
        };
    }
}

export async function fetchAndApplyPendingMessagesV2(params: {
    sessionId: string;
    encryption: PendingQueueReadEncryption;
    request: (path: string, init?: RequestInit) => Promise<Response>;
    outboxScope: ServerAccountScope;
    isOutboxScopeCurrent?: () => boolean | Promise<boolean>;
}): Promise<void> {
    const { sessionId, encryption, request } = params;
    const refreshKey = pendingScopedSessionKey(params.outboxScope, sessionId);
    // The capture point must belong to the RESPONSE, not to the caller. `apiSocket.request` shares
    // one in-flight GET with every later caller and drops the de-dupe entry only in the FIRST
    // caller's continuation, so a refresh starting after the committed twin can be answered by the
    // request an earlier refresh issued before it. While that earlier refresh is still registered,
    // inherit its capture: the response is either the predecessor's — captured exactly then — or
    // this refresh's own, which was issued later still and therefore cannot be older than the
    // inherited mark. Keying on the PRESENCE of a predecessor is load-bearing: `??` would silently
    // take a fresh capture whenever the predecessor's mark is `null` — exactly the no-basis state
    // the mark exists to preserve — and reopen the false withhold on the adopting refresh.
    // BOTH capture-time facts are inherited, for the one reason above.
    // `markPendingLocalIdAcceptedAfterSnapshotCapture` writes to the LATEST registered token only,
    // so every accept the predecessor recorded still postdates the response this refresh may adopt;
    // a fresh empty set would short-circuit the accepted-ID guard to "safe" and publish a pre-ACK
    // response over a row the server already owns, which is message loss rather than a flap. The
    // set is COPIED, not aliased: each token records the accepts after its OWN capture, and sharing
    // one Set would let this refresh's later accepts bind the predecessor retroactively. A
    // predecessor superseded by a local write is still inherited from — the write took its
    // authority, not its capture (see {@link supersedePendingSnapshotRefreshForLocalWrite}) — but
    // this refresh starts authoritative.
    const inFlightRefresh = latestPendingSnapshotRefreshByScopedSession.get(refreshKey);
    const refreshToken: PendingSnapshotRefreshToken = {
        acceptedLocalIdsAfterCapture: new Set<string>(inFlightRefresh?.acceptedLocalIdsAfterCapture),
        committedTranscriptSeqAtCapture: inFlightRefresh
            ? inFlightRefresh.committedTranscriptSeqAtCapture
            : captureCommittedTranscriptSeqForSession(sessionId),
        isSupersededByLocalWrite: false,
    };
    latestPendingSnapshotRefreshByScopedSession.set(refreshKey, refreshToken);

    try {
    const session = storage.getState().sessions[sessionId] ?? null;
    const sessionEncryptionMode: 'e2ee' | 'plain' = session?.encryptionMode === 'plain' ? 'plain' : 'e2ee';
    const sessionEncryption = sessionEncryptionMode === 'plain' ? null : encryption.getSessionEncryption(sessionId);

    const response = await request(`/v2/sessions/${sessionId}/pending?includeDiscarded=1`, { method: 'GET' });
    // This refresh may apply only while it is BOTH the latest registered refresh and unsuperseded by
    // a local write.
    const isRefreshTokenAuthoritative = (): boolean =>
        latestPendingSnapshotRefreshByScopedSession.get(refreshKey) === refreshToken
        && !refreshToken.isSupersededByLocalWrite;
    const isRefreshScopeCurrent = async (): Promise<boolean> => {
        if (!isRefreshTokenAuthoritative()) return false;
        let isScopeCurrent: boolean;
        if (params.isOutboxScopeCurrent) {
            isScopeCurrent = await params.isOutboxScopeCurrent();
        } else {
            const activeScope = getActiveServerAccountScope();
            isScopeCurrent = activeScope !== null
                && isPendingOutboxProjectionInScope({ pendingOutboxScope: activeScope }, params.outboxScope);
        }
        return isScopeCurrent && isRefreshTokenAuthoritative();
    };
    if (!await isRefreshScopeCurrent()) return;
    if (!response.ok) {
        throwAuthenticationResponseErrorIfNeeded(response.status);
        storage.getState().applyPendingSnapshot(sessionId, {
            messages: storage.getState().sessionPending[sessionId]?.messages ?? [],
            discarded: [],
        });
        return;
    }

    const json = await response.json().catch(() => null);
    if (!await isRefreshScopeCurrent()) return;
    const rows = parsePendingRows(json);
    if (!rows) {
        storage.getState().applyPendingSnapshot(sessionId, {
            messages: storage.getState().sessionPending[sessionId]?.messages ?? [],
            discarded: [],
        });
        return;
    }
    if (!pendingSnapshotContainsEveryAcceptedLocalIdAfterCapture(refreshToken, rows)) return;

    // This snapshot was parsed before any awaited decrypt work. It may retire only
    // tombstones that it already proves absent; newer cancellations remain fenced.
    pruneDeletedPendingLocalIdsProvenAbsent(params.outboxScope, sessionId, rows);

    // Map the complete authoritative snapshot before consulting transient deletion tombstones.
    // A concurrent DELETE can still fail while decrypting; final publication is the fence that
    // decides whether its row remains suppressed or is restored from this mapped snapshot.
    const queued = rows
        .filter((r) => r.status !== 'discarded')
        .sort((a, b) => a.position - b.position || a.createdAt - b.createdAt || a.localId.localeCompare(b.localId));
    const discarded = rows
        // `resent_as_new` is retained by older servers only as the idempotency/evidence owner for
        // the replacement operation. It is not discarded user work and must not become a duplicate
        // recovery row while this client can still meet that predecessor server shape.
        .filter((r) => r.status === 'discarded' && shouldExposePendingDeliveryInDiscardedHistoryV1({
            status: 'discarded',
            reason: r.discardedReason,
        }))
        .sort((a, b) => (a.discardedAt ?? a.updatedAt) - (b.discardedAt ?? b.updatedAt));

    const pendingMessages: PendingMessage[] = [];
    for (const r of queued) {
        const decrypted = await readPendingRowDecryptedContent({
            row: r,
            sessionEncryption,
        });
        if (decrypted.kind === 'decrypt_failed') {
            pendingMessages.push(withPendingDeliveryState(r, decrypted.message, params.outboxScope));
            continue;
        }

        const coerced = coercePendingUserTextRecord(decrypted.value);
        if (!coerced) {
            pendingMessages.push(withPendingDeliveryState(r, buildPendingDecryptFailureMessage({ row: r }), params.outboxScope));
            continue;
        }
        pendingMessages.push(withPendingDeliveryState(r, {
            id: r.localId,
            localId: r.localId,
            createdAt: r.createdAt,
            updatedAt: r.updatedAt,
            source: 'server_pending',
            text: coerced.text,
            displayText: coerced.displayText,
            rawRecord: coerced.rawRecord,
        }, params.outboxScope));
    }

    const discardedMessages: DiscardedPendingMessage[] = [];
    for (const r of discarded) {
        const decrypted = await readPendingRowDecryptedContent({
            row: r,
            sessionEncryption,
        });
        if (decrypted.kind === 'decrypt_failed') {
            discardedMessages.push({
                ...decrypted.message,
                ...(r.requestedAction ? { requestedAction: r.requestedAction } : {}),
                ...(r.requestedActionMalformed ? { requestedActionMalformed: true as const } : {}),
                discardedAt: r.discardedAt ?? r.updatedAt,
                discardedReason: coerceDiscardReason(r.discardedReason),
            });
            continue;
        }

        const coerced = coercePendingUserTextRecord(decrypted.value);
        if (!coerced) {
            discardedMessages.push({
                ...buildPendingDecryptFailureMessage({ row: r }),
                ...(r.requestedAction ? { requestedAction: r.requestedAction } : {}),
                ...(r.requestedActionMalformed ? { requestedActionMalformed: true as const } : {}),
                discardedAt: r.discardedAt ?? r.updatedAt,
                discardedReason: coerceDiscardReason(r.discardedReason),
            });
            continue;
        }
        discardedMessages.push({
            id: r.localId,
            localId: r.localId,
            createdAt: r.createdAt,
            updatedAt: r.updatedAt,
            source: 'server_pending',
            ...(r.requestedAction ? { requestedAction: r.requestedAction } : {}),
            ...(r.requestedActionMalformed ? { requestedActionMalformed: true as const } : {}),
            text: coerced.text,
            displayText: coerced.displayText,
            rawRecord: coerced.rawRecord,
            discardedAt: r.discardedAt ?? r.updatedAt,
            discardedReason: coerceDiscardReason(r.discardedReason),
        });
    }

    // A snapshot that no longer lists a row is the RECEIPT for a materialization the server has
    // already made durable — the same transaction deleted the row and wrote the committed message.
    // Publishing it while that committed twin is still being read, decrypted, or held in the apply
    // coalescer retires the pending row with nothing to take its slot, and the transcript publishes
    // a frame carrying NEITHER row for the utterance. `SessionPendingMessagesRefresh` re-issues this
    // GET on every `pendingVersion` change, i.e. on the very body that announces the settlement, so
    // that race is the routine ordering rather than an exotic one. Settle first, then publish.
    await settleReceivedSessionMessages(sessionId);
    if (!await isRefreshScopeCurrent()) return;
    if (!pendingSnapshotContainsEveryAcceptedLocalIdAfterCapture(refreshToken, rows)) return;
    const finalVisibleRows = filterDeletedPendingRows(params.outboxScope, sessionId, rows);
    const finalVisibleLocalIds = new Set(finalVisibleRows.map((row) => row.localId));
    const finalQueued = queued.filter((row) => finalVisibleLocalIds.has(row.localId));
    const reconciled = reconcileServerPendingSnapshotWithLocalOutbound({
        sessionId,
        outboxScope: params.outboxScope,
        serverPendingRows: finalQueued,
        serverPendingMessages: pendingMessages.filter((message) =>
            typeof message.localId === 'string' && finalVisibleLocalIds.has(message.localId)),
        serverDiscardedMessages: discardedMessages.filter((message) =>
            typeof message.localId === 'string' && finalVisibleLocalIds.has(message.localId)),
    });
    storage.getState().applyPendingSnapshot(
        sessionId,
        withholdPendingRowsCommittedAfterSnapshotCapture(sessionId, refreshToken, reconciled),
    );
    } finally {
        if (latestPendingSnapshotRefreshByScopedSession.get(refreshKey) === refreshToken) {
            latestPendingSnapshotRefreshByScopedSession.delete(refreshKey);
        }
    }
}

export function enqueuePendingMessageV2(
    params: Parameters<typeof enqueuePendingMessageV2Owned>[0],
): ReturnType<typeof enqueuePendingMessageV2Owned> {
    if (params.localId !== undefined && readPendingLocalId(params.localId) === null) {
        throw new Error('Pending localId must not be blank');
    }
    const localId = readPendingLocalId(params.localId) ?? randomUUID();
    assertSafePendingIdPathSegment(localId);
    const identityKey = pendingOutboxProjectionIdentityKey({
        sessionId: params.sessionId,
        localId,
        outboxScope: params.outboxScope,
    });
    const existing = inFlightPendingEnqueueByProjectionIdentity.get(identityKey);
    if (existing) return existing;

    const operation = enqueuePendingMessageV2Owned({ ...params, localId });
    inFlightPendingEnqueueByProjectionIdentity.set(identityKey, operation);
    const clear = (): void => {
        if (inFlightPendingEnqueueByProjectionIdentity.get(identityKey) === operation) {
            inFlightPendingEnqueueByProjectionIdentity.delete(identityKey);
        }
    };
    void operation.then(clear, clear);
    return operation;
}

async function enqueuePendingMessageV2Owned(params: {
    sessionId: string;
    text: string;
    displayText?: string;
    localId?: string;
    deliveryMode?: 'external_handoff';
    encryption: PendingQueueEncryption;
    metaOverrides?: Record<string, unknown>;
    fetchArtifactWithBody?: (artifactId: string) => Promise<DecryptedArtifact | null>;
    updateArtifact?: (artifact: DecryptedArtifact) => void;
    request: (path: string, init?: RequestInit) => Promise<Response>;
    onLocalPendingProjectionCreated?: (event: Readonly<{ localId: string }>) => void;
    outboxScope: ServerAccountScope;
    requestedAction: PendingRequestedActionV1;
    wireMode: PendingInputServerWireMode;
    onWireContractMismatch?: () => void | Promise<void>;
}): Promise<PendingMessageEnqueueResultV2> {
    const { sessionId, text, displayText, encryption, request, metaOverrides } = params;
    const outboxScope = params.outboxScope;

    storage.getState().markSessionOptimisticThinking(sessionId);

    const session = storage.getState().sessions[sessionId];
    if (!session) {
        storage.getState().clearSessionOptimisticThinking(sessionId);
        throw new Error(`Session ${sessionId} not found in storage`);
    }
    if (params.localId !== undefined && readPendingLocalId(params.localId) === null) {
        storage.getState().clearSessionOptimisticThinking(sessionId);
        throw new Error('Pending localId must not be blank');
    }
    const requestedLocalId = readPendingLocalId(params.localId) ?? '';
    const localId = requestedLocalId || randomUUID();
    const existingOutboxRow = requestedLocalId
        ? findPendingOutboxMessage(sessionId, requestedLocalId, outboxScope)
        : null;
    if (existingOutboxRow?.operation === 'quarantined') {
        ensurePendingOutboxQuarantineProjection(existingOutboxRow, outboxScope);
        storage.getState().clearSessionOptimisticThinking(sessionId);
        return { localId, accepted: false, terminal: true };
    }
    const frozenEnvelope = existingOutboxRow
        ? readPendingEnqueueFrozenEnvelope(existingOutboxRow.request.body)
        : null;
    if (existingOutboxRow && !frozenEnvelope) {
        storage.getState().clearSessionOptimisticThinking(sessionId);
        throw new Error('Persisted pending outbox envelope is invalid');
    }
    const requestedAction = frozenEnvelope?.requestedAction
        ?? PendingRequestedActionV1Schema.parse(params.requestedAction);
    const deliveryMode = existingOutboxRow
        ? frozenEnvelope?.deliveryMode
        : params.deliveryMode;
    const wireMode = params.wireMode;
    if (
        wireMode === 'released_server_v0_2_1'
        && (requestedAction.kind !== 'enqueue' || deliveryMode !== undefined)
    ) {
        storage.getState().clearSessionOptimisticThinking(sessionId);
        throw createPendingServerUpgradeRequiredError();
    }
    const sessionEncryptionMode: 'e2ee' | 'plain' = session.encryptionMode === 'plain' ? 'plain' : 'e2ee';
    const permissionMode = session.permissionMode || 'default';
    const flavor = session.metadata?.flavor;
    const agentId = resolveAgentIdFromFlavor(flavor);
    const candidateRawRecord: unknown = existingOutboxRow?.rawRecord ?? buildOutgoingUserTextRecord({
        text,
        sentFrom: resolveSentFrom(),
        displayText,
        agentId,
        modelMode: session.modelMode,
        permissionMode,
        settings: storage.getState().settings,
        session,
        metaOverrides,
    });
    const parsedRawRecord = RawRecordSchema.safeParse(candidateRawRecord);
    const rawRecord = parsedRawRecord.success && parsedRawRecord.data.role === 'user'
        ? parsedRawRecord.data
        : null;
    if (!rawRecord && !existingOutboxRow) {
        storage.getState().clearSessionOptimisticThinking(sessionId);
        throw new Error('Persisted pending outbox projection is invalid');
    }
    const canonicalText = existingOutboxRow?.text ?? text;
    const canonicalDisplayText = existingOutboxRow?.displayText ?? displayText;
    const createdAt = existingOutboxRow?.createdAt ?? nowServerMs();
    const updatedAt = createdAt;

    const authoritativeServerProjection = existingOutboxRow
        ? findCanonicalServerPendingProjection(sessionId, localId, outboxScope)
        : null;
    const existingLocalProjection = existingOutboxRow
        ? findPendingOutboxProjection(sessionId, localId, outboxScope)
        : null;
    if (!authoritativeServerProjection && !existingLocalProjection && (existingOutboxRow || rawRecord)) {
        const identity = { sessionId, localId, outboxScope } satisfies PendingOutboxProjectionIdentity;
        storage.getState().upsertPendingMessage(sessionId, existingOutboxRow
            ? buildPendingOutboxProjection(existingOutboxRow, outboxScope)
            : {
                id: allocatePendingOutboxProjectionId({
                    identity,
                    quarantined: false,
                    occupiedMessages: [
                        ...(storage.getState().sessionPending[sessionId]?.messages ?? []),
                        ...(storage.getState().sessionPending[sessionId]?.discarded ?? []),
                    ],
                }),
                localId,
                createdAt,
                updatedAt,
                source: 'local_outbound',
                deliveryStatus: 'queued',
                pendingOutboxScope: outboxScope,
                pendingOutboxOperation: 'enqueue',
                requestedAction,
                text: canonicalText,
                displayText: canonicalDisplayText,
                rawRecord: rawRecord!,
            });
        params.onLocalPendingProjectionCreated?.({ localId });
    }

    let serverCommitMayExist = false;
    try {
        const outcome = await runPendingEnqueueCommitInOrder(outboxScope, sessionId, async () => {
            const sessionEncryption = existingOutboxRow || sessionEncryptionMode === 'plain'
                ? null
                : await encryption.getSessionEncryption(sessionId);
            if (!existingOutboxRow && sessionEncryptionMode === 'e2ee' && !sessionEncryption) {
                throw new Error(`Session ${sessionId} not found`);
            }
            if (!existingOutboxRow) {
                savePendingOutboxMessage({
                    sessionId,
                    localId,
                    createdAt,
                    text: canonicalText,
                    displayText: canonicalDisplayText,
                    rawRecord: rawRecord!,
                    request: {
                        v: 1,
                        body: JSON.stringify(sessionEncryptionMode === 'plain'
                            ? { localId, content: { t: 'plain' as const, v: rawRecord! }, messageRole: 'user' as const, requestedAction, ...(deliveryMode ? { deliveryMode } : {}) }
                            : { localId, ciphertext: await sessionEncryption!.encryptRawRecord(rawRecord!), messageRole: 'user' as const, requestedAction, ...(deliveryMode ? { deliveryMode } : {}) }),
                    },
                }, outboxScope);
            }
            if (isPendingCancellationRequested(outboxScope, sessionId, localId)) {
                markPendingOutboxMessageCancelRequested(sessionId, localId, outboxScope);
            }
            const outboxRow = findPendingOutboxMessage(sessionId, localId, outboxScope);
            if (!outboxRow) {
                return { committed: false, cancelled: false, settled: true };
            }
            if (outboxRow.operation === 'cancel') {
                await completePendingOutboxCancellationIfRequested({ sessionId, localId, outboxScope, request });
                return { committed: false, cancelled: true, settled: false };
            }
            if (wireMode === 'indeterminate') {
                return { committed: false, cancelled: false, settled: false, waitingForWireMode: true as const };
            }

            // A scoped request wrapper can reject after the underlying transport has returned.
            // Treat an entered write as ambiguous until an explicit non-success response proves
            // rejection, so postflight scope fencing cannot destroy exact durable custody.
            serverCommitMayExist = true;
            const response = await request(`/v2/sessions/${sessionId}/pending`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: serializePendingEnqueueBodyForWire({
                    canonicalBody: outboxRow.request.body,
                    wireMode,
                    requestedAction,
                    ...(deliveryMode ? { deliveryMode } : {}),
                }),
            });
            if (!response.ok) {
                serverCommitMayExist = false;
                assertPendingResponseOk(response, 'Failed to enqueue pending message');
            }
            const payload = await response.json().catch(() => null) as unknown;
            assertPendingEnqueueAcknowledgedAndRefreshOnMismatch({
                payload,
                wireMode,
                localId,
                requestedAction,
                onWireContractMismatch: params.onWireContractMismatch,
            });
            // The acknowledgement is a fact about THIS RESPONSE: a 2xx that proves the exact row (or
            // its exact committed twin) means the server took custody, so a snapshot read issued
            // BEFORE it cannot list the row and must not be applied over it. Recorded here, above
            // every branch below, for the same reason the two PATCH boundaries record at their
            // response: the branches below decide what happened to LOCAL custody, which is a
            // different question, and each of their early returns would otherwise leave the fence
            // relying on `apiSocket.request`'s in-flight de-dupe — the very mechanism that creates
            // the losing ordering — rather than on the invariant.
            markPendingLocalIdAcceptedAfterSnapshotCapture(outboxScope, sessionId, localId);
            const terminal = isPlainObject(payload) && payload.terminal === true;
            if (deliveryMode === 'external_handoff') {
                const pending = isPlainObject(payload) && isPlainObject(payload.pending) ? payload.pending : null;
                const status = pending ? parsePendingDeliveryStatusV1(pending.deliveryStatus) : null;
                if (status?.status !== 'external_handoff') {
                    throw new Error('Server did not atomically claim external handoff');
                }
                // The acknowledgement proves unresolved provider custody before any concurrent
                // durable cancellation can complete and remove the local projection.
                markConfirmedExternalHandoffProjection({
                    sessionId,
                    persisted: outboxRow,
                    outboxScope,
                    rawRecord,
                });
            }
            if (!findPendingOutboxMessage(sessionId, localId, outboxScope)) {
                return { committed: true, cancelled: false, settled: true, terminal };
            }
            if (isPendingCancellationRequested(outboxScope, sessionId, localId)) {
                markPendingOutboxMessageCancelRequested(sessionId, localId, outboxScope);
            }
            const cancellationCompleted = await completePendingOutboxCancellationIfRequested({ sessionId, localId, outboxScope, request });
            if (cancellationCompleted) {
                return { committed: true, cancelled: true, settled: false };
            }
            const currentAfterCancellationYield = findPendingOutboxMessage(sessionId, localId, outboxScope);
            if (!currentAfterCancellationYield) {
                return { committed: true, cancelled: false, settled: true, terminal };
            }
            if (currentAfterCancellationYield.operation !== 'enqueue') {
                if (currentAfterCancellationYield.operation === 'cancel'
                    && await completePendingOutboxCancellationIfRequested({ sessionId, localId, outboxScope, request })) {
                    return { committed: true, cancelled: true, settled: false };
                }
                return { committed: true, cancelled: false, settled: true, terminal };
            }
            removePendingOutboxMessage(sessionId, localId, outboxScope);
            if (deliveryMode !== 'external_handoff') {
                if (rawRecord) {
                    markPendingOutboxProjectionAcceptedIfOwned(
                        sessionId,
                        localId,
                        outboxScope,
                        rawRecord,
                    );
                } else {
                    removePendingOutboxProjectionIfOwned(sessionId, localId, outboxScope);
                }
            }
            return { committed: true, cancelled: false, settled: false, terminal };
        });

        if ('waitingForWireMode' in outcome && outcome.waitingForWireMode === true) {
            storage.getState().clearSessionOptimisticThinking(sessionId);
            return { localId, accepted: false, waitingForWireMode: true };
        }

        if (outcome.settled) {
            removeSettledPendingOutboxLocalProjectionIfOwned(sessionId, localId, outboxScope);
            storage.getState().clearSessionOptimisticThinking(sessionId);
            return { localId, accepted: true, settled: true };
        }

        if (outcome.cancelled) {
            if (findPendingOutboxProjection(sessionId, localId, outboxScope)?.pendingDeliveryStatus === 'external_handoff') {
                clearDeletedPendingLocalId(outboxScope, sessionId, localId);
            }
            removeProjectionsAfterConfirmedCancellation(sessionId, localId, outboxScope);
            storage.getState().clearSessionOptimisticThinking(sessionId);
            return { localId, accepted: true, cancelled: true };
        }

        return {
            localId,
            accepted: true,
            ...(outcome.terminal ? { terminal: true as const } : {}),
            ...(deliveryMode === 'external_handoff' ? { externalHandoffClaimed: true as const } : {}),
        };
    } catch (e) {
        if (isTransientConnectivityError(e)) {
            // The write did not confirm (stalled/aborted server). Keep the message durably visible
            // as "unconfirmed" (spinner + retry underway) instead of a silent perpetual spinner, and
            // let the caller schedule the enqueue retry that owns the eventual failed transition.
            // The persisted outbox row is intentionally retained for replay.
            setPendingMessageSendState(sessionId, localId, 'unconfirmed', outboxScope);
            storage.getState().clearSessionOptimisticThinking(sessionId);
            return { localId, accepted: false };
        }
        if (serverCommitMayExist) {
            setPendingMessageSendState(sessionId, localId, 'unconfirmed', outboxScope);
            storage.getState().clearSessionOptimisticThinking(sessionId);
            return { localId, accepted: false };
        }
        if (existingOutboxRow) {
            setPendingMessageSendState(sessionId, localId, 'unconfirmed', outboxScope);
            storage.getState().clearSessionOptimisticThinking(sessionId);
            throw e;
        }
        if (isPendingCancellationRequested(outboxScope, sessionId, localId)) {
            clearDeletedPendingLocalId(outboxScope, sessionId, localId);
            storage.getState().clearSessionOptimisticThinking(sessionId);
            throw e;
        }
        // A definitive initial rejection happened before any ambiguous retry state existed.
        removePendingOutboxMessage(sessionId, localId, outboxScope);
        removePendingOutboxProjectionIfOwned(sessionId, localId, outboxScope);
        storage.getState().clearSessionOptimisticThinking(sessionId);
        throw e;
    }
}

/**
 * Replay the persisted outbox for a session on open: re-hydrate any durable rows that are not
 * already present in the in-memory pending slice as `local_outbound`/`unconfirmed` so they are
 * visible and retriable, and return the localIds that need an enqueue retry scheduled. Rows that
 * the server has already resolved are reconciled and cleared by the subsequent pending refresh +
 * retry (which re-POSTs with the same localId; the server dedupes).
 */
export function replayPersistedPendingOutboxForSession(
    sessionId: string,
    outboxScope: ServerAccountScope,
): string[] {
    const persisted = loadPendingOutboxForSession(sessionId, outboxScope);
    if (persisted.length === 0) return [];

    const existing = storage.getState().sessionPending[sessionId]?.messages ?? [];
    const serverOwnedLocalIds = new Set(existing
        .filter((message) => message.source === 'server_pending'
            && (!message.pendingOutboxScope || areServerAccountScopesEqual(message.pendingOutboxScope, outboxScope)))
        .map((message) => message.localId ?? message.id));
    const discardedServerOwnedLocalIds = new Set(
        (storage.getState().sessionPending[sessionId]?.discarded ?? [])
            .filter((message) => message.source === 'server_pending')
            .map((message) => message.localId ?? message.id),
    );
    const existingProjectionKeys = new Set<string>();
    for (const message of existing) {
        if (!isPendingOutboxProjectionInScope(message, outboxScope)) continue;
        const projectionKey = pendingOutboxProjectionIdentityKey({
            sessionId,
            localId: message.localId ?? message.id,
            outboxScope,
        });
        if (message.pendingOutboxQuarantineReason === undefined && message.source === 'local_outbound') {
            existingProjectionKeys.add(projectionKey);
        }
    }

    const localIdsNeedingRetry: string[] = [];
    for (const row of persisted) {
        const discardedServerOwnsIdentity = discardedServerOwnedLocalIds.has(row.localId);
        if (discardedServerOwnsIdentity && row.operation === 'enqueue') {
            removePendingOutboxMessage(sessionId, row.localId, outboxScope);
            continue;
        }
        const existingProjection = findPendingOutboxProjection(sessionId, row.localId, outboxScope);
        if (row.operation !== 'quarantined' && existingProjection?.sendState !== 'failed') {
            localIdsNeedingRetry.push(row.localId);
        }
        const projectionKey = pendingOutboxProjectionIdentityKey({ sessionId, localId: row.localId, outboxScope });
        if (row.operation === 'quarantined') {
            ensurePendingOutboxQuarantineProjection(row, outboxScope);
            continue;
        }
        if (serverOwnedLocalIds.has(row.localId) || discardedServerOwnsIdentity) continue;
        if (existingProjectionKeys.has(projectionKey)) continue;
        storage.getState().upsertPendingMessage(sessionId, buildPendingOutboxProjection(row, outboxScope));
    }
    return localIdsNeedingRetry;
}

export async function retryPendingOutboxOperationV2(params: {
    sessionId: string;
    localId: string;
    request: (path: string, init?: RequestInit) => Promise<Response>;
    outboxScope: ServerAccountScope;
    wireMode: PendingInputServerWireMode;
    onWireContractMismatch?: () => void | Promise<void>;
}): Promise<Readonly<{ accepted: boolean; terminal?: true; waitingForWireMode?: true }>> {
    const { sessionId, localId, request } = params;
    assertSafePendingIdPathSegment(localId);
    const outboxScope = params.outboxScope;
    const persisted = findPendingOutboxMessage(sessionId, localId, outboxScope);
    if (!persisted) return { accepted: true };
    if (persisted.operation === 'quarantined') {
        ensurePendingOutboxQuarantineProjection(persisted, outboxScope);
        return { accepted: false, terminal: true };
    }
    const pendingLocalId = persisted.localId;
    const existing = findPendingOutboxProjection(sessionId, pendingLocalId, outboxScope);
    const parsed = RawRecordSchema.safeParse(persisted.rawRecord);
    const deliveryMode = readPendingEnqueueDeliveryMode(persisted.request.body);
    const requestedAction = readPendingEnqueueRequestedAction(persisted.request.body);
    const wireMode = params.wireMode;
    const projectionRawRecord = parsed.success && parsed.data.role === 'user' ? parsed.data : null;
    if (!requestedAction) {
        const projection = existing ?? buildPendingOutboxProjection(persisted, outboxScope);
        storage.getState().upsertPendingMessage(sessionId, {
            ...projection,
            requestedAction: undefined,
            requestedActionMalformed: true,
            pendingDeliveryStatus: 'blocked',
            pendingDeliveryBlockedReason: 'unsupported_action',
            sendState: undefined,
        });
        return { accepted: false, terminal: true };
    }
    if (
        wireMode === 'released_server_v0_2_1'
        && (requestedAction.kind !== 'enqueue' || deliveryMode !== undefined)
    ) {
        throw createPendingServerUpgradeRequiredError();
    }

    let serverCommitMayExist = false;
    try {
        const outcome = await runPendingEnqueueCommitInOrder(outboxScope, sessionId, async () => {
            if (isPendingCancellationRequested(outboxScope, sessionId, pendingLocalId)) {
                markPendingOutboxMessageCancelRequested(sessionId, pendingLocalId, outboxScope);
            }
            const current = findPendingOutboxMessage(sessionId, pendingLocalId, outboxScope);
            if (current?.operation === 'cancel') {
                await completePendingOutboxCancellationIfRequested({
                    sessionId,
                    localId: pendingLocalId,
                    outboxScope,
                    request,
                });
                return { committed: false, cancelled: true };
            }
            if (!current) return { committed: false, cancelled: false, settled: true };
            if (wireMode === 'indeterminate') {
                return { committed: false, cancelled: false, waitingForWireMode: true as const };
            }

            if (deliveryMode === 'external_handoff'
                && !findPendingOutboxProjection(sessionId, pendingLocalId, outboxScope)) {
                storage.getState().upsertPendingMessage(
                    sessionId,
                    buildPendingOutboxProjection(current, outboxScope),
                );
            }

            // Keep exact replay custody ambiguous if the request wrapper rejects in its
            // postflight scope fence after the transport may already have committed.
            serverCommitMayExist = true;
            const response = await request(`/v2/sessions/${sessionId}/pending`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: serializePendingEnqueueBodyForWire({
                    canonicalBody: current.request.body,
                    wireMode,
                    requestedAction,
                    ...(deliveryMode ? { deliveryMode } : {}),
                }),
            });
            if (!response.ok) {
                serverCommitMayExist = false;
                assertPendingResponseOk(response, 'Failed to enqueue pending message');
            }
            const payload = await response.json().catch(() => null) as unknown;
            assertPendingEnqueueAcknowledgedAndRefreshOnMismatch({
                payload,
                wireMode,
                localId: pendingLocalId,
                requestedAction,
                onWireContractMismatch: params.onWireContractMismatch,
            });
            // The replay POST is an acknowledgement exactly like the initial enqueue above, and is
            // recorded at the response for the same reason: every branch below reads LOCAL custody,
            // and each of their early returns is downstream of the fact the server already stated.
            markPendingLocalIdAcceptedAfterSnapshotCapture(outboxScope, sessionId, pendingLocalId);
            if (deliveryMode === 'external_handoff') {
                const pending = isPlainObject(payload) && isPlainObject(payload.pending) ? payload.pending : null;
                const status = pending ? parsePendingDeliveryStatusV1(pending.deliveryStatus) : null;
                if (status?.status !== 'external_handoff') {
                    throw new Error('Server did not retain external handoff');
                }
                // Stamp only from the confirmed response and the frozen enqueue delivery mode,
                // before a concurrent cancellation can finish its DELETE.
                markConfirmedExternalHandoffProjection({
                    sessionId,
                    persisted: current,
                    outboxScope,
                    rawRecord: projectionRawRecord,
                });
            }
            if (!findPendingOutboxMessage(sessionId, pendingLocalId, outboxScope)) {
                return { committed: true, cancelled: false, settled: true };
            }
            if (isPendingCancellationRequested(outboxScope, sessionId, pendingLocalId)) {
                markPendingOutboxMessageCancelRequested(sessionId, pendingLocalId, outboxScope);
            }
            const cancellationCompleted = await completePendingOutboxCancellationIfRequested({
                sessionId,
                localId: pendingLocalId,
                outboxScope,
                request,
            });
            if (cancellationCompleted) {
                return { committed: true, cancelled: true };
            }
            const currentAfterCancellationYield = findPendingOutboxMessage(sessionId, pendingLocalId, outboxScope);
            if (!currentAfterCancellationYield) {
                return { committed: true, cancelled: false, settled: true };
            }
            if (currentAfterCancellationYield.operation !== 'enqueue') {
                if (currentAfterCancellationYield.operation === 'cancel'
                    && await completePendingOutboxCancellationIfRequested({
                        sessionId,
                        localId: pendingLocalId,
                        outboxScope,
                        request,
                    })) {
                    return { committed: true, cancelled: true };
                }
                return { committed: true, cancelled: false, settled: true };
            }

            // The server enqueue acknowledgement is the durable UI-success boundary.
            removePendingOutboxMessage(sessionId, pendingLocalId, outboxScope);
            const projectionAccepted = deliveryMode === 'external_handoff'
                ? false
                : projectionRawRecord
                ? markPendingOutboxProjectionAcceptedIfOwned(
                    sessionId,
                    pendingLocalId,
                    outboxScope,
                    projectionRawRecord,
                )
                : (removePendingOutboxProjectionIfOwned(sessionId, pendingLocalId, outboxScope), false);
            if (projectionAccepted) {
                storage.getState().markSessionOptimisticThinking(sessionId);
            }
            return { committed: true, cancelled: false, settled: false };
        });

        if ('waitingForWireMode' in outcome && outcome.waitingForWireMode === true) {
            return { accepted: false, waitingForWireMode: true };
        }

        if (outcome.settled) {
            removeSettledPendingOutboxLocalProjectionIfOwned(sessionId, pendingLocalId, outboxScope);
            return { accepted: true };
        }

        if (outcome.cancelled) {
            removePendingOutboxMessage(sessionId, pendingLocalId, outboxScope);
            if (findPendingOutboxProjection(sessionId, pendingLocalId, outboxScope)?.pendingDeliveryStatus === 'external_handoff') {
                clearDeletedPendingLocalId(outboxScope, sessionId, pendingLocalId);
            }
            removeProjectionsAfterConfirmedCancellation(sessionId, pendingLocalId, outboxScope);
            if (existing) storage.getState().clearSessionOptimisticThinking(sessionId);
            return { accepted: true };
        }

        return { accepted: true };
    } catch (e) {
        if (isTransientConnectivityError(e)) {
            setPendingMessageSendState(sessionId, pendingLocalId, 'unconfirmed', outboxScope);
            if (existing) storage.getState().clearSessionOptimisticThinking(sessionId);
            return { accepted: false };
        }
        if (serverCommitMayExist) {
            setPendingMessageSendState(sessionId, pendingLocalId, 'unconfirmed', outboxScope);
            if (existing) storage.getState().clearSessionOptimisticThinking(sessionId);
            throw e;
        }
        setPendingMessageSendState(sessionId, pendingLocalId, 'failed', outboxScope);
        if (existing) storage.getState().clearSessionOptimisticThinking(sessionId);
        throw e;
    }
}

export async function updatePendingMessageV2(params: {
    sessionId: string;
    pendingId: string;
    text: string;
    encryption: PendingQueueEncryption;
    fetchArtifactWithBody?: (artifactId: string) => Promise<DecryptedArtifact | null>;
    updateArtifact?: (artifact: DecryptedArtifact) => void;
    request: (path: string, init?: RequestInit) => Promise<Response>;
    outboxScope: ServerAccountScope;
}): Promise<void> {
    const { sessionId, text, encryption, request } = params;
    const mutationTarget = resolvePendingServerMutationTarget(sessionId, params.pendingId, params.outboxScope);
    const pendingId = mutationTarget.localId;
    assertPendingOutboxTransportAllowed(sessionId, pendingId, params.outboxScope);

    const session = storage.getState().sessions[sessionId] ?? null;
    const sessionEncryptionMode: 'e2ee' | 'plain' = session?.encryptionMode === 'plain' ? 'plain' : 'e2ee';
    const sessionEncryption = sessionEncryptionMode === 'plain' ? null : await encryption.getSessionEncryption(sessionId);
    if (sessionEncryptionMode === 'e2ee' && !sessionEncryption) {
        throw new Error(`Session ${sessionId} not found`);
    }

    const existing = findCurrentPendingServerMutationProjection(sessionId, mutationTarget, params.outboxScope);
    if (!existing) {
        throw new Error('Pending message not found');
    }
    const pendingOutbox = findPendingOutboxMessage(sessionId, pendingId, params.outboxScope);
    if (pendingOutbox?.operation === 'cancel') {
        throw new Error('Pending message cancellation is outstanding');
    }

    const rawRecord: RawRecord = (() => {
        if (existing.rawRecord) {
            const parsed = RawRecordSchema.safeParse(existing.rawRecord);
            if (parsed.success && parsed.data.role === 'user' && parsed.data.content.type === 'text') {
                const record = parsed.data;
                const existingMeta = isPlainObject(record.meta) ? record.meta : {};
                const { appendSystemPrompt: _appendSystemPrompt, ...nextMeta } = existingMeta;
                return {
                    ...record,
                    content: { type: 'text', text },
                    meta: nextMeta,
                };
            }
        }

        const session = storage.getState().sessions[sessionId] ?? null;
        const permissionMode = session?.permissionMode || 'default';
        const flavor = session?.metadata?.flavor;
        const agentId = resolveAgentIdFromFlavor(flavor);
        return buildOutgoingUserTextRecord({
            text,
            sentFrom: resolveSentFrom(),
            displayText: existing.pendingDecryptFailure
                ? undefined
                : (typeof existing.displayText === 'string' ? existing.displayText : undefined),
            agentId,
            modelMode: session?.modelMode,
            permissionMode,
            settings: storage.getState().settings,
            session,
        });
    })();

    const writeBody =
        sessionEncryptionMode === 'plain'
            ? { content: { t: 'plain', v: rawRecord }, messageRole: 'user' }
            : { ciphertext: await sessionEncryption!.encryptRawRecord(rawRecord), messageRole: 'user' };
    const updatedAt = nowServerMs();

    const response = await request(pendingMessagePath(sessionId, pendingId), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(writeBody),
    });
    if (!response.ok) {
        assertPendingResponseOk(response, 'Failed to update pending message');
    }

    // The PATCH is ITSELF an acknowledgement: a 2xx proves the server holds a pending row for this
    // localId, so a snapshot read issued BEFORE it cannot list that row and must not be applied over
    // it. Recorded here — at the RESPONSE — and not at the custody retirement below, because that
    // retirement is conditional on durable `enqueue` custody a canonical server row need not carry,
    // and because the acknowledgement is a fact about the response rather than about whichever
    // branch this client happens to take afterwards.
    markPendingLocalIdAcceptedAfterSnapshotCapture(params.outboxScope, sessionId, pendingId);
    supersedePendingSnapshotRefreshForLocalWrite(params.outboxScope, sessionId);
    const currentPendingOutbox = findPendingOutboxMessage(sessionId, pendingId, params.outboxScope);
    if (currentPendingOutbox?.operation === 'cancel') return;
    const currentProjection = findCurrentPendingServerMutationProjection(sessionId, mutationTarget, params.outboxScope);
    if (!currentProjection) return;
    if (currentPendingOutbox?.operation === 'enqueue') {
        removePendingOutboxMessage(sessionId, pendingId, params.outboxScope);
    }
    storage.getState().upsertPendingMessage(sessionId, {
        ...currentProjection,
        pendingDecryptFailure: undefined,
        text,
        updatedAt,
        rawRecord,
        displayText: currentProjection.pendingDecryptFailure ? undefined : currentProjection.displayText,
    });
    if (currentPendingOutbox?.operation === 'enqueue') {
        markPendingProjectionAcknowledgedIfOwned(sessionId, pendingId, params.outboxScope);
    }
}

export async function updatePendingRequestedActionV2(params: {
    sessionId: string;
    localId: string;
    requestedAction: PendingRequestedActionV1;
    request: (path: string, init?: RequestInit) => Promise<Response>;
    outboxScope: ServerAccountScope;
    wireMode: PendingInputServerWireMode;
}): Promise<void> {
    if (params.wireMode !== 'pending_input_v1') {
        throw createPendingServerUpgradeRequiredError();
    }
    const localId = params.localId;
    assertPendingOutboxTransportAllowed(params.sessionId, localId, params.outboxScope);
    const response = await params.request(`${pendingMessagePath(params.sessionId, localId)}/action`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestedAction: params.requestedAction }),
    });
    const payload = await response.json().catch(() => null) as { error?: unknown; didUpdate?: unknown } | null;
    if (!response.ok) {
        const errorCode = typeof payload?.error === 'string' ? payload.error : undefined;
        throw Object.assign(
            new Error(`Failed to update Pending requested action (${response.status})`),
            ...(errorCode ? [{ code: errorCode }] : []),
        );
    }
    // Recorded at the RESPONSE, for the reason given in `updatePendingMessageV2`: the PATCH
    // succeeded, so the server holds the row, and every guard below — including the malformed-payload
    // throw — is downstream of that fact.
    markPendingLocalIdAcceptedAfterSnapshotCapture(params.outboxScope, params.sessionId, localId);
    if (typeof payload?.didUpdate !== 'boolean') {
        throw new Error('Pending requested-action response is missing didUpdate');
    }
    const currentOutbox = findPendingOutboxMessage(
        params.sessionId,
        localId,
        params.outboxScope,
    );
    if (currentOutbox?.operation === 'enqueue') {
        removePendingOutboxMessage(params.sessionId, localId, params.outboxScope);
    }
    markPendingProjectionAcknowledgedIfOwned(
        params.sessionId,
        localId,
        params.outboxScope,
    );
    supersedePendingSnapshotRefreshForLocalWrite(params.outboxScope, params.sessionId);
}

export async function deletePendingMessageV2(params: {
    sessionId: string;
    pendingId: string;
    request: (path: string, init?: RequestInit) => Promise<Response>;
    outboxScope: ServerAccountScope;
}): Promise<void> {
    const { sessionId, request } = params;
    const mutationTarget = resolvePendingServerMutationTarget(sessionId, params.pendingId, params.outboxScope);
    const pendingId = mutationTarget.localId;
    assertPendingOutboxTransportAllowed(sessionId, pendingId, params.outboxScope);
    const identity = { sessionId, localId: pendingId, outboxScope: params.outboxScope } satisfies PendingOutboxProjectionIdentity;
    const pendingMessages = storage.getState().sessionPending[sessionId]?.messages ?? [];
    const collidingMessages = pendingMessages.filter((message) =>
        message.id === params.pendingId || message.localId === params.pendingId
    );
    const existing = mutationTarget.projection;
    if (!existing && collidingMessages.some((message) => message.pendingOutboxScope != null)) return;
    const retainedOutboxCandidate = findPendingOutboxMessage(sessionId, pendingId, params.outboxScope);
    // A quarantine diagnostic and a canonical server row may share the same opaque localId.
    // Only executable enqueue/cancel custody enters the cancellation owner.
    const retainedOutbox = retainedOutboxCandidate?.operation === 'quarantined'
        ? null
        : retainedOutboxCandidate;
    const localProjectionAwaitingPersistence = existing?.source === 'local_outbound'
        && existing.deliveryStatus === 'queued'
        && isPendingOutboxProjectionForIdentity(existing, identity);
    if (retainedOutbox || localProjectionAwaitingPersistence) {
        const localId = retainedOutbox?.localId ?? existing!.localId ?? existing!.id;
        const outboxScope = params.outboxScope;
        markPendingCancellationRequested(outboxScope, sessionId, localId);
        markPendingOutboxMessageCancelRequested(sessionId, localId, outboxScope);
        if (existing && isPendingOutboxProjectionForIdentity(existing, identity)) {
            storage.getState().upsertPendingMessage(sessionId, {
                ...existing,
                pendingOutboxOperation: 'cancel',
            });
        }
        let cancellationConfirmed = false;
        try {
            cancellationConfirmed = await runPendingEnqueueCommitInOrder(outboxScope, sessionId, async () => {
                markPendingCancellationRequested(outboxScope, sessionId, localId);
                markPendingOutboxMessageCancelRequested(
                    sessionId,
                    localId,
                    outboxScope,
                );
                return await completePendingOutboxCancellationIfRequested({ sessionId, localId, outboxScope, request });
            });
            if (cancellationConfirmed) {
                removeProjectionsAfterConfirmedCancellation(sessionId, localId, outboxScope);
            }
            const currentProjection = findPendingOutboxProjection(sessionId, localId, outboxScope);
            const currentExternalHandoff = storage.getState().sessionPending[sessionId]?.messages?.find((message) =>
                (message.localId ?? message.id) === localId
                && message.pendingDeliveryStatus === 'external_handoff'
                && (!message.pendingOutboxScope || areServerAccountScopesEqual(message.pendingOutboxScope, outboxScope))
            );
            if (currentExternalHandoff) {
                clearDeletedPendingLocalId(outboxScope, sessionId, localId);
            }
            if (!cancellationConfirmed
                && currentProjection
                && currentProjection.pendingDeliveryStatus !== 'external_handoff') {
                removePendingOutboxProjectionIfOwned(sessionId, localId, outboxScope);
            }
            storage.getState().clearSessionOptimisticThinking(sessionId);
        } catch (error) {
            clearPendingCancellationRequested(outboxScope, sessionId, localId);
            setPendingMessageSendState(sessionId, localId, 'failed', outboxScope);
            storage.getState().clearSessionOptimisticThinking(sessionId);
            throw error;
        }
        if (!cancellationConfirmed) {
            clearPendingCancellationRequested(outboxScope, sessionId, localId);
        }
        return;
    }

    const suppressStaleSnapshot = existing?.pendingDeliveryStatus !== 'external_handoff';
    const response = await request(pendingMessagePath(sessionId, pendingId), { method: 'DELETE' });
    if (!response.ok && response.status !== 404) {
        assertPendingResponseOk(response, 'Failed to delete pending message');
    }
    const currentCanonicalProjection = findCanonicalServerPendingProjection(
        sessionId,
        pendingId,
        params.outboxScope,
    );
    const currentOutboxProjection = findPendingOutboxProjection(
        sessionId,
        pendingId,
        params.outboxScope,
    );
    if (currentCanonicalProjection?.pendingDeliveryStatus === 'external_handoff'
        || currentOutboxProjection?.pendingDeliveryStatus === 'external_handoff') {
        clearDeletedPendingLocalId(params.outboxScope, sessionId, pendingId);
        return;
    }
    if (suppressStaleSnapshot) markPendingLocalIdDeleted(params.outboxScope, sessionId, pendingId);
    storage.getState().removePendingMessage(
        sessionId,
        currentCanonicalProjection?.id ?? currentOutboxProjection?.id ?? pendingId,
    );
}

export async function discardPendingMessageV2(params: {
    sessionId: string;
    pendingId: string;
    reason?: 'switch_to_local' | 'manual';
    encryption: PendingQueueReadEncryption;
    request: (path: string, init?: RequestInit) => Promise<Response>;
    outboxScope: ServerAccountScope;
    isOutboxScopeCurrent?: () => boolean | Promise<boolean>;
}): Promise<void> {
    const { sessionId, reason, encryption, request } = params;
    const mutationTarget = resolvePendingServerMutationTarget(sessionId, params.pendingId, params.outboxScope);
    const pendingId = mutationTarget.localId;
    assertPendingOutboxTransportAllowed(sessionId, pendingId, params.outboxScope);

    const response = await request(`${pendingMessagePath(sessionId, pendingId)}/discard`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
    });
    if (!response.ok) {
        assertPendingResponseOk(response, 'Failed to discard pending message');
    }
    // Owner-driven retirement: the discard committed, so this device already knows the row is no
    // longer queued. Retiring it here (as `deletePendingMessageV2` and `markPendingDeliveryHandledV2`
    // do) means the projection does not depend on the refresh below landing. It is a write into
    // this session's bucket, so it takes the same owner-scope fence the follow-up snapshot takes.
    if (params.isOutboxScopeCurrent === undefined || await params.isOutboxScopeCurrent()) {
        const existing = findCurrentPendingServerMutationProjection(sessionId, mutationTarget, params.outboxScope);
        if (existing) storage.getState().removePendingMessage(sessionId, existing.id);
    }
    await fetchAndApplyPendingMessagesV2({ sessionId, encryption, request, outboxScope: params.outboxScope, isOutboxScopeCurrent: params.isOutboxScopeCurrent });
}

export async function markPendingDeliveryHandledV2(params: {
    sessionId: string;
    pendingId: string;
    encryption: PendingQueueReadEncryption;
    request: (path: string, init?: RequestInit) => Promise<Response>;
    outboxScope: ServerAccountScope;
    isOutboxScopeCurrent?: () => boolean | Promise<boolean>;
}): Promise<void> {
    const { sessionId, encryption, request } = params;
    const mutationTarget = resolvePendingServerMutationTarget(sessionId, params.pendingId, params.outboxScope);
    const pendingId = mutationTarget.localId;
    assertPendingOutboxTransportAllowed(sessionId, pendingId, params.outboxScope);

    const response = await request(`${pendingMessagePath(sessionId, pendingId)}/delivery/handled`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
    });
    if (!response.ok) {
        assertPendingResponseOk(response, 'Failed to mark pending delivery handled');
    }
    const existing = findCurrentPendingServerMutationProjection(sessionId, mutationTarget, params.outboxScope);
    if (existing) storage.getState().removePendingMessage(sessionId, existing.id);
    await fetchAndApplyPendingMessagesV2({ sessionId, encryption, request, outboxScope: params.outboxScope, isOutboxScopeCurrent: params.isOutboxScopeCurrent });
}

export async function blockPendingDeliveryV2(params: {
    sessionId: string;
    pendingId: string;
    reason: PendingDeliveryBlockedReason;
    encryption: PendingQueueReadEncryption;
    request: (path: string, init?: RequestInit) => Promise<Response>;
    outboxScope: ServerAccountScope;
    isOutboxScopeCurrent?: () => boolean | Promise<boolean>;
}): Promise<void> {
    const { sessionId, reason, encryption, request } = params;
    const pendingId = resolvePendingServerMutationTarget(
        sessionId,
        params.pendingId,
        params.outboxScope,
    ).localId;
    assertPendingOutboxTransportAllowed(sessionId, pendingId, params.outboxScope);

    const response = await request(`${pendingMessagePath(sessionId, pendingId)}/delivery/block`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
    });
    assertPendingResponseOk(response, 'Failed to block pending delivery');
    await fetchAndApplyPendingMessagesV2({
        sessionId,
        encryption,
        request,
        outboxScope: params.outboxScope,
        isOutboxScopeCurrent: params.isOutboxScopeCurrent,
    });
}

export async function dismissPendingDeliveryV2(params: {
    sessionId: string;
    pendingId: string;
    encryption: PendingQueueReadEncryption;
    request: (path: string, init?: RequestInit) => Promise<Response>;
    outboxScope: ServerAccountScope;
    isOutboxScopeCurrent?: () => boolean | Promise<boolean>;
}): Promise<void> {
    const { sessionId, encryption, request } = params;
    const pendingId = resolvePendingServerMutationTarget(sessionId, params.pendingId, params.outboxScope).localId;
    assertPendingOutboxTransportAllowed(sessionId, pendingId, params.outboxScope);
    const response = await request(`${pendingMessagePath(sessionId, pendingId)}/delivery/dismiss`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
    });
    assertPendingResponseOk(response, 'Failed to dismiss pending delivery');
    await fetchAndApplyPendingMessagesV2({ sessionId, encryption, request, outboxScope: params.outboxScope, isOutboxScopeCurrent: params.isOutboxScopeCurrent });
}

export async function sendPendingDeliveryAsNewV2(params: {
    sessionId: string;
    pendingId: string;
    encryption: PendingQueueReadEncryption;
    request: (path: string, init?: RequestInit) => Promise<Response>;
    outboxScope: ServerAccountScope;
    isOutboxScopeCurrent?: () => boolean | Promise<boolean>;
}): Promise<void> {
    const { sessionId, encryption, request } = params;
    const pendingId = resolvePendingServerMutationTarget(sessionId, params.pendingId, params.outboxScope).localId;
    assertPendingOutboxTransportAllowed(sessionId, pendingId, params.outboxScope);
    const response = await request(`${pendingMessagePath(sessionId, pendingId)}/delivery/send-as-new`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
    });
    assertPendingResponseOk(response, 'Failed to send pending delivery as new');
    await fetchAndApplyPendingMessagesV2({ sessionId, encryption, request, outboxScope: params.outboxScope, isOutboxScopeCurrent: params.isOutboxScopeCurrent });
}

export async function restoreDiscardedPendingMessageV2(params: {
    sessionId: string;
    pendingId: string;
    encryption: PendingQueueReadEncryption;
    request: (path: string, init?: RequestInit) => Promise<Response>;
    outboxScope: ServerAccountScope;
    isOutboxScopeCurrent?: () => boolean | Promise<boolean>;
}): Promise<void> {
    const { sessionId, pendingId, encryption, request } = params;
    assertPendingOutboxTransportAllowed(sessionId, pendingId, params.outboxScope);

    const response = await request(`${pendingMessagePath(sessionId, pendingId)}/restore`, { method: 'POST' });
    if (!response.ok) {
        assertPendingResponseOk(response, 'Failed to restore discarded message');
    }
    await fetchAndApplyPendingMessagesV2({ sessionId, encryption, request, outboxScope: params.outboxScope, isOutboxScopeCurrent: params.isOutboxScopeCurrent });
}

export async function deleteDiscardedPendingMessageV2(params: {
    sessionId: string;
    pendingId: string;
    encryption: PendingQueueReadEncryption;
    request: (path: string, init?: RequestInit) => Promise<Response>;
    outboxScope: ServerAccountScope;
    isOutboxScopeCurrent?: () => boolean | Promise<boolean>;
}): Promise<void> {
    const { sessionId, pendingId, encryption, request } = params;
    assertPendingOutboxTransportAllowed(sessionId, pendingId, params.outboxScope);

    const response = await request(pendingMessagePath(sessionId, pendingId), { method: 'DELETE' });
    if (!response.ok && response.status !== 404) {
        assertPendingResponseOk(response, 'Failed to delete discarded message');
    }
    markPendingLocalIdDeleted(params.outboxScope, sessionId, pendingId);
    await fetchAndApplyPendingMessagesV2({ sessionId, encryption, request, outboxScope: params.outboxScope, isOutboxScopeCurrent: params.isOutboxScopeCurrent });
}

export async function reorderPendingMessagesV2(params: {
    sessionId: string;
    orderedLocalIds: string[];
    encryption: PendingQueueReadEncryption;
    request: (path: string, init?: RequestInit) => Promise<Response>;
    outboxScope: ServerAccountScope;
    isOutboxScopeCurrent?: () => boolean | Promise<boolean>;
}): Promise<void> {
    const { sessionId, orderedLocalIds, encryption, request } = params;
    for (const localId of orderedLocalIds) {
        assertPendingOutboxTransportAllowed(sessionId, localId, params.outboxScope);
    }

    const response = await request(`/v2/sessions/${sessionId}/pending/reorder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderedLocalIds }),
    });
    if (!response.ok) {
        assertPendingResponseOk(response, 'Failed to reorder pending messages');
    }
    await fetchAndApplyPendingMessagesV2({ sessionId, encryption, request, outboxScope: params.outboxScope, isOutboxScopeCurrent: params.isOutboxScopeCurrent });
}
