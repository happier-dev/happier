import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { withAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { sessionRoutes } from "./sessionRoutes";

const OWNER_METADATA_CIPHERTEXT =
    "oQoBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQGDb9gtt8Xqs3gDuzJU/wWRuslcRY3OZA==";

const layoutOneBody = {
    tag: "layout-one-create",
    metadataLayoutVersion: 1,
    sharedMetadata: { ciphertext: JSON.stringify({ v: 1, flavor: "codex" }) },
    ownerMetadata: { ciphertext: OWNER_METADATA_CIPHERTEXT },
    agentState: JSON.stringify({ privateAgentState: "owner-only" }),
    dataEncryptionKey: null,
    encryptionMode: "plain",
} as const;

describe("session create-or-load metadata envelope (SQLite integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-session-create-envelope-",
            initAuth: false,
        });
    }, 120_000);

    afterAll(async () => {
        if (harness) await harness.close();
    });

    beforeEach(() => {
        vi.resetModules();
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
        });
    });

    afterEach(async () => {
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.sessionShare.deleteMany(),
            () => db.accountChange.deleteMany(),
            () => db.session.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    async function createAccount(publicKey: string) {
        return db.account.create({
            data: { publicKey, encryptionMode: "plain" },
            select: { id: true },
        });
    }

    async function withApp(run: (app: FastifyInstance) => Promise<void>) {
        await withAuthenticatedTestApp(
            (app) => sessionRoutes(app),
            run,
        );
    }

    it("refuses to activate layout-v1 for a fresh session", async () => {
        const owner = await createAccount("pk-layout-one-owner");

        await withApp(async (app) => {
            const created = await app.inject({
                method: "POST",
                url: "/v1/sessions",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": owner.id,
                },
                payload: layoutOneBody,
            });

            expect(created.statusCode).toBe(409);
            expect(created.json()).toMatchObject({
                code: "metadata_privacy_upgrade_required",
            });
            await expect(db.session.count({
                where: { accountId: owner.id },
            })).resolves.toBe(0);
        });
    });

    it("loads an already-layout-v1 same-tag session without overwriting the tuple", async () => {
        const owner = await createAccount("pk-layout-one-retry");
        const before = await db.session.create({
            data: {
                accountId: owner.id,
                tag: layoutOneBody.tag,
                encryptionMode: "plain",
                metadata: layoutOneBody.sharedMetadata.ciphertext,
                metadataLayoutVersion: 1,
                ownerMetadata: OWNER_METADATA_CIPHERTEXT,
                agentState: layoutOneBody.agentState,
            },
        });

        await withApp(async (app) => {
            const request = () => app.inject({
                method: "POST",
                url: "/v1/sessions",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": owner.id,
                },
                payload: layoutOneBody,
            });
            for (let attempt = 0; attempt < 2; attempt += 1) {
                const loaded = await request();
                expect(loaded.statusCode).toBe(200);
                expect(loaded.json()).toEqual({
                    created: false,
                    session: expect.objectContaining({
                        id: before.id,
                        metadata: before.metadata,
                        ownerMetadata: before.ownerMetadata,
                        agentState: before.agentState,
                        metadataLayoutVersion: 1,
                    }),
                });
            }
            await expect(db.session.findUniqueOrThrow({
                where: { id: before.id },
            })).resolves.toEqual(before);
        });
    });

    it("loads the canonical same-layout tuple without overwriting divergent request fields and rejects both cross-version directions", async () => {
        const owner = await createAccount("pk-layout-skew");
        const before = await db.session.create({
            data: {
                accountId: owner.id,
                tag: layoutOneBody.tag,
                encryptionMode: "plain",
                metadata: layoutOneBody.sharedMetadata.ciphertext,
                metadataLayoutVersion: 1,
                ownerMetadata: OWNER_METADATA_CIPHERTEXT,
                agentState: layoutOneBody.agentState,
            },
        });

        await withApp(async (app) => {
            const inject = (payload: Record<string, unknown>) => app.inject({
                method: "POST",
                url: "/v1/sessions",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": owner.id,
                },
                payload,
            });

            const divergentRequest = await inject({
                ...layoutOneBody,
                sharedMetadata: {
                    ciphertext: JSON.stringify({ v: 1, flavor: "claude" }),
                },
            });
            expect(divergentRequest.statusCode).toBe(200);
            expect(divergentRequest.json()).toMatchObject({
                created: false,
                session: {
                    id: before.id,
                    metadata: before.metadata,
                    ownerMetadata: before.ownerMetadata,
                    agentState: before.agentState,
                    metadataLayoutVersion: 1,
                },
            });
            const oldClientAgainstCurrent = await inject({
                tag: layoutOneBody.tag,
                metadata: "legacy-whole-bag",
                agentState: null,
                dataEncryptionKey: null,
                encryptionMode: "plain",
            });
            expect(oldClientAgainstCurrent.statusCode).toBe(409);
            expect(oldClientAgainstCurrent.json()).toMatchObject({
                code: "metadata_privacy_upgrade_required",
            });
            await expect(db.session.findUniqueOrThrow({
                where: { id: before.id },
            })).resolves.toEqual(before);

            const legacy = await inject({
                tag: "legacy-layout-zero",
                metadata: "legacy-whole-bag",
                agentState: "legacy-agent-state",
                dataEncryptionKey: null,
                encryptionMode: "plain",
            });
            expect(legacy.statusCode).toBe(200);
            expect(legacy.json().created).toBe(true);
            const currentAgainstLegacy = await inject({
                ...layoutOneBody,
                tag: "legacy-layout-zero",
            });
            expect(currentAgainstLegacy.statusCode).toBe(409);
            expect(currentAgainstLegacy.json()).toMatchObject({
                code: "metadata_privacy_upgrade_required",
            });
        });
    });

    it("keeps released layout-zero metadata and Agent-state PATCH writes live while fencing layout one", async () => {
        const owner = await createAccount("pk-layout-zero-writer");
        const legacy = await db.session.create({
            data: {
                accountId: owner.id,
                tag: "legacy-writer",
                encryptionMode: "plain",
                metadata: "legacy-before",
                agentState: "state-before",
            },
        });
        const split = await db.session.create({
            data: {
                accountId: owner.id,
                tag: "split-writer",
                encryptionMode: "plain",
                metadata: layoutOneBody.sharedMetadata.ciphertext,
                metadataLayoutVersion: 1,
                ownerMetadata: OWNER_METADATA_CIPHERTEXT,
                agentState: layoutOneBody.agentState,
            },
        });

        await withApp(async (app) => {
            const headers = {
                "content-type": "application/json",
                "x-test-user-id": owner.id,
            };
            const updated = await app.inject({
                method: "PATCH",
                url: `/v2/sessions/${legacy.id}`,
                headers,
                payload: {
                    metadata: {
                        ciphertext: "legacy-after",
                        expectedVersion: 0,
                    },
                    agentState: {
                        ciphertext: "state-after",
                        expectedVersion: 0,
                    },
                },
            });
            expect(updated.statusCode).toBe(200);
            expect(updated.json()).toEqual({
                success: true,
                metadata: { version: 1 },
                agentState: { version: 1 },
            });
            await expect(db.session.findUniqueOrThrow({
                where: { id: legacy.id },
                select: {
                    metadataLayoutVersion: true,
                    ownerMetadata: true,
                    metadata: true,
                    metadataVersion: true,
                    agentState: true,
                    agentStateVersion: true,
                },
            })).resolves.toEqual({
                metadataLayoutVersion: 0,
                ownerMetadata: null,
                metadata: "legacy-after",
                metadataVersion: 1,
                agentState: "state-after",
                agentStateVersion: 1,
            });

            const fenced = await app.inject({
                method: "PATCH",
                url: `/v2/sessions/${split.id}`,
                headers,
                payload: {
                    metadata: {
                        ciphertext: "unsafe-legacy-write",
                        expectedVersion: 0,
                    },
                },
            });
            expect(fenced.statusCode).toBe(409);
            expect(fenced.json()).toMatchObject({
                code: "metadata_privacy_upgrade_required",
            });
            await expect(db.session.findUniqueOrThrow({
                where: { id: split.id },
                select: {
                    metadata: true,
                    metadataVersion: true,
                    ownerMetadata: true,
                    metadataLayoutVersion: true,
                },
            })).resolves.toEqual({
                metadata: layoutOneBody.sharedMetadata.ciphertext,
                metadataVersion: 0,
                ownerMetadata: OWNER_METADATA_CIPHERTEXT,
                metadataLayoutVersion: 1,
            });
        });
    });

    it("rejects malformed, mixed, storage-policy, and plaintext/data-key mismatches before persistence", async () => {
        const owner = await createAccount("pk-layout-one-invalid");

        await withApp(async (app) => {
            const inject = (payload: Record<string, unknown>) => app.inject({
                method: "POST",
                url: "/v1/sessions",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": owner.id,
                },
                payload,
            });
            for (const payload of [
                { ...layoutOneBody, metadata: "mixed-whole-bag" },
                {
                    ...layoutOneBody,
                    ownerMetadata: { ciphertext: "wrong-domain-ciphertext" },
                },
                {
                    ...layoutOneBody,
                    dataEncryptionKey: "AQID",
                },
            ]) {
                expect((await inject(payload)).statusCode).toBe(400);
            }

            harness.resetEnv({
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "required_e2ee",
            });
            const policyMismatch = await inject(layoutOneBody);
            expect(policyMismatch.statusCode).toBe(400);
            expect(policyMismatch.json()).toMatchObject({
                code: "storage_policy_requires_e2ee",
            });
            await expect(db.session.count({
                where: { accountId: owner.id },
            })).resolves.toBe(0);
        });
    });
});
