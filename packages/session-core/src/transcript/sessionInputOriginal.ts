import { FollowDeliveryProjectionV1Schema, type FollowDeliveryProjectionV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowDeliveryProjectionV1';
import { SessionMessageRoleSchema, type SessionMessageRole } from '@happier-dev/protocol/sessions/messages/sessionMessageRole';
import { SessionTurnV1Schema, type SessionTurnV1 } from '@happier-dev/protocol/sessions/turns/sessionTurnV1';
import { SessionRuntimeIssueV1Schema, type SessionRuntimeIssueV1 } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import { readStoredSessionMessageDeliveryResolutionV1, type SessionMessageDeliveryResolutionV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageDeliveryResolutionV1';
import { SessionInputAdmissionReceiptV1Schema, type SessionInputAdmissionReceiptV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { SessionStoredMessageContentSchema as SessionMessageContentSchema, type SessionStoredMessageContent as SessionMessageContent } from '@happier-dev/protocol/sessions/messages/sessionStoredMessageContent';

export type TranscriptMessageLookupResult = {
    id: string;
    seq: number;
    localId: string | null;
    sidechainId: string | null;
    createdAt: number;
    updatedAt: number;
    content: SessionMessageContent;
    messageRole?: SessionMessageRole;
    inputAdmissionReceipt?: SessionInputAdmissionReceiptV1;
    deliveryResolution?: SessionMessageDeliveryResolutionV1;
    acceptedTurnId?: string;
    turnStartWitnessId?: string;
    turn?: SessionTurnV1;
    inputDeliveryIssue?: SessionRuntimeIssueV1;
    followDeliveryProjection?: FollowDeliveryProjectionV1;
};

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

export function parseTranscriptLookupMessageFromUnknown(found: unknown): TranscriptMessageLookupResult | null {
    const record = asRecord(found);
    if (!record) return null;
    const content = SessionMessageContentSchema.safeParse(record.content);
    if (!content.success) return null;
    const role = record.messageRole == null ? null : SessionMessageRoleSchema.safeParse(record.messageRole);
    if (role && !role.success) return null;
    const receipt = record.inputAdmissionReceipt === undefined ? null
        : SessionInputAdmissionReceiptV1Schema.safeParse(record.inputAdmissionReceipt);
    if (receipt && !receipt.success) return null;
    const turn = record.turn === undefined ? null : SessionTurnV1Schema.safeParse(record.turn);
    if (turn && !turn.success) return null;
    const inputDeliveryIssue = record.inputDeliveryIssue === undefined ? null : SessionRuntimeIssueV1Schema.safeParse(record.inputDeliveryIssue);
    if (inputDeliveryIssue && !inputDeliveryIssue.success) return null;
    const followDeliveryProjection = record.followDeliveryProjection === undefined
        ? undefined
        : FollowDeliveryProjectionV1Schema.safeParse(record.followDeliveryProjection);
    if (followDeliveryProjection && !followDeliveryProjection.success) return null;
    const deliveryResolution = record.deliveryResolution === undefined ? null
        : readStoredSessionMessageDeliveryResolutionV1(record.deliveryResolution);
    if (record.deliveryResolution !== undefined && !deliveryResolution) return null;
    for (const key of ['acceptedTurnId', 'turnStartWitnessId']) {
        const value = record[key];
        if (value !== undefined && (typeof value !== 'string' || value.length === 0)) return null;
    }
    if (typeof record.id !== 'string') return null;
    if (typeof record.seq !== 'number') return null;
    const foundLocalId = typeof record.localId === 'string' ? record.localId : null;
    const sidechainIdRaw = record.sidechainId;
    const sidechainId = typeof sidechainIdRaw === 'string' ? (sidechainIdRaw.trim() || null) : null;
    const createdAtRaw = record.createdAt;
    if (!(typeof createdAtRaw === 'number' && Number.isSafeInteger(createdAtRaw) && createdAtRaw >= 0)) return null;
    const updatedAtRaw = record.updatedAt;
    if (!(typeof updatedAtRaw === 'number' && Number.isSafeInteger(updatedAtRaw) && updatedAtRaw >= 0)) return null;
    return {
        id: record.id,
        seq: record.seq,
        localId: foundLocalId,
        sidechainId,
        createdAt: createdAtRaw,
        updatedAt: updatedAtRaw,
        content: content.data,
        ...(role?.success ? { messageRole: role.data } : {}),
        ...(receipt?.success ? { inputAdmissionReceipt: receipt.data } : {}),
        ...(deliveryResolution ? { deliveryResolution } : {}),
        ...(typeof record.acceptedTurnId === 'string' ? { acceptedTurnId: record.acceptedTurnId } : {}),
        ...(typeof record.turnStartWitnessId === 'string' ? { turnStartWitnessId: record.turnStartWitnessId } : {}),
        ...(turn?.success ? { turn: turn.data } : {}),
        ...(inputDeliveryIssue?.success ? { inputDeliveryIssue: inputDeliveryIssue.data } : {}),
        ...(followDeliveryProjection?.success ? { followDeliveryProjection: followDeliveryProjection.data } : {}),
    };
}
