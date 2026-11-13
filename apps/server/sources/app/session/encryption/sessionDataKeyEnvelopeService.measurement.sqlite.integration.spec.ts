import { afterAll, beforeAll, describe, expect, it } from "vitest";
import tweetnacl from "tweetnacl";
import { encodeBase64 } from "privacy-kit";
import {
    SESSION_DATA_KEY_ENVELOPE_PAGE_MAX_ENTRIES_V1,
    encodeSessionDataKeyEnvelopeCursorV1,
    sealEncryptedDataKeyEnvelopeV1,
    signAccountContentKeyBindingV1,
} from "@happier-dev/protocol";

import { createPresentUserSessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication.testkit";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import {
    applySessionDataKeyEnvelopes,
    readSessionDataKeyEnvelopePage,
} from "./sessionDataKeyEnvelopeService";

/**
 * Evidence-only measurement for the incumbent full-page PATCH transaction.
 *
 * This is not a timeout or a product-limit gate. It runs the canonical SQLite
 * owner at the approved 24/100/500-recipient fanout points, verifies every tuple and private
 * AccountChange, and prints the observed service time so the page bound is
 * based on an implemented persistence path rather than a pre-table estimate.
 */
describe("Session data-key envelope full-page PATCH measurement (SQLite)", () => {
    let harness: LightSqliteHarness;
    const authentication = createPresentUserSessionAccessAuthentication();

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-session-envelope-patch-measurement-",
            initAuth: false,
            env: {
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            },
        });
    }, 120_000);

    afterAll(async () => { await harness?.close(); });

    it.each([24, 100, 500])(
    "measures %i recipients in bounded atomic pages with one private invalidation per recipient",
    async (recipientCount) => {
        const ownerSigning = tweetnacl.sign.keyPair();
        const ownerContent = tweetnacl.box.keyPair();
        const owner = await db.account.create({
            data: {
                id: `session-envelope-patch-measurement-owner-${recipientCount}`,
                publicKey: Buffer.from(ownerSigning.publicKey).toString("hex"),
                encryptionMode: "e2ee",
                contentPublicKey: Buffer.from(ownerContent.publicKey),
                contentPublicKeySig: Buffer.from(signAccountContentKeyBindingV1({
                    accountSigningSecretKey: ownerSigning.secretKey,
                    contentPublicKey: ownerContent.publicKey,
                })),
            },
        });
        const session = await db.session.create({
            data: {
                id: `session-envelope-patch-measurement-session-${recipientCount}`,
                accountId: owner.id,
                tag: `session-envelope-patch-measurement-tag-${recipientCount}`,
                encryptionMode: "e2ee",
                metadata: JSON.stringify({ t: "encrypted", c: "" }),
                seq: 1,
            },
        });
        const dataKey = new Uint8Array(32).fill(73);
        await db.sessionDataKeyEnvelope.create({
            data: {
                sessionId: session.id,
                recipientAccountId: owner.id,
                encryptedDataKey: Buffer.from(sealEncryptedDataKeyEnvelopeV1({
                    dataKey,
                    recipientPublicKey: ownerContent.publicKey,
                    randomBytes: length => new Uint8Array(length).fill(17),
                })),
            },
        });

        const recipients = Array.from(
            { length: recipientCount },
            (_, index) => {
                const signing = tweetnacl.sign.keyPair();
                const content = tweetnacl.box.keyPair();
                return {
                    id: `session-envelope-patch-measurement-recipient-${recipientCount}-${String(index).padStart(3, "0")}`,
                    signing,
                    content,
                };
            },
        );
        await db.account.createMany({
            data: recipients.map(recipient => ({
                id: recipient.id,
                publicKey: Buffer.from(recipient.signing.publicKey).toString("hex"),
                encryptionMode: "e2ee",
                contentPublicKey: Buffer.from(recipient.content.publicKey),
                contentPublicKeySig: Buffer.from(signAccountContentKeyBindingV1({
                    accountSigningSecretKey: recipient.signing.secretKey,
                    contentPublicKey: recipient.content.publicKey,
                })),
            })),
        });
        await db.sessionGrant.createMany({
            data: (recipients.map(recipient => ({
                sessionId: session.id,
                createdByAccountId: owner.id,
                accountId: recipient.id,
                accessLevel: "view",
            }))).map(data => ({ ...data, principalKind: 'account' })),
        });

        const entries = recipients.map(recipient => ({
            recipientAccountId: recipient.id,
            encryptedDataKey: encodeBase64(new Uint8Array(sealEncryptedDataKeyEnvelopeV1({
                dataKey,
                recipientPublicKey: recipient.content.publicKey,
                randomBytes: length => tweetnacl.randomBytes(length),
            }))),
        }));
        const pageTimingsMs: number[] = [];
        for (let offset = 0; offset < entries.length; offset += SESSION_DATA_KEY_ENVELOPE_PAGE_MAX_ENTRIES_V1) {
            const page = entries.slice(offset, offset + SESSION_DATA_KEY_ENVELOPE_PAGE_MAX_ENTRIES_V1);
            const startedAt = performance.now();
            const result = await applySessionDataKeyEnvelopes({
                actorAccountId: owner.id,
                sessionId: session.id,
                authentication,
                entries: page,
            });
            pageTimingsMs.push(performance.now() - startedAt);
            expect(result).toEqual({ ok: true, appliedCount: page.length });
        }
        expect(await db.sessionDataKeyEnvelope.count({
            where: {
                sessionId: session.id,
                recipientAccountId: { in: recipients.map(recipient => recipient.id) },
            },
        })).toBe(recipientCount);
        expect(pageTimingsMs).toHaveLength(1);
        expect(await db.accountChange.count({
            where: {
                accountId: { in: recipients.map(recipient => recipient.id) },
                kind: "session",
                entityId: session.id,
            },
        })).toBe(recipientCount);
        const changedRecipients = await db.accountChange.findMany({
            where: {
                accountId: { in: recipients.map(recipient => recipient.id) },
                kind: "session",
                entityId: session.id,
            },
            orderBy: { accountId: "asc" },
            select: { accountId: true },
        });
        expect(changedRecipients.map(change => change.accountId)).toEqual(
            recipients.map(recipient => recipient.id),
        );
        // Read side of the same fanout point. The cursorless page owns the one
        // Session-scoped aggregate over the whole current audience (the owner's
        // own tuple included); a keyset continuation starts after the decoded
        // Account and deliberately carries no aggregate, so paging a large
        // audience never re-walks the delivered prefix.
        const summaryStartedAt = performance.now();
        const settled = await readSessionDataKeyEnvelopePage({
            actorAccountId: owner.id,
            sessionId: session.id,
            authentication,
            query: { state: "action_required", limit: SESSION_DATA_KEY_ENVELOPE_PAGE_MAX_ENTRIES_V1 },
        });
        const audienceAggregateMs = performance.now() - summaryStartedAt;
        if (!settled.ok || settled.page.status !== "required") throw new Error("audience aggregate unavailable");
        expect(settled.page.items).toHaveLength(0);
        expect(settled.page.nextCursor).toBeNull();
        expect(settled.page.summary).toEqual({
            // Every audience Account now holds a structurally valid envelope,
            // including the Session's storage owner, whose envelope lives in the
            // same canonical tuple.
            prepared: recipientCount + 1,
            pending: 0,
            invalid: 0,
            recipientKeyUnavailable: 0,
        });

        const midIndex = Math.floor(recipients.length / 2);
        const continuationStartedAt = performance.now();
        const continuation = await readSessionDataKeyEnvelopePage({
            actorAccountId: owner.id,
            sessionId: session.id,
            authentication,
            query: {
                state: "all",
                limit: 100,
                cursor: encodeSessionDataKeyEnvelopeCursorV1(recipients[midIndex - 1]!.id),
            },
        });
        const continuationMs = performance.now() - continuationStartedAt;
        if (!continuation.ok || continuation.page.status !== "required") throw new Error("continuation unavailable");
        expect(continuation.page.summary).toBeNull();
        expect(continuation.page.items[0]?.recipientAccountId).toBe(recipients[midIndex]!.id);
        expect(continuation.page.items).toHaveLength(Math.min(100, recipients.length - midIndex));

        console.info(JSON.stringify({
            measurement: "session-envelope-audience-page-sqlite",
            audienceAccounts: recipientCount + 1,
            audienceAggregateMs: Math.round(audienceAggregateMs * 100) / 100,
            keysetContinuationMs: Math.round(continuationMs * 100) / 100,
            keysetContinuationItems: continuation.page.items.length,
        }));
        console.info(JSON.stringify({
            measurement: "session-envelope-paged-patch-sqlite",
            entries: entries.length,
            pages: pageTimingsMs.length,
            pageEntryLimit: SESSION_DATA_KEY_ENVELOPE_PAGE_MAX_ENTRIES_V1,
            tupleWrites: entries.length,
            recipientAccountChanges: changedRecipients.length,
            totalPatchMs: Math.round(pageTimingsMs.reduce((total, value) => total + value, 0) * 100) / 100,
            pageTimingsMs: pageTimingsMs.map(value => Math.round(value * 100) / 100),
        }));
    }, 120_000);
});
