import {
    openEncryptedDataKeyEnvelopeV1,
    sealEncryptedDataKeyEnvelopeV1,
} from "@happier-dev/protocol";
import { encodeBase64 } from "privacy-kit";
import tweetnacl from "tweetnacl";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { deleteSessionAccessGrantInTx, putSessionAccessGrantInTx } from "@/app/session/access/sessionAccessGrantService";
import { resolveEffectiveSessionAccess } from "@/app/session/access/sessionAccess";
import { createPresentUserSessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication.testkit";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import {
    createSessionDataKeyEnvelopeViewerSelect,
    projectViewerSessionDataKey,
    resolveViewerSessionNotificationContentAvailability,
    writeSessionDataKeyEnvelopeInTx,
} from "./sessionDataKeyEnvelopePersistence";

const authentication = createPresentUserSessionAccessAuthentication();

/**
 * The canonical tuple is the only place a Session data key is stored, so these
 * cases exercise the real row, the real projector and the real grant service
 * rather than a mocked persistence seam.
 */

function sealFor(recipientPublicKey: Uint8Array, dataKey: Uint8Array): Uint8Array<ArrayBuffer> {
    const sealed = sealEncryptedDataKeyEnvelopeV1({
        dataKey,
        recipientPublicKey,
        randomBytes: (length) => tweetnacl.randomBytes(length),
    });
    const copy = new Uint8Array(sealed.length);
    copy.set(sealed);
    return copy;
}

async function createAccount(_prefix: string) {
    const keyPair = tweetnacl.box.keyPair();
    const binding = createSignedAccountContentBinding(keyPair.publicKey);
    const account = await db.account.create({
        data: {
            publicKey: binding.publicKey,
            encryptionMode: "e2ee",
            contentPublicKey: Buffer.from(binding.contentPublicKey),
            contentPublicKeySig: Buffer.from(binding.contentPublicKeySig),
        },
        select: { id: true },
    });
    return { id: account.id, contentPublicKey: binding.contentPublicKey, contentSecretKey: keyPair.secretKey };
}

