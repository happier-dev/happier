import Fastify from "fastify";
import {
    serializerCompiler,
    validatorCompiler,
    ZodTypeProvider,
} from "fastify-type-provider-zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { enableAuthentication } from "@/app/api/utils/enableAuthentication";
import { registerApiRoutes } from "@/app/api/api";
import type { Fastify as TypedFastify } from "@/app/api/types";
import { resolveApiRateLimitPluginOptions } from "@/app/api/utils/apiRateLimitPolicy";
import { createSavedSecretResourceInTx } from "@/app/account/savedSecrets/savedSecretResourceService";
import { auth } from "@/app/auth/auth";
import { HOME_GOVERNANCE_POLICY_ID } from "@/app/home/governance/governancePolicy";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

const RELEASED_ACCOUNT_ID = "released-team-legacy-account";
const RELEASED_TOKEN_MASTER_SECRET = "auth-team-legacy-release-fixture-secret";

// Golden bearer produced with privacy-kit@0.0.25 using the exact
// `createToken(accountId)` call shape in immutable server-v0.2.11
// (98ea8fb76733b1dd785d38c31360179cafa84824). Its signed payload has the
// released account subject and token epoch, but no provenance marker.
const SERVER_V0_2_11_ACCOUNT_TOKEN =
    "eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJyZWxlYXNlZC10ZWFtLWxlZ2FjeS1hY2NvdW50IiwidG9rZW5FcG9jaCI6MCwiaWF0IjoxNzg5MjMxNDgxLCJuYmYiOjE3ODkyMzE0ODEsImlzcyI6ImhhbmR5IiwianRpIjoiMGU4ZmEzZDItNGQwZC00NDYzLTkyYTMtNzZkODQxZTVmODZmIn0.CJ5FiCaGvHJlL22-_mmNnrdvW3HbGitmbMJ0Zco2koQSZfU48jA6mKFm9Ygu3GJyq4GET4CGV50gSmrkSyUjAQ";

