import type { Prisma } from "@prisma/client";
import type { FastifyRequest } from "fastify";
import { z } from "zod/mini";
import { SessionTranscriptSurfaceItemReferenceInputV1Schema } from '@happier-dev/protocol/sessions/messages/transcriptObservationV1';
import { catchupFollowupReturnedCounter } from "@/app/monitoring/metrics/index";
import { SessionMessageDeliveryResolutionV1Schema, readStoredSessionMessageDeliveryResolutionV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageDeliveryResolutionV1';
import { FollowDeliveryProjectionV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowDeliveryProjectionV1';
import { SessionMessageRoleSchema, type SessionMessageRole } from '@happier-dev/protocol/sessions/messages/sessionMessageRole';
import { MessageActionReferenceV1Schema } from '@happier-dev/protocol/sessions/messages/messageActionReferenceV1';
import { ExternalShareableActorV1Schema, ExternalShareableTranscriptSnapshotV1Schema, deriveExternalShareableActorFromAdmissionReceiptV1 } from '@happier-dev/protocol/sessions/messages/sessionExternalShareableTranscriptV1';
import { SessionMessageAccountActorV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessageAccountActorV1';
import { SessionInputAdmissionReceiptV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { SessionStoredMessageContentSchema } from '@happier-dev/protocol/sessions/messages/sessionStoredMessageContent';
import { SessionTranscriptObservationProvenanceV1Schema, isRecoveredHistoryTranscriptObservationProvenance } from '@happier-dev/protocol/sessions/messages/transcriptObservationV1';
import { parseSessionMessageRole } from "@/app/session/messageRole/resolveSessionMessageRole";
import { issueSessionMessageActionReference } from "@/app/session/sessionMessageActionLookup";
import { projectSessionInputAdmissionReceipt } from "@/app/session/messages/sessionInputAdmission";
import { projectSessionFollowWakeBatchDelivery } from "@/app/session/follow/projectSessionFollowWakeBatchDelivery";
type SessionStoredMessageContent = z.infer<typeof SessionStoredMessageContentSchema>;
export const SessionTranscriptStoredContentUnavailableResponseSchema = z.strictObject({
    error: z.literal("session_transcript_stored_content_unavailable"),
});
export type SessionListPreviewQuery = Readonly<{
    messageId?: string;
    scope?: unknown;
    sidechainId?: unknown;
    limit?: number;
    beforeSeq?: number;
    afterSeq?: number;
    role?: unknown;
    roles?: unknown;
    projection?: unknown;
}>;
/**
 * `session.list` needs one current main-chain user/agent row for its optional preview. The
 * Machine signature proves who may make the request; this route-owned projection keeps that
 * proof from becoming general transcript pagination authority.
 */
export function isAdmittedSessionListPreviewRequest(input: Readonly<{
    request: Pick<FastifyRequest, "externalActionExecutionAuthorized" | "externalActionEffectActionId" | "externalActionExecutionTarget">;
    sessionId: string;
    query: SessionListPreviewQuery | undefined;
}>): boolean {
    if (input.request.externalActionExecutionAuthorized !== true
        || input.request.externalActionEffectActionId !== "session.list") {
        return true;
    }
    const target = input.request.externalActionExecutionTarget;
    if (!target)
        return false;
    if (target.kind === "session" && target.sessionId !== input.sessionId)
        return false;
    const query = input.query;
    return query?.limit === 1
        && query.scope === "main"
        && query.roles === "user,agent"
        && query.sidechainId === undefined
        && query.messageId === undefined
        && query.beforeSeq === undefined
        && query.afterSeq === undefined
        && query.role === undefined
        && query.projection === undefined;
}
export const SessionTranscriptMessagePageResponseSchema = z.strictObject({
    messages: z.array(z.strictObject({
        id: z.string(),
        seq: z.number().check(z.int(), z.minimum(0)),
        content: SessionStoredMessageContentSchema,
        localId: z.nullable(z.string()),
        sidechainId: z.optional(z.string().check(z.minLength(1))),
        messageRole: z.optional(SessionMessageRoleSchema),
        deliveryResolution: z.optional(SessionMessageDeliveryResolutionV1Schema),
        followDeliveryProjection: z.optional(FollowDeliveryProjectionV1Schema),
        createdAt: z.number().check(z.int(), z.minimum(0)),
        updatedAt: z.number().check(z.int(), z.minimum(0)),
        sourceCreatedAt: z.optional(z.number().check(z.int(), z.minimum(0))),
        sourceUpdatedAt: z.optional(z.number().check(z.int(), z.minimum(0))),
        transcriptObservationProvenance: z.optional(SessionTranscriptObservationProvenanceV1Schema),
        surfaceItemReference: z.optional(z.nullable(SessionTranscriptSurfaceItemReferenceInputV1Schema)),
        externalShareableActor: z.optional(ExternalShareableActorV1Schema),
        /**
         * Authenticated-reader only. External/public-link projections keep their
         * deliberately coarse `externalShareableActor` contract and never carry
         * an Account identity or profile.
         */
        accountActor: z.optional(z.nullable(SessionMessageAccountActorV1Schema)),
        inputAdmissionReceipt: z.optional(SessionInputAdmissionReceiptV1Schema),
        messageActionReference: z.optional(MessageActionReferenceV1Schema),
    })),
    hasMore: z.boolean(),
    nextBeforeSeq: z.nullable(z.number().check(z.int(), z.minimum(0))),
    nextAfterSeq: z.nullable(z.number().check(z.int(), z.minimum(0))),
    publicationBlocked: z.optional(z.boolean()),
    externalShareableSnapshot: z.optional(ExternalShareableTranscriptSnapshotV1Schema),
});
export function deriveExternalShareableActor(params: Readonly<{
    inputAdmissionReceipt: unknown;
    messageRole: unknown;
    transcriptObservationProvenance: unknown;
}>) {
    const admittedActor = deriveExternalShareableActorFromAdmissionReceiptV1(params.inputAdmissionReceipt, 'stored');
    if (admittedActor)
        return admittedActor;
    if (parseSessionMessageRole(params.messageRole) !== "user")
        return null;
    return isRecoveredHistoryTranscriptObservationProvenance(params.transcriptObservationProvenance) ? "machine" : null;
}
type ExternalShareableReferencedUserSourceRow = Readonly<{
    id: unknown;
    seq: unknown;
    localId: unknown;
    messageRole: unknown;
    sidechainId: unknown;
    content: unknown;
    createdAt: unknown;
    updatedAt: unknown;
    inputAdmissionReceipt: unknown;
    transcriptObservationProvenance: unknown;
}>;
export function readExternalShareableSequence(value: unknown): number | null {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
        ? value
        : null;
}
/**
 * The server snapshot is the disclosure boundary for out-of-page consumed
 * inputs. Keep the database-only receipt behind this projection even though
 * it is needed briefly to derive the coarse actor.
 */
export function projectExternalShareableReferencedUserRow(row: ExternalShareableReferencedUserSourceRow) {
    const seq = readExternalShareableSequence(row.seq);
    const content = SessionStoredMessageContentSchema.safeParse(row.content);
    if (typeof row.id !== "string"
        || !row.id
        || seq === null
        || typeof row.localId !== "string"
        || !row.localId
        || parseSessionMessageRole(row.messageRole) !== "user"
        || row.sidechainId !== null
        || !content.success
        || !(row.createdAt instanceof Date)
        || !(row.updatedAt instanceof Date)) {
        return null;
    }
    const externalShareableActor = deriveExternalShareableActor({
        inputAdmissionReceipt: row.inputAdmissionReceipt,
        messageRole: row.messageRole,
        transcriptObservationProvenance: row.transcriptObservationProvenance,
    });
    return {
        id: row.id,
        seq,
        localId: row.localId,
        messageRole: "user" as const,
        content: content.data,
        createdAt: row.createdAt.getTime(),
        updatedAt: row.updatedAt.getTime(),
        ...(externalShareableActor ? { externalShareableActor } : {}),
    };
}
function parseSessionMessageRoleCsv(value: unknown): {
    ok: true;
    roles: string[];
} | {
    ok: false;
} {
    if (typeof value !== "string")
        return { ok: false };
    const roles = value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    return roles.length > 0 ? { ok: true, roles } : { ok: false };
}
export function resolveRequestedMessageRoles(query: Readonly<{
    role?: unknown;
    roles?: unknown;
}> | undefined): {
    ok: true;
    roles: SessionMessageRole[];
} | {
    ok: false;
} {
    if (!query || (query.role === undefined && query.roles === undefined))
        return { ok: true, roles: [] };
    if (Array.isArray(query.role) || Array.isArray(query.roles))
        return { ok: false };
    const roles: SessionMessageRole[] = [];
    if (query.role !== undefined) {
        const parsed = SessionMessageRoleSchema.safeParse(query.role);
        if (!parsed.success)
            return { ok: false };
        roles.push(parsed.data);
    }
    if (query.roles !== undefined) {
        const parsedCsv = parseSessionMessageRoleCsv(query.roles);
        if (!parsedCsv.ok)
            return { ok: false };
        for (const rawRole of parsedCsv.roles) {
            const parsed = SessionMessageRoleSchema.safeParse(rawRole);
            if (!parsed.success)
                return { ok: false };
            roles.push(parsed.data);
        }
    }
    return { ok: true, roles: Array.from(new Set(roles)) };
}
export function buildRequestedMessageRoleWhere(roles: readonly SessionMessageRole[]): Prisma.SessionMessageWhereInput | null {
    if (roles.length === 0)
        return null;
    const concreteRoleFilter = roles.length === 1 ? roles[0] : { in: [...roles] };
    if (!roles.includes("user")) {
        return { messageRole: concreteRoleFilter };
    }
    return {
        OR: [
            { messageRole: concreteRoleFilter },
            { messageRole: null },
        ],
    };
}
export const SESSION_MESSAGE_PAGE_DEFAULT_LIMIT = 150;
export const SESSION_BATCH_MESSAGE_ROLES = ['user', 'agent', 'event'] as const;
export const SESSION_MESSAGE_PAGE_ROW_SELECT = {
    id: true,
    sessionId: true,
    seq: true,
    localId: true,
    sidechainId: true,
    messageRole: true,
    content: true,
    deliveryResolution: true,
    acceptedTurnKind: true,
    acceptedTurnId: true,
    turnStartWitnessId: true,
    createdAt: true,
    updatedAt: true,
    sourceCreatedAt: true,
    sourceUpdatedAt: true,
    transcriptObservationProvenance: true,
    surfaceItemReference: true,
    inputAdmissionReceipt: true,
    authorAccountId: true,
} as const satisfies Prisma.SessionMessageSelect;
export type SessionMessagePageRow = Prisma.SessionMessageGetPayload<{
    select: typeof SESSION_MESSAGE_PAGE_ROW_SELECT;
}>;
export type SessionMessagePageResponse = {
    status: 200;
    body: z.output<typeof SessionTranscriptMessagePageResponseSchema>;
} | {
    status: 400 | 403 | 404 | 503;
    body: {
        error: string;
        code?: string;
    };
};
export function projectSessionMessagePage(input: Readonly<{
    sessionId: string;
    resultMessages: readonly SessionMessagePageRow[];
    hasMore: boolean;
    publicationBlocked?: boolean;
    externalShareableSnapshot?: z.infer<typeof ExternalShareableTranscriptSnapshotV1Schema>;
    turnProjectionNextBeforeSeq: number | null;
    pageAccountActors: readonly (z.infer<typeof SessionMessageAccountActorV1Schema> | null)[] | undefined;
    sessionListPreviewProjection: boolean;
    externalShareableProjection: boolean;
    turnProjection: boolean;
    afterSeq?: number;
}>): SessionMessagePageResponse {
    const { sessionId, resultMessages, hasMore, publicationBlocked, externalShareableSnapshot, turnProjectionNextBeforeSeq, pageAccountActors, sessionListPreviewProjection, externalShareableProjection, turnProjection, afterSeq } = input;
    const parsedResultContents: SessionStoredMessageContent[] = [];
    for (const message of resultMessages) {
        const parsedContent = SessionStoredMessageContentSchema.safeParse(message.content);
        if (!parsedContent.success) {
            return { status: 503, body: {
                    error: "session_transcript_stored_content_unavailable",
                } };
        }
        parsedResultContents.push(parsedContent.data);
    }
    if (afterSeq !== undefined) {
        catchupFollowupReturnedCounter.inc({ type: 'session-messages-afterSeq' }, resultMessages.length);
    }
    const nextBeforeSeq = afterSeq !== undefined
        ? null
        // The turn projection pages by TURN, so its cursor is the oldest prompt kept —
        // the last ROW returned is a reply, and paging below that would skip its prompt.
        : turnProjection
            ? turnProjectionNextBeforeSeq
            : hasMore && resultMessages.length > 0
                ? resultMessages[resultMessages.length - 1].seq
                : null;
    const nextAfterSeq = afterSeq !== undefined
        ? hasMore && resultMessages.length > 0
            ? resultMessages[resultMessages.length - 1].seq
            : null
        : null;
    return { status: 200, body: {
            messages: resultMessages.map((v, index) => ({
                id: v.id,
                seq: v.seq,
                content: parsedResultContents[index]!,
                ...(!sessionListPreviewProjection ? (() => {
                    const reference = issueSessionMessageActionReference({
                        sessionId,
                        messageId: v.id,
                        updatedAt: v.updatedAt,
                    });
                    return reference ? { messageActionReference: reference } : {};
                })() : {}),
                ...(!sessionListPreviewProjection ? (() => {
                    const deliveryResolution = readStoredSessionMessageDeliveryResolutionV1(v.deliveryResolution);
                    return deliveryResolution ? { deliveryResolution } : {};
                })() : {}),
                ...(!externalShareableProjection && !sessionListPreviewProjection
                    ? projectSessionFollowWakeBatchDelivery(v) : {}),
                localId: v.localId,
                ...(!sessionListPreviewProjection && typeof v.sidechainId === "string" && v.sidechainId
                    ? { sidechainId: v.sidechainId }
                    : {}),
                ...(() => {
                    const messageRole = parseSessionMessageRole(v.messageRole);
                    return messageRole ? { messageRole } : {};
                })(),
                createdAt: v.createdAt.getTime(),
                updatedAt: v.updatedAt.getTime(),
                ...(!sessionListPreviewProjection && v.sourceCreatedAt
                    ? { sourceCreatedAt: v.sourceCreatedAt.getTime() }
                    : {}),
                ...(!sessionListPreviewProjection && v.sourceUpdatedAt
                    ? { sourceUpdatedAt: v.sourceUpdatedAt.getTime() }
                    : {}),
                ...(!sessionListPreviewProjection ? (() => {
                    const provenance = SessionTranscriptObservationProvenanceV1Schema.safeParse(v.transcriptObservationProvenance);
                    return provenance.success ? { transcriptObservationProvenance: provenance.data } : {};
                })() : {}),
                ...(() => {
                    if (!externalShareableProjection)
                        return {};
                    const externalShareableActor = deriveExternalShareableActor({
                        inputAdmissionReceipt: v.inputAdmissionReceipt,
                        messageRole: v.messageRole,
                        transcriptObservationProvenance: v.transcriptObservationProvenance,
                    });
                    return externalShareableActor ? { externalShareableActor } : {};
                })(),
                // Ordinary pages carry admitted occurrences when present. Only
                // the explicit publication page asserts completeness with null.
                ...(externalShareableProjection
                    ? { surfaceItemReference: v.surfaceItemReference == null ? null : SessionTranscriptSurfaceItemReferenceInputV1Schema.parse(v.surfaceItemReference) }
                    : !sessionListPreviewProjection && v.surfaceItemReference != null
                        ? { surfaceItemReference: SessionTranscriptSurfaceItemReferenceInputV1Schema.parse(v.surfaceItemReference) } : {}),
                // Transcript pages state object-or-null so clients can retract
                // stale attribution. Derived evidence may omit presentation.
                ...(externalShareableProjection || sessionListPreviewProjection
                    ? {}
                    : { ...(pageAccountActors === undefined ? {} : { accountActor: pageAccountActors[index] ?? null }),
                        ...projectSessionInputAdmissionReceipt(v.inputAdmissionReceipt) }),
            })),
            hasMore: sessionListPreviewProjection
                ? false
                : hasMore
                    || publicationBlocked
                    || externalShareableSnapshot?.publicationBlockedFromSeq !== undefined
                    || externalShareableSnapshot?.turnSettlementBlockedFromSeq !== undefined,
            nextBeforeSeq: sessionListPreviewProjection ? null : nextBeforeSeq,
            nextAfterSeq: sessionListPreviewProjection ? null : nextAfterSeq,
            ...(externalShareableProjection ? { publicationBlocked, externalShareableSnapshot } : {}),
        } };
}
