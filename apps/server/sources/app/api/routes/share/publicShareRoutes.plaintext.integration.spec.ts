import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "crypto";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { publicShareRoutes } from "./publicShareRoutes";

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
});
