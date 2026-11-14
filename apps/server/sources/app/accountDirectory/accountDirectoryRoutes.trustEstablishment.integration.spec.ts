import { createHash } from "node:crypto";
import Fastify from "fastify";
import * as privacyKit from "privacy-kit";
import tweetnacl from "tweetnacl";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";

import type { Fastify as AppFastify } from "@/app/api/types";
import { enableAuthentication } from "@/app/api/utils/enableAuthentication";
import { registerHomeLoginApprovalRoutes } from "@/app/api/routes/auth/homeApprovalGate";
import { auth } from "@/app/auth/auth";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { registerAccountDirectoryLinkRoutes } from "./accountDirectoryRoutes";
import { preparePlainAccountApiTokenLabel } from "@/testkit/privateLabelFixture";

const ISSUER_SERVER_IDENTITY_ID = "srv_account_service_trust_routes";

function createTestApp(): AppFastify {
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as AppFastify;
    enableAuthentication(typed);
    registerAccountDirectoryLinkRoutes(typed);
    registerHomeLoginApprovalRoutes(typed);
    return typed;
}

function linkBody() {
    const publicKey = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(17)).publicKey;
    return {
        v: 1 as const,
        issuerServerIdentityId: ISSUER_SERVER_IDENTITY_ID,
        issuerSubjectId: "account-service-subject-1",
        issuerSigningKeyId: createHash("sha256").update(publicKey).digest("hex"),
        issuerSigningPublicKeyBase64Url: Buffer.from(publicKey).toString("base64url"),
        relink: false,
    };
}

async function createPendingApproval(accountId: string, suffix: string) {
    return db.authPairingSession.create({
        data: {
            accountId,
            secretHash: `route-trust-secret-${suffix}`,
            requestedPublicKey: Buffer.alloc(32, suffix === "approve" ? 1 : suffix === "reject" ? 2 : 3).toString("base64"),
            requestedBindingProof: `route-trust-binding-proof-${suffix}`,
            requestedDeviceLabel: null,
            requestedAt: new Date(),
            expiresAt: new Date(Date.now() + 120_000),
            flow: "account_assertion",
            requesterIssuerServerIdentityId: ISSUER_SERVER_IDENTITY_ID,
            requesterIssuerSubjectId: `route-trust-subject-${suffix}`,
            approvalStatus: "pending",
        },
    });
}

