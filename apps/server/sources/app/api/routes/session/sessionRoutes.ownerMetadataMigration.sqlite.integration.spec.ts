import {
    afterAll,
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import type { FastifyInstance } from "fastify";
import tweetnacl from "tweetnacl";
import { computeContentPublicKeyFingerprint } from "@happier-dev/protocol";

import { db } from "@/storage/db";
import {
    createLightSqliteHarness,
    type LightSqliteHarness,
} from "@/testkit/lightSqliteHarness";
import { withAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { sessionRoutes } from "./sessionRoutes";

const OWNER_METADATA_CIPHERTEXT =
    "oQoBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQGDb9gtt8Xqs3gDuzJU/wWRuslcRY3OZA==";

function createAccountContentBinding() {
    const signingKeyPair = tweetnacl.sign.keyPair();
    const contentKeyPair = tweetnacl.box.keyPair();
    const binding = Buffer.concat([
        Buffer.from("Happy content key v1\u0000", "utf8"),
        Buffer.from(contentKeyPair.publicKey),
    ]);
    return {
        publicKey: Buffer.from(signingKeyPair.publicKey).toString("hex"),
        contentPublicKey: Buffer.from(contentKeyPair.publicKey),
        contentPublicKeySig: Buffer.from(
            tweetnacl.sign.detached(binding, signingKeyPair.secretKey),
        ),
        fingerprint: computeContentPublicKeyFingerprint(
            new Uint8Array(contentKeyPair.publicKey),
        ),
    };
}

describe("session owner metadata migration route (SQLite integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-session-owner-migration-",
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

    it("accepts the strict currentness shape but refuses activation with zero Session mutation or publication", async () => {
        const binding = createAccountContentBinding();
        const owner = await db.account.create({
            data: {
                publicKey: binding.publicKey,
                contentPublicKey: binding.contentPublicKey,
                contentPublicKeySig: binding.contentPublicKeySig,
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: `legacy-frozen-${Math.random()}`,
                encryptionMode: "plain",
                metadataLayoutVersion: 0,
                metadata: "legacy-whole-bag",
                metadataVersion: 4,
                ownerMetadata: null,
                agentState: "legacy-agent-state",
                agentStateVersion: 7,
            },
            select: { id: true },
        });
        const before = await db.session.findUniqueOrThrow({
            where: { id: session.id },
        });
        const changesBefore = await db.accountChange.count({
            where: { accountId: owner.id },
        });

        await withAuthenticatedTestApp(
            (app) => sessionRoutes(app),
            async (app: FastifyInstance) => {
                const response = await app.inject({
                    method: "PATCH",
                    url: `/v2/sessions/${session.id}`,
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": owner.id,
                    },
                    payload: {
                        mode: "owner_migration",
                        expectedAccountEncryptionMode: "plain",
                        expectedAccountContentPublicKeyFingerprint:
                            binding.fingerprint,
                        source: {
                            metadataLayoutVersion: 0,
                            metadata: {
                                version: 4,
                                ciphertext: "legacy-whole-bag",
                            },
                            ownerMetadata: null,
                            agentState: {
                                version: 7,
                                ciphertext: "legacy-agent-state",
                            },
                        },
                        target: {
                            metadataLayoutVersion: 1,
                            sharedMetadata: { ciphertext: "shared-safe" },
                            ownerMetadata: {
                                ciphertext: OWNER_METADATA_CIPHERTEXT,
                            },
                            agentState: {
                                ciphertext: "owner-agent-state",
                            },
                        },
                    },
                });

                expect(response.statusCode, response.body).toBe(409);
                expect(response.json()).toEqual({
                    error: "Session metadata privacy upgrade required",
                    code: "metadata_privacy_upgrade_required",
                });
            },
        );

        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
        })).resolves.toEqual(before);
        await expect(db.accountChange.count({
            where: { accountId: owner.id },
        })).resolves.toBe(changesBefore);
    });
});
