import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import {
    storage,
} from '@/sync/domains/state/storage';
import {
    findPendingOutboxMessage,
    isPendingOutboxMessageQuarantined,
    loadPendingOutboxForSession,
    markPendingOutboxMessageCancelRequested,
    removePendingOutboxMessage,
    savePendingOutboxMessage,
    type PersistedPendingOutboxMessage,
} from '@/sync/domains/state/pendingOutboxPersistence';
import type { Encryption } from '@/sync/encryption/encryption';
import { nowServerMs } from '@/sync/runtime/time';
import {
    RawRecordSchema,
    type RawRecord,
} from '@/sync/typesRaw';
import { randomUUID } from '@/platform/randomUUID';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import type {
    DiscardedPendingMessage,
    PendingDeliveryStatus,
    PendingMessage,
} from '@/sync/domains/state/storageTypes';
import {
    buildLocalOutboundPendingUserMessage,
    buildOutgoingUserTextRecord,
} from '@/sync/domains/messages/outgoingUserMessage';
import { isDemoModeActive } from '@/demoMode/runtime/enterExitDemoMode';
import {
    normalizePendingDeliveryStatusV1,
    readPendingLocalId,
    normalizePendingDeliveryBlockedReason,
    parsePendingDeliveryStatusV1,
    PendingRequestedActionV1Schema,
    DEFAULT_PENDING_REQUESTED_ACTION_V1,
    SessionStoredMessageContentSchema,
    type PendingDeliveryBlockedReason,
    type PendingDeliveryStatusV1,
    type PendingRequestedActionV1,
    type SessionStoredMessageContent,
} from '@happier-dev/protocol';
import { t } from '@/text';
import { HappyError } from '@/utils/errors/errors';
import { isTransientConnectivityError } from '@/sync/runtime/connectivity/transientConnectivityErrors';
import {
    serverAccountScopeKeySuffix,
    type ServerAccountScope,
} from '@/sync/domains/scope/serverAccountScope';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import {
    isPendingOutboxProjectionForIdentity,
    isPendingOutboxProjectionInScope,
    pendingOutboxProjectionIdentityKey,
    type PendingOutboxProjectionIdentity,
} from './pendingOutboxProjectionIdentity';
import type { PendingInputServerWireMode } from './pendingInputServerWireContract';
import { assertValidPendingMessageId } from '@/sync/domains/pending/pendingMessageId';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';

export { assertValidPendingMessageId } from '@/sync/domains/pending/pendingMessageId';

type PendingStatus = 'queued' | 'delivering' | 'external_handoff' | 'blocked' | 'discarded' | 'unknown';

type PendingRow = {
    localId: string;
    messageRole: 'user' | 'non_user' | null;
    content: SessionStoredMessageContent | null;
    status: PendingStatus;
    statusRaw: string;
    position: number;
    createdAt: number;
    updatedAt: number;
    discardedAt: number | null;
    discardedReason: string | null;
    deliveryBlockedReason: string | null;
    deliveryStatus: PendingDeliveryStatusV1;
    authorAccountId: string | null;
    requestedAction: PendingRequestedActionV1 | null;
    requestedActionMalformed?: true;
};

type PendingDecryptFailure = Readonly<{
    kind: 'decrypt_failed';
}>;

type PendingQueueSessionEncryption = Readonly<{
    encryptRawRecord: (record: RawRecord) => Promise<string>;
}>;

export type PendingQueueEncryption = Readonly<{
    getSessionEncryption: (
        sessionId: string,
    ) => PendingQueueSessionEncryption | null | undefined | Promise<PendingQueueSessionEncryption | null | undefined>;
}>;

export function setPendingMessageSendState(
    sessionId: string,
    localId: string,
    sendState: 'unconfirmed' | 'failed' | undefined,
    outboxScope: ServerAccountScope,
): void {
    if (sendState !== undefined && !findPendingOutboxMessage(sessionId, localId, outboxScope)) return;
    const identity = { sessionId, localId, outboxScope } satisfies PendingOutboxProjectionIdentity;
    const existing = storage.getState().sessionPending[sessionId]?.messages?.find((message) =>
        isPendingOutboxProjectionForIdentity(message, identity)
    );
    if (!existing || (existing.deliveryStatus === 'accepted' && sendState !== undefined)) return;
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
        && !isPendingOutboxQuarantineDiagnostic(message)
    ) ?? null;
}

function isPendingOutboxQuarantineDiagnostic(message: PendingMessage): boolean {
    return message.source === 'local_outbound'
        && message.deliveryStatus === 'accepted'
        && message.pendingDeliveryStatus === 'blocked'
        && typeof message.pendingDeliveryBlockedReasonRaw === 'string'
        && message.pendingOutboxOperation === undefined
        && message.sendState === undefined;
}

function findCanonicalPendingProjection(
    sessionId: string,
    pendingId: string,
    outboxScope: ServerAccountScope,
): PendingMessage | null {
    const candidates = (storage.getState().sessionPending[sessionId]?.messages ?? []).filter((message) =>
        (message.id === pendingId || message.localId === pendingId)
        && (
            message.pendingOutboxScope === undefined
            || isPendingOutboxProjectionInScope(message, outboxScope)
        )
        && !isPendingOutboxQuarantineDiagnostic(message)
    );
    const localIdCandidates = candidates.filter((message) => message.localId === pendingId);
    const exactScopedLocalIdCandidates = localIdCandidates.filter((message) =>
        isPendingOutboxProjectionInScope(message, outboxScope));
    return exactScopedLocalIdCandidates.find((message) =>
        message.source === 'server_pending'
    )
        ?? exactScopedLocalIdCandidates[0]
        ?? localIdCandidates.find((message) => message.source === 'server_pending')
        ?? localIdCandidates[0]
        ?? candidates.find((message) => message.source === 'server_pending' && message.id === pendingId)
        ?? candidates.find((message) => message.source === 'server_pending')
        ?? candidates.find((message) => message.id === pendingId)
        ?? candidates[0]
        ?? null;
}

function findPendingProjectionByCanonicalLocalId(
    sessionId: string,
    localId: string,
    outboxScope: ServerAccountScope,
): PendingMessage | null {
    const candidates = (storage.getState().sessionPending[sessionId]?.messages ?? []).filter((message) =>
        (message.localId ?? message.id) === localId
        && (
            message.pendingOutboxScope === undefined
            || isPendingOutboxProjectionInScope(message, outboxScope)
        )
        && !isPendingOutboxQuarantineDiagnostic(message)
    );
    return candidates.find((message) => message.source === 'server_pending')
        ?? candidates[0]
        ?? null;
}

function removePendingOutboxProjectionIfOwned(
    sessionId: string,
    localId: string,
    outboxScope: ServerAccountScope,
): void {
    const existing = findPendingOutboxProjection(sessionId, localId, outboxScope);
    if (existing) storage.getState().removePendingMessage(sessionId, existing.id);
}

