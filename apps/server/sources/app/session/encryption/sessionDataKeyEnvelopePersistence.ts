import type { Prisma } from "@prisma/client";
import { parseEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { encodeBase64 } from "privacy-kit";

import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { deriveAccountRecipientEnvelopeReadinessFromRow, type AccountRecipientEnvelopeReadinessReadScope, type AccountRecipientEnvelopeReadinessRow } from "@/app/encryption/accountRecipientEnvelopeReadiness";
import type { Tx } from "@/storage/inTx";
import { RECIPIENT_READINESS_SELECT } from "./sessionDataKeyRecipientProjection";

/**
 * The only owner of `(Session, Account)` data-key envelope persistence.
 *
 * One tuple holds the Session owner's envelope and every other recipient's, so
 * no reader has to ask whether a viewer is the owner before it knows which
 * column to read. Access is decided elsewhere and always first: this module
 * stores and projects opaque bytes and never grants, opens, or synthesizes a
 * Session data key.
 *
 * It is deliberately separate from the collection resource in
 * `sessionDataKeyEnvelopeService.ts`. That module owns one HTTP surface's
 * authorization, readiness and paging; this one owns the row and is shared by
 * Session creation, direct grants and that resource alike.
 */

/**
 * Select the current viewer's envelope inside the caller's existing Session
 * query.
 *
 * The composite primary key makes this at most one row per Session, and the
 * recipient-first index serves the reverse lookup, so a list stays one query.
 * Resolving envelopes through a per-row service call instead would reintroduce
 * the N+1 the single projector exists to prevent.
 */
export function createSessionDataKeyEnvelopeViewerSelect(
    params: Readonly<{ viewerAccountId: string }>,
) {
    return {
        // Persisted Session mode is the authority for whether key material may
        // be projected. Keeping it in the shared select prevents one caller
        // from forgetting the Plain-mode fence.
        encryptionMode: true,
        dataKeyEnvelopes: {
            where: { recipientAccountId: params.viewerAccountId },
            select: {
                encryptedDataKey: true,
                recipientAccount: { select: RECIPIENT_READINESS_SELECT },
            },
        },
    } as const satisfies Prisma.SessionSelect;
}

export type SessionDataKeyEnvelopeViewerRow = Readonly<{
    encryptionMode: string | null;
    dataKeyEnvelopes: readonly Readonly<{
        encryptedDataKey: Uint8Array;
        recipientAccount: Readonly<{
            id: string;
            publicKey: string | null;
            encryptionMode: string | null;
            contentPublicKey: Uint8Array | null;
            contentPublicKeySig: Uint8Array | null;
        }>;
    }>[];
}>;

/**
 * Project the wire `dataEncryptionKey` for one already-authorized viewer.
 *
 * This must run only after the canonical access predicate has admitted the
 * viewer: it cannot tell an unauthorized reader from an authorized one, and a
 * tuple never authorizes. Plain or malformed Session mode always projects
 * `null`; for E2EE, `null` means this viewer currently has no envelope, which
 * the client resolves into pending, setup, or the historical owner-only
 * compatibility reader — the server does not decide that.
 */
export function projectViewerSessionDataKey(row: SessionDataKeyEnvelopeViewerRow): string | null {
    if (row.encryptionMode !== "e2ee") return null;
    const envelope = row.dataKeyEnvelopes[0];
    return envelope ? encodeBase64(new Uint8Array(envelope.encryptedDataKey)) : null;
}

/**
 * Server-side privacy ceiling for a current, already-authorized viewer.
 *
 * Plain content needs no recipient envelope. E2EE content may be described in
 * a rich notification only when Lane 06's Account readiness owner is current
 * and this viewer's canonical tuple is structurally valid. This deliberately
 * does not claim that a device opened the envelope; native/UI still performs
 * that proof and applies its local preview policy.
 */
export function resolveViewerSessionNotificationContentAvailability(
    row: SessionDataKeyEnvelopeViewerRow & Readonly<{ encryptionMode: string | null }>,
    recipientReadiness: AccountRecipientEnvelopeReadinessReadScope = deriveAccountRecipientEnvelopeReadinessFromRow,
): boolean {
    if (row.encryptionMode === "plain") return true;
    if (row.encryptionMode !== "e2ee") return false;
    const envelope = row.dataKeyEnvelopes[0];
    if (!envelope) return false;
    if (recipientReadiness(envelope.recipientAccount).status !== "available") {
        return false;
    }
    return isStructurallyValidSessionDataKeyEnvelope(envelope.encryptedDataKey);
}

/**
 * Whether an authorized viewer may attempt a client-side content read.
 * Unlike a rich notification, an explicit read can use the retained owner-only
 * Account reader when the Session envelope is genuinely absent. This is only
 * eligibility: the key-holding reader must still authenticate/open the content.
 * A present invalid envelope never falls back, and neither does a recipient.
 */
export function resolveViewerSessionContentReadAvailability(
    row: SessionDataKeyEnvelopeViewerRow & Readonly<{
        accountId: string;
        account: AccountRecipientEnvelopeReadinessRow & Readonly<{ id: string }>;
    }>,
    viewerAccountId: string,
): boolean {
    if (row.encryptionMode === "e2ee" && row.accountId === viewerAccountId && row.dataKeyEnvelopes.length === 0) {
        return deriveAccountRecipientEnvelopeReadinessFromRow(row.account).status === "available";
    }
    return resolveViewerSessionNotificationContentAvailability(row);
}

/**
 * Whether these bytes are a structurally valid data-key envelope.
 *
 * Callers that must reject before opening a write transaction use this so an
 * invalid envelope cannot leave a half-applied grant behind. It proves shape
 * only: the server cannot tell whether the recipient can actually open it.
 */
export function isStructurallyValidSessionDataKeyEnvelope(bytes: Uint8Array): boolean {
    return parseEncryptedDataKeyEnvelopeV1(new Uint8Array(bytes)) !== null;
}

export type SessionDataKeyEnvelopeWriteResult =
    | Readonly<{ ok: true }>
    | Readonly<{ ok: false; error: "invalid_envelope" }>;

/**
 * Write one recipient's envelope inside the caller's transaction.
 *
 * Structural admission applies to new writes only. Migrated legacy bytes are
 * preserved exactly, including malformed ones, so the recipient can reach a
 * truthful repair state; but nothing conforming producers could not have
 * emitted is newly stored.
 *
 * Repeating or replacing a structurally valid envelope is allowed: randomized
 * ciphertext for the same data key is semantically equivalent, and last write
 * wins is what makes repair work without a compare-and-set protocol.
 *
 * This is an internal primitive, not a public unchecked upsert. Callers
 * establish actor authority, recipient eligibility and Session mode in the same
 * transaction before calling it.
 */
export async function writeSessionDataKeyEnvelopeInTx(
    tx: Tx,
    params: Readonly<{
        sessionId: string;
        recipientAccountId: string;
        encryptedDataKey: Uint8Array;
        /**
         * Creation writes the owner's own envelope while materializing the
         * Session, which its caller already announces, and a grant transition
         * publishes its own coalesced change. Only a standalone write to an
         * existing Session needs to invalidate the recipient here.
         */
        markRecipientChanged: boolean;
    }>,
): Promise<SessionDataKeyEnvelopeWriteResult> {
    const encryptedDataKey = new Uint8Array(params.encryptedDataKey);
    if (parseEncryptedDataKeyEnvelopeV1(encryptedDataKey) === null) {
        return { ok: false, error: "invalid_envelope" };
    }

    await tx.sessionDataKeyEnvelope.upsert({
        where: {
            sessionId_recipientAccountId: {
                sessionId: params.sessionId,
                recipientAccountId: params.recipientAccountId,
            },
        },
        create: {
            sessionId: params.sessionId,
            recipientAccountId: params.recipientAccountId,
            encryptedDataKey: Buffer.from(encryptedDataKey),
        },
        update: { encryptedDataKey: Buffer.from(encryptedDataKey) },
    });

    if (params.markRecipientChanged) {
        // Recipient-private, and only `session`: the envelope belongs to this
        // Account alone and must never reach a shared Session room. The existing
        // changes planner maps this to exact-Session hydration.
        await markAccountChanged(tx, {
            accountId: params.recipientAccountId,
            kind: "session",
            entityId: params.sessionId,
        });
    }

    return { ok: true };
}

/**
 * Read one recipient's stored envelope bytes, or `null` when none exists.
 *
 * Absence and malformed presence stay distinguishable here so callers can keep
 * them distinct; collapsing them is what previously turned a repairable state
 * into a silent Account-key fallback.
 */
export async function readSessionDataKeyEnvelopeInTx(
    tx: Tx,
    params: Readonly<{ sessionId: string; recipientAccountId: string }>,
): Promise<Uint8Array | null> {
    const stored = await tx.sessionDataKeyEnvelope.findUnique({
        where: {
            sessionId_recipientAccountId: {
                sessionId: params.sessionId,
                recipientAccountId: params.recipientAccountId,
            },
        },
        select: { encryptedDataKey: true },
    });
    return stored ? new Uint8Array(stored.encryptedDataKey) : null;
}
