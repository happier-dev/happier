import { decodeBase64 } from "privacy-kit";
import { classifySessionDataKeyEnvelopeItemV1, decodeSessionDataKeyEnvelopeCursorV1, encodeSessionDataKeyEnvelopeCursorV1, PatchSessionDataKeyEnvelopesV1Schema, type SessionDataKeyEnvelopeErrorCodeV1, type SessionDataKeyEnvelopeItemV1, type SessionDataKeyEnvelopePageQueryV1, type SessionDataKeyEnvelopePageV1, type SessionDataKeyEnvelopeStateV1 } from '@happier-dev/protocol/sessions/encryption/sessionDataKeyEnvelopes';
import { parseEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';

import { writeSessionDataKeyEnvelopeInTx } from "./sessionDataKeyEnvelopePersistence";
import { deriveAccountRecipientEnvelopeReadinessFromRow } from "@/app/encryption/accountRecipientEnvelopeReadiness";
import {
    projectRecipientContentKey,
    RECIPIENT_READINESS_SELECT,
    type RecipientReadinessRow,
} from "./sessionDataKeyRecipientProjection";
import {
    listCurrentSessionAudienceAccountsInTx,
    resolveSessionAccessForOperation,
    resolveStructuralSessionAccessForAccountsInTx,
    resolveStructuralSessionAccessForSessionsInTx,
} from "@/app/session/access/sessionAccess";
import { readCollectiveSessionGrantIdsForAccountInTx } from "@/app/session/access/sessionAccessMembershipImpact";
import { inTx, type Tx } from "@/storage/inTx";
import { portableQueryChunks } from "@/storage/portableQueryChunks";
import { captureReadSnapshot } from "@/storage/captureReadSnapshot";
import type { SessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication";
import { acquireSessionAccountCursorLocksInTx } from "@/app/session/changeTracking/acquireSessionAccountCursorLocksInTx";
import { markAccountChanged } from "@/app/changes/markAccountChanged";

/**
 * The canonical per-Session recipient data-key envelope collection.
 *
 * It is the only owner of the `GET`/`PATCH /v2/sessions/:sessionId/data-key/envelopes`
 * behavior. Access comes from the Lane 04 effective-access owner, recipient
 * readiness from the Account encryption owner, and envelope structure from the
 * Protocol codec: this service composes those decisions and owns nothing that
 * could become a second answer to any of them.
 *
 * The Home stores and projects opaque bytes. It never opens an envelope, never
 * claims a stored envelope is usable, and never treats tuple presence as access.
 */

/**
 * How many audience Accounts one database round trip resolves while the summary
 * walks the whole authorized audience.
 *
 * It matches the Account-filter chunking the access owner already uses, so a
 * scan stays below SQLite's conservative bind-parameter boundary. It bounds
 * memory and transport per round trip, not the authorized result set, and it is
 * deliberately independent of the wire page bound: the page limits what one
 * client receives, this limits what one query binds.
 */
const AUDIENCE_SCAN_CHUNK = 100;

export type SessionDataKeyEnvelopePageError = Extract<
    SessionDataKeyEnvelopeErrorCodeV1,
    "session_not_found" | "forbidden" | "invalid_cursor" | "session_data_key_unavailable"
    | "session_access_authentication_required" | "session_access_authentication_unavailable"
>;

export type SessionDataKeyEnvelopePageResult =
    | Readonly<{ ok: true; page: SessionDataKeyEnvelopePageV1 }>
    | Readonly<{ ok: false; error: SessionDataKeyEnvelopePageError }>;

export type SessionDataKeyEnvelopePatchError = Extract<
    SessionDataKeyEnvelopeErrorCodeV1,
    | "invalid_request"
    | "session_not_found"
    | "forbidden"
    | "session_access_authentication_required"
    | "session_access_authentication_unavailable"
    | "data_key_not_required"
    | "recipient_changed"
    | "recipient_key_unavailable"
    | "session_data_key_unavailable"
>;

export type SessionDataKeyEnvelopePatchResult =
    | Readonly<{ ok: true; appliedCount: number }>
    | Readonly<{ ok: false; error: SessionDataKeyEnvelopePatchError }>;

function toBytes(value: Uint8Array): Uint8Array {
    return new Uint8Array(value);
}

function projectEnvelopeState(stored: Uint8Array | null): SessionDataKeyEnvelopeStateV1 {
    if (stored === null) return "missing";
    // Bytes that no conforming producer could have emitted stay stored and
    // become repair work; discarding them would erase the only evidence the
    // recipient's manager needs to prepare again.
    return parseEncryptedDataKeyEnvelopeV1(stored) === null ? "invalid" : "prepared";
}

/**
 * Account key setup can make an existing Team or Group audience sealable.
 * Run after the Account mutation commits so it never holds its key-admission
 * locks while publishing to other Accounts. The daemon consumes the same
 * content-free wake used for membership changes.
 */
export async function publishSessionRecipientReadinessWake(accountId: string): Promise<void> {
    await inTx(async tx => {
        const sessionIds = await readCollectiveSessionGrantIdsForAccountInTx(tx, accountId);
        for (const ids of portableQueryChunks({ values: sessionIds, bindingsPerValue: 1, fixedBindings: 3 })) {
            const candidates = await tx.session.findMany({
                where: { id: { in: [...ids] }, accountId: { not: accountId }, encryptionMode: "e2ee",
                    dataKeyEnvelopes: { some: {} } },
                select: { id: true, accountId: true, dataKeyEnvelopes: {
                    where: { recipientAccountId: accountId }, select: { encryptedDataKey: true },
                } },
            });
            const owed = candidates.filter(row => projectEnvelopeState(row.dataKeyEnvelopes[0]?.encryptedDataKey ?? null) !== "prepared");
            const access = await resolveStructuralSessionAccessForSessionsInTx(tx, {
                sessionIds: owed.map(row => row.id), accountIds: [accountId],
            });
            for (const row of owed) {
                const recipient = access.get(row.id)?.get(accountId);
                if (recipient?.capabilities.readTranscript
                    && recipient.sources.some(source => source.kind === "team" || source.kind === "group")) {
                    await markAccountChanged(tx, { accountId: row.accountId, kind: "share", entityId: row.id });
                }
            }
        }
    });
}

type CollectionAuthorization =
    | Readonly<{ ok: true; encryptionMode: "e2ee" | "plain" }>
    | Readonly<{ ok: false; error: Extract<SessionDataKeyEnvelopeErrorCodeV1, "session_data_key_unavailable"> }>
    | Readonly<{ ok: false; error: Extract<SessionDataKeyEnvelopeErrorCodeV1, "session_not_found" | "forbidden" | "session_access_authentication_required" | "session_access_authentication_unavailable"> }>;

/**
 * Visibility and management are separate answers on purpose: a Session the
 * caller cannot read must be indistinguishable from one that does not exist,
 * while a readable Session the caller cannot manage gets an honest `forbidden`.
 */
async function authorizeCollection(
    tx: Tx,
    input: Readonly<{ actorAccountId: string; sessionId: string; authentication: SessionAccessAuthentication }>,
): Promise<CollectionAuthorization> {
    const decision = await resolveSessionAccessForOperation(tx, {
        accountId: input.actorAccountId,
        sessionId: input.sessionId,
        authentication: input.authentication,
        capability: "manageAccess",
    });
    if (decision.status === "authentication_required") {
        return { ok: false, error: "session_access_authentication_required" };
    }
    if (decision.status === "authentication_unavailable") {
        return { ok: false, error: "session_access_authentication_unavailable" };
    }
    if (decision.status !== "allowed") {
        const readable = await resolveSessionAccessForOperation(tx, {
            accountId: input.actorAccountId,
            sessionId: input.sessionId,
            authentication: input.authentication,
            capability: "readTranscript",
        });
        if (readable.status === "allowed") return { ok: false, error: "forbidden" };
        return { ok: false, error: "session_not_found" };
    }

    const session = await tx.session.findUnique({
        where: { id: input.sessionId },
        select: { encryptionMode: true },
    });
    if (!session) return { ok: false, error: "session_not_found" };
    if (session.encryptionMode !== "e2ee" && session.encryptionMode !== "plain") {
        return { ok: false, error: "session_data_key_unavailable" };
    }
    return { ok: true, encryptionMode: session.encryptionMode };
}

async function readAudienceChunk(
    tx: Tx,
    sessionId: string,
    afterAccountId: string | null,
): Promise<readonly { account: RecipientReadinessRow; stored: Uint8Array | null }[]> {
    const audience = await listCurrentSessionAudienceAccountsInTx({
        tx,
        sessionId,
        afterAccountId,
        limit: AUDIENCE_SCAN_CHUNK,
    });
    if (audience.length === 0) return [];
    const accountIds = audience.map(entry => entry.accountId);

    const accounts = await tx.account.findMany({
        where: { id: { in: accountIds } },
        select: RECIPIENT_READINESS_SELECT,
        orderBy: { id: "asc" },
    });
    const envelopes = await tx.sessionDataKeyEnvelope.findMany({
        where: { sessionId, recipientAccountId: { in: accountIds } },
        select: { recipientAccountId: true, encryptedDataKey: true },
    });
    const storedByAccountId = new Map(
        envelopes.map(row => [row.recipientAccountId, toBytes(row.encryptedDataKey)] as const),
    );
    return accounts.map(account => ({
        account,
        stored: storedByAccountId.get(account.id) ?? null,
    }));
}

/**
 * Reads one bounded exception page plus a cursorless Session-scoped aggregate.
 *
 * The aggregate describes every Account in the current authorized audience,
 * including the Session's storage owner, because the canonical tuple stores the
 * owner's envelope too. It is computed by walking that audience in bounded
 * chunks through the same readiness and codec owners the items use, so the
 * summary can never disagree with the rows a manager expands. Cursorless
 * discovery and the cursorless final recheck pay that one set-aggregate cost;
 * continuation pages start from their database keyset and return `summary:
 * null`, so they neither rescan nor discard the already delivered prefix.
 */
function projectAudienceItem(account: RecipientReadinessRow, stored: Uint8Array | null): SessionDataKeyEnvelopeItemV1 {
    const readiness = deriveAccountRecipientEnvelopeReadinessFromRow(account);
    return { recipientAccountId: account.id, envelopeState: projectEnvelopeState(stored),
        contentKey: projectRecipientContentKey(account, readiness) };
}

export async function readSessionDataKeyEnvelopePage(input: Readonly<{
    actorAccountId: string;
    sessionId: string;
    query: SessionDataKeyEnvelopePageQueryV1;
    authentication: SessionAccessAuthentication;
}>): Promise<SessionDataKeyEnvelopePageResult> {
    const cursorAccountId = input.query.cursor === undefined
        ? null
        : decodeSessionDataKeyEnvelopeCursorV1(input.query.cursor);
    if (input.query.cursor !== undefined && cursorAccountId === null) {
        return { ok: false, error: "invalid_cursor" };
    }

    return await captureReadSnapshot<SessionDataKeyEnvelopePageResult>(async tx => {
        const authorization = await authorizeCollection(tx, input);
        if (!authorization.ok) return { ok: false, error: authorization.error };
        // A plain Session settles before any recipient key material is read.
        if (authorization.encryptionMode === "plain") {
            return { ok: true, page: { status: "not_required" } };
        }

        const summary = cursorAccountId === null
            ? { prepared: 0, pending: 0, invalid: 0, recipientKeyUnavailable: 0 }
            : null;
        const items: SessionDataKeyEnvelopeItemV1[] = [];
        let nextCursor: string | null = null;
        let afterAccountId: string | null = cursorAccountId;

        for (;;) {
            const chunk = await readAudienceChunk(tx, input.sessionId, afterAccountId);
            if (chunk.length === 0) break;

            for (const { account, stored } of chunk) {
                const item = projectAudienceItem(account, stored);
                const bucket = classifySessionDataKeyEnvelopeItemV1(item);
                if (summary !== null) summary[bucket] += 1;

                if (nextCursor !== null) continue;
                if (input.query.state !== "all" && bucket === "prepared") continue;
                if (input.query.state === "owed" && bucket === "recipientKeyUnavailable") continue;

                if (items.length < input.query.limit) {
                    items.push(item);
                } else {
                    // One further qualifying recipient exists, so the cursor is
                    // the last item actually delivered. Cursorless discovery
                    // continues only to finish its one Session-scoped aggregate;
                    // a continuation stops without reading the remaining suffix.
                    nextCursor = encodeSessionDataKeyEnvelopeCursorV1(
                        items[items.length - 1]!.recipientAccountId,
                    );
                }
            }

            if (nextCursor !== null && summary === null) break;

            afterAccountId = chunk[chunk.length - 1]!.account.id;
            if (chunk.length < AUDIENCE_SCAN_CHUNK) break;
        }

        return { ok: true, page: { status: "required", summary, items, nextCursor } };
    });
}

type ValidatedEntry = Readonly<{ recipientAccountId: string; envelope: Uint8Array }>;

function validateEntries(
    entries: readonly Readonly<{ recipientAccountId: string; encryptedDataKey: string }>[],
): readonly ValidatedEntry[] | null {
    const request = PatchSessionDataKeyEnvelopesV1Schema.safeParse({ entries });
    if (!request.success) return null;
    const validated: ValidatedEntry[] = [];
    for (const entry of request.data.entries) {
        let envelope: Uint8Array;
        try {
            envelope = decodeBase64(entry.encryptedDataKey);
        } catch {
            return null;
        }
        if (parseEncryptedDataKeyEnvelopeV1(envelope) === null) return null;
        validated.push({ recipientAccountId: entry.recipientAccountId, envelope });
    }
    return validated;
}

/**
 * Applies one bounded set of recipient envelopes atomically.
 *
 * Every check runs before the first write, so a single bad entry leaves the
 * collection exactly as it was rather than half prepared. Repeating or
 * replacing a structurally valid envelope is allowed: randomized ciphertext for
 * the same data key is semantically equivalent, and last-write-wins is what
 * makes `Prepare again` a real repair path without a revision or digest.
 */
export async function applySessionDataKeyEnvelopes(input: Readonly<{
    actorAccountId: string;
    sessionId: string;
    entries: readonly Readonly<{ recipientAccountId: string; encryptedDataKey: string }>[];
    authentication: SessionAccessAuthentication;
}>): Promise<SessionDataKeyEnvelopePatchResult> {
    const validated = validateEntries(input.entries);
    if (validated === null) return { ok: false, error: "invalid_request" };

    return await inTx(async tx => {
        await acquireSessionAccountCursorLocksInTx(tx, [input.sessionId],
            [input.actorAccountId, ...validated.map(entry => entry.recipientAccountId)]);
        const authorization = await authorizeCollection(tx, input);
        if (!authorization.ok) return { ok: false, error: authorization.error };
        if (authorization.encryptionMode === "plain") {
            return { ok: false, error: "data_key_not_required" };
        }

        // Require a structurally supported caller envelope. Only the invoking
        // client can prove it opens to the Session's standalone key; an
        // Account-scoped fallback is never transferable Session key material.
        const callerEnvelope = await tx.sessionDataKeyEnvelope.findUnique({
            where: {
                sessionId_recipientAccountId: {
                    sessionId: input.sessionId,
                    recipientAccountId: input.actorAccountId,
                },
            },
            select: { encryptedDataKey: true },
        });
        if (
            !callerEnvelope
            || parseEncryptedDataKeyEnvelopeV1(toBytes(callerEnvelope.encryptedDataKey)) === null
        ) {
            return { ok: false, error: "session_data_key_unavailable" };
        }

        const recipientIds = validated.map(entry => entry.recipientAccountId);
        const access = await resolveStructuralSessionAccessForAccountsInTx(tx, {
            sessionId: input.sessionId, accountIds: recipientIds,
        });
        for (const recipientAccountId of recipientIds) {
            if (access.get(recipientAccountId)?.capabilities.readTranscript !== true) {
                return { ok: false, error: "recipient_changed" };
            }
        }

        const accounts = await tx.account.findMany({
            where: { id: { in: recipientIds } },
            select: RECIPIENT_READINESS_SELECT,
        });
        if (accounts.length !== recipientIds.length) return { ok: false, error: "recipient_changed" };
        for (const account of accounts) {
            if (deriveAccountRecipientEnvelopeReadinessFromRow(account).status !== "available") {
                return { ok: false, error: "recipient_key_unavailable" };
            }
        }

        for (const entry of validated) {
            // The tuple row and its recipient-private `session` invalidation have
            // one writer, shared with Session creation and direct grants, so this
            // resource cannot drift into a second persistence path.
            const written = await writeSessionDataKeyEnvelopeInTx(tx, {
                sessionId: input.sessionId,
                recipientAccountId: entry.recipientAccountId,
                encryptedDataKey: entry.envelope,
                markRecipientChanged: true,
            });
            if (!written.ok) return { ok: false, error: "invalid_request" };
        }

        return { ok: true, appliedCount: validated.length };
    }, { isolationLevel: "ReadCommitted" /* Account key/mode transitions and grant changes share the admitted Account/Session locks. */ });
}
