import { createHash } from "node:crypto";

import {
    CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
    buildAccountStoredContentCompatibilityHttpHeadersV1,
} from "@happier-dev/protocol";
import type { FastifyRequest } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { publicShareRoutes } from "@/app/api/routes/share/publicShareRoutes";
import { createAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { readOptionalPublicAuthDisposition } from "@/app/api/utils/optionalPublicAuth";
import { verifyRequestPrincipal } from "@/app/api/utils/verifyRequestPrincipal";
import { auth } from "@/app/auth/auth";
import { createMaterializedEphemeralRunnerFixture } from "@/app/ephemeralRunner/materializedRunner.testkit";
import { revokeMaterializedEphemeralRunnerBindingInTx } from "@/app/ephemeralRunner/materializedTeardown";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import {
    createLightSqliteHarness,
    type LightSqliteHarness,
} from "@/testkit/lightSqliteHarness";

describe("materialized ephemeral Runner principal currentness", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-runner-principal-currentness-",
            initAuth: true,
            env: {
                HANDY_MASTER_SECRET: "runner-principal-currentness-secret",
                AUTH_TOKEN_CACHE_MAX_ENTRIES: "64",
                AUTH_REQUIRED_LOGIN_PROVIDERS: "",
            },
        });
    }, 120_000);

    afterEach(async () => {
        await harness.resetDbTables([
            () => db.publicSessionShare.deleteMany(),
            () => db.accessKey.deleteMany(),
            () => db.ephemeralRunnerActivation.deleteMany(),
            () => db.session.deleteMany(),
            () => db.machine.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    afterAll(async () => {
        await harness.close();
    });

    it.each([
        {
            boundary: "activation revocation",
            revoke: async (fixture: Awaited<ReturnType<typeof createMaterializedEphemeralRunnerFixture>>) => {
                await db.ephemeralRunnerActivation.update({
                    where: { id: fixture.activationId },
                    data: { state: "closed", closeReason: "revoked" },
                });
            },
        },
        {
            boundary: "creator token-epoch revocation",
            revoke: async (fixture: Awaited<ReturnType<typeof createMaterializedEphemeralRunnerFixture>>) => {
                await db.account.update({
                    where: { id: fixture.accountId },
                    data: { tokenEpoch: { increment: 1 } },
                });
            },
        },
        {
            boundary: "Machine revocation",
            revoke: async (fixture: Awaited<ReturnType<typeof createMaterializedEphemeralRunnerFixture>>) => {
                await db.machine.update({
                    where: { id: fixture.machineId },
                    data: { active: false, revokedAt: new Date() },
                });
            },
        },
        {
            boundary: "Machine installation-identity replacement",
            revoke: async (fixture: Awaited<ReturnType<typeof createMaterializedEphemeralRunnerFixture>>) => {
                await db.machine.update({
                    where: { id: fixture.machineId },
                    data: {
                        installationId: "replacement-installation",
                        installationPublicKey: new Uint8Array(32).fill(19),
                    },
                });
            },
        },
        {
            boundary: "AccessKey revocation",
            revoke: async (fixture: Awaited<ReturnType<typeof createMaterializedEphemeralRunnerFixture>>) => {
                await db.accessKey.delete({
                    where: {
                        accountId_machineId_sessionId: {
                            accountId: fixture.accountId,
                            machineId: fixture.machineId,
                            sessionId: fixture.sessionId,
                        },
                    },
                });
            },
        },
        {
            boundary: "sibling Session AccessKey substitution",
            revoke: async (fixture: Awaited<ReturnType<typeof createMaterializedEphemeralRunnerFixture>>) => {
                const siblingSession = await db.session.create({
                    data: {
                        accountId: fixture.accountId,
                        tag: `${fixture.sessionId}-sibling`,
                        metadata: "{}",
                        encryptionMode: "plain",
                        metadataLayoutVersion: 1,
                    },
                });
                await db.accessKey.delete({
                    where: {
                        accountId_machineId_sessionId: {
                            accountId: fixture.accountId,
                            machineId: fixture.machineId,
                            sessionId: fixture.sessionId,
                        },
                    },
                });
                await db.accessKey.create({
                    data: {
                        accountId: fixture.accountId,
                        machineId: fixture.machineId,
                        sessionId: siblingSession.id,
                        data: "sibling-session-access",
                    },
                });
            },
        },
    ])("rejects a cached Runner bearer after $boundary", async ({ revoke }) => {
        const fixture = await createMaterializedEphemeralRunnerFixture();

        await expect(auth.verifyToken(fixture.token)).resolves.toMatchObject({
            authTokenKind: "ephemeral_session_runner",
            ephemeralSessionRunnerPrincipal: {
                activationId: fixture.activationId,
                sessionId: fixture.sessionId,
                machineId: fixture.machineId,
            },
        });

        await revoke(fixture);

        // The first verification populated the auth cache. Reconnect must still
        // re-read the exact materialized binding instead of trusting that cache.
        await expect(auth.verifyToken(fixture.token)).resolves.toBeNull();
        await expect(auth.verifyTokenDisposition(fixture.token, {
            allowLegacyHome: true,
        })).resolves.toEqual({
            status: "rejected_restricted",
            authTokenKind: "ephemeral_session_runner",
        });
    });

    it("never downgrades a cryptographically verified Runner bearer to anonymous public-share access after revocation", async () => {
        const fixture = await createMaterializedEphemeralRunnerFixture();
        await db.session.update({
            where: { id: fixture.sessionId },
            data: {
                metadata: JSON.stringify({ v: 1 }),
                ownerMetadata: JSON.stringify({ t: "plain", v: { v: 1 } }),
                currentStorageState: "snapshot_complete",
                materializationPublicationId: "runner-public-share-publication",
                materializedThroughSourceAt: 1n,
                publishedThroughServerSeq: 0,
            },
        });
        const publicShareToken = `runner-public-share-${crypto.randomUUID()}`;
        await db.publicSessionShare.create({
            data: {
                sessionId: fixture.sessionId,
                createdByUserId: fixture.accountId,
                tokenHash: createHash("sha256").update(publicShareToken, "utf8").digest(),
                encryptedDataKey: null,
                isConsentRequired: false,
            },
        });

        const app = createAuthenticatedTestApp();
        app.addHook("onRequest", async (request: FastifyRequest) => {
            Object.assign(
                request.headers,
                buildAccountStoredContentCompatibilityHttpHeadersV1(
                    CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
                ),
            );
        });
        publicShareRoutes(app);
        await app.ready();

        const readPublicShare = async (bearer: string) => {
            const detail = await app.inject({
                method: "GET",
                url: `/v1/public-share/${encodeURIComponent(publicShareToken)}`,
                headers: { authorization: `Bearer ${bearer}` },
            });
            const messages = await app.inject({
                method: "GET",
                url: `/v1/public-share/${encodeURIComponent(publicShareToken)}/messages`,
                headers: { authorization: `Bearer ${bearer}` },
            });
            return { detail, messages };
        };

        try {
            await expect(readOptionalPublicAuthDisposition(`Bearer ${fixture.token}`)).resolves.toEqual({
                status: "session_runtime_forbidden",
            });
            const current = await readPublicShare(fixture.token);
            expect(current.detail.statusCode, current.detail.body).toBe(403);
            expect(current.messages.statusCode, current.messages.body).toBe(403);

            await expect(inTx(async (tx) => revokeMaterializedEphemeralRunnerBindingInTx(tx, {
                accountId: fixture.accountId,
                machineId: fixture.machineId,
                sessionId: fixture.sessionId,
            }))).resolves.toBe("revoked");
            await expect(db.accessKey.findUnique({
                where: {
                    accountId_machineId_sessionId: {
                        accountId: fixture.accountId,
                        machineId: fixture.machineId,
                        sessionId: fixture.sessionId,
                    },
                },
            })).resolves.toBeNull();

            await expect(verifyRequestPrincipal({
                authorizationHeader: `Bearer ${fixture.token}`,
                allowLegacyHomeToken: true,
                readEnv: async () => process.env,
            })).resolves.toEqual({
                status: "rejected_restricted",
                kind: "ephemeral_session_runner",
            });

            await expect(readOptionalPublicAuthDisposition(`Bearer ${fixture.token}`)).resolves.toEqual({
                status: "session_runtime_forbidden",
            });
            const revoked = await readPublicShare(fixture.token);
            expect(revoked.detail.statusCode, revoked.detail.body).toBe(403);
            expect(revoked.messages.statusCode, revoked.messages.body).toBe(403);

            await expect(readOptionalPublicAuthDisposition("Bearer arbitrary-invalid-bearer")).resolves.toEqual({
                status: "anonymous",
            });
            const invalid = await readPublicShare("arbitrary-invalid-bearer");
            expect(invalid.detail.statusCode, invalid.detail.body).toBe(200);
            expect(invalid.messages.statusCode, invalid.messages.body).toBe(200);
        } finally {
            await app.close();
        }
    });
});