function removeLocalPendingOutboxProjectionsIfOwned(
    sessionId: string,
    localId: string,
    outboxScope: ServerAccountScope,
): void {
    const identity = { sessionId, localId, outboxScope } satisfies PendingOutboxProjectionIdentity;
    const localProjections = (storage.getState().sessionPending[sessionId]?.messages ?? []).filter((message) =>
        message.source !== 'server_pending'
        && !isPendingOutboxQuarantineDiagnostic(message)
        && isPendingOutboxProjectionForIdentity(message, identity));
    for (const projection of localProjections) {
        storage.getState().removePendingMessage(sessionId, projection.id);
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

function markPendingOutboxProjectionExternalHandoffIfOwned(
    sessionId: string,
    localId: string,
    outboxScope: ServerAccountScope,
): boolean {
    const existing = findPendingOutboxProjection(sessionId, localId, outboxScope);
    if (!existing) return false;
    storage.getState().upsertPendingMessage(sessionId, {
        ...existing,
        updatedAt: nowServerMs(),
        source: 'server_pending',
        deliveryStatus: 'accepted',
        pendingDeliveryStatus: 'external_handoff',
        sendState: undefined,
        pendingOutboxOperation: undefined,
    });
    return true;
}

function buildPendingOutboxProjection(
    row: PersistedPendingOutboxMessage,
    outboxScope: ServerAccountScope,
    occupiedProjectionIds: ReadonlySet<string> = new Set(),
    preferredProjectionId?: string,
): PendingMessage {
    const requestedAction = readPendingEnqueueRequestedAction(row.request.body);
    const frozenRawRecord = readPendingEnqueuePlainUserRecord(row);
    const parsedRawRecord = RawRecordSchema.safeParse(row.rawRecord);
    const projectionRawRecord: RawRecord = frozenRawRecord
        ?? (parsedRawRecord.success && parsedRawRecord.data.role === 'user'
            ? parsedRawRecord.data
            : { role: 'user', content: { type: 'text', text: row.text }, meta: {} });
    const projectionText = frozenRawRecord?.content.type === 'text'
        ? frozenRawRecord.content.text
        : row.text;
    if (isPendingOutboxMessageQuarantined(row)) {
        const baseProjectionId = `pending-outbox-quarantine:${pendingOutboxProjectionIdentityKey({
            sessionId: row.sessionId,
            localId: row.localId,
            outboxScope,
        })}`;
        const projectionId = allocatePendingProjectionId({
            preferredProjectionId,
            primaryProjectionId: baseProjectionId,
            fallbackProjectionId: baseProjectionId,
            occupiedProjectionIds,
        });
        return {
            id: projectionId,
            localId: row.localId,
            createdAt: row.createdAt,
            updatedAt: row.createdAt,
            source: 'local_outbound',
            deliveryStatus: 'accepted',
            pendingOutboxScope: outboxScope,
            pendingDeliveryStatus: 'blocked',
            pendingDeliveryBlockedReason: 'unknown',
            pendingDeliveryBlockedReasonRaw: row.quarantineReason,
            text: projectionText,
            displayText: row.displayText,
            rawRecord: projectionRawRecord,
        };
    }
    const baseProjectionId = `pending-outbox:${pendingOutboxProjectionIdentityKey({
        sessionId: row.sessionId,
        localId: row.localId,
        outboxScope,
    })}`;
    const projectionId = allocatePendingProjectionId({
        preferredProjectionId,
        primaryProjectionId: row.localId,
        fallbackProjectionId: baseProjectionId,
        occupiedProjectionIds,
    });
    return {
        id: projectionId,
        localId: row.localId,
        createdAt: row.createdAt,
        updatedAt: row.createdAt,
        source: 'local_outbound',
        deliveryStatus: 'queued',
        pendingOutboxScope: outboxScope,
        pendingOutboxOperation: row.operation === 'cancel' ? 'cancel' : 'enqueue',
        sendState: 'unconfirmed',
        text: projectionText,
        displayText: row.displayText,
        rawRecord: projectionRawRecord,
        ...(requestedAction
            ? { pendingRequestedAction: requestedAction }
            : { pendingRequestedActionMalformed: true }),
    };
}

function allocatePendingProjectionId(params: Readonly<{
    preferredProjectionId?: string;
    primaryProjectionId: string;
    fallbackProjectionId: string;
    occupiedProjectionIds: ReadonlySet<string>;
}>): string {
    const preferredCandidates = [params.preferredProjectionId, params.primaryProjectionId]
        .filter((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0);
    for (const candidate of preferredCandidates) {
        if (!params.occupiedProjectionIds.has(candidate)) return candidate;
    }
    let projectionId = params.fallbackProjectionId;
    let collisionIndex = 1;
    while (params.occupiedProjectionIds.has(projectionId)) {
        projectionId = `${params.fallbackProjectionId}:collision:${collisionIndex}`;
        collisionIndex += 1;
    }
    return projectionId;
}

function isPendingOutboxQuarantineDiagnosticForRow(
    message: PendingMessage,
    row: PersistedPendingOutboxMessage,
    outboxScope: ServerAccountScope,
): boolean {
    return isPendingOutboxProjectionForIdentity(message, {
        sessionId: row.sessionId,
        localId: row.localId,
        outboxScope,
    })
        && isPendingOutboxQuarantineDiagnostic(message)
        && message.pendingDeliveryBlockedReasonRaw === row.quarantineReason;
}

function upsertPendingOutboxQuarantineDiagnostic(
    row: PersistedPendingOutboxMessage,
    outboxScope: ServerAccountScope,
): PendingMessage {
    const existing = storage.getState().sessionPending[row.sessionId]?.messages ?? [];
    const existingDiagnostics = existing.filter((message) =>
        isPendingOutboxQuarantineDiagnosticForRow(message, row, outboxScope));
    const occupiedProjectionIds = collectOccupiedPendingCollectionIds(row.sessionId);
    for (const diagnostic of existingDiagnostics) {
        if (!isPendingDiscardedIdOccupied(row.sessionId, diagnostic.id)) {
            occupiedProjectionIds.delete(diagnostic.id);
        }
    }
    const projection = buildPendingOutboxProjection(
        row,
        outboxScope,
        occupiedProjectionIds,
        existingDiagnostics[0]?.id,
    );
    for (const diagnostic of existingDiagnostics) {
        if (diagnostic.id !== projection.id) {
            storage.getState().removePendingMessage(row.sessionId, diagnostic.id);
        }
    }
    storage.getState().upsertPendingMessage(row.sessionId, projection);
    return projection;
}

function collectOccupiedPendingCollectionIds(sessionId: string): Set<string> {
    const bucket = storage.getState().sessionPending[sessionId];
    return new Set([
        ...(bucket?.messages ?? []).map((message) => message.id),
        ...(bucket?.discarded ?? []).map((message) => message.id),
    ]);
}

function isPendingDiscardedIdOccupied(sessionId: string, pendingId: string): boolean {
    return (storage.getState().sessionPending[sessionId]?.discarded ?? [])
        .some((message) => message.id === pendingId);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function createPendingServerUpgradeRequiredError(): Error & { code: 'server-upgrade-required' } {
    return Object.assign(
        new Error('This Pending action requires a newer server'),
        { code: 'server-upgrade-required' as const },
    );
}

export function serializePendingEnqueueBodyForServerWire(
    canonicalBody: string,
    mode: PendingInputServerWireMode,
): string | null {
    if (mode === 'indeterminate') return null;
    if (mode === 'pending_input_v1') return canonicalBody;
    let parsed: unknown;
    try {
        parsed = JSON.parse(canonicalBody) as unknown;
    } catch {
        return null;
    }
    if (!isPlainObject(parsed) || readPendingLocalId(parsed.localId) === null) {
        return null;
    }
    const requestedActionResult = parsed.requestedAction === undefined
        ? { success: true as const, data: DEFAULT_PENDING_REQUESTED_ACTION_V1 }
        : PendingRequestedActionV1Schema.safeParse(parsed.requestedAction);
    if (!requestedActionResult.success) {
        return null;
    }
    if (requestedActionResult.data.kind !== 'enqueue' || parsed.deliveryMode !== undefined) {
        throw createPendingServerUpgradeRequiredError();
    }
    const content = SessionStoredMessageContentSchema.safeParse(parsed.content);
    const ciphertext = typeof parsed.ciphertext === 'string' && parsed.ciphertext.length > 0
        ? parsed.ciphertext
        : null;
    if (content.success === Boolean(ciphertext)) return null;
    return JSON.stringify({
        localId: parsed.localId,
        ...(content.success ? { content: content.data } : { ciphertext }),
    });
}

function isReleasedServerV021Integer(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isReleasedServerV021NullableInteger(value: unknown): value is number | null {
    return value === null || isReleasedServerV021Integer(value);
}

function assertCurrentServerPendingEnqueueResponse(params: Readonly<{
    payload: unknown;
    localId: string;
    requestedAction: PendingRequestedActionV1;
}>): void {
    const payload = isPlainObject(params.payload) ? params.payload : null;
    const acknowledgedAction = payload
        ? PendingRequestedActionV1Schema.safeParse(payload.requestedAction)
        : null;
    if (!payload || !acknowledgedAction?.success || acknowledgedAction.data.kind !== params.requestedAction.kind) {
        throw new Error('Server did not acknowledge the persisted Pending requested action');
    }
    if (payload.terminal !== true) {
        const pending = isPlainObject(payload.pending) ? payload.pending : null;
        if (!pending || readPendingLocalId(pending.localId) !== params.localId) {
            throw new Error('Server did not prove the exact persisted Pending row');
        }
        return;
    }

    const message = isPlainObject(payload.message) ? payload.message : null;
    if (
        !message
        || typeof message.id !== 'string'
        || message.id.trim().length === 0
        || !isReleasedServerV021Integer(message.seq)
        || readPendingLocalId(message.localId) !== params.localId
    ) {
        throw new Error('Server did not prove the exact committed Pending message');
    }
}

function hasExactKeys(value: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
    const actualKeys = Object.keys(value).sort();
    const sortedExpectedKeys = [...expectedKeys].sort();
    return actualKeys.length === sortedExpectedKeys.length
        && actualKeys.every((key, index) => key === sortedExpectedKeys[index]);
}

export function isReleasedServerV021PendingEnqueueResponse(
    payload: unknown,
    expectedLocalId: string,
): boolean {
    if (!isPlainObject(payload)
        || !hasExactKeys(payload, ['didWrite', 'pending', 'pendingCount', 'pendingVersion'])
        || typeof payload.didWrite !== 'boolean'
        || !isReleasedServerV021Integer(payload.pendingCount)
        || !isReleasedServerV021Integer(payload.pendingVersion)
        || !isPlainObject(payload.pending)) {
        return false;
    }
    const pending = payload.pending;
    return hasExactKeys(pending, [
        'localId',
        'content',
        'status',
        'position',
        'createdAt',
        'updatedAt',
        'discardedAt',
        'discardedReason',
        'authorAccountId',
    ])
        && pending.localId === expectedLocalId
        && SessionStoredMessageContentSchema.safeParse(pending.content).success
        && (pending.status === 'queued' || pending.status === 'discarded')
        && isReleasedServerV021Integer(pending.position)
        && isReleasedServerV021Integer(pending.createdAt)
        && isReleasedServerV021Integer(pending.updatedAt)
        && isReleasedServerV021NullableInteger(pending.discardedAt)
        && (pending.discardedReason === null || typeof pending.discardedReason === 'string')
        && typeof pending.authorAccountId === 'string'
        && pending.authorAccountId.trim().length > 0;
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

function readPendingEnqueuePlainUserRecord(row: PersistedPendingOutboxMessage): RawRecord | null {
    try {
        const parsed = JSON.parse(row.request.body) as unknown;
        if (!isPlainObject(parsed) || parsed.localId !== row.localId || !isPlainObject(parsed.content)) return null;
        if (parsed.content.t !== 'plain' || !('v' in parsed.content)) return null;
        const record = RawRecordSchema.safeParse(parsed.content.v);
        return record.success
            && record.data.role === 'user'
            && record.data.content.type === 'text'
            ? record.data
            : null;
    } catch {
        return null;
    }
}

function readPendingEnqueueRequestedAction(body: string): PendingRequestedActionV1 | null {
    try {
        const parsed = JSON.parse(body) as unknown;
        if (!isPlainObject(parsed) || parsed.requestedAction === undefined || parsed.requestedAction === null) {
            return DEFAULT_PENDING_REQUESTED_ACTION_V1;
        }
        const action = PendingRequestedActionV1Schema.safeParse(parsed.requestedAction);
        return action.success ? action.data : null;
    } catch {
        return null;
    }
}

function parsePendingRows(raw: unknown): PendingRow[] | null {
    if (!isPlainObject(raw)) return null;
    const pending = raw.pending;
    if (!Array.isArray(pending)) return null;

    const out: PendingRow[] = [];
    for (const item of pending) {
        if (!isPlainObject(item)) continue;
        const localId = readPendingLocalId(item.localId);
        const messageRole = item.messageRole;
        const content = item.content;
        const status = item.status;
        const deliveryState = item.deliveryState;
        const position = item.position;
        const createdAt = item.createdAt;
        const updatedAt = item.updatedAt;
        const discardedAt = item.discardedAt;
        const discardedReason = item.discardedReason;
        const deliveryBlockedReason = item.deliveryBlockedReason;
        const typedDeliveryStatus = parsePendingDeliveryStatusV1(item.deliveryStatus);
        const authorAccountId = item.authorAccountId;
        const requestedActionResult = item.requestedAction === undefined || item.requestedAction === null
            ? { success: true as const, data: DEFAULT_PENDING_REQUESTED_ACTION_V1 }
            : PendingRequestedActionV1Schema.safeParse(item.requestedAction);
        const requestedActionMalformed = item.requestedActionMalformed === true || !requestedActionResult.success;

        if (localId === null) continue;
        const contentParsed = SessionStoredMessageContentSchema.safeParse(content);
        const statusRaw = typeof status === 'string' && status.length > 0 ? status : 'unknown';
        const legacyStatus: PendingStatus =
            statusRaw === 'queued' || statusRaw === 'delivering' || statusRaw === 'blocked' || statusRaw === 'discarded'
                ? statusRaw
                : 'unknown';
        const deliveryStateRaw = typeof deliveryState === 'string' && deliveryState.length > 0
            ? deliveryState
            : null;
        const deliveryStateMalformed = deliveryStateRaw !== null
            && deliveryStateRaw !== 'delivering'
            && deliveryStateRaw !== 'external_handoff'
            && deliveryStateRaw !== 'blocked';
        const legacyDeliveryStatus = normalizePendingDeliveryStatusV1({
            status: statusRaw,
            deliveryState: deliveryStateRaw,
            deliveryBlockedReason,
            discardedReason,
        });
        const effectiveDeliveryStatus = requestedActionMalformed && legacyStatus !== 'discarded'
            ? { status: 'blocked' as const, reason: 'unsupported_action' as const }
            : typedDeliveryStatus ?? (
                deliveryStateMalformed && legacyStatus !== 'discarded'
                    ? {
                        status: 'blocked' as const,
                        reason: normalizePendingDeliveryBlockedReason(deliveryBlockedReason) ?? 'unknown',
                    }
                    : legacyDeliveryStatus
            );
        const parsedStatus: PendingStatus =
            effectiveDeliveryStatus.status === 'discarded'
                ? 'discarded'
                : effectiveDeliveryStatus.status === 'blocked'
                    ? 'blocked'
                    : effectiveDeliveryStatus.status === 'delivering'
                        ? 'delivering'
                        : effectiveDeliveryStatus.status === 'external_handoff'
                            ? 'external_handoff'
                        : legacyStatus === 'unknown'
                            ? 'unknown'
                            : 'queued';
        if (typeof position !== 'number' || !Number.isFinite(position)) continue;
        if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) continue;
        if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) continue;

        out.push({
            localId,
            messageRole: messageRole === 'user' ? 'user' : messageRole == null ? null : 'non_user',
            content: contentParsed.success ? contentParsed.data : null,
            status: parsedStatus,
            statusRaw: legacyStatus !== 'discarded' && deliveryStateRaw ? deliveryStateRaw : statusRaw,
            position,
            createdAt,
            updatedAt,
            discardedAt: typeof discardedAt === 'number' && Number.isFinite(discardedAt) ? discardedAt : null,
            discardedReason: typeof discardedReason === 'string' && discardedReason.length > 0 ? discardedReason : null,
            deliveryBlockedReason: requestedActionMalformed && legacyStatus !== 'discarded'
                ? 'unsupported_action'
                : typeof deliveryBlockedReason === 'string' && deliveryBlockedReason.length > 0
                    ? deliveryBlockedReason
                    : null,
            deliveryStatus: effectiveDeliveryStatus,
            authorAccountId: typeof authorAccountId === 'string' && authorAccountId.length > 0 ? authorAccountId : null,
            requestedAction: requestedActionResult.success && !requestedActionMalformed ? requestedActionResult.data : null,
            ...(requestedActionMalformed ? { requestedActionMalformed: true as const } : {}),
        });
    }
    return out;
}

function resolvePendingDeliveryStatus(row: Pick<PendingRow, 'status' | 'deliveryStatus'>): PendingDeliveryStatus {
    if (row.deliveryStatus.status === 'delivering') return 'server_delivering';
    if (row.deliveryStatus.status === 'external_handoff') return 'external_handoff';
    if (row.deliveryStatus.status === 'blocked' || row.status === 'unknown') return 'blocked';
    return 'server_queued';
}

function resolvePendingDeliveryBlockedReason(row: Pick<PendingRow, 'status' | 'deliveryStatus' | 'deliveryBlockedReason'>): {
    reason?: PendingDeliveryBlockedReason;
    rawReason?: string;
} {
    if (row.deliveryStatus.status === 'blocked') {
        const rawReason = row.deliveryBlockedReason;
        return {
            reason: row.deliveryStatus.reason,
            ...(
                row.deliveryStatus.reason === 'unknown'
                && rawReason
                && normalizePendingDeliveryBlockedReason(rawReason) === null
                    ? { rawReason }
                    : {}
            ),
        };
    }
    if (row.status !== 'blocked' && row.status !== 'unknown') return {};
    if (!row.deliveryBlockedReason) return { reason: 'unknown' };
    const reason = normalizePendingDeliveryBlockedReason(row.deliveryBlockedReason);
    return reason ? { reason } : { reason: 'unknown', rawReason: row.deliveryBlockedReason };
}

function withPendingDeliveryState<T extends PendingMessage>(row: PendingRow, message: T): T {
    const pendingDeliveryStatus = resolvePendingDeliveryStatus(row);
    const { reason: pendingDeliveryBlockedReason, rawReason: pendingDeliveryBlockedReasonRaw } = resolvePendingDeliveryBlockedReason(row);
    const pendingDeliveryStatusRaw = row.statusRaw !== 'queued'
        && row.statusRaw !== 'delivering'
        && row.statusRaw !== 'external_handoff'
        && row.statusRaw !== 'blocked'
        && row.statusRaw !== 'discarded'
            ? row.statusRaw
            : null;
    return {
        ...message,
        pendingDeliveryStatus,
        ...(row.deliveryStatus.status === 'delivering' && row.deliveryStatus.detail
            ? { pendingDeliveryDetail: row.deliveryStatus.detail }
            : {}),
        ...(pendingDeliveryBlockedReason ? { pendingDeliveryBlockedReason } : {}),
        ...(pendingDeliveryBlockedReasonRaw ? { pendingDeliveryBlockedReasonRaw } : {}),
        ...(pendingDeliveryStatusRaw ? { pendingDeliveryStatusRaw } : {}),
        ...(row.requestedAction
            ? { pendingRequestedAction: row.requestedAction }
            : { pendingRequestedActionMalformed: true }),
    };
}

function coerceDiscardReason(value: string | null): DiscardedPendingMessage['discardedReason'] {
    if (value === 'switch_to_local') return 'switch_to_local';
    if (value === 'dismissed_uncertain' || value === 'resent_as_new') return value;
    return 'manual';
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
const pendingCancellationRequestedLocalIdsByScopedSession = new Map<string, Set<string>>();
const deletedPendingLocalIdsByScopedSession = new Map<string, Set<string>>();
type PendingSnapshotRefreshToken = {
    acceptedLocalIdsAfterCapture: Set<string>;
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

function pendingMessagePath(sessionId: string, pendingId: string): string {
    assertValidPendingMessageId(pendingId);
    return `/v2/sessions/${sessionId}/pending/${encodeURIComponent(pendingId)}`;
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

function clearPendingCancellationRequested(scope: ServerAccountScope, sessionId: string, localId: string): void {
    const key = pendingScopedSessionKey(scope, sessionId);
    const requested = pendingCancellationRequestedLocalIdsByScopedSession.get(key);
    if (!requested) return;
    requested.delete(localId);
    if (requested.size === 0) pendingCancellationRequestedLocalIdsByScopedSession.delete(key);
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
        const inFlightIdentity = pendingOutboxProjectionIdentityKey({ sessionId, localId, outboxScope: scope });
        if (!presentLocalIds.has(localId) && !inFlightPendingEnqueueByProjectionIdentity.has(inFlightIdentity)) {
            deleted.delete(localId);
        }
    }
    if (deleted.size === 0) deletedPendingLocalIdsByScopedSession.delete(key);
}

function invalidatePendingSnapshotRefresh(
    scope: ServerAccountScope,
    sessionId: string,
    acceptedLocalId?: string,
): void {
    const refreshKey = pendingScopedSessionKey(scope, sessionId);
    const refreshToken = latestPendingSnapshotRefreshByScopedSession.get(refreshKey);
    if (refreshToken && acceptedLocalId !== undefined) {
        refreshToken.acceptedLocalIdsAfterCapture.add(acceptedLocalId);
        return;
    }
    latestPendingSnapshotRefreshByScopedSession.delete(refreshKey);
}

function pendingSnapshotRepresentsAcceptedLocalIdsAfterCapture(
    refreshToken: PendingSnapshotRefreshToken,
    rows: ReadonlyArray<Pick<PendingRow, 'localId'>>,
): boolean {
    for (const acceptedLocalId of refreshToken.acceptedLocalIdsAfterCapture) {
        if (!rows.some((row) => row.localId === acceptedLocalId)) return false;
    }
    return true;
}

function assertPendingOutboxTransportable(
    sessionId: string,
    localId: string,
    outboxScope: ServerAccountScope,
    resolvedTarget?: PendingMessage | null,
): void {
    const targetsCanonicalServerProjection = resolvedTarget?.source === 'server_pending';
    const directRow = findPendingOutboxMessage(sessionId, localId, outboxScope);
    if (directRow && isPendingOutboxMessageQuarantined(directRow) && !targetsCanonicalServerProjection) {
        throw new Error('Persisted pending outbox row is quarantined');
    }
    const matchingProjectionLocalIds = (storage.getState().sessionPending[sessionId]?.messages ?? [])
        .filter((message) =>
            message.id === localId
            && isPendingOutboxProjectionInScope(message, outboxScope))
        .map((message) => message.localId)
        .filter((candidate): candidate is string => typeof candidate === 'string');
    for (const projectionLocalId of matchingProjectionLocalIds) {
        const projectedRow = findPendingOutboxMessage(sessionId, projectionLocalId, outboxScope);
        if (projectedRow && isPendingOutboxMessageQuarantined(projectedRow) && !targetsCanonicalServerProjection) {
            throw new Error('Persisted pending outbox row is quarantined');
        }
    }
}

function assertCanonicalPendingLocalIdTransportable(
    sessionId: string,
    localId: string,
    outboxScope: ServerAccountScope,
): void {
    assertValidPendingMessageId(localId);
    const directRow = findPendingOutboxMessage(sessionId, localId, outboxScope);
    const hasCanonicalServerProjection = (storage.getState().sessionPending[sessionId]?.messages ?? []).some((message) =>
        message.source === 'server_pending'
        && message.localId === localId
        && (
            message.pendingOutboxScope === undefined
            || isPendingOutboxProjectionInScope(message, outboxScope)
        )
        && !isPendingOutboxQuarantineDiagnostic(message)
    );
    if (directRow && isPendingOutboxMessageQuarantined(directRow) && !hasCanonicalServerProjection) {
        throw new Error('Persisted pending outbox row is quarantined');
    }
}

function resolvePendingMutationTarget(
    sessionId: string,
    pendingId: string,
    outboxScope: ServerAccountScope,
): PendingMessage | null {
    const target = findCanonicalPendingProjection(sessionId, pendingId, outboxScope);
    assertPendingOutboxTransportable(sessionId, pendingId, outboxScope, target);
    return target;
}

function resolvePendingMutationIdentity(
    sessionId: string,
    pendingId: string,
    outboxScope: ServerAccountScope,
): Readonly<{ target: PendingMessage | null; localId: string }> {
    const target = resolvePendingMutationTarget(sessionId, pendingId, outboxScope);
    return {
        target,
        localId: target?.localId ?? target?.id ?? pendingId,
    };
}

export function resolvePendingMessageProjectionLocalIdV2(
    sessionId: string,
    pendingId: string,
    outboxScope: ServerAccountScope,
): string {
    const projections = (storage.getState().sessionPending[sessionId]?.messages ?? []).filter((message) =>
        message.id === pendingId
        && (
            message.pendingOutboxScope === undefined
            || isPendingOutboxProjectionInScope(message, outboxScope)
        )
    );
    const projection = projections.find((message) =>
        isPendingOutboxProjectionInScope(message, outboxScope)
    ) ?? projections[0] ?? null;
    assertPendingOutboxTransportable(sessionId, pendingId, outboxScope, projection);
    return projection?.localId ?? projection?.id ?? pendingId;
}

function revalidateResolvedPendingMutationTarget(
    sessionId: string,
    target: PendingMessage | null,
    localId: string,
    outboxScope: ServerAccountScope,
): PendingMessage | null {
    if (!target) return null;
    return (storage.getState().sessionPending[sessionId]?.messages ?? []).find((message) =>
        message.id === target.id
        && (message.localId ?? message.id) === localId
        && (
            message.pendingOutboxScope === undefined
            || isPendingOutboxProjectionInScope(message, outboxScope)
        )
        && !isPendingOutboxQuarantineDiagnostic(message)
    ) ?? null;
}

export function assertPendingMessageProjectionTransportableV2(
    sessionId: string,
    pendingId: string,
    resolvedOutboxScope?: ServerAccountScope,
): void {
    if (resolvedOutboxScope) {
        const target = findCanonicalPendingProjection(sessionId, pendingId, resolvedOutboxScope);
        assertPendingOutboxTransportable(sessionId, pendingId, resolvedOutboxScope, target);
        return;
    }
    const matchingScopes = (storage.getState().sessionPending[sessionId]?.messages ?? [])
        .filter((message) => message.id === pendingId || message.localId === pendingId)
        .map((message) => message.pendingOutboxScope)
        .filter((scope): scope is ServerAccountScope => scope !== undefined);
    for (const outboxScope of matchingScopes) {
        const target = findCanonicalPendingProjection(sessionId, pendingId, outboxScope);
        assertPendingOutboxTransportable(sessionId, pendingId, outboxScope, target);
    }
}

function retirePendingProjectionAfterConfirmedCancellation(
    sessionId: string,
    localId: string,
    outboxScope: ServerAccountScope,
): void {
    const matchingRetirableProjections = (storage.getState().sessionPending[sessionId]?.messages ?? [])
        .filter((message) =>
            (message.id === localId || message.localId === localId)
            && message.pendingDeliveryStatus !== 'external_handoff'
            && !isPendingOutboxQuarantineDiagnostic(message)
            && (
                message.pendingOutboxScope === undefined
                || isPendingOutboxProjectionInScope(message, outboxScope)
            ));
    for (const message of matchingRetirableProjections) {
        storage.getState().removePendingMessage(sessionId, message.id);
    }
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
    markPendingCancellationRequested(params.outboxScope, params.sessionId, params.localId);
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

function createPendingAuthError(status: 401 | 403): HappyError {
    return new HappyError('Authentication required', false, {
        status,
        kind: 'auth',
        code: 'not_authenticated',
    });
}

function readPendingAuthStatus(status: number): 401 | 403 | null {
    if (status === 401 || status === 403) {
        return status;
    }
    return null;
}

function throwPendingAuthErrorIfNeeded(status: number): void {
    const authStatus = readPendingAuthStatus(status);
    if (authStatus) {
        throw createPendingAuthError(authStatus);
    }
}

function assertPendingResponseOk(response: Response, message: string): void {
    if (response.ok) {
        return;
    }
    throwPendingAuthErrorIfNeeded(response.status);
    throw new Error(`${message} (${response.status})`);
}

async function buildPendingUserMessageWriteBody(params: {
    sessionId: string;
    localId: string;
    rawRecord: RawRecord;
    sessionEncryptionMode: 'e2ee' | 'plain';
    sessionEncryption: PendingQueueSessionEncryption | null | undefined;
}): Promise<Record<string, unknown>> {
    if (params.sessionEncryptionMode === 'plain') {
        return {
            localId: params.localId,
            content: { t: 'plain', v: params.rawRecord },
            messageRole: 'user',
        };
    }
    if (!params.sessionEncryption) {
        throw new Error(`Session ${params.sessionId} not found`);
    }
    return {
        localId: params.localId,
        ciphertext: await params.sessionEncryption.encryptRawRecord(params.rawRecord),
        messageRole: 'user',
    };
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
    const serverPendingByLocalId = new Map(params.serverPendingMessages.map((message) => [
        message.localId ?? message.id,
        message,
    ]));
    const serverPendingLocalIds = new Set(serverPendingByLocalId.keys());
    const serverDiscardedLocalIds = new Set(params.serverDiscardedMessages.map((message) => message.localId ?? message.id));
    const serverLocalIds = new Set([...serverPendingLocalIds, ...serverDiscardedLocalIds]);
    const durableOutboxRows = loadPendingOutboxForSession(params.sessionId, params.outboxScope);
    for (const row of durableOutboxRows) {
        if (isPendingOutboxMessageQuarantined(row)) continue;
        if (
            row.operation === 'enqueue'
            && (serverDiscardedLocalIds.has(row.localId) || serverPendingLocalIds.has(row.localId))
        ) {
            removePendingOutboxMessage(params.sessionId, row.localId, params.outboxScope);
        }
    }
    const retainedDurableOutboxRows = loadPendingOutboxForSession(params.sessionId, params.outboxScope);
    const shouldPreserveUnscopedLocalOutbound = (message: PendingMessage): boolean => {
        if (
            message.pendingDeliveryStatus === 'external_handoff'
            && (message.deliveryStatus === 'accepted' || message.source === 'server_pending')
        ) return false;
        if (message.pendingOutboxScope) return false;
        if (message.localId && serverLocalIds.has(message.localId)) return false;
        return message.source === 'local_outbound'
            || (message.source == null && message.deliveryStatus === 'accepted');
    };
    const shouldPreserveExternalHandoff = (message: PendingMessage): boolean =>
        message.pendingDeliveryStatus === 'external_handoff'
        && (message.deliveryStatus === 'accepted' || message.source === 'server_pending')
        && isPendingOutboxProjectionInScope(message, params.outboxScope)
        && !(message.localId && serverLocalIds.has(message.localId));
    const serverProjectionIds = new Set([
        ...params.serverPendingMessages.map((message) => message.id),
        ...params.serverDiscardedMessages.map((message) => message.id),
    ]);
    const retainedOriginalProjectionIds = new Set(
        existing
            .filter((message) =>
                shouldPreserveUnscopedLocalOutbound(message)
                || shouldPreserveExternalHandoff(message))
            .map((message) => message.id),
    );
    for (const row of retainedDurableOutboxRows) {
        const retainedProjection = isPendingOutboxMessageQuarantined(row)
            ? existing.find((message) =>
                isPendingOutboxQuarantineDiagnosticForRow(message, row, params.outboxScope))
            : findPendingOutboxProjection(params.sessionId, row.localId, params.outboxScope);
        if (retainedProjection) retainedOriginalProjectionIds.add(retainedProjection.id);
    }
    const occupiedProjectionIds = new Set([
        ...serverProjectionIds,
        ...retainedOriginalProjectionIds,
    ]);
    const retainWithCollisionSafeProjectionId = (
        message: PendingMessage,
        retainedKind: 'legacy-unscoped' | 'external-handoff',
    ): PendingMessage => {
        const localId = message.localId ?? message.id;
        if (!serverProjectionIds.has(message.id)) {
            occupiedProjectionIds.delete(message.id);
        }
        const projectionId = allocatePendingProjectionId({
            preferredProjectionId: message.id,
            primaryProjectionId: localId,
            fallbackProjectionId: `pending-retained:${retainedKind}:${pendingOutboxProjectionIdentityKey({
                sessionId: params.sessionId,
                localId,
                outboxScope: params.outboxScope,
            })}`,
            occupiedProjectionIds,
        });
        occupiedProjectionIds.add(projectionId);
        return projectionId === message.id ? message : { ...message, id: projectionId };
    };
    const preservedUnscopedLocalOutbound = existing
        .filter(shouldPreserveUnscopedLocalOutbound)
        .map((message) => retainWithCollisionSafeProjectionId(message, 'legacy-unscoped'));
    const retainedCancellationProjectionIdentities = new Set(
        retainedDurableOutboxRows
            .filter((row) => row.operation === 'cancel' && !isPendingOutboxMessageQuarantined(row))
            .map((row) => pendingOutboxProjectionIdentityKey({
                sessionId: params.sessionId,
                localId: row.localId,
                outboxScope: params.outboxScope,
            })),
    );
    const preservedExternalHandoffsByProjectionIdentity = new Map<string, PendingMessage>();
    for (const message of existing
        .filter(shouldPreserveExternalHandoff)) {
        const canonicalMessage: PendingMessage = {
            ...message,
            source: 'server_pending',
            sendState: undefined,
            pendingOutboxOperation: undefined,
        };
        const localId = canonicalMessage.localId ?? canonicalMessage.id;
        const identityKey = pendingOutboxProjectionIdentityKey({
            sessionId: params.sessionId,
            localId,
            outboxScope: params.outboxScope,
        });
        if (retainedCancellationProjectionIdentities.has(identityKey)) continue;
        if (!preservedExternalHandoffsByProjectionIdentity.has(identityKey)) {
            preservedExternalHandoffsByProjectionIdentity.set(identityKey, canonicalMessage);
        }
    }
    const preservedExternalHandoffs = [...preservedExternalHandoffsByProjectionIdentity.values()]
        .map((message) => retainWithCollisionSafeProjectionId(message, 'external-handoff'));
    const scopedLocalOutbound: PendingMessage[] = [];
    for (const row of retainedDurableOutboxRows) {
        if (!isPendingOutboxMessageQuarantined(row) && serverLocalIds.has(row.localId)) continue;
        const projectionIdentityKey = pendingOutboxProjectionIdentityKey({
            sessionId: params.sessionId,
            localId: row.localId,
            outboxScope: params.outboxScope,
        });
        if (
            row.operation === 'enqueue'
            && preservedExternalHandoffsByProjectionIdentity.has(projectionIdentityKey)
        ) {
            removePendingOutboxMessage(params.sessionId, row.localId, params.outboxScope);
            continue;
        }
        const existingQuarantineDiagnostic = isPendingOutboxMessageQuarantined(row)
            ? existing.find((message) =>
                isPendingOutboxQuarantineDiagnosticForRow(message, row, params.outboxScope))
            : undefined;
        if (
            existingQuarantineDiagnostic
            && !isPendingDiscardedIdOccupied(params.sessionId, existingQuarantineDiagnostic.id)
            && !params.serverPendingMessages.some((message) => message.id === existingQuarantineDiagnostic.id)
            && !params.serverDiscardedMessages.some((message) => message.id === existingQuarantineDiagnostic.id)
        ) {
            occupiedProjectionIds.delete(existingQuarantineDiagnostic.id);
        }
        const existingNormalProjection = !isPendingOutboxMessageQuarantined(row)
            ? findPendingOutboxProjection(params.sessionId, row.localId, params.outboxScope)
            : null;
        if (
            existingNormalProjection
            && !isPendingDiscardedIdOccupied(params.sessionId, existingNormalProjection.id)
            && !params.serverPendingMessages.some((message) => message.id === existingNormalProjection.id)
            && !params.serverDiscardedMessages.some((message) => message.id === existingNormalProjection.id)
        ) {
            occupiedProjectionIds.delete(existingNormalProjection.id);
        }
        const projection = isPendingOutboxMessageQuarantined(row)
            ? buildPendingOutboxProjection(
                row,
                params.outboxScope,
                occupiedProjectionIds,
                existingQuarantineDiagnostic?.id,
            )
            : buildPendingOutboxProjection(
                row,
                params.outboxScope,
                occupiedProjectionIds,
                existingNormalProjection?.id,
            );
        scopedLocalOutbound.push(projection);
        occupiedProjectionIds.add(projection.id);
    }
    const preservedLocalOutbound = [
        ...scopedLocalOutbound,
        ...preservedUnscopedLocalOutbound,
        ...preservedExternalHandoffs,
    ];
    if (preservedLocalOutbound.length === 0) {
        return { messages: params.serverPendingMessages, discarded: params.serverDiscardedMessages };
    }

    const merged = [...params.serverPendingMessages];
    const mergedIds = new Set(merged.map((message) => message.id));
    for (const message of preservedLocalOutbound) {
        if (mergedIds.has(message.id)) continue;
        merged.push(message);
        mergedIds.add(message.id);
    }
    return { messages: merged, discarded: params.serverDiscardedMessages };
}

async function readPendingRowDecryptedContent(params: {
    row: Pick<PendingRow, 'content' | 'localId' | 'createdAt' | 'updatedAt'>;
    sessionEncryption: ReturnType<Encryption['getSessionEncryption']>;
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
    encryption: Encryption;
    request: (path: string, init?: RequestInit) => Promise<Response>;
    outboxScope: ServerAccountScope;
    isOutboxScopeCurrent?: () => boolean | Promise<boolean>;
}): Promise<void> {
    const { sessionId, encryption, request } = params;
    const refreshKey = pendingScopedSessionKey(params.outboxScope, sessionId);
    const refreshToken: PendingSnapshotRefreshToken = {
        acceptedLocalIdsAfterCapture: new Set<string>(),
    };
    latestPendingSnapshotRefreshByScopedSession.set(refreshKey, refreshToken);

    try {
    const session = storage.getState().sessions[sessionId] ?? null;
    if (isDemoModeActive()) {
        storage.getState().applyPendingSnapshot(sessionId, {
            messages: storage.getState().sessionPending[sessionId]?.messages ?? [],
            discarded: [],
        });
        return;
    }
    const sessionEncryptionMode: 'e2ee' | 'plain' = session?.encryptionMode === 'plain' ? 'plain' : 'e2ee';
    const sessionEncryption = sessionEncryptionMode === 'plain' ? null : encryption.getSessionEncryption(sessionId);

    const response = await request(`/v2/sessions/${sessionId}/pending?includeDiscarded=1`, { method: 'GET' });
    const isRefreshScopeCurrent = async (): Promise<boolean> => {
        if (latestPendingSnapshotRefreshByScopedSession.get(refreshKey) !== refreshToken) return false;
        const isScopeCurrent = params.isOutboxScopeCurrent
            ? await params.isOutboxScopeCurrent()
            : (() => {
                const activeScope = getActiveServerAccountScope();
                return activeScope !== null
                    && isPendingOutboxProjectionInScope({ pendingOutboxScope: activeScope }, params.outboxScope);
    })();
        return isScopeCurrent
            && latestPendingSnapshotRefreshByScopedSession.get(refreshKey) === refreshToken;
    };
    if (!await isRefreshScopeCurrent()) return;
    if (!response.ok) {
        throwPendingAuthErrorIfNeeded(response.status);
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
    if (!pendingSnapshotRepresentsAcceptedLocalIdsAfterCapture(refreshToken, rows)) return;

    const queued = rows
        .filter((r) => r.status !== 'discarded')
        .sort((a, b) => a.position - b.position || a.createdAt - b.createdAt || a.localId.localeCompare(b.localId));
    const discarded = rows.filter((r) => r.status === 'discarded').sort((a, b) => (a.discardedAt ?? a.updatedAt) - (b.discardedAt ?? b.updatedAt));
    const pendingMessages: PendingMessage[] = [];
    for (const r of queued) {
        const decrypted = await readPendingRowDecryptedContent({
            row: r,
            sessionEncryption,
        });
        if (decrypted.kind === 'decrypt_failed') {
            pendingMessages.push(withPendingDeliveryState(r, {
                ...decrypted.message,
                pendingOutboxScope: params.outboxScope,
            }));
            continue;
        }

        const coerced = coercePendingUserTextRecord(decrypted.value);
        if (!coerced) {
            pendingMessages.push(withPendingDeliveryState(r, {
                ...buildPendingDecryptFailureMessage({ row: r }),
                pendingOutboxScope: params.outboxScope,
            }));
            continue;
        }
        pendingMessages.push(withPendingDeliveryState(r, {
            id: r.localId,
            localId: r.localId,
            createdAt: r.createdAt,
            updatedAt: r.updatedAt,
            source: 'server_pending',
            pendingOutboxScope: params.outboxScope,
            text: coerced.text,
            displayText: coerced.displayText,
            rawRecord: coerced.rawRecord,
        }));
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
                pendingOutboxScope: params.outboxScope,
                discardedAt: r.discardedAt ?? r.updatedAt,
                discardedReason: coerceDiscardReason(r.discardedReason),
            });
            continue;
        }

        const coerced = coercePendingUserTextRecord(decrypted.value);
        if (!coerced) {
            discardedMessages.push({
                ...buildPendingDecryptFailureMessage({ row: r }),
                pendingOutboxScope: params.outboxScope,
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
            pendingOutboxScope: params.outboxScope,
            text: coerced.text,
            displayText: coerced.displayText,
            rawRecord: coerced.rawRecord,
            discardedAt: r.discardedAt ?? r.updatedAt,
            discardedReason: coerceDiscardReason(r.discardedReason),
        });
    }

    if (!await isRefreshScopeCurrent()) return;
    if (!pendingSnapshotRepresentsAcceptedLocalIdsAfterCapture(refreshToken, rows)) return;
    // Mapping the complete captured snapshot before consulting deletion tombstones
    // lets a concurrently failed DELETE restore its authoritative server row.
    pruneDeletedPendingLocalIdsProvenAbsent(params.outboxScope, sessionId, rows);
    const finalVisibleQueued = filterDeletedPendingRows(params.outboxScope, sessionId, queued);
    const finalVisibleQueuedLocalIds = new Set(finalVisibleQueued.map((row) => row.localId));
    const finalVisibleDiscarded = filterDeletedPendingRows(params.outboxScope, sessionId, discarded);
    const finalVisibleDiscardedLocalIds = new Set(finalVisibleDiscarded.map((row) => row.localId));
    const reconciled = reconcileServerPendingSnapshotWithLocalOutbound({
        sessionId,
        outboxScope: params.outboxScope,
        serverPendingRows: finalVisibleQueued,
        serverPendingMessages: pendingMessages.filter((message) =>
            typeof message.localId === 'string' && finalVisibleQueuedLocalIds.has(message.localId)),
        serverDiscardedMessages: discardedMessages.filter((message) =>
            typeof message.localId === 'string' && finalVisibleDiscardedLocalIds.has(message.localId)),
    });
    storage.getState().applyPendingSnapshot(sessionId, reconciled);
    } finally {
        if (latestPendingSnapshotRefreshByScopedSession.get(refreshKey) === refreshToken) {
            latestPendingSnapshotRefreshByScopedSession.delete(refreshKey);
        }
    }
}

export function enqueuePendingMessageV2(
    params: Parameters<typeof enqueuePendingMessageV2Owned>[0],
): ReturnType<typeof enqueuePendingMessageV2Owned> {
    const localId = params.localId === undefined ? randomUUID() : params.localId;
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

export type PendingMessageEnqueueResultV2 = Readonly<{
    localId: string;
    accepted: boolean;
    cancelled?: true;
    terminal?: true;
    settled?: true;
    externalHandoffClaimed?: true;
}>;

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
    serverWireMode: PendingInputServerWireMode;
    requestedAction?: PendingRequestedActionV1;
}): Promise<PendingMessageEnqueueResultV2> {
    const { sessionId, text, displayText, encryption, request, metaOverrides } = params;
    const outboxScope = params.outboxScope;
    assertValidPendingMessageId(params.localId ?? '');

    storage.getState().markSessionOptimisticThinking(sessionId);

    const session = storage.getState().sessions[sessionId];
    if (!session) {
        storage.getState().clearSessionOptimisticThinking(sessionId);
        throw new Error(`Session ${sessionId} not found in storage`);
    }
    const requestedLocalId = readPendingLocalId(params.localId);
    const localId = requestedLocalId ?? randomUUID();
    const existingOutboxRow = requestedLocalId !== null
        ? findPendingOutboxMessage(sessionId, requestedLocalId, outboxScope)
        : null;
    if (existingOutboxRow && isPendingOutboxMessageQuarantined(existingOutboxRow)) {
        upsertPendingOutboxQuarantineDiagnostic(existingOutboxRow, outboxScope);
        storage.getState().clearSessionOptimisticThinking(sessionId);
        throw new Error('Persisted pending outbox row is quarantined');
    }
    const effectiveDeliveryMode = existingOutboxRow
        ? readPendingEnqueueDeliveryMode(existingOutboxRow.request.body)
        : params.deliveryMode;
    const sessionEncryptionMode: 'e2ee' | 'plain' = session.encryptionMode === 'plain' ? 'plain' : 'e2ee';
    const candidateRawRecord: unknown = existingOutboxRow?.rawRecord ?? buildOutgoingUserTextRecord({
        text,
        displayText,
        permissionMode: session.permissionMode || 'default',
        agentId: resolveAgentIdFromSessionMetadata(readSessionOwnerMetadataView(session)),
        modelMode: session.modelMode,
        settings: storage.getState().settings,
        session,
        metaOverrides,
    });
    const parsedRawRecord = RawRecordSchema.safeParse(candidateRawRecord);
    const rawRecord = parsedRawRecord.success && parsedRawRecord.data.role === 'user'
        ? parsedRawRecord.data
        : null;
    if (!rawRecord && !existingOutboxRow) {
        removePendingOutboxMessage(sessionId, localId, outboxScope);
        storage.getState().clearSessionOptimisticThinking(sessionId);
        throw new Error('Persisted pending outbox projection is invalid');
    }
    const canonicalText = existingOutboxRow?.text ?? text;
    const canonicalDisplayText = existingOutboxRow?.displayText ?? displayText;
    const createdAt = existingOutboxRow?.createdAt ?? nowServerMs();
    const updatedAt = createdAt;
    const effectiveRequestedAction = existingOutboxRow
        ? readPendingEnqueueRequestedAction(existingOutboxRow.request.body)
        : (params.requestedAction ?? DEFAULT_PENDING_REQUESTED_ACTION_V1);

    const authoritativeServerProjection = existingOutboxRow
        ? storage.getState().sessionPending[sessionId]?.messages?.find((message) =>
            (message.id === localId || message.localId === localId)
            && message.source === 'server_pending'
            && isPendingOutboxProjectionInScope(message, outboxScope)
        )
        : null;
    const existingScopedOutboxProjection = existingOutboxRow
        ? findPendingOutboxProjection(sessionId, localId, outboxScope)
        : null;
    if (!authoritativeServerProjection && !existingScopedOutboxProjection) {
        const occupiedProjectionIds = collectOccupiedPendingCollectionIds(sessionId);
        const projection: PendingMessage | null = existingOutboxRow
            ? buildPendingOutboxProjection(existingOutboxRow, outboxScope, occupiedProjectionIds)
            : rawRecord
                ? ({
                    ...buildLocalOutboundPendingUserMessage({
                        localId,
                        createdAt,
                        updatedAt,
                        deliveryStatus: 'queued' as const,
                        pendingOutboxScope: outboxScope,
                        pendingOutboxOperation: 'enqueue' as const,
                        text: canonicalText,
                        displayText: canonicalDisplayText,
                        rawRecord,
                    }),
                    id: allocatePendingProjectionId({
                        primaryProjectionId: localId,
                        fallbackProjectionId: `pending-outbox:${pendingOutboxProjectionIdentityKey({
                            sessionId,
                            localId,
                            outboxScope,
                        })}`,
                        occupiedProjectionIds,
                    }),
                    ...(effectiveRequestedAction
                        ? { pendingRequestedAction: effectiveRequestedAction }
                        : { pendingRequestedActionMalformed: true as const }),
                } satisfies PendingMessage)
                : null;
        if (projection) {
            storage.getState().upsertPendingMessage(sessionId, projection);
            occupiedProjectionIds.add(projection.id);
            params.onLocalPendingProjectionCreated?.({ localId });
        }
    }

    let serverCommitMayExist = false;
    try {
        if (existingOutboxRow && effectiveRequestedAction === null) {
            throw new Error('Persisted pending requested action is unsupported');
        }
        const outcome = await runPendingEnqueueCommitInOrder(outboxScope, sessionId, async () => {
            const sessionEncryption = existingOutboxRow || sessionEncryptionMode === 'plain'
                ? null
                : await encryption.getSessionEncryption(sessionId);
            if (!existingOutboxRow && sessionEncryptionMode === 'e2ee' && !sessionEncryption) {
                throw new Error(`Session ${sessionId} not found`);
            }
            const currentExistingOutboxRow = existingOutboxRow
                ? findPendingOutboxMessage(sessionId, localId, outboxScope)
                : null;
            if (existingOutboxRow && !currentExistingOutboxRow) {
                return { committed: false, cancelled: false, alreadySettled: true };
            }
            const savedOutboxRow = currentExistingOutboxRow ?? savePendingOutboxMessage({
                sessionId,
                localId,
                createdAt,
                text: canonicalText,
                displayText: canonicalDisplayText,
                rawRecord: rawRecord!,
                request: {
                    v: 1,
                    body: JSON.stringify({
                        ...(await buildPendingUserMessageWriteBody({
                            sessionId,
                            localId,
                            rawRecord: rawRecord!,
                            sessionEncryptionMode,
                            sessionEncryption,
                        })),
                        ...(effectiveDeliveryMode ? { deliveryMode: effectiveDeliveryMode } : {}),
                        requestedAction: effectiveRequestedAction ?? DEFAULT_PENDING_REQUESTED_ACTION_V1,
                    }),
                },
            }, outboxScope);
            if (isPendingCancellationRequested(outboxScope, sessionId, localId)) {
                markPendingOutboxMessageCancelRequested(sessionId, localId, outboxScope);
            }
            const outboxRow = findPendingOutboxMessage(sessionId, localId, outboxScope) ?? savedOutboxRow;
            if (outboxRow.operation === 'cancel') {
                await completePendingOutboxCancellationIfRequested({ sessionId, localId, outboxScope, request });
                return { committed: false, cancelled: true };
            }

            const wireBody = serializePendingEnqueueBodyForServerWire(
                outboxRow.request.body,
                params.serverWireMode,
            );
            if (wireBody === null) {
                return { committed: false, cancelled: false, wireIndeterminate: true };
            }

            serverCommitMayExist = true;
            const response = await request(`/v2/sessions/${sessionId}/pending`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: wireBody,
            });
            if (!response.ok) {
                serverCommitMayExist = false;
                assertPendingResponseOk(response, 'Failed to enqueue pending message');
            }
            const payload = await response.json().catch(() => null) as unknown;
            if (params.serverWireMode === 'pending_input_v1') {
                assertCurrentServerPendingEnqueueResponse({
                    payload,
                    localId,
                    requestedAction: effectiveRequestedAction ?? DEFAULT_PENDING_REQUESTED_ACTION_V1,
                });
            } else if (params.serverWireMode === 'released_server_v0_2_1'
                && !isReleasedServerV021PendingEnqueueResponse(payload, localId)) {
                    throw new Error('Released server returned an invalid Pending enqueue acknowledgement');
            }
            const terminal = isPlainObject(payload) && payload.terminal === true;
            if (effectiveDeliveryMode === 'external_handoff') {
                const pending = isPlainObject(payload) && isPlainObject(payload.pending) ? payload.pending : null;
                const status = pending ? parsePendingDeliveryStatusV1(pending.deliveryStatus) : null;
                if (status?.status !== 'external_handoff') {
                    throw new Error('Server did not atomically claim external handoff');
                }
                markPendingOutboxProjectionExternalHandoffIfOwned(sessionId, localId, outboxScope);
            }
            if (isPendingCancellationRequested(outboxScope, sessionId, localId)) {
                markPendingOutboxMessageCancelRequested(sessionId, localId, outboxScope);
            }
            if (await completePendingOutboxCancellationIfRequested({ sessionId, localId, outboxScope, request })) {
                return { committed: true, cancelled: true };
            }
            const postCancellationRow = findPendingOutboxMessage(sessionId, localId, outboxScope);
            if (!postCancellationRow) {
                return { committed: true, cancelled: false, alreadySettled: true };
            }
            if (isPendingOutboxMessageQuarantined(postCancellationRow)) {
                throw new Error('Persisted pending outbox row is quarantined');
            }
            if (postCancellationRow.operation === 'cancel') {
                await completePendingOutboxCancellationIfRequested({ sessionId, localId, outboxScope, request });
                return { committed: true, cancelled: true };
            }
            invalidatePendingSnapshotRefresh(outboxScope, sessionId, localId);
            removePendingOutboxMessage(sessionId, localId, outboxScope);
            if (effectiveDeliveryMode === 'external_handoff') {
                markPendingOutboxProjectionExternalHandoffIfOwned(sessionId, localId, outboxScope);
            } else if (rawRecord) {
                markPendingOutboxProjectionAcceptedIfOwned(
                    sessionId,
                    localId,
                    outboxScope,
                    rawRecord,
                    effectiveDeliveryMode === 'external_handoff' ? 'external_handoff' : undefined,
                );
            } else {
                removePendingOutboxProjectionIfOwned(sessionId, localId, outboxScope);
            }
            return { committed: true, cancelled: false, terminal };
        });

        if (outcome.alreadySettled === true) {
            removeLocalPendingOutboxProjectionsIfOwned(sessionId, localId, outboxScope);
            storage.getState().clearSessionOptimisticThinking(sessionId);
            return { localId, accepted: true, settled: true };
        }

        if (outcome.cancelled) {
            retirePendingProjectionAfterConfirmedCancellation(sessionId, localId, outboxScope);
            storage.getState().clearSessionOptimisticThinking(sessionId);
            return { localId, accepted: true, cancelled: true };
        }

        if (outcome.wireIndeterminate === true) {
            setPendingMessageSendState(sessionId, localId, 'unconfirmed', outboxScope);
            storage.getState().clearSessionOptimisticThinking(sessionId);
            return { localId, accepted: false };
        }

        return {
            localId,
            accepted: true,
            ...(outcome.terminal ? { terminal: true as const } : {}),
            ...(effectiveDeliveryMode === 'external_handoff' ? { externalHandoffClaimed: true as const } : {}),
        };
    } catch (e) {
        if (isTransientConnectivityError(e)) {
            setPendingMessageSendState(sessionId, localId, 'unconfirmed', outboxScope);
            storage.getState().clearSessionOptimisticThinking(sessionId);
            return { localId, accepted: false };
        }
        if (serverCommitMayExist) {
            setPendingMessageSendState(sessionId, localId, 'unconfirmed', outboxScope);
            storage.getState().clearSessionOptimisticThinking(sessionId);
            return { localId, accepted: false };
        }
        if (existingOutboxRow !== null) {
            setPendingMessageSendState(sessionId, localId, 'unconfirmed', outboxScope);
            storage.getState().clearSessionOptimisticThinking(sessionId);
            throw e;
        }
        if (isPendingCancellationRequested(outboxScope, sessionId, localId)) {
            storage.getState().clearSessionOptimisticThinking(sessionId);
            throw e;
        }
        removePendingOutboxMessage(sessionId, localId, outboxScope);
        removePendingOutboxProjectionIfOwned(sessionId, localId, outboxScope);
        storage.getState().clearSessionOptimisticThinking(sessionId);
        throw e;
    }
}

export function replayPersistedPendingOutboxForSession(
    sessionId: string,
    outboxScope: ServerAccountScope,
): string[] {
    const persisted = loadPendingOutboxForSession(sessionId, outboxScope);
    if (persisted.length === 0) return [];
    const existing = storage.getState().sessionPending[sessionId]?.messages ?? [];
    const serverOwnedLocalIds = new Set(existing
        .filter((message) =>
            message.source === 'server_pending'
            && isPendingOutboxProjectionInScope(message, outboxScope))
        .map((message) => message.localId ?? message.id));
    const discardedServerOwnedLocalIds = new Set(
        (storage.getState().sessionPending[sessionId]?.discarded ?? [])
            .filter((message) =>
                message.source === 'server_pending'
                && isPendingOutboxProjectionInScope(message, outboxScope))
            .map((message) => message.localId ?? message.id),
    );
    const existingProjectionKeys = new Set(existing
        .filter((message) => isPendingOutboxProjectionInScope(message, outboxScope))
        .map((message) => pendingOutboxProjectionIdentityKey({
            sessionId,
            localId: message.localId ?? message.id,
            outboxScope,
        })));
    const occupiedProjectionIds = collectOccupiedPendingCollectionIds(sessionId);
    const localIdsNeedingRetry: string[] = [];
    for (const row of persisted) {
        if (isPendingOutboxMessageQuarantined(row)) {
            const projection = upsertPendingOutboxQuarantineDiagnostic(row, outboxScope);
            occupiedProjectionIds.add(projection.id);
            continue;
        }
        assertValidPendingMessageId(row.localId);
        if (row.operation === 'enqueue' && discardedServerOwnedLocalIds.has(row.localId)) {
            removePendingOutboxMessage(sessionId, row.localId, outboxScope);
            continue;
        }
        if (row.operation === 'enqueue' && serverOwnedLocalIds.has(row.localId)) {
            removePendingOutboxMessage(sessionId, row.localId, outboxScope);
            continue;
        }
        const existingProjection = findPendingOutboxProjection(sessionId, row.localId, outboxScope);
        if (existingProjection?.sendState !== 'failed') {
            localIdsNeedingRetry.push(row.localId);
        }
        const projectionKey = pendingOutboxProjectionIdentityKey({ sessionId, localId: row.localId, outboxScope });
        if (existingProjectionKeys.has(projectionKey)) continue;
        const projection = buildPendingOutboxProjection(row, outboxScope, occupiedProjectionIds);
        storage.getState().upsertPendingMessage(sessionId, projection);
        occupiedProjectionIds.add(projection.id);
    }
    return localIdsNeedingRetry;
}

export async function retryPendingOutboxOperationV2(params: {
    sessionId: string;
    localId: string;
    request: (path: string, init?: RequestInit) => Promise<Response>;
    outboxScope: ServerAccountScope;
    serverWireMode: PendingInputServerWireMode;
}): Promise<Readonly<{ accepted: boolean }>> {
    const { sessionId, localId, request } = params;
    const outboxScope = params.outboxScope;
    assertValidPendingMessageId(localId);
    const persisted = findPendingOutboxMessage(sessionId, localId, outboxScope);
    if (!persisted) return { accepted: true };
    if (isPendingOutboxMessageQuarantined(persisted)) {
        throw new Error('Persisted pending outbox row is quarantined');
    }
    const pendingLocalId = persisted.localId;
    const existing = findPendingOutboxProjection(sessionId, pendingLocalId, outboxScope);
    const parsed = RawRecordSchema.safeParse(persisted.rawRecord);
    const auxiliaryRawRecord = parsed.success && parsed.data.role === 'user' ? parsed.data : null;
    const deliveryMode = readPendingEnqueueDeliveryMode(persisted.request.body);
    const requestedAction = readPendingEnqueueRequestedAction(persisted.request.body);
    let serverCommitMayExist = false;

    try {
        if (requestedAction === null) {
            throw new Error('Persisted pending requested action is unsupported');
        }
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
            if (!current) return { committed: false, cancelled: false, alreadySettled: true };

            const wireBody = serializePendingEnqueueBodyForServerWire(
                current.request.body,
                params.serverWireMode,
            );
            if (wireBody === null) {
                return { committed: false, cancelled: false, wireIndeterminate: true };
            }

            const response = await request(`/v2/sessions/${sessionId}/pending`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: wireBody,
            });
            if (!response.ok) {
                assertPendingResponseOk(response, 'Failed to enqueue pending message');
            }
            serverCommitMayExist = true;
            const payload = await response.json().catch(() => null) as unknown;
            if (params.serverWireMode === 'pending_input_v1') {
                assertCurrentServerPendingEnqueueResponse({
                    payload,
                    localId: pendingLocalId,
                    requestedAction,
                });
            } else if (params.serverWireMode === 'released_server_v0_2_1'
                && !isReleasedServerV021PendingEnqueueResponse(payload, pendingLocalId)) {
                    throw new Error('Released server returned an invalid Pending enqueue acknowledgement');
            }
            const terminal = isPlainObject(payload) && payload.terminal === true;
            if (deliveryMode === 'external_handoff') {
                const pending = isPlainObject(payload) && isPlainObject(payload.pending) ? payload.pending : null;
                const status = pending ? parsePendingDeliveryStatusV1(pending.deliveryStatus) : null;
                if (status?.status !== 'external_handoff') {
                    throw new Error('Server did not retain external handoff');
                }
                markPendingOutboxProjectionExternalHandoffIfOwned(
                    sessionId,
                    pendingLocalId,
                    outboxScope,
                );
            }
            if (!findPendingOutboxMessage(sessionId, pendingLocalId, outboxScope)) {
                return { committed: true, cancelled: false, alreadySettled: true };
            }
            if (isPendingCancellationRequested(outboxScope, sessionId, pendingLocalId)) {
                markPendingOutboxMessageCancelRequested(sessionId, pendingLocalId, outboxScope);
            }
            if (await completePendingOutboxCancellationIfRequested({
                sessionId,
                localId: pendingLocalId,
                outboxScope,
                request,
            })) {
                return { committed: true, cancelled: true };
            }
            const postCancellationRow = findPendingOutboxMessage(sessionId, pendingLocalId, outboxScope);
            if (!postCancellationRow) {
                return { committed: true, cancelled: false, alreadySettled: true };
            }
            if (isPendingOutboxMessageQuarantined(postCancellationRow)) {
                throw new Error('Persisted pending outbox row is quarantined');
            }
            if (postCancellationRow.operation === 'cancel') {
                await completePendingOutboxCancellationIfRequested({
                    sessionId,
                    localId: pendingLocalId,
                    outboxScope,
                    request,
                });
                return { committed: true, cancelled: true };
            }
            invalidatePendingSnapshotRefresh(outboxScope, sessionId, pendingLocalId);
            removePendingOutboxMessage(sessionId, pendingLocalId, outboxScope);
            const acknowledgedExternalHandoff = (storage.getState().sessionPending[sessionId]?.messages ?? []).some(
                (message) =>
                    message.source === 'server_pending'
                    && message.pendingDeliveryStatus === 'external_handoff'
                    && isPendingOutboxProjectionForIdentity(message, {
                        sessionId,
                        localId: pendingLocalId,
                        outboxScope,
                    }),
            );
            if (acknowledgedExternalHandoff) {
                removeLocalPendingOutboxProjectionsIfOwned(sessionId, pendingLocalId, outboxScope);
            } else if (deliveryMode === 'external_handoff') {
                if (markPendingOutboxProjectionExternalHandoffIfOwned(sessionId, pendingLocalId, outboxScope)) {
                    storage.getState().markSessionOptimisticThinking(sessionId);
                }
            } else if (auxiliaryRawRecord) {
                if (markPendingOutboxProjectionAcceptedIfOwned(
                    sessionId,
                    pendingLocalId,
                    outboxScope,
                    auxiliaryRawRecord,
                )) {
                    storage.getState().markSessionOptimisticThinking(sessionId);
                }
            } else {
                removePendingOutboxProjectionIfOwned(sessionId, pendingLocalId, outboxScope);
            }
            return { committed: true, cancelled: false };
        });

        if (outcome.alreadySettled === true) {
            removeLocalPendingOutboxProjectionsIfOwned(sessionId, pendingLocalId, outboxScope);
            if (existing) storage.getState().clearSessionOptimisticThinking(sessionId);
            return { accepted: true };
        }

        if (outcome.cancelled) {
            removePendingOutboxMessage(sessionId, pendingLocalId, outboxScope);
            retirePendingProjectionAfterConfirmedCancellation(sessionId, pendingLocalId, outboxScope);
            if (existing) storage.getState().clearSessionOptimisticThinking(sessionId);
            return { accepted: true };
        }

        if (outcome.wireIndeterminate === true) {
            setPendingMessageSendState(sessionId, pendingLocalId, 'unconfirmed', outboxScope);
            if (existing) storage.getState().clearSessionOptimisticThinking(sessionId);
            return { accepted: false };
        }

        return { accepted: true };
    } catch (e) {
        if (serverCommitMayExist) {
            setPendingMessageSendState(sessionId, pendingLocalId, 'unconfirmed', outboxScope);
            if (existing) storage.getState().clearSessionOptimisticThinking(sessionId);
            throw e;
        }
        if (isTransientConnectivityError(e)) {
            setPendingMessageSendState(sessionId, pendingLocalId, 'unconfirmed', outboxScope);
            if (existing) storage.getState().clearSessionOptimisticThinking(sessionId);
            return { accepted: false };
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
    encryption: Encryption;
    fetchArtifactWithBody?: (artifactId: string) => Promise<DecryptedArtifact | null>;
    updateArtifact?: (artifact: DecryptedArtifact) => void;
    request: (path: string, init?: RequestInit) => Promise<Response>;
    outboxScope: ServerAccountScope;
}): Promise<void> {
    const { sessionId, pendingId, text, encryption, request } = params;
    const { target: resolvedTarget, localId } = resolvePendingMutationIdentity(
        sessionId,
        pendingId,
        params.outboxScope,
    );

    const session = storage.getState().sessions[sessionId] ?? null;
    const sessionEncryptionMode: 'e2ee' | 'plain' = session?.encryptionMode === 'plain' ? 'plain' : 'e2ee';
    const sessionEncryption = sessionEncryptionMode === 'plain' ? null : encryption.getSessionEncryption(sessionId);
    if (sessionEncryptionMode === 'e2ee' && !sessionEncryption) {
        throw new Error(`Session ${sessionId} not found`);
    }

    const existing = resolvedTarget;
    if (!existing) {
        throw new Error('Pending message not found');
    }
    const retainedOutbox = findPendingOutboxMessage(sessionId, localId, params.outboxScope);
    if (retainedOutbox?.operation === 'cancel') {
        throw new Error('Pending cancellation is outstanding');
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
        const agentId = resolveAgentIdFromSessionMetadata(
            session ? readSessionOwnerMetadataView(session) : null,
        );
        const modelMode = session?.modelMode;

        return buildOutgoingUserTextRecord({
            text,
            displayText:
                existing.pendingDecryptFailure
                    ? undefined
                    : (typeof existing.displayText === 'string' ? existing.displayText : undefined),
            permissionMode,
            agentId,
            modelMode,
            settings: storage.getState().settings,
            session,
        });
    })();

    const writeBody =
        sessionEncryptionMode === 'plain'
            ? { content: { t: 'plain', v: rawRecord }, messageRole: 'user' }
            : { ciphertext: await sessionEncryption!.encryptRawRecord(rawRecord), messageRole: 'user' };
    const updatedAt = nowServerMs();

    await runPendingEnqueueCommitInOrder(params.outboxScope, sessionId, async () => {
        const beforePatch = findPendingOutboxMessage(sessionId, localId, params.outboxScope);
        if (beforePatch?.operation === 'cancel') throw new Error('Pending cancellation is outstanding');
        const response = await request(pendingMessagePath(sessionId, localId), {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(writeBody),
        });
        if (!response.ok) {
            assertPendingResponseOk(response, 'Failed to update pending message');
        }
        const afterPatch = findPendingOutboxMessage(sessionId, localId, params.outboxScope);
        if (afterPatch?.operation === 'cancel') throw new Error('Pending cancellation is outstanding');
        const currentProjection = revalidateResolvedPendingMutationTarget(
            sessionId,
            resolvedTarget,
            localId,
            params.outboxScope,
        );
        if (
            !currentProjection
            || currentProjection.pendingOutboxOperation === 'cancel'
            || isPendingCancellationRequested(params.outboxScope, sessionId, localId)
        ) return;

        invalidatePendingSnapshotRefresh(params.outboxScope, sessionId);
        if (afterPatch?.operation === 'enqueue') {
            removePendingOutboxMessage(sessionId, localId, params.outboxScope);
        }
        storage.getState().upsertPendingMessage(sessionId, {
            ...currentProjection,
            ...(afterPatch?.operation === 'enqueue'
                ? {
                    deliveryStatus: 'accepted' as const,
                    sendState: undefined,
                    pendingOutboxOperation: undefined,
                }
                : {}),
            pendingDecryptFailure: undefined,
            text,
            updatedAt,
            rawRecord,
            displayText: currentProjection.pendingDecryptFailure ? undefined : currentProjection.displayText,
        });
    });
}

export async function updatePendingRequestedActionV2(params: {
    sessionId: string;
    localId: string;
    requestedAction: PendingRequestedActionV1;
    request: (path: string, init?: RequestInit) => Promise<Response>;
    outboxScope: ServerAccountScope;
}): Promise<void> {
    const localId = params.localId;
    assertCanonicalPendingLocalIdTransportable(params.sessionId, localId, params.outboxScope);
    const response = await params.request(`${pendingMessagePath(params.sessionId, localId)}/action`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestedAction: params.requestedAction }),
    });
    const payload = await response.json().catch(() => null) as unknown;
    if (!response.ok) {
        assertPendingResponseOk(response, 'Failed to update pending action');
    }
    if (!isPlainObject(payload) || typeof payload.didUpdate !== 'boolean') return;
    invalidatePendingSnapshotRefresh(params.outboxScope, params.sessionId);
    const current = findPendingOutboxMessage(params.sessionId, localId, params.outboxScope);
    const projection = findPendingProjectionByCanonicalLocalId(params.sessionId, localId, params.outboxScope);
    if (projection) {
        storage.getState().upsertPendingMessage(params.sessionId, {
            ...projection,
            updatedAt: nowServerMs(),
            deliveryStatus: 'accepted',
            sendState: undefined,
            pendingOutboxOperation: undefined,
            pendingRequestedAction: params.requestedAction,
            pendingRequestedActionMalformed: undefined,
        });
    }
    if (current?.operation === 'enqueue') {
        removePendingOutboxMessage(params.sessionId, localId, params.outboxScope);
    }
}

