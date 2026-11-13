import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { sealEncryptedDataKeyEnvelopeV1, ARTIFACT_PLAIN_DATA_KEY_MARKER } from "@happier-dev/protocol";
import { decodeBase64 } from "privacy-kit";
import tweetnacl from "tweetnacl";

import { startSocket } from "@/app/api/socket";
import type { Fastify as AppFastify } from "@/app/api/types";
import { enableAuthentication } from "@/app/api/utils/enableAuthentication";
import { auth } from "@/app/auth/auth";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";

import { authRoutes } from "./authRoutes";

/**
 * Erasure cases that involve encrypted access seal real envelopes to a real
 * content binding, because the canonical `(Session, Account)` tuple is the only
 * place a Session data key lives and the erasure contract is about those exact
 * bytes surviving or cascading away.
 */
async function createE2eeAccount() {
    const binding = createSignedAccountContentBinding();
    const account = await db.account.create({
        data: {
            publicKey: binding.publicKey,
            encryptionMode: "e2ee",
            contentPublicKey: Buffer.from(binding.contentPublicKey),
            contentPublicKeySig: Buffer.from(binding.contentPublicKeySig),
        },
        select: { id: true },
    });
    return { id: account.id, contentPublicKey: binding.contentPublicKey };
}

function sealFor(recipientPublicKey: Uint8Array, dataKey: Uint8Array): Uint8Array {
    return sealEncryptedDataKeyEnvelopeV1({
        dataKey,
        recipientPublicKey,
        randomBytes: (length) => tweetnacl.randomBytes(length),
    });
}

function createTestApp(): AppFastify {
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as AppFastify;
    enableAuthentication(typed);
    startSocket(typed);
    authRoutes(typed);
    return typed;
}

