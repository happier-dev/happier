import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "crypto";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { publicShareRoutes } from "./publicShareRoutes";

function currentPublicShareEncryptedDataKey(): Uint8Array<ArrayBuffer> {
    const serializedPayload = JSON.stringify({
        __happierSerializedJsonValueV1: true,
        type: "json",
        value: { v: 0, keyB64: "A".repeat(44) },
    });
    return new Uint8Array(24 + 16 + Buffer.byteLength(serializedPayload, "utf8")).fill(1);
}

describe("publicShareRoutes plaintext sessions (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-public-share-plain-",
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
        });
    });

    afterAll(async () => {
        await harness.close();
    });

    it("creates and accesses a public share for a plaintext session without encryptedDataKey", async () => {
        const owner = await db.account.create({ data: { publicKey: "pk_owner" }, select: { id: true } });
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: "s_plain",
                encryptionMode: "plain",
                metadata: JSON.stringify({ v: 1, flavor: "claude" }),
                agentState: null,
                dataEncryptionKey: null,
            },
            select: { id: true },
        });

        const app = createAuthenticatedTestApp();
        publicShareRoutes(app as any);
        await app.ready();
        try {
            const token = "tok_plain_1";
            const createRes = await app.inject({
                method: "POST",
                url: `/v1/sessions/${session.id}/public-share`,
                headers: { "x-test-user-id": owner.id, "content-type": "application/json" },
                payload: JSON.stringify({ token, isConsentRequired: false }),
            });
            expect(createRes.statusCode).toBe(200);

            const accessRes = await app.inject({
                method: "GET",
                url: `/v1/public-share/${encodeURIComponent(token)}`,
            });
            expect(accessRes.statusCode).toBe(200);
            const json = accessRes.json();
            expect(json.session?.id).toBe(session.id);
            expect(json.session?.encryptionMode).toBe("plain");
            expect(json.encryptedDataKey).toBe(null);
        } finally {
            await app.close();
        }
    });

    it.each([
        { name: "disabled", trustProxy: undefined, remoteAddress: "203.0.113.9", forwardedFor: "198.51.100.7", consentRequired: true, expectedIp: "203.0.113.9" },
        { name: "untrusted", trustProxy: "10.0.0.0/8", remoteAddress: "203.0.113.9", forwardedFor: "198.51.100.7", consentRequired: true, expectedIp: "203.0.113.9" },
        { name: "trusted", trustProxy: "10.0.0.0/8", remoteAddress: "10.1.2.3", forwardedFor: "198.51.100.7", consentRequired: true, expectedIp: "198.51.100.7" },
        { name: "real-ip-only", trustProxy: "10.0.0.0/8", remoteAddress: "10.1.2.3", forwardedFor: undefined, consentRequired: true, expectedIp: "10.1.2.3" },
        { name: "untrusted-chain", trustProxy: "10.0.0.0/8", remoteAddress: "10.1.2.3", forwardedFor: "198.51.100.7, 203.0.113.8", consentRequired: true, expectedIp: "203.0.113.8" },
        { name: "without-consent", trustProxy: "10.0.0.0/8", remoteAddress: "10.1.2.3", forwardedFor: "198.51.100.7", consentRequired: false, expectedIp: null },
    ])("persists the canonical client IP and consent policy for $name proxies", async ({ name, trustProxy, remoteAddress, forwardedFor, consentRequired, expectedIp }) => {
        const owner = await db.account.create({
            data: { publicKey: `pk_owner_proxy_${name}` },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: `s_plain_proxy_${name}`,
                encryptionMode: "plain",
                metadata: JSON.stringify({ v: 1 }),
            },
            select: { id: true },
        });
        const token = `tok_plain_proxy_${name}`;
        const share = await db.publicSessionShare.create({
            data: {
                sessionId: session.id,
                createdByUserId: owner.id,
                tokenHash: createHash("sha256").update(token, "utf8").digest(),
                encryptedDataKey: null,
                isConsentRequired: consentRequired,
            },
            select: { id: true },
        });

        const app = createAuthenticatedTestApp({ trustProxy });
        publicShareRoutes(app);
        await app.ready();
        try {
            if (consentRequired) {
                const denied = await app.inject({ method: "GET", url: `/v1/public-share/${encodeURIComponent(token)}` });
                expect(denied.statusCode).toBe(403);
                await expect(db.publicShareAccessLog.count({ where: { publicShareId: share.id } })).resolves.toBe(0);
            }
            const response = await app.inject({
                method: "GET",
                url: `/v1/public-share/${encodeURIComponent(token)}?consent=true`,
                remoteAddress,
                headers: {
                    ...(forwardedFor ? { "x-forwarded-for": forwardedFor } : {}),
                    "x-real-ip": "192.0.2.99",
                    "user-agent": "share-access-test",
                },
            });
            expect(response.statusCode).toBe(200);
            await expect(db.publicShareAccessLog.findMany({
                where: { publicShareId: share.id },
                select: { ipAddress: true, userAgent: true },
            })).resolves.toEqual([{
                ipAddress: expectedIp,
                userAgent: consentRequired ? "share-access-test" : null,
            }]);
            if (!consentRequired) {
                const withoutConsentQuery = await app.inject({ method: "GET", url: `/v1/public-share/${encodeURIComponent(token)}` });
                expect(withoutConsentQuery.statusCode).toBe(200);
                await expect(db.publicShareAccessLog.findMany({
                    where: { publicShareId: share.id },
                    select: { ipAddress: true, userAgent: true },
                })).resolves.toEqual([{ ipAddress: null, userAgent: null }, { ipAddress: null, userAgent: null }]);
            }
        } finally {
            await app.close();
        }
    });

    it("returns 404 for message reads when an E2EE session public share is missing encryptedDataKey", async () => {
        const owner = await db.account.create({ data: { publicKey: "pk_owner_2" }, select: { id: true } });
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: "s_e2ee",
                encryptionMode: "e2ee",
                metadata: "ciphertext",
                agentState: null,
                dataEncryptionKey: Buffer.from([1, 2, 3]),
            },
            select: { id: true },
        });

        const token = "tok_e2ee_missing_dek";
        const tokenHash = createHash("sha256").update(token, "utf8").digest();
        await db.publicSessionShare.create({
            data: {
                sessionId: session.id,
                createdByUserId: owner.id,
                tokenHash,
                encryptedDataKey: null,
                isConsentRequired: false,
            },
        });

        const app = createAuthenticatedTestApp();
        publicShareRoutes(app as any);
        await app.ready();
        try {
            const messagesRes = await app.inject({
                method: "GET",
                url: `/v1/public-share/${encodeURIComponent(token)}/messages`,
            });
            expect(messagesRes.statusCode).toBe(404);
        } finally {
            await app.close();
        }
    });

    it("rejects repeated direct message reads for a capped public share without consuming a use", async () => {
        const owner = await db.account.create({ data: { publicKey: "pk_owner_capped_direct" }, select: { id: true } });
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: "s_plain_capped_direct",
                encryptionMode: "plain",
                metadata: JSON.stringify({ v: 1, flavor: "codex" }),
                agentState: null,
                dataEncryptionKey: null,
            },
            select: { id: true },
        });
        await db.sessionMessage.create({
            data: {
                sessionId: session.id,
                seq: 1,
                messageRole: "user",
                content: { t: "plain", v: { role: "user", content: { type: "text", text: "hello" } } },
            },
        });

        const token = "tok_plain_capped_direct";
        const share = await db.publicSessionShare.create({
            data: {
                sessionId: session.id,
                createdByUserId: owner.id,
                tokenHash: createHash("sha256").update(token, "utf8").digest(),
                encryptedDataKey: null,
                isConsentRequired: false,
                maxUses: 1,
                useCount: 0,
            },
            select: { id: true },
        });

        const app = createAuthenticatedTestApp();
        publicShareRoutes(app as any);
        await app.ready();
        try {
            const first = await app.inject({
                method: "GET",
                url: `/v1/public-share/${encodeURIComponent(token)}/messages`,
            });
            const second = await app.inject({
                method: "GET",
                url: `/v1/public-share/${encodeURIComponent(token)}/messages`,
            });

            expect(first.statusCode).toBe(404);
            expect(second.statusCode).toBe(404);
        } finally {
            await app.close();
        }

        await expect(db.publicSessionShare.findUnique({
            where: { id: share.id },
            select: { useCount: true },
        })).resolves.toEqual({ useCount: 0 });
    });

    it("returns public transcript history in canonical seq order, not createdAt order", async () => {
        const owner = await db.account.create({ data: { publicKey: "pk_owner_seq_order" }, select: { id: true } });
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: "s_plain_seq_order",
                encryptionMode: "plain",
                metadata: JSON.stringify({ v: 1, flavor: "codex" }),
                agentState: null,
                dataEncryptionKey: null,
            },
            select: { id: true },
        });
        // createdAt deliberately disagrees with seq (imported/migrated sessions, clock
        // skew, out-of-order writes): the transcript's canonical order is seq. Selecting
        // the newest page by createdAt can silently omit newer transcript rows.
        const base = Date.now();
        for (const message of [
            { seq: 1, createdAt: new Date(base + 30_000), text: "first" },
            { seq: 2, createdAt: new Date(base + 10_000), text: "second" },
            { seq: 3, createdAt: new Date(base + 20_000), text: "third" },
        ]) {
            await db.sessionMessage.create({
                data: {
                    sessionId: session.id,
                    seq: message.seq,
                    createdAt: message.createdAt,
                    messageRole: "user",
                    content: { t: "plain", v: { role: "user", content: { type: "text", text: message.text } } },
                },
            });
        }

        const token = "tok_plain_seq_order";
        await db.publicSessionShare.create({
            data: {
                sessionId: session.id,
                createdByUserId: owner.id,
                tokenHash: createHash("sha256").update(token, "utf8").digest(),
                encryptedDataKey: null,
                isConsentRequired: false,
                maxUses: null,
                useCount: 0,
            },
            select: { id: true },
        });

        const app = createAuthenticatedTestApp();
        publicShareRoutes(app as any);
        await app.ready();
        try {
            const metadata = await app.inject({
                method: "GET",
                url: `/v1/public-share/${encodeURIComponent(token)}`,
            });
            const messages = await app.inject({
                method: "GET",
                url: `/v1/public-share/${encodeURIComponent(token)}/messages`,
            });

            expect(messages.statusCode).toBe(200);
            const seqs = messages.json().messages.map((message: { seq: number }) => message.seq);
            expect(seqs).toEqual([3, 2, 1]);
            expect(messages.json().hasMore).toBe(false);
            for (let seq = 4; seq <= 150; seq += 1) {
                await db.sessionMessage.create({ data: {
                    sessionId: session.id, seq, messageRole: "user",
                    content: { t: "plain", v: { role: "user", content: { type: "text", text: `message ${seq}` } } },
                } });
            }
            const exactPage = await app.inject({ method: "GET", url: `/v1/public-share/${encodeURIComponent(token)}/messages` });
            expect(exactPage.json().messages).toHaveLength(150);
            expect(exactPage.json().hasMore).toBe(false);
            await db.sessionMessage.create({ data: {
                sessionId: session.id, seq: 151, messageRole: "user",
                content: { t: "plain", v: { role: "user", content: { type: "text", text: "newest message" } } },
            } });
            const partialPage = await app.inject({ method: "GET", url: `/v1/public-share/${encodeURIComponent(token)}/messages` });
            expect(partialPage.json().hasMore).toBe(true);
            expect(partialPage.json().messages).toHaveLength(150);
            expect(partialPage.json().messages[0].seq).toBe(151);
            expect(partialPage.json().messages.at(-1).seq).toBe(2);

        } finally {
            await app.close();
        }
    });

    it("counts a capped public viewer open once and grants its paired message read", async () => {
        const owner = await db.account.create({ data: { publicKey: "pk_owner_capped_view" }, select: { id: true } });
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: "s_plain_capped_view",
                encryptionMode: "plain",
                metadata: JSON.stringify({ v: 1, flavor: "codex" }),
                agentState: null,
                dataEncryptionKey: null,
            },
            select: { id: true },
        });
        await db.sessionMessage.create({
            data: {
                sessionId: session.id,
                seq: 1,
                messageRole: "user",
                content: { t: "plain", v: { role: "user", content: { type: "text", text: "hello" } } },
            },
        });

        const token = "tok_plain_capped_view";
        const share = await db.publicSessionShare.create({
            data: {
                sessionId: session.id,
                createdByUserId: owner.id,
                tokenHash: createHash("sha256").update(token, "utf8").digest(),
                encryptedDataKey: null,
                isConsentRequired: false,
                maxUses: 1,
                useCount: 0,
            },
            select: { id: true },
        });

        const app = createAuthenticatedTestApp();
        publicShareRoutes(app as any);
        await app.ready();
        try {
            const metadata = await app.inject({
                method: "GET",
                url: `/v1/public-share/${encodeURIComponent(token)}`,
            });
            const messagesAccessToken = metadata.json().messagesAccessToken;
            const messages = await app.inject({
                method: "GET",
                url: `/v1/public-share/${encodeURIComponent(token)}/messages`,
                headers: { "x-public-share-messages-access-token": messagesAccessToken ?? "missing-grant" },
            });

            expect(metadata.statusCode).toBe(200);
            expect(messagesAccessToken).toEqual(expect.any(String));
            expect(messages.statusCode).toBe(200);
        } finally {
            await app.close();
        }

        await expect(db.publicSessionShare.findUnique({
            where: { id: share.id },
            select: { useCount: true },
        })).resolves.toEqual({ useCount: 1 });
    });

    it("allows exactly one concurrent metadata claim for a maxUses=1 public share", async () => {
        const owner = await db.account.create({ data: { publicKey: "pk_owner_concurrent_claim" }, select: { id: true } });
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: "s_plain_concurrent_claim",
                encryptionMode: "plain",
                metadata: JSON.stringify({ v: 1, flavor: "codex" }),
                agentState: null,
                dataEncryptionKey: null,
            },
            select: { id: true },
        });
        const token = "tok_plain_concurrent_claim";
        const share = await db.publicSessionShare.create({
            data: {
                sessionId: session.id,
                createdByUserId: owner.id,
                tokenHash: createHash("sha256").update(token, "utf8").digest(),
                encryptedDataKey: null,
                isConsentRequired: false,
                maxUses: 1,
                useCount: 0,
            },
            select: { id: true },
        });

        const app = createAuthenticatedTestApp();
        publicShareRoutes(app as any);
        await app.ready();
        try {
            const results = await Promise.all([
                app.inject({ method: "GET", url: `/v1/public-share/${encodeURIComponent(token)}` }),
                app.inject({ method: "GET", url: `/v1/public-share/${encodeURIComponent(token)}` }),
            ]);

            expect(results.map((result) => result.statusCode).sort()).toEqual([200, 404]);
        } finally {
            await app.close();
        }

        await expect(db.publicSessionShare.findUnique({
            where: { id: share.id },
            select: { useCount: true },
        })).resolves.toEqual({ useCount: 1 });
    });

    it("fails closed for malformed persisted use limits without consuming", async () => {
        const owner = await db.account.create({ data: { publicKey: "pk_owner_invalid_cap" }, select: { id: true } });
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: "s_plain_invalid_cap",
                encryptionMode: "plain",
                metadata: JSON.stringify({ v: 1, flavor: "codex" }),
                agentState: null,
                dataEncryptionKey: null,
            },
            select: { id: true },
        });
        const token = "tok_plain_invalid_cap";
        const share = await db.publicSessionShare.create({
            data: {
                sessionId: session.id,
                createdByUserId: owner.id,
                tokenHash: createHash("sha256").update(token, "utf8").digest(),
                encryptedDataKey: null,
                isConsentRequired: false,
                maxUses: -1,
                useCount: 0,
            },
            select: { id: true },
        });

        const app = createAuthenticatedTestApp();
        publicShareRoutes(app as any);
        await app.ready();
        try {
            const metadata = await app.inject({ method: "GET", url: `/v1/public-share/${encodeURIComponent(token)}` });
            const messages = await app.inject({ method: "GET", url: `/v1/public-share/${encodeURIComponent(token)}/messages` });
            expect(metadata.statusCode).toBe(404);
            expect(messages.statusCode).toBe(404);
        } finally {
            await app.close();
        }

        await expect(db.publicSessionShare.findUnique({
            where: { id: share.id },
            select: { useCount: true },
        })).resolves.toEqual({ useCount: 0 });
    });

    it("rolls back the final capped use when transactional access logging fails", async () => {
        const owner = await db.account.create({ data: { publicKey: "pk_owner_log_rollback" }, select: { id: true } });
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: "s_plain_log_rollback",
                encryptionMode: "plain",
                metadata: JSON.stringify({ v: 1, flavor: "codex" }),
                agentState: null,
                dataEncryptionKey: null,
            },
            select: { id: true },
        });
        const token = "tok_plain_log_rollback";
        const share = await db.publicSessionShare.create({
            data: {
                sessionId: session.id,
                createdByUserId: owner.id,
                tokenHash: createHash("sha256").update(token, "utf8").digest(),
                encryptedDataKey: null,
                isConsentRequired: false,
                maxUses: 1,
                useCount: 0,
            },
            select: { id: true },
        });

        await db.$executeRawUnsafe(`
            CREATE TRIGGER "force_public_share_access_log_failure"
            BEFORE INSERT ON "PublicShareAccessLog"
            BEGIN
                SELECT RAISE(ABORT, 'forced public share access-log failure');
            END
        `);

        const app = createAuthenticatedTestApp();
        publicShareRoutes(app as any);
        await app.ready();
        try {
            const metadata = await app.inject({ method: "GET", url: `/v1/public-share/${encodeURIComponent(token)}` });
            expect(metadata.statusCode).toBe(500);
        } finally {
            await app.close();
            await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS "force_public_share_access_log_failure"');
        }

        await expect(db.publicSessionShare.findUnique({
            where: { id: share.id },
            select: { useCount: true },
        })).resolves.toEqual({ useCount: 0 });
    });

    it("rejects a malformed E2EE key envelope before consuming the final use", async () => {
        const owner = await db.account.create({ data: { publicKey: "pk_owner_malformed_envelope" }, select: { id: true } });
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: "s_e2ee_malformed_envelope",
                encryptionMode: "e2ee",
                metadata: "ciphertext",
                agentState: null,
                dataEncryptionKey: Buffer.from([1, 2, 3]),
            },
            select: { id: true },
        });

        const token = "tok_e2ee_malformed_envelope";
        const share = await db.publicSessionShare.create({
            data: {
                sessionId: session.id,
                createdByUserId: owner.id,
                tokenHash: createHash("sha256").update(token, "utf8").digest(),
                encryptedDataKey: Buffer.from([1, 2, 3]),
                isConsentRequired: false,
                maxUses: 1,
                useCount: 0,
            },
            select: { id: true },
        });

        const app = createAuthenticatedTestApp();
        publicShareRoutes(app as any);
        await app.ready();
        try {
            const access = await app.inject({
                method: "GET",
                url: `/v1/public-share/${encodeURIComponent(token)}`,
            });
            expect(access.statusCode).toBe(404);
        } finally {
            await app.close();
        }

        await expect(db.publicSessionShare.findUnique({
            where: { id: share.id },
            select: { useCount: true },
        })).resolves.toEqual({ useCount: 0 });
    });

    it("projects messageRole for public transcript normalization", async () => {
        const owner = await db.account.create({ data: { publicKey: "pk_owner_message_role" }, select: { id: true } });
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: "s_plain_message_role",
                encryptionMode: "plain",
                metadata: JSON.stringify({ v: 1, flavor: "codex" }),
                agentState: null,
                dataEncryptionKey: null,
            },
            select: { id: true },
        });
        await db.sessionMessage.create({
            data: {
                sessionId: session.id,
                seq: 1,
                messageRole: "event",
                content: { t: "plain", v: { role: "agent", content: { type: "output", data: { type: "assistant", message: { content: "status" } } } } },
            },
        });

        const token = "tok_plain_message_role";
        await db.publicSessionShare.create({
            data: {
                sessionId: session.id,
                createdByUserId: owner.id,
                tokenHash: createHash("sha256").update(token, "utf8").digest(),
                encryptedDataKey: null,
                isConsentRequired: false,
            },
        });

        const app = createAuthenticatedTestApp();
        publicShareRoutes(app as any);
        await app.ready();
        try {
            const root = await app.inject({
                method: "GET",
                url: `/v1/public-share/${encodeURIComponent(token)}`,
            });
            const messages = await app.inject({
                method: "GET",
                url: `/v1/public-share/${encodeURIComponent(token)}/messages`,
            });

            expect(root.statusCode).toBe(200);
            expect(messages.statusCode).toBe(200);
            expect(messages.json().messages).toEqual([
                expect.objectContaining({ seq: 1, messageRole: "event" }),
            ]);
        } finally {
            await app.close();
        }
    });

    it("keeps the exact cli-v0.2.1 viewer request valid for unlimited shares while treating literal false consent as false", async () => {
        const owner = await db.account.create({ data: { publicKey: "pk_owner_strict_consent" }, select: { id: true } });
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: "s_plain_strict_consent",
                encryptionMode: "plain",
                metadata: JSON.stringify({ v: 1, flavor: "codex" }),
                agentState: null,
                dataEncryptionKey: null,
            },
            select: { id: true },
        });
        await db.sessionMessage.create({
            data: {
                sessionId: session.id,
                seq: 1,
                messageRole: "user",
                content: { t: "plain", v: { role: "user", content: { type: "text", text: "main" } } },
            },
        });
        const token = "tok_plain_strict_consent";
        const share = await db.publicSessionShare.create({
            data: {
                sessionId: session.id,
                createdByUserId: owner.id,
                tokenHash: createHash("sha256").update(token, "utf8").digest(),
                encryptedDataKey: null,
                isConsentRequired: true,
                maxUses: null,
                useCount: 0,
            },
            select: { id: true },
        });

        const app = createAuthenticatedTestApp();
        publicShareRoutes(app as any);
        await app.ready();
        try {
            const deniedRoot = await app.inject({
                method: "GET",
                url: `/v1/public-share/${encodeURIComponent(token)}?consent=false`,
            });
            const deniedMessages = await app.inject({
                method: "GET",
                url: `/v1/public-share/${encodeURIComponent(token)}/messages?consent=0`,
            });
            expect(deniedRoot.statusCode).toBe(403);
            expect(deniedMessages.statusCode).toBe(403);

            const root = await app.inject({
                method: "GET",
                url: `/v1/public-share/${encodeURIComponent(token)}?consent=true`,
            });
            const grant = root.json().messagesAccessToken;
            expect(root.statusCode).toBe(200);
            expect(grant).toBeUndefined();

            // Exact cli-v0.2.1 viewer request shape at
            // b1d15a8a9c241737d1ca9b167459901e6259173a: no messages grant header.
            const direct = await app.inject({
                method: "GET",
                url: `/v1/public-share/${encodeURIComponent(token)}/messages?consent=true`,
            });
            expect(direct.statusCode).toBe(200);
        } finally {
            await app.close();
        }

        await expect(db.publicSessionShare.findUnique({
            where: { id: share.id },
            select: { useCount: true },
        })).resolves.toEqual({ useCount: 1 });
    });

    it.each([
        { encryptionMode: "plain" as const, suffix: "plain" },
        { encryptionMode: "e2ee" as const, suffix: "e2ee" },
    ])("returns only canonical main rows for a $suffix public transcript", async ({ encryptionMode, suffix }) => {
        const owner = await db.account.create({
            data: { publicKey: `pk_owner_main_scope_${suffix}` },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: `s_main_scope_${suffix}`,
                encryptionMode,
                metadata: encryptionMode === "plain" ? JSON.stringify({ v: 1 }) : "encrypted-metadata",
                agentState: null,
                dataEncryptionKey: encryptionMode === "plain" ? null : Buffer.from([1, 2, 3]),
            },
            select: { id: true },
        });
        await db.sessionMessage.createMany({
            data: [
                {
                    sessionId: session.id,
                    seq: 1,
                    sidechainId: null,
                    messageRole: "user",
                    content: encryptionMode === "plain"
                        ? { t: "plain", v: { role: "user", content: { type: "text", text: "main" } } }
                        : { t: "encrypted", c: "encrypted-main" },
                },
                {
                    sessionId: session.id,
                    seq: 2,
                    sidechainId: "sidechain-1",
                    messageRole: "agent",
                    content: encryptionMode === "plain"
                        ? { t: "plain", v: { role: "agent", content: { type: "text", text: "sidechain" } } }
                        : { t: "encrypted", c: "encrypted-sidechain" },
                },
            ],
        });
        const token = `tok_main_scope_${suffix}`;
        await db.publicSessionShare.create({
            data: {
                sessionId: session.id,
                createdByUserId: owner.id,
                tokenHash: createHash("sha256").update(token, "utf8").digest(),
                encryptedDataKey: encryptionMode === "plain"
                    ? null
                    : Uint8Array.from(currentPublicShareEncryptedDataKey()),
                isConsentRequired: false,
                maxUses: null,
                useCount: 0,
            },
        });

        const app = createAuthenticatedTestApp();
        publicShareRoutes(app as any);
        await app.ready();
        try {
            const root = await app.inject({
                method: "GET",
                url: `/v1/public-share/${encodeURIComponent(token)}`,
            });
            const messages = await app.inject({
                method: "GET",
                url: `/v1/public-share/${encodeURIComponent(token)}/messages`,
            });

            expect(root.statusCode).toBe(200);
            expect(messages.statusCode).toBe(200);
            expect(messages.json().messages).toEqual([
                expect.objectContaining({
                    seq: 1,
                    content: encryptionMode === "plain"
                        ? expect.objectContaining({ t: "plain" })
                        : { t: "encrypted", c: "encrypted-main" },
                }),
            ]);
        } finally {
            await app.close();
        }
    });
});