export async function deletePendingMessageV2(params: {
    sessionId: string;
    pendingId: string;
    request: (path: string, init?: RequestInit) => Promise<Response>;
    outboxScope: ServerAccountScope;
}): Promise<void> {
    const { sessionId, pendingId, request } = params;
    const { target: resolvedTarget, localId } = resolvePendingMutationIdentity(
        sessionId,
        pendingId,
        params.outboxScope,
    );
    const pendingMessages = storage.getState().sessionPending[sessionId]?.messages ?? [];
    const collidingMessages = pendingMessages.filter((message) => message.id === pendingId || message.localId === pendingId);
    const existing = resolvedTarget;
    if (!existing && collidingMessages.some((message) => message.pendingOutboxScope != null)) return;
    const retainedOutbox = findPendingOutboxMessage(sessionId, localId, params.outboxScope);
    if (
        existing?.source === 'server_pending'
        && retainedOutbox
        && !isPendingOutboxMessageQuarantined(retainedOutbox)
    ) {
        markPendingCancellationRequested(params.outboxScope, sessionId, localId);
        markPendingOutboxMessageCancelRequested(sessionId, localId, params.outboxScope);
        const cancellationConfirmed = await runPendingEnqueueCommitInOrder(params.outboxScope, sessionId, async () => {
            return await completePendingOutboxCancellationIfRequested({
                sessionId,
                localId,
                outboxScope: params.outboxScope,
                request,
            });
        });
        const cancellationRetired = cancellationConfirmed
            || findPendingOutboxMessage(sessionId, localId, params.outboxScope) === null;
        if (existing.pendingDeliveryStatus === 'external_handoff' && cancellationRetired) {
            clearDeletedPendingLocalId(params.outboxScope, sessionId, localId);
        }
        if (existing.pendingDeliveryStatus !== 'external_handoff' && cancellationRetired) {
            storage.getState().removePendingMessage(sessionId, existing.id);
        }
        return;
    }
    if (existing?.source === 'local_outbound' && existing.deliveryStatus === 'queued') {
        const localId = existing.localId ?? existing.id;
        const outboxScope = params.outboxScope;
        markPendingCancellationRequested(outboxScope, sessionId, localId);
        markPendingOutboxMessageCancelRequested(sessionId, localId, outboxScope);
        storage.getState().upsertPendingMessage(sessionId, {
            ...existing,
            pendingOutboxOperation: 'cancel',
        });
        let cancellationConfirmed = false;
        try {
            cancellationConfirmed = await runPendingEnqueueCommitInOrder(outboxScope, sessionId, async () => {
                markPendingOutboxMessageCancelRequested(sessionId, localId, outboxScope);
                return await completePendingOutboxCancellationIfRequested({ sessionId, localId, outboxScope, request });
            });
            retirePendingProjectionAfterConfirmedCancellation(sessionId, localId, outboxScope);
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
    try {
        const response = await request(pendingMessagePath(sessionId, localId), { method: 'DELETE' });
        if (!response.ok && response.status !== 404) {
            assertPendingResponseOk(response, 'Failed to delete pending message');
        }
    } catch (error) {
        throw error;
    }
    if (existing?.pendingDeliveryStatus === 'external_handoff') {
        return;
    }
    if (suppressStaleSnapshot) markPendingLocalIdDeleted(params.outboxScope, sessionId, localId);
    if (existing) storage.getState().removePendingMessage(sessionId, existing.id);
}

export async function discardPendingMessageV2(params: {
    sessionId: string;
    pendingId: string;
    reason?: 'switch_to_local' | 'manual';
    encryption: Encryption;
    request: (path: string, init?: RequestInit) => Promise<Response>;
    outboxScope: ServerAccountScope;
    isOutboxScopeCurrent?: () => boolean | Promise<boolean>;
}): Promise<void> {
    const { sessionId, pendingId, reason, encryption, request } = params;
    const { localId } = resolvePendingMutationIdentity(sessionId, pendingId, params.outboxScope);

    const response = await request(`${pendingMessagePath(sessionId, localId)}/discard`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
    });
    if (!response.ok) {
        assertPendingResponseOk(response, 'Failed to discard pending message');
    }
    await fetchAndApplyPendingMessagesV2({
        sessionId, encryption, request, outboxScope: params.outboxScope,
        isOutboxScopeCurrent: params.isOutboxScopeCurrent,
    });
}

export async function dismissPendingDeliveryV2(params: {
    sessionId: string;
    pendingId: string;
    encryption: Encryption;
    request: (path: string, init?: RequestInit) => Promise<Response>;
    outboxScope: ServerAccountScope;
    isOutboxScopeCurrent?: () => boolean | Promise<boolean>;
}): Promise<void> {
    const { sessionId, pendingId, encryption, request } = params;
    const { localId } = resolvePendingMutationIdentity(sessionId, pendingId, params.outboxScope);

    const response = await request(`${pendingMessagePath(sessionId, localId)}/delivery/dismiss`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
    });
    if (!response.ok) {
        assertPendingResponseOk(response, 'Failed to dismiss pending delivery');
    }
    await fetchAndApplyPendingMessagesV2({
        sessionId, encryption, request, outboxScope: params.outboxScope,
        isOutboxScopeCurrent: params.isOutboxScopeCurrent,
    });
}

