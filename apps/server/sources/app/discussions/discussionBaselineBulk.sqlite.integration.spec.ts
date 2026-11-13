import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/storage/db";
import { makeShareEligibleForTest } from '@/testkit/shareEligibility.testkit';
import { inTx, type Tx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createPresentUserSessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication.testkit";
import { initializeSessionOwnerReadStateInTx } from "@/app/session/personal/readState";
import { createDiscussion, postDiscussionMessage } from "./mutations";
import { inviteDiscussionParticipant } from "./accessService";
import { initializeDiscussionCursorsOnGrantEntryInTx } from "./trackingEntry";
import { ARTIFACT_PLAIN_DATA_KEY_MARKER } from "@happier-dev/protocol";
import { decodeBase64 } from "@happier-dev/protocol/crypto/base64";

const authentication = createPresentUserSessionAccessAuthentication();
const plainBody = (text: string) => ({ t: "plain" as const, v: { v: 1, parts: [{ t: "text", text }] } });

/** Instrument the real transaction's statement boundary without replacing its logic. */
function countStatements(tx: Tx, observed: { count: number }): Tx {
    return new Proxy(tx, {
        get(target, property, receiver) {
            const delegate: unknown = Reflect.get(target, property, receiver);
            if (typeof delegate === "function" && typeof property === "string" && property.startsWith("$")) {
                return (...args: readonly unknown[]) => {
                    observed.count += 1;
                    return Reflect.apply(delegate, target, args);
                };
            }
            if (typeof delegate !== "object" || delegate === null) return delegate;
            return new Proxy(delegate, {
                get(model, method, modelReceiver) {
                    const member: unknown = Reflect.get(model, method, modelReceiver);
                    if (typeof member !== "function") return member;
                    return (...args: readonly unknown[]) => {
                        observed.count += 1;
                        return Reflect.apply(member, model, args);
                    };
                },
            });
        },
    });
}

describe("Discussion grant-entry baseline (SQLite)", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-discussion-grant-baseline-", initAuth: false });
    }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it("seeds a recipient set without per-recipient statement growth", async () => {
        const seed = async (readerCount: number) => {
            const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
            const discussion = await db.discussion.create({ data: {
                ownerAccountId: owner.id, encryptionMode: "plain", createdByAccountId: owner.id,
                dataEncryptionKey: new Uint8Array(decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER)),
                creationLocalId: randomUUID(), creationEqualityEvidenceV1: { kind: "plainDigest", digest: "A".repeat(43) },
                titleContent: { t: "plain", v: { v: 1, title: "Bulk recipients" } }, messageSeq: 5, lastMessageAt: new Date(),
            } });
            const readers = await Promise.all(Array.from({ length: readerCount }, () => db.account.create({
                data: { publicKey: randomUUID(), encryptionMode: "plain" }, select: { id: true },
            })));
            await db.discussionGrant.createMany({ data: readers.map(reader => ({ principalKind: 'account',
                discussionId: discussion.id, accountId: reader.id, accessLevel: "view", createdByAccountId: owner.id,
            })) });
            const observed = { count: 0 };
            const inserted = await inTx(tx => initializeDiscussionCursorsOnGrantEntryInTx(countStatements(tx, observed), {
                discussionId: discussion.id, accountIds: readers.map(reader => reader.id),
            }));
            expect(inserted).toBe(readerCount);
            expect(await db.discussionReadState.count({ where: { discussionId: discussion.id, lastReadSeq: 5 } })).toBe(readerCount);
            return observed.count;
        };
        expect(await seed(31)).toBe(await seed(2));
    });

    it("baselines a new invitation at its own ceiling and preserves unread on retry", async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const reader = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        await makeShareEligibleForTest(owner.id, reader.id);
        const created = await createDiscussion({
            authentication, actorAccountId: owner.id,
            request: {
                creationLocalId: randomUUID(),
                titleContent: { t: "plain", v: { v: 1, title: "Baseline" } },
                firstMessage: { localId: randomUUID(), content: plainBody("Before invitation"), mentionedAccountIds: [] },
            },
        });
        expect(created.ok).toBe(true);
        if (!created.ok) throw new Error(created.error);
        const discussionId = created.value.discussion.id;
        expect((await inviteDiscussionParticipant({
            authentication, actorAccountId: owner.id, discussionId,
            request: { participant: { kind: "account", accountId: reader.id } },
        })).ok).toBe(true);
        expect(await db.discussionReadState.findUnique({
            where: { discussionId_accountId: { discussionId, accountId: reader.id } },
        })).toMatchObject({ lastReadSeq: 1 });
        expect((await postDiscussionMessage({
            authentication, actorAccountId: owner.id, discussionId,
            request: { localId: randomUUID(), content: plainBody("After invitation"), mentionedAccountIds: [] },
        })).ok).toBe(true);
        expect(await inTx(tx => initializeDiscussionCursorsOnGrantEntryInTx(tx, {
            discussionId, accountIds: [reader.id, reader.id],
        }))).toBe(0);
        expect(await db.discussionReadState.findUnique({
            where: { discussionId_accountId: { discussionId, accountId: reader.id } },
        })).toMatchObject({ lastReadSeq: 1 });
    });

    it("does not enroll a Session owner into an anchored Discussion owned by someone else", async () => {
        const sourceOwner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const discussionOwner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const session = await db.session.create({ data: {
            accountId: sourceOwner.id, tag: randomUUID(), encryptionMode: "plain", metadata: "{}",
        } });
        const discussion = await db.discussion.create({ data: {
            ownerAccountId: discussionOwner.id, encryptionMode: "plain", createdByAccountId: discussionOwner.id,
            dataEncryptionKey: new Uint8Array(decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER)),
            creationLocalId: randomUUID(), creationEqualityEvidenceV1: { kind: "plainDigest", digest: "A".repeat(43) },
            anchorV1: { kind: "session", sessionId: session.id }, anchorSessionId: session.id,
            titleContent: { t: "plain", v: { v: 1, title: "Private" } }, messageSeq: 1, lastMessageAt: new Date(),
        } });
        await inTx(tx => initializeSessionOwnerReadStateInTx(tx, { sessionId: session.id, accountId: sourceOwner.id }));
        expect(await db.discussionReadState.count({ where: { discussionId: discussion.id, accountId: sourceOwner.id } })).toBe(0);
        expect(await inTx(tx => initializeDiscussionCursorsOnGrantEntryInTx(tx, {
            discussionId: discussion.id, accountIds: [sourceOwner.id],
        }))).toBe(0);
    });
});
