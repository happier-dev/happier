import {
    MessageActionReferenceV1Schema,
    type MessageActionDurableResolutionV1,
    type MessageActionReferenceV1,
    type SessionMessageRole,
} from "@happier-dev/protocol";

import { parseSessionMessageRole } from "./messageRole/resolveSessionMessageRole";
import { resolveSessionTranscriptPublicationCeiling } from "./sessionTranscriptPublicationPolicy";

type SessionMessageActionRow = Readonly<{
    id: unknown;
    sessionId: unknown;
    seq: unknown;
    messageRole: unknown;
    updatedAt: unknown;
}>;

export type SessionMessageActionLookup = MessageActionDurableResolutionV1;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isServerSequence(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function resolveMessageRole(value: unknown): SessionMessageRole | null | undefined {
    if (value === null) return null;
    return parseSessionMessageRole(value) ?? undefined;
}

function readUpdatedAtMs(value: unknown): number | null {
    return value instanceof Date
        && Number.isSafeInteger(value.getTime())
        ? value.getTime()
        : null;
}

const sessionMessageRowRevisionActionReferencePattern = /^session-message-row-revision:v1:(0|[1-9][0-9]*)$/;

/**
 * The active prepare-phase issuer retains its existing timestamp observation.
 * The canonical Message row revision codec below is intentionally not consumed
 * until the separately gated activation transition.
 */
export function issueSessionMessageActionReference(params: Readonly<{
    sessionId: string;
    messageId: string;
    updatedAt: unknown;
}>): MessageActionReferenceV1 | null {
    const updatedAtMs = readUpdatedAtMs(params.updatedAt);
    if (updatedAtMs === null) return null;

    const parsed = MessageActionReferenceV1Schema.safeParse({
        v: 1,
        sessionId: params.sessionId,
        messageId: params.messageId,
        observedRevision: `message-updated-at:${updatedAtMs}`,
    });
    return parsed.success ? parsed.data : null;
}

export function issueSessionMessageRowRevisionActionReference(params: Readonly<{
    sessionId: string;
    messageId: string;
    rowRevision: unknown;
}>): MessageActionReferenceV1 | null {
    if (typeof params.rowRevision !== "bigint" || params.rowRevision < BigInt(0)) return null;

    const parsed = MessageActionReferenceV1Schema.safeParse({
        v: 1,
        sessionId: params.sessionId,
        messageId: params.messageId,
        observedRevision: `session-message-row-revision:v1:${params.rowRevision.toString(10)}`,
    });
    return parsed.success ? parsed.data : null;
}

export function parseSessionMessageRowRevisionActionReference(observedRevision: unknown): bigint | null {
    if (typeof observedRevision !== "string") return null;
    const match = sessionMessageRowRevisionActionReferencePattern.exec(observedRevision);
    return match ? BigInt(match[1]) : null;
}

/**
 * Resolves the server-owned, durable portion of a Message Action reference.
 *
 * The Message owner reads with a current-participant predicate. If no row is
 * visible, it then asks the same transaction whether the Session remains
 * accessible: only accessible+missing is `deleted`; inaccessible stays
 * `unavailable`. The returned data intentionally excludes content and
 * revision/current-intent state: those decisions require the decrypted
 * Message and live mounted SDK action owner, respectively.
 */
export async function resolveSessionMessageActionLookup(params: Readonly<{
    actorUserId: string;
    sessionId: string;
    messageId: string;
    reference: MessageActionReferenceV1;
    readAccess: (actorUserId: string, sessionId: string) => Promise<boolean>;
    /**
     * Reads the exact durable row without applying a transcript-publication
     * filter. The owner applies the publication ceiling below so it can return
     * `compacted`, rather than incorrectly reporting the filtered row deleted.
     */
    readMessage: (sessionId: string, messageId: string) => Promise<SessionMessageActionRow | null>;
    readPublication: (sessionId: string) => Promise<object | null>;
}>): Promise<SessionMessageActionLookup> {
    try {
        const reference = MessageActionReferenceV1Schema.safeParse(params.reference);
        if (!reference.success
            || reference.data.sessionId !== params.sessionId
            || reference.data.messageId !== params.messageId) {
            return { status: "unavailable" };
        }
        const row = await params.readMessage(params.sessionId, params.messageId);
        if (row === null || !isRecord(row)
            || row.id !== params.messageId
            || row.sessionId !== params.sessionId
            || !isServerSequence(row.seq)) {
            if (row !== null || !await params.readAccess(params.actorUserId, params.sessionId)) {
                return { status: "unavailable" };
            }
            return { status: "deleted" };
        }

        const messageRole = resolveMessageRole(row.messageRole);
        if (messageRole === undefined) return { status: "unavailable" };
        const currentReference = issueSessionMessageActionReference({
            sessionId: params.sessionId,
            messageId: params.messageId,
            updatedAt: row.updatedAt,
        });
        if (!currentReference) return { status: "unavailable" };

        const publication = await params.readPublication(params.sessionId);
        if (!publication || !isRecord(publication)) return { status: "unavailable" };
        const ceiling = resolveSessionTranscriptPublicationCeiling(publication);
        if (ceiling !== null && row.seq > ceiling) {
            return { status: "compacted" };
        }
        if (currentReference.observedRevision !== reference.data.observedRevision) {
            return { status: "stale" };
        }

        return {
            status: "available",
            message: {
                sessionId: params.sessionId,
                messageId: params.messageId,
                seq: row.seq,
                messageRole,
                observedRevision: currentReference.observedRevision,
            },
        };
    } catch {
        return { status: "unavailable" };
    }
}