export async function blockPendingDeliveryV2(params: {
    sessionId: string;
    pendingId: string;
    reason: PendingDeliveryBlockedReason;
    encryption: Encryption;
    request: (path: string, init?: RequestInit) => Promise<Response>;
    outboxScope: ServerAccountScope;
    isOutboxScopeCurrent?: () => boolean | Promise<boolean>;
}): Promise<void> {
    const { sessionId, pendingId, reason, encryption, request } = params;
    const { localId } = resolvePendingMutationIdentity(sessionId, pendingId, params.outboxScope);

    const response = await request(`${pendingMessagePath(sessionId, localId)}/delivery/block`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
    });
    if (!response.ok) {
        assertPendingResponseOk(response, 'Failed to block pending delivery');
    }
    await fetchAndApplyPendingMessagesV2({
        sessionId, encryption, request, outboxScope: params.outboxScope,
        isOutboxScopeCurrent: params.isOutboxScopeCurrent,
    });
}

export async function sendPendingDeliveryAsNewV2(params: {
    sessionId: string;
    pendingId: string;
    encryption: Encryption;
    request: (path: string, init?: RequestInit) => Promise<Response>;
    outboxScope: ServerAccountScope;
    isOutboxScopeCurrent?: () => boolean | Promise<boolean>;
}): Promise<string> {
    const { sessionId, pendingId, encryption, request } = params;
    const { localId } = resolvePendingMutationIdentity(sessionId, pendingId, params.outboxScope);

    const response = await request(`${pendingMessagePath(sessionId, localId)}/delivery/send-as-new`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
    });
    if (!response.ok) {
        assertPendingResponseOk(response, 'Failed to send pending delivery as new');
    }
    const payload = await response.json().catch(() => null) as { newLocalId?: unknown } | null;
    const newLocalId = readPendingLocalId(payload?.newLocalId);
    if (!newLocalId) {
        throw new Error('Send-as-new response is missing the server-owned replacement identity');
    }
    await fetchAndApplyPendingMessagesV2({
        sessionId, encryption, request, outboxScope: params.outboxScope,
        isOutboxScopeCurrent: params.isOutboxScopeCurrent,
    });
    return newLocalId;
}