describe("authRoutes (Account erasure) (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-auth-account-erasure-",
            initAuth: true,
            env: { AUTH_REQUIRED_LOGIN_PROVIDERS: "" },
        });
    }, 120_000);

    afterEach(async () => {
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.sessionShareAccessLog.deleteMany(),
            () => db.publicShareAccessLog.deleteMany(),
            () => db.sessionDataKeyEnvelope.deleteMany(),
            () => db.sessionGrant.deleteMany({ where: { principalKind: 'account' } }),
            () => db.publicSessionShare.deleteMany(),
            () => db.session.deleteMany(),
            () => db.teamMembership.deleteMany(),
            () => db.team.deleteMany(),
            () => db.machine.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    afterAll(async () => await harness.close());

    it("confirms erasure of a fresh Account with no Teams or Machines", async () => {
        const account = await createE2eeAccount();
        const token = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" });
        const app = createTestApp();
        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/auth/account/delete",
                headers: { authorization: `Bearer ${token}` },
                payload: { confirmation: "DELETE" },
            });
            expect({ status: response.statusCode, body: response.json() }).toEqual({
                status: 200, body: { status: "deleted" },
            });
            expect(await db.account.findUnique({ where: { id: account.id } })).toBeNull();
        } finally {
            await app.close();
        }
    });

    it("preserves grants authored on surviving Sessions while erasing recipient grants and owned Sessions", async () => {
        const { deleteAccountForErasure } = await import("@/app/plugins/data/accountDataErase");
        const owner = await createE2eeAccount();
        const author = await createE2eeAccount();
        const recipient = await createE2eeAccount();
        const surviving = await db.session.create({ data: { accountId: owner.id, tag: "surviving", metadata: "{}", encryptionMode: "e2ee", currentStorageState: "hosted" } });
        const owned = await db.session.create({ data: { accountId: author.id, tag: "erased", metadata: "{}", encryptionMode: "e2ee", currentStorageState: "hosted" } });
        // Encrypted access lives in the canonical tuple, never on the grant row.
        // The recipient's envelope must outlive the Account that authored their
        // grant, while the erased Account's own envelope and every envelope on
        // its deleted Session must cascade away with it.
        const survivingDataKey = tweetnacl.randomBytes(32);
        const recipientEnvelope = sealFor(recipient.contentPublicKey, survivingDataKey);
        await db.sessionDataKeyEnvelope.createMany({ data: [
            { sessionId: surviving.id, recipientAccountId: recipient.id, encryptedDataKey: Buffer.from(recipientEnvelope) },
            { sessionId: surviving.id, recipientAccountId: author.id, encryptedDataKey: Buffer.from(sealFor(author.contentPublicKey, survivingDataKey)) },
            { sessionId: owned.id, recipientAccountId: recipient.id, encryptedDataKey: Buffer.from(sealFor(recipient.contentPublicKey, tweetnacl.randomBytes(32))) },
        ] });
        const authored = await db.sessionGrant.create({ data: { principalKind: 'account',
            sessionId: surviving.id, createdByAccountId: author.id, accountId: recipient.id,
            accessLevel: "edit", canApprovePermissions: true,
        } });
        await db.sessionGrant.create({ data: { principalKind: 'account',
            sessionId: surviving.id, createdByAccountId: owner.id, accountId: author.id, accessLevel: "admin",
        } });
        const team = await db.team.create({ data: { name: "Erased Session recipients" } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId: recipient.id, role: "owner" },
            { teamId: team.id, accountId: author.id, role: "member" },
        ] });
        await db.sessionGrant.create({ data: { principalKind: 'team', sessionId: owned.id, teamId: team.id, accessLevel: "view", effectiveAt: new Date() } });
        const retainedLog = await db.sessionShareAccessLog.create({ data: { sessionShareId: authored.id, userId: recipient.id } });
        await db.sessionShareAccessLog.create({ data: { sessionShareId: authored.id, userId: author.id } });
        const publicShare = await db.publicSessionShare.create({ data: {
            sessionId: surviving.id, createdByUserId: owner.id, tokenHash: new Uint8Array(32),
        } });
        const retainedPublicLog = await db.publicShareAccessLog.create({ data: { publicShareId: publicShare.id, userId: recipient.id } });
        await db.publicShareAccessLog.create({ data: { publicShareId: publicShare.id, userId: author.id } });

        const retainedDiscussion = await db.discussion.create({ data: {
            ownerAccountId: owner.id,
            encryptionMode: "plain",
            anchorSessionId: surviving.id,
            dataEncryptionKey: decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER),
            anchorV1: { kind: "session", sessionId: surviving.id },
            creationLocalId: "erased-author-discussion",
            creationEqualityEvidenceV1: { kind: "plainDigest", digest: "A".repeat(43) },
            createdByAccountId: author.id,
            titleContent: { t: "plain", v: { v: 1, title: "Retained discussion" } },
            messageSeq: 1,
            lastMessageAt: new Date(),
        } });
        const retainedDiscussionMessage = await db.discussionMessage.create({ data: {
            discussionId: retainedDiscussion.id,
            localId: "erased-author-message",
            requestEqualityEvidenceV1: { kind: "plainDigest", digest: "B".repeat(43) },
            seq: 1,
            authorAccountId: author.id,
            content: { t: "plain", v: { v: 1, parts: [{ t: "text", text: "Retained body" }] } },
        } });
        await db.discussionMessageMention.create({ data: {
            messageId: retainedDiscussionMessage.id,
            accountId: author.id,
        } });
        await db.discussionReadState.create({ data: {
            discussionId: retainedDiscussion.id,
            accountId: author.id,
            lastReadSeq: 1,
        } });

        await expect(deleteAccountForErasure({ accountId: author.id })).resolves.toEqual({ status: "deleted" });
        await expect.soft(db.sessionGrant.findUnique({ where: { principalKind: 'account', id: authored.id } })).resolves.toMatchObject({
            createdByAccountId: owner.id, accountId: recipient.id, accessLevel: "edit",
            canApprovePermissions: true, createdAt: authored.createdAt,
        });
        const preservedEnvelope = await db.sessionDataKeyEnvelope.findUnique({
            where: { sessionId_recipientAccountId: { sessionId: surviving.id, recipientAccountId: recipient.id } },
            select: { encryptedDataKey: true },
        });
        expect.soft(preservedEnvelope && Uint8Array.from(preservedEnvelope.encryptedDataKey)).toEqual(Uint8Array.from(recipientEnvelope));
        await expect.soft(db.sessionDataKeyEnvelope.count({ where: { recipientAccountId: author.id } })).resolves.toBe(0);
        await expect.soft(db.sessionDataKeyEnvelope.count({ where: { sessionId: owned.id } })).resolves.toBe(0);
        await expect(db.sessionGrant.count({ where: { principalKind: 'account', accountId: author.id } })).resolves.toBe(0);
        await expect(db.session.findUnique({ where: { id: owned.id } })).resolves.toBeNull();
        await expect(db.account.findUnique({ where: { id: author.id } })).resolves.toBeNull();
        await expect(db.discussion.findUnique({ where: { id: retainedDiscussion.id } })).resolves.toMatchObject({
            createdByAccountId: null,
        });
        await expect(db.discussionMessage.findUnique({
            where: { id: retainedDiscussionMessage.id },
        })).resolves.toMatchObject({ authorAccountId: null });
        await expect(db.discussionMessageMention.count({
            where: { messageId: retainedDiscussionMessage.id },
        })).resolves.toBe(0);
        await expect(db.discussionReadState.count({
            where: { discussionId: retainedDiscussion.id, accountId: author.id },
        })).resolves.toBe(0);
        await expect.soft(db.sessionShareAccessLog.findMany({ select: { id: true } })).resolves.toEqual([{ id: retainedLog.id }]);
        await expect(db.publicShareAccessLog.findMany({ select: { id: true } })).resolves.toEqual([{ id: retainedPublicLog.id }]);
        await expect(db.accountChange.findFirst({ where: { accountId: recipient.id, kind: "session", entityId: owned.id } })).resolves.toMatchObject({
            hint: { v: 1, lifecycle: "deleted" },
        });
        await expect(deleteAccountForErasure({ accountId: author.id })).resolves.toEqual({ status: "already-deleted" });
    });

    it("wakes surviving readers when erasure clears a Team-only assignee", async () => {
        const { deleteAccountForErasure } = await import("@/app/plugins/data/accountDataErase");
        const owner = await db.account.create({ data: { encryptionMode: "plain" } });
        const assignee = await db.account.create({ data: { encryptionMode: "plain" } });
        const team = await db.team.create({ data: { name: "Erasure responsibility" } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId: owner.id, role: "owner" },
            { teamId: team.id, accountId: assignee.id, role: "member" },
        ] });
        const session = await db.session.create({ data: {
            accountId: owner.id, responsibleAccountId: assignee.id, tag: "assigned", metadata: "{}",
            encryptionMode: "plain", currentStorageState: "hosted",
        } });
        await db.sessionGrant.create({ data: { principalKind: 'team', sessionId: session.id, teamId: team.id, accessLevel: "view", effectiveAt: new Date() } });

        await expect(deleteAccountForErasure({ accountId: assignee.id })).resolves.toEqual({ status: "deleted" });
        await expect(db.session.findUnique({ where: { id: session.id } })).resolves.toMatchObject({ responsibleAccountId: null });
        await expect(db.accountChange.findFirst({ where: { accountId: owner.id, kind: "session", entityId: session.id } })).resolves.toMatchObject({
            hint: { responsibleAccountId: null },
        });
        await expect(db.sessionGrant.count({ where: { principalKind: 'team', sessionId: session.id } })).resolves.toBe(1);
    });

    it("requires present-user authority and exact confirmation, then deletes only that Account", async () => {
        const account = await db.account.create({
            data: { publicKey: "account-erasure-admission", encryptionMode: "plain" },
        });
        await db.machine.create({
            data: { id: "account-erasure-machine", accountId: account.id, metadata: "fixture" },
        });
        const [signedToken, pat] = await Promise.all([
            auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" }),
            auth.createApiToken({ accountId: account.id, tokenId: crypto.randomUUID(), label: "Automation cannot erase Accounts" }),
        ]);
        const app = createTestApp();
        await app.ready();

        try {
            const patResponse = await app.inject({
                method: "POST",
                url: "/v1/auth/account/delete",
                headers: { authorization: `Bearer ${pat.token}` },
                payload: { confirmation: "DELETE" },
            });
            expect(patResponse.statusCode).toBe(403);
            expect(patResponse.json()).toEqual({ error: "present_user_required" });

            const malformedResponse = await app.inject({
                method: "POST",
                url: "/v1/auth/account/delete",
                headers: { authorization: `Bearer ${signedToken}` },
                payload: { confirmation: "delete", accountId: "another-account" },
            });
            expect(malformedResponse.statusCode).toBe(400);
            expect(malformedResponse.json()).toEqual({ error: "invalid_request" });
            await expect(db.account.findUnique({ where: { id: account.id } })).resolves.not.toBeNull();

            const deletedResponse = await app.inject({
                method: "POST",
                url: "/v1/auth/account/delete",
                headers: { authorization: `Bearer ${signedToken}` },
                payload: { confirmation: "DELETE" },
            });
            expect(deletedResponse.statusCode).toBe(200);
            expect(deletedResponse.json()).toEqual({ status: "deleted" });
            await expect(db.account.findUnique({ where: { id: account.id } })).resolves.toBeNull();
            await expect(db.machine.findUnique({ where: { id: "account-erasure-machine" } })).resolves.toBeNull();
        } finally {
            await app.close();
        }
    });
});
