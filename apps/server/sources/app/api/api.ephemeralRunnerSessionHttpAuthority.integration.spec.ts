import Fastify from "fastify";
import {
    serializerCompiler,
    validatorCompiler,
    ZodTypeProvider,
} from "fastify-type-provider-zod";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createMaterializedEphemeralRunnerFixture } from "@/app/ephemeralRunner/materializedRunner.testkit";
import { auth } from "@/app/auth/auth";
import { db } from "@/storage/db";
import {
    createLightSqliteHarness,
    type LightSqliteHarness,
} from "@/testkit/lightSqliteHarness";

import { registerApiRoutes } from "./api";
import type { Fastify as TypedFastify } from "./types";
import { enableAuthentication } from "./utils/enableAuthentication";
import { resolveApiRateLimitPluginOptions } from "./utils/apiRateLimitPolicy";

function createProductionCompositionApp() {
    const app = Fastify({ logger: false });
    app.register(
        import("@fastify/rate-limit"),
        resolveApiRateLimitPluginOptions(process.env),
    );
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as TypedFastify;
    enableAuthentication(typed);
    registerApiRoutes(typed);
    return app;
}

const compatibilityHeaders = {
    "x-happier-account-stored-content-protocol": "2",
} as const;

describe("ephemeral Runner Session HTTP authority (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-runner-session-http-authority-",
            initAuth: true,
            initEncrypt: true,
            env: {
                AUTH_REQUIRED_LOGIN_PROVIDERS: "",
                AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: "0",
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            },
        });
    }, 120_000);

    afterEach(async () => {
        await db.ephemeralRunnerActivation.deleteMany();
        await db.accessKey.deleteMany();
        await db.usageEvent.deleteMany();
        await db.sessionGrant.deleteMany({ where: { principalKind: 'account' } });
        await db.sessionMessage.deleteMany();
        await db.sessionPin.deleteMany();
        await db.sessionAttentionStanding.deleteMany();
        await db.accountSessionFollow.deleteMany();
        await db.accountSessionReadState.deleteMany();
        await db.session.deleteMany();
        await db.machine.deleteMany();
        await db.account.deleteMany();
    });

    afterAll(async () => {
        await harness.close();
    });

    async function createFixture() {
        const fixture = await createMaterializedEphemeralRunnerFixture();
        await db.session.update({
            where: { id: fixture.sessionId },
            data: {
                seq: 5,
                latestReadyEventSeq: 5,
                metadata: JSON.stringify({
                    v: 1,
                    summary: { text: "shared", updatedAt: 0 },
                }),
                metadataVersion: 0,
                ownerMetadata: JSON.stringify({
                    t: "plain",
                    v: { v: 1, workspace: { name: "owner-only" } },
                }),
                agentState: "owner-agent-state",
                agentStateVersion: 1,
            },
        });
        await db.accountSessionReadState.create({
            data: {
                accountId: fixture.accountId,
                sessionId: fixture.sessionId,
                lastViewedSessionSeq: 1,
                unreadSince: new Date(1_000),
            },
        });
        await db.accountSessionFollow.create({
            data: {
                accountId: fixture.accountId,
                sessionId: fixture.sessionId,
                following: true,
                followPolicy: JSON.stringify({ preset: "important" }),
            },
        });
        await db.sessionAttentionStanding.create({
            data: {
                accountId: fixture.accountId,
                sessionId: fixture.sessionId,
                standing: true,
            },
        });
        await db.sessionPin.create({
            data: {
                accountId: fixture.accountId,
                sessionId: fixture.sessionId,
            },
        });
        await db.sessionMessage.create({
            data: {
                sessionId: fixture.sessionId,
                seq: 1,
                messageRole: "user",
                content: {
                    t: "plain",
                    v: {
                        role: "user",
                        content: { type: "text", text: "runtime-private-authorship" },
                    },
                },
                authorAccountId: fixture.accountId,
                inputAdmissionReceipt: {
                    v: 1,
                    issuer: "authenticatedAccount",
                    actorAccountId: fixture.accountId,
                    sessionRelationship: "owner",
                },
            },
        });
        const sibling = await db.session.create({
            data: {
                accountId: fixture.accountId,
                tag: `runner-sibling-${crypto.randomUUID()}`,
                metadata: JSON.stringify({ v: 1, name: "sibling" }),
                encryptionMode: "plain",
                metadataLayoutVersion: 1,
                ownerMetadata: JSON.stringify({ t: "plain", v: { v: 1 } }),
            },
        });
        const target = await db.account.create({
            data: {
                publicKey: `runner-share-target-${crypto.randomUUID()}`,
                encryptionMode: "plain",
            },
        });
        return { ...fixture, siblingSessionId: sibling.id, targetAccountId: target.id };
    }

    function createUsageEventPayload(params: Readonly<{
        sessionId: string;
        machineId?: string | null;
        externalKey: string;
    }>) {
        return {
            sessionId: params.sessionId,
            observedAt: 1_714_000_000_000,
            agentId: "codex",
            backendMode: "appServer",
            modelId: "gpt-5-codex",
            projectKey: null,
            workspaceId: null,
            ...(params.machineId === undefined ? {} : { machineId: params.machineId }),
            source: "token_count",
            scope: "turn_delta" as const,
            externalKey: params.externalKey,
            turnId: "turn-1",
            isCumulative: false,
            tokens: {
                input: 10,
                output: 5,
                reasoning: 1,
                cacheRead: 0,
                cacheWrite: 0,
                total: 16,
            },
            cost: {
                reportedUsd: 0.11,
                estimatedUsd: 0.09,
                currency: "USD",
            },
        };
    }

    it("admits only exact detail and shared-editor mutation without deriving owner authority", async () => {
        const fixture = await createFixture();
        const app = createProductionCompositionApp();
        const authorization = { authorization: `Bearer ${fixture.token}` };

        try {
            await app.ready();

            const detail = await app.inject({
                method: "GET",
                url: `/v2/sessions/${fixture.sessionId}?accessProjectionVersion=1`,
                headers: { ...compatibilityHeaders, ...authorization },
            });
            expect(detail.statusCode, detail.body).toBe(200);
            expect(detail.json()).toMatchObject({
                session: {
                    id: fixture.sessionId,
                    metadata: JSON.stringify({
                        v: 1,
                        summary: { text: "shared", updatedAt: 0 },
                    }),
                    agentState: null,
                    effectiveAccess: {
                        level: "edit",
                        sources: [],
                        capabilities: {
                            readTranscript: true,
                            submitAgentInput: true,
                            editSessionRecords: true,
                            manageAccess: false,
                            managePublicLink: false,
                            stopSession: false,
                            deleteSession: false,
                        },
                    },
                },
            });
            expect(detail.body).not.toContain("owner-only");
            expect(detail.body).not.toContain("owner-agent-state");
            expect(detail.body).not.toContain("runtime-private-authorship");
            expect(detail.json().session).not.toHaveProperty("viewer");
            expect(detail.json().session).not.toHaveProperty("lastViewedSessionSeq");
            expect(detail.json().session).not.toHaveProperty("unreadSince");

            const sharedEditor = await app.inject({
                method: "PATCH",
                url: `/v2/sessions/${fixture.sessionId}`,
                headers: { ...compatibilityHeaders, ...authorization },
                payload: {
                    mode: "shared_editor",
                    metadataLayoutVersion: 1,
                    sharedMetadata: {
                        ciphertext: JSON.stringify({
                            v: 1,
                            summary: { text: "runner-updated", updatedAt: 1 },
                        }),
                        expectedVersion: 0,
                    },
                },
            });
            expect(sharedEditor.statusCode, sharedEditor.body).toBe(200);
            expect(sharedEditor.json()).toMatchObject({
                success: true,
                metadataLayoutVersion: 1,
                sharedMetadata: { version: 1 },
            });

            const externalIdentityClaim = await app.inject({
                method: "PATCH",
                url: `/v2/sessions/${fixture.sessionId}`,
                headers: { ...compatibilityHeaders, ...authorization },
                payload: { externalIdentityTag: `direct:v1:${"e".repeat(64)}` },
            });
            expect(externalIdentityClaim.statusCode, externalIdentityClaim.body).toBe(200);
            expect(externalIdentityClaim.json()).toEqual({ externalIdentity: "claimed" });

            const deniedRequests = [
                {
                    label: "owner metadata",
                    method: "PATCH" as const,
                    url: `/v2/sessions/${fixture.sessionId}`,
                    payload: {
                        mode: "owner",
                        metadataLayoutVersion: 1,
                        expectedOwnerMetadata: {
                            t: "plain",
                            v: { v: 1, workspace: { name: "owner-only" } },
                        },
                        sharedMetadata: { ciphertext: "shared", expectedVersion: 1 },
                        ownerMetadata: {
                            t: "plain",
                            v: { v: 1, workspace: { name: "changed" } },
                        },
                        agentState: { ciphertext: "changed-agent-state", expectedVersion: 1 },
                    },
                    status: 403,
                },
                {
                    label: "AgentState mutation",
                    method: "PATCH" as const,
                    url: `/v2/sessions/${fixture.sessionId}`,
                    payload: {
                        agentState: {
                            ciphertext: "changed-agent-state",
                            expectedVersion: 1,
                        },
                    },
                    status: 403,
                },
                {
                    label: "sibling Session",
                    method: "GET" as const,
                    url: `/v2/sessions/${fixture.siblingSessionId}?accessProjectionVersion=1`,
                    status: 403,
                },
                {
                    label: "sharing administration",
                    method: "POST" as const,
                    url: "/v2/sessions/access-grants/set",
                    payload: {
                        sessionId: fixture.sessionId,
                        subject: { kind: "account", accountId: fixture.targetAccountId },
                        accessLevel: "view",
                        canApprovePermissions: false,
                    },
                    status: 403,
                },
                {
                    label: "owner-only deletion",
                    method: "DELETE" as const,
                    url: `/v1/sessions/${fixture.sessionId}`,
                    status: 403,
                },
                {
                    label: "malformed shared-editor field",
                    method: "PATCH" as const,
                    url: `/v2/sessions/${fixture.sessionId}`,
                    payload: {
                        mode: "shared_editor",
                        metadataLayoutVersion: 1,
                        sharedMetadata: { ciphertext: "malformed", expectedVersion: 1 },
                        ownerMetadata: { t: "plain", v: { v: 1 } },
                    },
                    status: 400,
                },
                {
                    label: "Account state",
                    method: "GET" as const,
                    url: "/v1/auth/ping",
                    status: 403,
                },
                {
                    label: "Account settings",
                    method: "GET" as const,
                    url: "/v1/account/settings",
                    status: 403,
                },
                {
                    label: "Machine list",
                    method: "GET" as const,
                    url: "/v1/machines",
                    status: 403,
                },
                {
                    label: "exact Machine administration",
                    method: "GET" as const,
                    url: `/v1/machines/${fixture.machineId}`,
                    status: 403,
                },
                {
                    label: "exact Machine revocation",
                    method: "POST" as const,
                    url: `/v1/machines/${fixture.machineId}/revoke`,
                    status: 403,
                },
                {
                    label: "Team administration",
                    method: "POST" as const,
                    url: "/v1/teams/list",
                    payload: {},
                    status: 403,
                },
            ];

            for (const denied of deniedRequests) {
                const response = await app.inject({
                    method: denied.method,
                    url: denied.url,
                    headers: { ...compatibilityHeaders, ...authorization },
                    ...(denied.payload === undefined ? {} : { payload: denied.payload }),
                });
                expect(response.statusCode, `${denied.label}: ${response.body}`).toBe(denied.status);
                if (denied.label === "Team administration") {
                    expect(response.json()).toEqual({ error: "team_forbidden" });
                }
            }

            await db.accessKey.deleteMany({
                where: {
                    accountId: fixture.accountId,
                    sessionId: fixture.sessionId,
                    machineId: fixture.machineId,
                },
            });
            const revoked = await app.inject({
                method: "GET",
                url: `/v2/sessions/${fixture.sessionId}?accessProjectionVersion=1`,
                headers: { ...compatibilityHeaders, ...authorization },
            });
            expect(revoked.statusCode, revoked.body).toBe(401);
        } finally {
            await app.close();
        }
    });

    it("gives the released unqualified detail the same runtime authority", async () => {
        // The released owner/direct seam projection and the version-qualified
        // current projection are two presentations of one access decision. A
        // Session-scoped runtime credential is never the owner, so omitting
        // `accessProjectionVersion` must not hand it owner capabilities or
        // owner-private content.
        const fixture = await createFixture();
        const app = createProductionCompositionApp();
        const authorization = { authorization: `Bearer ${fixture.token}` };

        try {
            await app.ready();

            const released = await app.inject({
                method: "GET",
                url: `/v2/sessions/${fixture.sessionId}`,
                headers: { ...compatibilityHeaders, ...authorization },
            });
            expect(released.statusCode, released.body).toBe(200);
            expect(released.json()).toMatchObject({
                session: {
                    id: fixture.sessionId,
                    metadata: JSON.stringify({
                        v: 1,
                        summary: { text: "shared", updatedAt: 0 },
                    }),
                    agentState: null,
                    effectiveAccess: {
                        level: "edit",
                        sources: [],
                        capabilities: {
                            readTranscript: true,
                            submitAgentInput: true,
                            editSessionRecords: true,
                            manageAccess: false,
                            managePublicLink: false,
                            stopSession: false,
                            deleteSession: false,
                        },
                    },
                },
            });
            expect(released.body).not.toContain("owner-only");
            expect(released.body).not.toContain("owner-agent-state");
            expect(released.body).not.toContain("runtime-private-authorship");
            expect(released.json().session).not.toHaveProperty("viewer");
            expect(released.json().session).not.toHaveProperty("lastViewedSessionSeq");
            expect(released.json().session).not.toHaveProperty("unreadSince");
            expect(released.json().session).not.toHaveProperty("pendingExecutionRunIds");

            // Sibling isolation is an admission fact, not a projection fact, so it
            // must hold on the released seam as well.
            const sibling = await app.inject({
                method: "GET",
                url: `/v2/sessions/${fixture.siblingSessionId}`,
                headers: { ...compatibilityHeaders, ...authorization },
            });
            expect(sibling.statusCode, sibling.body).toBe(403);
        } finally {
            await app.close();
        }
    });

    it("admits the current materialized Runner to the existing authenticated feature projection", async () => {
        const fixture = await createFixture();
        const app = createProductionCompositionApp();

        try {
            await app.ready();
            const [runnerResponse, accountResponse] = await Promise.all([
                app.inject({
                    method: "GET",
                    url: "/v1/features/authenticated",
                    headers: { authorization: `Bearer ${fixture.token}` },
                }),
                app.inject({
                    method: "GET",
                    url: "/v1/features/authenticated",
                    headers: { authorization: `Bearer ${fixture.accountToken}` },
                }),
            ]);

            expect(runnerResponse.statusCode, runnerResponse.body).toBe(200);
            expect(accountResponse.statusCode, accountResponse.body).toBe(200);
            expect(runnerResponse.json()).toEqual(accountResponse.json());
        } finally {
            await app.close();
        }
    });

    it("admits append-only usage only for the Runner principal's exact Session and optional exact Machine", async () => {
        const fixture = await createFixture();
        const app = createProductionCompositionApp();
        const authorization = { authorization: `Bearer ${fixture.token}` };

        try {
            await app.ready();

            for (const payload of [
                createUsageEventPayload({
                    sessionId: fixture.sessionId,
                    externalKey: "runner-usage-without-machine",
                }),
                createUsageEventPayload({
                    sessionId: fixture.sessionId,
                    machineId: null,
                    externalKey: "runner-usage-null-machine",
                }),
                createUsageEventPayload({
                    sessionId: fixture.sessionId,
                    machineId: fixture.machineId,
                    externalKey: "runner-usage-exact-machine",
                }),
            ]) {
                const response = await app.inject({
                    method: "POST",
                    url: "/v2/usage-events",
                    headers: { ...compatibilityHeaders, ...authorization },
                    payload,
                });
                expect(response.statusCode, response.body).toBe(200);
                expect(response.json()).toMatchObject({ success: true, eventId: expect.any(String) });
            }

            const deniedRequests = [
                {
                    label: "sibling Session usage",
                    url: "/v2/usage-events",
                    payload: createUsageEventPayload({
                        sessionId: fixture.siblingSessionId,
                        externalKey: "runner-usage-sibling",
                    }),
                },
                {
                    label: "different Machine usage",
                    url: "/v2/usage-events",
                    payload: createUsageEventPayload({
                        sessionId: fixture.sessionId,
                        machineId: `wrong-${fixture.machineId}`,
                        externalKey: "runner-usage-wrong-machine",
                    }),
                },
                {
                    label: "usage query",
                    url: "/v2/usage/query",
                    payload: { filters: { sessionIds: [fixture.sessionId] } },
                },
                {
                    label: "legacy usage ingestion",
                    url: "/v2/usage-reports",
                    payload: {
                        key: "runner-legacy-usage",
                        sessionId: fixture.sessionId,
                        tokens: { total: 1 },
                        cost: { total: 0 },
                    },
                },
            ];

            for (const denied of deniedRequests) {
                const response = await app.inject({
                    method: "POST",
                    url: denied.url,
                    headers: { ...compatibilityHeaders, ...authorization },
                    payload: denied.payload,
                });
                expect(response.statusCode, `${denied.label}: ${response.body}`).toBe(403);
            }

            await expect(db.usageEvent.findMany({
                where: { accountId: fixture.accountId },
                select: { sessionId: true, machineId: true, externalKey: true },
                orderBy: { externalKey: "asc" },
            })).resolves.toEqual([
                {
                    sessionId: fixture.sessionId,
                    machineId: fixture.machineId,
                    externalKey: "runner-usage-exact-machine",
                },
                {
                    sessionId: fixture.sessionId,
                    machineId: null,
                    externalKey: "runner-usage-null-machine",
                },
                {
                    sessionId: fixture.sessionId,
                    machineId: null,
                    externalKey: "runner-usage-without-machine",
                },
            ]);
        } finally {
            await app.close();
        }
    });

    it("rejects Runner usage ingestion after principal currentness is revoked", async () => {
        const fixture = await createFixture();
        const app = createProductionCompositionApp();

        try {
            await app.ready();
            await db.machine.update({
                where: { id: fixture.machineId },
                data: { revokedAt: new Date(), active: false },
            });

            const response = await app.inject({
                method: "POST",
                url: "/v2/usage-events",
                headers: {
                    ...compatibilityHeaders,
                    authorization: `Bearer ${fixture.token}`,
                },
                payload: createUsageEventPayload({
                    sessionId: fixture.sessionId,
                    machineId: fixture.machineId,
                    externalKey: "runner-usage-after-revocation",
                }),
            });

            expect(response.statusCode, response.body).toBe(401);
            await expect(db.usageEvent.count({ where: { accountId: fixture.accountId } })).resolves.toBe(0);
        } finally {
            await app.close();
        }
    });

    it.each([
        {
            boundary: "closed activation",
            invalidate: async (fixture: Awaited<ReturnType<typeof createFixture>>) => {
                await db.ephemeralRunnerActivation.update({
                    where: { id: fixture.activationId },
                    data: { state: "closed", closeReason: "revoked" },
                });
                return fixture.token;
            },
        },
        {
            boundary: "deleted AccessKey",
            invalidate: async (fixture: Awaited<ReturnType<typeof createFixture>>) => {
                await db.accessKey.delete({
                    where: {
                        accountId_machineId_sessionId: {
                            accountId: fixture.accountId,
                            machineId: fixture.machineId,
                            sessionId: fixture.sessionId,
                        },
                    },
                });
                return fixture.token;
            },
        },
        {
            boundary: "revoked Machine",
            invalidate: async (fixture: Awaited<ReturnType<typeof createFixture>>) => {
                await db.machine.update({
                    where: { id: fixture.machineId },
                    data: { revokedAt: new Date(), active: false },
                });
                return fixture.token;
            },
        },
        {
            boundary: "replaced Machine installation",
            invalidate: async (fixture: Awaited<ReturnType<typeof createFixture>>) => {
                await db.machine.update({
                    where: { id: fixture.machineId },
                    data: {
                        installationId: "replacement-installation",
                        installationPublicKey: Buffer.from(new Uint8Array(32).fill(29)),
                    },
                });
                return fixture.token;
            },
        },
        {
            boundary: "wrong Session binding",
            invalidate: async (fixture: Awaited<ReturnType<typeof createFixture>>) => await auth.createToken(
                fixture.accountId,
                {
                    ephemeralSessionRunnerPrincipal: {
                        kind: "ephemeral_session_runner" as const,
                        authority: "session_runtime" as const,
                        accountId: fixture.accountId,
                        activationId: fixture.activationId,
                        sessionId: fixture.siblingSessionId,
                        machineId: fixture.machineId,
                        installationId: fixture.installationId,
                        installationPublicKey: fixture.installationPublicKey,
                        creatorTokenEpoch: 0,
                    },
                },
                { kind: "ephemeral_session_runner", authority: "session_runtime" },
            ),
        },
        {
            boundary: "wrong Machine binding",
            invalidate: async (fixture: Awaited<ReturnType<typeof createFixture>>) => await auth.createToken(
                fixture.accountId,
                {
                    ephemeralSessionRunnerPrincipal: {
                        kind: "ephemeral_session_runner" as const,
                        authority: "session_runtime" as const,
                        accountId: fixture.accountId,
                        activationId: fixture.activationId,
                        sessionId: fixture.sessionId,
                        machineId: `wrong-${fixture.machineId}`,
                        installationId: fixture.installationId,
                        installationPublicKey: fixture.installationPublicKey,
                        creatorTokenEpoch: 0,
                    },
                },
                { kind: "ephemeral_session_runner", authority: "session_runtime" },
            ),
        },
    ])("rejects the Runner feature read after $boundary", async ({ invalidate }) => {
        const fixture = await createFixture();
        const token = await invalidate(fixture);
        const app = createProductionCompositionApp();

        try {
            await app.ready();
            const response = await app.inject({
                method: "GET",
                url: "/v1/features/authenticated",
                headers: { authorization: `Bearer ${token}` },
            });
            expect(response.statusCode, response.body).toBe(401);
            expect(response.json()).toEqual({ error: "invalid_token" });
        } finally {
            await app.close();
        }
    });
});