export async function markPendingDeliveryHandledV2(params: {
    sessionId: string;
    pendingId: string;
    encryption: Encryption;
    request: (path: string, init?: RequestInit) => Promise<Response>;
    outboxScope: ServerAccountScope;
    isOutboxScopeCurrent?: () => boolean | Promise<boolean>;
}): Promise<void> {
    const { sessionId, pendingId, encryption, request } = params;
    const { target, localId } = resolvePendingMutationIdentity(sessionId, pendingId, params.outboxScope);

    const response = await request(`${pendingMessagePath(sessionId, localId)}/delivery/handled`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
    });
    if (!response.ok) {
        assertPendingResponseOk(response, 'Failed to mark pending delivery handled');
    }
    const existing = revalidateResolvedPendingMutationTarget(
        sessionId,
        target,
        localId,
        params.outboxScope,
    );
    if (existing) storage.getState().removePendingMessage(sessionId, existing.id);
    await fetchAndApplyPendingMessagesV2({
        sessionId, encryption, request, outboxScope: params.outboxScope,
        isOutboxScopeCurrent: params.isOutboxScopeCurrent,
    });
}

export async function restoreDiscardedPendingMessageV2(params: {
    sessionId: string;
    pendingId: string;
    encryption: Encryption;
    request: (path: string, init?: RequestInit) => Promise<Response>;
    outboxScope: ServerAccountScope;
    isOutboxScopeCurrent?: () => boolean | Promise<boolean>;
}): Promise<void> {
    const { sessionId, pendingId, encryption, request } = params;
    const { localId } = resolvePendingMutationIdentity(sessionId, pendingId, params.outboxScope);

    const response = await request(`${pendingMessagePath(sessionId, localId)}/restore`, { method: 'POST' });
    if (!response.ok) {
        assertPendingResponseOk(response, 'Failed to restore discarded message');
    }
    await fetchAndApplyPendingMessagesV2({
        sessionId, encryption, request, outboxScope: params.outboxScope,
        isOutboxScopeCurrent: params.isOutboxScopeCurrent,
    });
}