describe("Account Directory Home trust route admission (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-account-directory-trust-routes-",
            initAuth: true,
            env: { HAPPIER_API_RATE_LIMITS_ENABLED: "0" },
        });
    }, 120_000);

    afterEach(async () => {
        await db.authPairingSession.deleteMany();
        await db.accountDirectoryLink.deleteMany();
        await db.accountApiToken.deleteMany();
        await db.account.deleteMany();
        harness.resetEnv({ HAPPIER_API_RATE_LIMITS_ENABLED: "0" });
    });

    afterAll(async () => {
        await harness.close();
    });

    it("denies Directory, terminal, and PAT credentials on every Home trust route", async () => {
        const account = await db.account.create({
            data: { publicKey: "account-directory-trust-route-denials" },
            select: { id: true },
        });
        const credentials = [
            await auth.createToken(account.id, undefined, {
                kind: "account_directory",
                authority: "present_user",
            }),
            await auth.createToken(account.id, { session: "trust-route-terminal" }, {
                kind: "terminal",
                authority: "account_automation",
            }),
            (await auth.createApiToken({ accountId: account.id, tokenId: crypto.randomUUID(), label: await preparePlainAccountApiTokenLabel(account.id, "trust-route PAT") })).token,
        ];
        const pending = await createPendingApproval(account.id, "denied");
        const body = linkBody();
        await db.accountDirectoryLink.create({
            data: {
                accountId: account.id,
                issuerServerIdentityId: ISSUER_SERVER_IDENTITY_ID,
                issuerSubjectId: body.issuerSubjectId,
                issuerSigningKeyId: body.issuerSigningKeyId,
                issuerSigningPublicKey: Buffer.from(body.issuerSigningPublicKeyBase64Url, "base64url"),
            },
        });

        const app = createTestApp();
        await app.ready();
        try {
            for (const [index, token] of credentials.entries()) {
                const headers = { authorization: `Bearer ${token}` };
                const responses = await Promise.all([
                    app.inject({
                        method: "PUT",
                        url: `/v1/account/directory-links/${ISSUER_SERVER_IDENTITY_ID}`,
                        headers,
                        payload: body,
                    }),
                    app.inject({
                        method: "DELETE",
                        url: `/v1/account/directory-links/${ISSUER_SERVER_IDENTITY_ID}`,
                        headers,
                        payload: { v: 1 },
                    }),
                    app.inject({
                        method: "GET",
                        url: "/v1/auth/home-login/approvals",
                        headers,
                    }),
                    app.inject({
                        method: "POST",
                        url: `/v1/auth/home-login/approvals/${pending.id}/decision`,
                        headers,
                        payload: { decision: index % 2 === 0 ? "approve" : "reject" },
                    }),
                ]);
                expect(responses.map((response) => response.statusCode)).toEqual([403, 403, 403, 403]);
                expect(responses.map((response) => response.json())).toEqual([
                    { error: "present_user_required" },
                    { error: "present_user_required" },
                    { error: "present_user_required" },
                    { error: "present_user_required" },
                ]);
                expect((await db.authPairingSession.findUniqueOrThrow({ where: { id: pending.id } })).approvalStatus).toBe("pending");
                await expect(db.accountDirectoryLink.count({
                    where: { accountId: account.id, issuerServerIdentityId: ISSUER_SERVER_IDENTITY_ID },
                })).resolves.toBe(1);
            }
        } finally {
            await app.close();
        }
    });

    it("accepts ordinary current and legacy full present-user Home credentials", async () => {
        const account = await db.account.create({
            data: { publicKey: "account-directory-trust-route-current" },
            select: { id: true },
        });
        const currentToken = await auth.createToken(account.id, undefined, {
            kind: "account",
            authority: "present_user",
        });
        const legacyGenerator = await privacyKit.createPersistentTokenGenerator({
            service: "handy",
            seed: process.env.HANDY_MASTER_SECRET!,
        });
        const legacyToken = await legacyGenerator.new({
            user: account.id,
            extras: { tokenEpoch: 0 },
        });
        const body = linkBody();
        const approve = await createPendingApproval(account.id, "approve");
        const reject = await createPendingApproval(account.id, "reject");
        const app = createTestApp();
        await app.ready();
        try {
            for (const token of [currentToken, legacyToken]) {
                const response = await app.inject({
                    method: "GET",
                    url: "/v1/auth/home-login/approvals",
                    headers: { authorization: `Bearer ${token}` },
                });
                expect(response.statusCode).toBe(200);
            }

            const put = await app.inject({
                method: "PUT",
                url: `/v1/account/directory-links/${ISSUER_SERVER_IDENTITY_ID}`,
                headers: { authorization: `Bearer ${currentToken}` },
                payload: body,
            });
            expect(put.statusCode).toBe(200);

            const approveResponse = await app.inject({
                method: "POST",
                url: `/v1/auth/home-login/approvals/${approve.id}/decision`,
                headers: { authorization: `Bearer ${legacyToken}` },
                payload: { decision: "approve" },
            });
            expect(approveResponse.statusCode).toBe(200);
            expect(approveResponse.json()).toEqual({ status: "approved" });

            const rejectResponse = await app.inject({
                method: "POST",
                url: `/v1/auth/home-login/approvals/${reject.id}/decision`,
                headers: { authorization: `Bearer ${currentToken}` },
                payload: { decision: "reject" },
            });
            expect(rejectResponse.statusCode).toBe(200);
            expect(rejectResponse.json()).toEqual({ status: "rejected" });

            const remove = await app.inject({
                method: "DELETE",
                url: `/v1/account/directory-links/${ISSUER_SERVER_IDENTITY_ID}`,
                headers: { authorization: `Bearer ${legacyToken}` },
                payload: { v: 1 },
            });
            expect(remove.statusCode).toBe(200);
            await expect(db.accountDirectoryLink.count({ where: { accountId: account.id } })).resolves.toBe(0);
        } finally {
            await app.close();
        }
    });
});