describe("Team API composition legacy Home credential admission (SQLite integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-team-legacy-auth-",
            initAuth: true,
            initEncrypt: true,
            initFiles: true,
            env: {
                HANDY_MASTER_SECRET: RELEASED_TOKEN_MASTER_SECRET,
                AUTH_REQUIRED_LOGIN_PROVIDERS: "",
                HAPPIER_FEATURE_TEAMS__ENABLED: "1",
                HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED: "1",
            },
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    it("keeps a released opaque Home bearer compatible with ordinary Home routes but denies every Team family and Team-granted material read", async () => {
        const account = await db.account.create({
            data: {
                id: RELEASED_ACCOUNT_ID,
                publicKey: "released-team-legacy-account-key",
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        await db.homeGovernancePolicy.upsert({
            where: { id: HOME_GOVERNANCE_POLICY_ID },
            create: { id: HOME_GOVERNANCE_POLICY_ID, revision: 1, teamCreationPolicy: "self_service" },
            update: { teamCreationPolicy: "self_service" },
        });
        const team = await db.team.create({ data: { name: "Legacy admission target" } });
        await db.teamMembership.create({
            data: { teamId: team.id, accountId: account.id, role: "owner" },
        });
        const target = await db.account.create({
            data: { publicKey: "released-team-legacy-target-key", encryptionMode: "plain" },
            select: { id: true },
        });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: target.id, role: "member" } });
        const savedSecretResourceId = "released-team-legacy-saved-secret";
        const savedSecret = await inTx((tx) => createSavedSecretResourceInTx(tx, {
            accountId: account.id,
            resourceId: savedSecretResourceId,
            displayName: "Legacy denial secret",
            kind: "apiKey",
            encryptionMode: "plain",
            storedContent: {
                t: "plain",
                v: { v: 1, name: "Legacy denial secret", kind: "apiKey", value: "must-not-disclose" },
            },
        }));
        expect(savedSecret.ok).toBe(true);
        const teamSecretResourceId = "released-team-legacy-team-secret";
        expect(await inTx((tx) => createSavedSecretResourceInTx(tx, {
            accountId: target.id,
            authentication: { authenticationAuthority: "present_user" },
            resourceId: teamSecretResourceId,
            displayName: "Team-only secret",
            kind: "apiKey",
            encryptionMode: "plain",
            storedContent: { t: "plain", v: { v: 1, name: "Team-only secret", kind: "apiKey", value: "team-only-value" } },
            teamGrants: [team.id],
        }))).toMatchObject({ ok: true });
        const currentToken = await auth.createToken(account.id, undefined, {
            kind: "account",
            authority: "present_user",
        });

        const app = Fastify({ logger: false });
        app.register(
            import("@fastify/rate-limit"),
            resolveApiRateLimitPluginOptions(process.env),
        );
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as TypedFastify;
        enableAuthentication(typed);
        typed.get("/v1/ordinary-home", { preHandler: typed.authenticate }, async () => ({ ok: true }));
        registerApiRoutes(typed);
        await app.ready();

        try {
            const inject = (
                url: string,
                payload?: Readonly<Record<string, unknown>>,
                bearer: string = SERVER_V0_2_11_ACCOUNT_TOKEN,
            ) => app.inject({
                method: payload === undefined ? "GET" : "POST",
                url,
                headers: { authorization: `Bearer ${bearer}` },
                ...(payload === undefined ? {} : { payload }),
            });

            const ordinary = await inject("/v1/ordinary-home");
            expect({ status: ordinary.statusCode, body: ordinary.json() }).toEqual({
                status: 200,
                body: { ok: true },
            });

            const attempts = [
                await inject("/v1/teams/update", { v: 1, teamId: team.id, name: "Unauthorized rename" }),
                await inject("/v1/teams/members/add", {
                    v: 1,
                    teamId: team.id,
                    accountId: target.id,
                    role: "member",
                    historyAccess: "all_existing",
                }),
                await inject("/v1/teams/groups/create", {
                    v: 1,
                    teamId: team.id,
                    name: "Unauthorized group",
                    requestKey: crypto.randomUUID(),
                }),
                await inject(`/v1/teams/${team.id}/directory-sources`, {
                    v: 1,
                    kind: "github_organization",
                    displayName: "Unauthorized directory",
                    githubAppInstallationId: "installation-legacy-denied",
                }),
                await inject("/v1/teams/invitations/create", {
                    v: 1,
                    teamId: team.id,
                    role: "member",
                    historyAccess: "from_membership",
                    recipientEmail: null,
                    requestKey: crypto.randomUUID(),
                }),
                // The read a 0.3 client issues during its first Account sync.
                await inject("/v2/teams/label-envelopes"),
            ];
            // The released bearer is still a valid Home credential, so Team
            // families refuse it as a permission answer. A 401 would tell the
            // client to discard the person's stored credential and sign them out.
            for (const attempt of attempts) {
                expect({ status: attempt.statusCode, body: attempt.json() }).toEqual({
                    status: 403,
                    body: { error: "team_forbidden" },
                });
            }

            // Ordinary Account custody remains readable with the released bearer;
            // Team-derived custody still requires qualified Team authentication.
            const legacyMaterials = await inject("/v1/account/saved-secrets/resources/materials");
            expect(legacyMaterials.statusCode).toBe(200);
            expect(legacyMaterials.json().resources.map((resource: { resourceId: string }) => resource.resourceId))
                .toEqual([savedSecretResourceId]);

            await expect(db.team.findUniqueOrThrow({ where: { id: team.id } }))
                .resolves.toMatchObject({ name: "Legacy admission target" });
            await expect(db.team.count()).resolves.toBe(1);
            await expect(db.teamMembership.count({ where: { teamId: team.id } })).resolves.toBe(2);
            await expect(db.teamGroup.count({ where: { teamId: team.id } })).resolves.toBe(0);
            await expect(db.teamDirectorySource.count({ where: { teamId: team.id } })).resolves.toBe(0);
            await expect(db.teamInvitation.count({ where: { teamId: team.id } })).resolves.toBe(0);
            await expect(db.savedSecretResource.count({ where: { id: savedSecretResourceId } })).resolves.toBe(1);

            const currentMaterials = await inject(
                "/v1/account/saved-secrets/resources/materials",
                undefined,
                currentToken,
            );
            expect(currentMaterials.statusCode).toBe(200);
            expect(currentMaterials.json().resources.map((resource: { resourceId: string }) => resource.resourceId).sort())
                .toEqual([savedSecretResourceId, teamSecretResourceId].sort());
        } finally {
            await app.close();
        }
    });
});