export async function deleteDiscardedPendingMessageV2(params: {
    sessionId: string;
    pendingId: string;
    encryption: Encryption;
    request: (path: string, init?: RequestInit) => Promise<Response>;
    outboxScope: ServerAccountScope;
    isOutboxScopeCurrent?: () => boolean | Promise<boolean>;
}): Promise<void> {
    const { sessionId, pendingId, encryption, request } = params;
    const { localId } = resolvePendingMutationIdentity(sessionId, pendingId, params.outboxScope);

    try {
        const response = await request(pendingMessagePath(sessionId, localId), { method: 'DELETE' });
        if (!response.ok && response.status !== 404) {
            assertPendingResponseOk(response, 'Failed to delete discarded message');
        }
        markPendingLocalIdDeleted(params.outboxScope, sessionId, localId);
        await fetchAndApplyPendingMessagesV2({
            sessionId, encryption, request, outboxScope: params.outboxScope,
            isOutboxScopeCurrent: params.isOutboxScopeCurrent,
        });
    } catch (error) {
        clearDeletedPendingLocalId(params.outboxScope, sessionId, localId);
        throw error;
    }
}

export async function reorderPendingMessagesV2(params: {
    sessionId: string;
    orderedLocalIds: string[];
    encryption: Encryption;
    request: (path: string, init?: RequestInit) => Promise<Response>;
    outboxScope: ServerAccountScope;
    isOutboxScopeCurrent?: () => boolean | Promise<boolean>;
}): Promise<void> {
    const { sessionId, orderedLocalIds, encryption, request } = params;
    for (const localId of orderedLocalIds) {
        assertCanonicalPendingLocalIdTransportable(sessionId, localId, params.outboxScope);
    }

    const response = await request(`/v2/sessions/${sessionId}/pending/reorder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderedLocalIds }),
    });
    if (!response.ok) {
        assertPendingResponseOk(response, 'Failed to reorder pending messages');
    }
    await fetchAndApplyPendingMessagesV2({
        sessionId, encryption, request, outboxScope: params.outboxScope,
        isOutboxScopeCurrent: params.isOutboxScopeCurrent,
    });
}