describe("Session data-key envelope persistence (SQLite integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-session-data-key-envelope-",
            initAuth: false,
        });
    }, 180_000);

    afterAll(async () => {
        if (harness) await harness.close();
    });

    afterEach(async () => {
        await harness.resetDbTables([
            () => db.accountChange.deleteMany(),
            () => db.sessionDataKeyEnvelope.deleteMany(),
            () => db.sessionGrant.deleteMany({ where: { principalKind: 'account' } }),
            () => db.session.deleteMany(),
            () => db.userRelationship.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    async function createSession(ownerId: string, encryptionMode: "e2ee" | "plain") {
        return await db.session.create({
            data: {
                accountId: ownerId,
                tag: `envelope-${crypto.randomUUID()}`,
                encryptionMode,
                metadata: JSON.stringify({}),
                currentStorageState: "hosted",
            },
            select: { id: true },
        });
    }

    async function makeFriends(ownerId: string, recipientId: string) {
        await db.userRelationship.create({ data: {
            fromUserId: ownerId, toUserId: recipientId, status: "friend",
        } });
    }

    async function publishOwnerEnvelope(sessionId: string, owner: Awaited<ReturnType<typeof createAccount>>, dataKey: Uint8Array) {
        await db.sessionDataKeyEnvelope.create({ data: {
            sessionId, recipientAccountId: owner.id,
            encryptedDataKey: Buffer.from(sealFor(owner.contentPublicKey, dataKey)),
        } });
    }

    it("round-trips the exact sealed data key to the recipient through one projector", async () => {
        const owner = await createAccount("envelope-owner");
        const recipient = await createAccount("envelope-recipient");
        const session = await createSession(owner.id, "e2ee");
        const dataKey = tweetnacl.randomBytes(32);

        const written = await inTx(async (tx) => await writeSessionDataKeyEnvelopeInTx(tx, {
            sessionId: session.id,
            recipientAccountId: recipient.id,
            encryptedDataKey: sealFor(recipient.contentPublicKey, dataKey),
            markRecipientChanged: true,
        }));
        expect(written).toEqual({ ok: true });

        const row = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: createSessionDataKeyEnvelopeViewerSelect({ viewerAccountId: recipient.id }),
        });
        const projected = projectViewerSessionDataKey(row);
        expect(projected).not.toBeNull();

        // The recipient opens the exact original Session data key, which is the
        // only proof that the stored bytes are usable rather than merely present.
        const opened = openEncryptedDataKeyEnvelopeV1({
            envelope: new Uint8Array(Buffer.from(projected!, "base64")),
            recipientSecretKeyOrSeed: recipient.contentSecretKey,
        });
        expect(opened).toEqual(dataKey);

        // Recipient-private invalidation: exactly one `session` change, and no
        // `share` change, so no shared Session room learns about the key.
        const changes = await db.accountChange.findMany({
            where: { accountId: recipient.id },
            select: { kind: true, entityId: true },
        });
        expect(changes).toEqual([{ kind: "session", entityId: session.id }]);
    });

    it("raises the notification content ceiling only from the canonical recipient readiness result", async () => {
        const owner = await createAccount("notification-owner");
        const recipient = await createAccount("notification-recipient");
        const plain = await createSession(owner.id, "plain");
        const encrypted = await createSession(owner.id, "e2ee");
        const dataKey = tweetnacl.randomBytes(32);
        await publishOwnerEnvelope(encrypted.id, owner, dataKey);
        await inTx(async (tx) => await writeSessionDataKeyEnvelopeInTx(tx, {
            sessionId: encrypted.id,
            recipientAccountId: recipient.id,
            encryptedDataKey: sealFor(recipient.contentPublicKey, dataKey),
            markRecipientChanged: false,
        }));

        const select = createSessionDataKeyEnvelopeViewerSelect({ viewerAccountId: recipient.id });
        const [plainRow, encryptedRow] = await Promise.all([
            db.session.findUniqueOrThrow({ where: { id: plain.id }, select }),
            db.session.findUniqueOrThrow({ where: { id: encrypted.id }, select }),
        ]);
        expect(resolveViewerSessionNotificationContentAvailability(plainRow)).toBe(true);
        expect(resolveViewerSessionNotificationContentAvailability(encryptedRow)).toBe(true);
        expect(resolveViewerSessionNotificationContentAvailability({
            ...encryptedRow,
            encryptionMode: null,
        })).toBe(false);

        await db.account.update({ where: { id: recipient.id }, data: { encryptionMode: "plain" } });
        const noLongerReady = await db.session.findUniqueOrThrow({
            where: { id: encrypted.id },
            select,
        });
        expect(resolveViewerSessionNotificationContentAvailability(noLongerReady)).toBe(false);

        await db.account.update({ where: { id: recipient.id }, data: { encryptionMode: "e2ee" } });
        await db.session.update({ where: { id: encrypted.id }, data: { encryptionMode: "unsupported" } });
        const invalidSessionMode = await db.session.findUniqueOrThrow({
            where: { id: encrypted.id },
            select,
        });
        expect(resolveViewerSessionNotificationContentAvailability(invalidSessionMode)).toBe(false);
    });

    it("projects null for an Account with no tuple and never leaks another recipient's envelope", async () => {
        const owner = await createAccount("envelope-owner");
        const recipient = await createAccount("envelope-recipient");
        const stranger = await createAccount("envelope-stranger");
        const session = await createSession(owner.id, "e2ee");

        await inTx(async (tx) => await writeSessionDataKeyEnvelopeInTx(tx, {
            sessionId: session.id,
            recipientAccountId: recipient.id,
            encryptedDataKey: sealFor(recipient.contentPublicKey, tweetnacl.randomBytes(32)),
            markRecipientChanged: false,
        }));

        const strangerRow = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: createSessionDataKeyEnvelopeViewerSelect({ viewerAccountId: stranger.id }),
        });
        expect(projectViewerSessionDataKey(strangerRow)).toBeNull();
    });

    it("never projects a retained envelope from a plain Session", async () => {
        const owner = await createAccount("plain-envelope-owner");
        const session = await createSession(owner.id, "plain");
        await db.sessionDataKeyEnvelope.create({ data: {
            sessionId: session.id,
            recipientAccountId: owner.id,
            encryptedDataKey: Buffer.from(sealFor(owner.contentPublicKey, tweetnacl.randomBytes(32))),
        } });

        const row = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: createSessionDataKeyEnvelopeViewerSelect({ viewerAccountId: owner.id }),
        });

        expect(projectViewerSessionDataKey(row)).toBeNull();
    });

    it("refuses to newly store bytes no conforming producer could have emitted", async () => {
        const owner = await createAccount("envelope-owner");
        const recipient = await createAccount("envelope-recipient");
        const session = await createSession(owner.id, "e2ee");

        const written = await inTx(async (tx) => await writeSessionDataKeyEnvelopeInTx(tx, {
            sessionId: session.id,
            recipientAccountId: recipient.id,
            encryptedDataKey: new Uint8Array([1, 2, 3]),
            markRecipientChanged: true,
        }));
        expect(written).toEqual({ ok: false, error: "invalid_envelope" });
        expect(await db.sessionDataKeyEnvelope.count()).toBe(0);
        expect(await db.accountChange.count()).toBe(0);
    });

    it("commits a direct grant and its recipient envelope in one transaction", async () => {
        const owner = await createAccount("grant-owner");
        const recipient = await createAccount("grant-recipient");
        await makeFriends(owner.id, recipient.id);
        const session = await createSession(owner.id, "e2ee");
        const dataKey = tweetnacl.randomBytes(32);
        await publishOwnerEnvelope(session.id, owner, dataKey);

        const result = await inTx(async (tx) => await putSessionAccessGrantInTx(tx, { authentication, 
            actorAccountId: owner.id,
            sessionId: session.id,
            subject: { kind: "account", accountId: recipient.id },
            grant: { accessLevel: "view", canApprovePermissions: false },
            accountEnvelopeInput: { v: 1, encryptedDataKey: encodeBase64(sealFor(recipient.contentPublicKey, dataKey)) },
        }));
        expect(result).toMatchObject({ ok: true });

        const stored = await db.sessionDataKeyEnvelope.findMany({
            where: { recipientAccountId: recipient.id },
            select: { sessionId: true, recipientAccountId: true },
        });
        expect(stored).toEqual([{ sessionId: session.id, recipientAccountId: recipient.id }]);
    });

    it("rejects a structurally invalid grant envelope without committing the grant", async () => {
        const owner = await createAccount("grant-owner");
        const recipient = await createAccount("grant-recipient");
        await makeFriends(owner.id, recipient.id);
        const session = await createSession(owner.id, "e2ee");
        await publishOwnerEnvelope(session.id, owner, tweetnacl.randomBytes(32));

        const result = await inTx(async (tx) => await putSessionAccessGrantInTx(tx, { authentication, 
            actorAccountId: owner.id,
            sessionId: session.id,
            subject: { kind: "account", accountId: recipient.id },
            grant: { accessLevel: "view", canApprovePermissions: false },
            accountEnvelopeInput: { v: 1, encryptedDataKey: encodeBase64(new Uint8Array([7, 7])) },
        }));
        expect(result).toEqual({ ok: false, error: "invalid_request" });

        // No half-applied state: the recipient must not end up authorized with a
        // key they can never open.
        expect(await db.sessionGrant.count({ where: { principalKind: 'account' } })).toBe(0);
        expect(await db.sessionDataKeyEnvelope.count({ where: { recipientAccountId: recipient.id } })).toBe(0);
    });

    it("keeps a retained tuple inert when the grant is removed", async () => {
        const owner = await createAccount("grant-owner");
        const recipient = await createAccount("grant-recipient");
        await makeFriends(owner.id, recipient.id);
        const session = await createSession(owner.id, "e2ee");
        const dataKey = tweetnacl.randomBytes(32);
        await publishOwnerEnvelope(session.id, owner, dataKey);

        await inTx(async (tx) => await putSessionAccessGrantInTx(tx, { authentication, 
            actorAccountId: owner.id,
            sessionId: session.id,
            subject: { kind: "account", accountId: recipient.id },
            grant: { accessLevel: "view", canApprovePermissions: false },
            accountEnvelopeInput: { v: 1, encryptedDataKey: encodeBase64(sealFor(recipient.contentPublicKey, dataKey)) },
        }));
        expect(await inTx(async (tx) => await deleteSessionAccessGrantInTx(tx, { authentication,
            actorAccountId: owner.id,
            sessionId: session.id,
            subject: { kind: "account", accountId: recipient.id },
        }))).toMatchObject({ ok: true, changed: true });

        // Revocation is an access decision, not a delete: the row survives and is
        // simply never projected again, which is what makes re-granting cheap.
        expect(await db.sessionDataKeyEnvelope.count({ where: { recipientAccountId: recipient.id } })).toBe(1);
        expect(await inTx(tx => resolveEffectiveSessionAccess(tx, { authentication, 
            accountId: recipient.id, sessionId: session.id,
        }))).toBeNull();
    });

    it("cascades tuples with the Session and with the recipient Account", async () => {
        const owner = await createAccount("cascade-owner");
        const recipient = await createAccount("cascade-recipient");
        const session = await createSession(owner.id, "e2ee");
        for (const account of [owner, recipient]) {
            await inTx(async (tx) => await writeSessionDataKeyEnvelopeInTx(tx, {
                sessionId: session.id,
                recipientAccountId: account.id,
                encryptedDataKey: sealFor(account.contentPublicKey, tweetnacl.randomBytes(32)),
                markRecipientChanged: false,
            }));
        }
        expect(await db.sessionDataKeyEnvelope.count()).toBe(2);

        await db.account.delete({ where: { id: recipient.id } });
        expect(await db.sessionDataKeyEnvelope.count()).toBe(1);

        await db.session.delete({ where: { id: session.id } });
        expect(await db.sessionDataKeyEnvelope.count()).toBe(0);
    });
});
