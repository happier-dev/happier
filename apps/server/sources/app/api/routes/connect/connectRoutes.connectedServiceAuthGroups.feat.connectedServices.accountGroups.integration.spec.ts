import Fastify from "fastify";
import type { FastifyReply, FastifyRequest } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";

const { emitUpdate } = vi.hoisted(() => ({
    emitUpdate: vi.fn(),
}));

vi.mock("@/app/events/eventRouter", async () => {
    const actual = await vi.importActual<typeof import("@/app/events/eventRouter")>("@/app/events/eventRouter");
    return {
        ...actual,
        eventRouter: { emitUpdate },
    };
});

import { db } from "@/storage/db";
import { ConnectedServiceAuthGroupResponseV1Schema } from "@happier-dev/protocol";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { connectRoutes } from "./connectRoutes";
import { DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1 } from "./connectedServicesV3/authGroupPolicy";
import { createAppCloseTracker } from "../../testkit/appLifecycle";
import {
    upsertConnectedServiceUsageSource,
    upsertProviderAccountUsageRecord,
} from "./providerAccountUsage";
import {
    createProviderAccountUsageRecordKey,
    createUsageSnapshot,
} from "./providerAccountUsageTestkit";

const { trackApp, closeTrackedApps } = createAppCloseTracker();

function createTestApp() {
    const app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>();

    typed.decorate("authenticate", async (request: FastifyRequest, reply: FastifyReply) => {
        const userId = request.headers["x-test-user-id"];
        if (typeof userId !== "string" || !userId) {
            return reply.code(401).send({ error: "Unauthorized" });
        }
        (request as FastifyRequest & { userId: string }).userId = userId;
        return undefined;
    });

    return trackApp(typed);
}

async function createAccount(publicKey: string) {
    return db.account.create({ data: { publicKey }, select: { id: true } });
}

async function createConnectedProfile(accountId: string, serviceId: string, profileId: string) {
    await db.serviceAccountToken.create({
        data: {
            accountId,
            vendor: serviceId,
            profileId,
            token: Buffer.from(`sealed:${serviceId}:${profileId}`, "utf8"),
            metadata: { kind: "oauth" },
        },
    });
}

async function seedAuthGroup(params: Readonly<{
    accountId: string;
    serviceId: string;
    groupId: string;
    memberProfileIds: readonly string[];
    activeProfileId: string | null;
}>): Promise<void> {
    await db.connectedServiceAuthGroup.create({
        data: {
            accountId: params.accountId,
            vendor: params.serviceId,
            groupId: params.groupId,
            displayName: null,
            policyJson: JSON.stringify(DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1),
            activeProfileId: params.activeProfileId,
            stateJson: null,
            members: {
                create: params.memberProfileIds.map((profileId, index) => ({
                    accountId: params.accountId,
                    vendor: params.serviceId,
                    groupId: params.groupId,
                    profileId,
                    priority: (index + 1) * 10,
                    enabled: true,
                    stateJson: null,
                })),
            },
        },
    });
}

async function createReadyApp() {
    const app = createTestApp();
    connectRoutes(app);
    await app.ready();
    return app;
}

function authHeaders(userId: string) {
    return { "content-type": "application/json", "x-test-user-id": userId };
}

async function readAccountChangeCursor(accountId: string): Promise<number | null> {
    return (await db.accountChange.findUnique({
        where: { accountId_kind_entityId: { accountId, kind: "account", entityId: "self" } },
        select: { cursor: true },
    }))?.cursor ?? null;
}

async function readStoredAuthGroupActiveState(params: {
    accountId: string;
    serviceId: string;
    groupId: string;
}): Promise<{ activeProfileId: string | null; generation: number } | null> {
    return db.connectedServiceAuthGroup.findUnique({
        where: {
            accountId_vendor_groupId: {
                accountId: params.accountId,
                vendor: params.serviceId,
                groupId: params.groupId,
            },
        },
        select: { activeProfileId: true, generation: true },
    });
}

function expectLastProjectedGroup(params: {
    accountId: string;
    group: {
        groupId: string;
        displayName: string | null;
        activeProfileId: string | null;
        generation: number;
        memberProfileIds: readonly string[];
    } | null;
}) {
    const lastCall = emitUpdate.mock.lastCall?.[0];
    expect(lastCall).toEqual(expect.objectContaining({
        userId: params.accountId,
        recipientFilter: { type: "user-scoped-only" },
        payload: expect.objectContaining({
            body: expect.objectContaining({
                t: "update-account",
                connectedServicesV2: expect.any(Array),
            }),
        }),
    }));

    const projectedService = (lastCall?.payload?.body?.connectedServicesV2 as Array<{
        serviceId: string;
        groups?: unknown[];
    }> | undefined)?.find((entry) => entry.serviceId === "openai-codex");

    if (params.group === null) {
        expect(projectedService).toEqual(expect.objectContaining({
            serviceId: "openai-codex",
            groups: [],
        }));
        return;
    }

    expect(projectedService).toEqual(expect.objectContaining({
        serviceId: "openai-codex",
        groups: [
            expect.objectContaining({
                groupId: params.group.groupId,
                displayName: params.group.displayName,
                activeProfileId: params.group.activeProfileId,
                generation: params.group.generation,
                memberProfileIds: params.group.memberProfileIds,
            }),
        ],
    }));
}

describe("connectRoutes connected service auth groups (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-connected-service-auth-groups-",
            initAuth: true,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    afterEach(async () => {
        await closeTrackedApps();
        harness.resetEnv();
        vi.unstubAllGlobals();
        vi.clearAllMocks();
        await db.accountChange.deleteMany().catch(() => {});
        await db.connectedServiceUsageSource.deleteMany().catch(() => {});
        await db.providerAccountUsageRecord.deleteMany().catch(() => {});
        await db.serviceAccountToken.deleteMany().catch(() => {});
        await db.account.deleteMany().catch(() => {});
    });

    it("creates and lists an account-owned group with existing connected profiles", async () => {
        const user = await createAccount("pk-groups-create");
        await createConnectedProfile(user.id, "openai-codex", "work");
        await createConnectedProfile(user.id, "openai-codex", "backup");
        const app = await createReadyApp();

        const create = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload: {
                groupId: "codex-main",
                displayName: "Codex Main",
                members: [
                    { profileId: "work", priority: 10 },
                    { profileId: "backup", priority: 20 },
                ],
                activeProfileId: "work",
            },
        });

        expect(create.statusCode).toBe(200);
        expect(ConnectedServiceAuthGroupResponseV1Schema.safeParse(create.json()).success).toBe(true);
        expect(create.json()).toEqual({
            group: expect.objectContaining({
                v: 1,
                serviceId: "openai-codex",
                groupId: "codex-main",
                displayName: "Codex Main",
                activeProfileId: "work",
                generation: 0,
                policy: expect.objectContaining({ v: 1, strategy: "least_limited", autoSwitch: true }),
                members: [
                    expect.objectContaining({ v: 1, serviceId: "openai-codex", profileId: "work", priority: 10, enabled: true }),
                    expect.objectContaining({ v: 1, serviceId: "openai-codex", profileId: "backup", priority: 20, enabled: true }),
                ],
            }),
        });

        const list = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/groups",
            headers: { "x-test-user-id": user.id },
        });

        expect(list.statusCode).toBe(200);
        expect(list.json()).toEqual({
            groups: [
                expect.objectContaining({
                    serviceId: "openai-codex",
                    groupId: "codex-main",
                    members: expect.arrayContaining([
                        expect.objectContaining({ profileId: "work" }),
                        expect.objectContaining({ profileId: "backup" }),
                    ]),
                }),
            ],
        });
    });

    it("fails closed when the account-groups feature gate is disabled", async () => {
        harness.resetEnv({ HAPPIER_FEATURE_CONNECTED_SERVICES_ACCOUNT_GROUPS__ENABLED: "0" });
        const user = await createAccount("pk-groups-disabled");
        const app = await createReadyApp();

        const res = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/groups",
            headers: { "x-test-user-id": user.id },
        });

        expect(res.statusCode).toBe(404);
        expect(res.json()).toEqual({ error: "not_found" });
    });

    it("allows gemini group configuration while rejecting same-group runtime fallback controls", async () => {
        const user = await createAccount("pk-gemini-groups");
        await createConnectedProfile(user.id, "gemini", "work");
        await createConnectedProfile(user.id, "gemini", "backup");
        const app = await createReadyApp();

        const created = await app.inject({
            method: "POST",
            url: "/v3/connect/gemini/groups",
            headers: authHeaders(user.id),
            payload: {
                groupId: "gemini-main",
                members: [{ profileId: "work" }, { profileId: "backup" }],
                activeProfileId: "work",
            },
        });
        expect(created.statusCode).toBe(200);
        expect(created.json()).toEqual({
            group: expect.objectContaining({
                serviceId: "gemini",
                groupId: "gemini-main",
                activeProfileId: "work",
            }),
        });

        const autoSwitchPatch = await app.inject({
            method: "PATCH",
            url: "/v3/connect/gemini/groups/gemini-main",
            headers: authHeaders(user.id),
            payload: {
                policy: { autoSwitch: true },
                expectedGeneration: 0,
            },
        });
        expect(autoSwitchPatch.statusCode).toBe(400);
        expect(autoSwitchPatch.json()).toEqual({ error: "connect_group_runtime_fallback_unsupported" });

        const switchActiveProfile = await app.inject({
            method: "POST",
            url: "/v3/connect/gemini/groups/gemini-main/active-profile",
            headers: authHeaders(user.id),
            payload: { profileId: "backup", expectedGeneration: 0 },
        });
        expect(switchActiveProfile.statusCode).toBe(400);
        expect(switchActiveProfile.json()).toEqual({ error: "connect_group_runtime_fallback_unsupported" });
    });

    it("enforces account ownership and member profile existence", async () => {
        const owner = await createAccount("pk-groups-owner");
        const other = await createAccount("pk-groups-other");
        await createConnectedProfile(owner.id, "openai-codex", "work");
        const app = await createReadyApp();

        const create = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(owner.id),
            payload: {
                groupId: "codex-main",
                members: [{ profileId: "work" }],
                activeProfileId: "work",
            },
        });
        expect(create.statusCode).toBe(200);

        const otherRead = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/groups/codex-main",
            headers: { "x-test-user-id": other.id },
        });
        expect(otherRead.statusCode).toBe(404);
        expect(otherRead.json()).toEqual({ error: "connect_group_not_found" });

        const missingMember = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups/codex-main/members",
            headers: authHeaders(owner.id),
            payload: { profileId: "missing", expectedGeneration: 0 },
        });
        expect(missingMember.statusCode).toBe(400);
        expect(missingMember.json()).toEqual({ error: "connect_group_member_profile_not_found" });
    });

    it("rejects duplicate group ids and duplicate member profile ids", async () => {
        const user = await createAccount("pk-groups-duplicates");
        await createConnectedProfile(user.id, "openai-codex", "work");
        const app = await createReadyApp();

        const payload = {
            groupId: "codex-main",
            members: [{ profileId: "work" }],
            activeProfileId: "work",
        };
        expect((await app.inject({ method: "POST", url: "/v3/connect/openai-codex/groups", headers: authHeaders(user.id), payload })).statusCode).toBe(200);

        const duplicateGroup = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload,
        });
        expect(duplicateGroup.statusCode).toBe(409);
        expect(duplicateGroup.json()).toEqual({ error: "connect_group_already_exists" });

        const duplicateMember = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups/codex-main/members",
            headers: authHeaders(user.id),
            payload: { profileId: "work", expectedGeneration: 0 },
        });
        expect(duplicateMember.statusCode).toBe(409);
        expect(duplicateMember.json()).toEqual({ error: "connect_group_member_already_exists" });
    });

    it("bumps generation on active profile switch and rejects stale generation updates", async () => {
        const user = await createAccount("pk-groups-generation");
        await createConnectedProfile(user.id, "openai-codex", "work");
        await createConnectedProfile(user.id, "openai-codex", "backup");
        const app = await createReadyApp();

        expect((await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload: {
                groupId: "codex-main",
                members: [{ profileId: "work" }, { profileId: "backup" }],
                activeProfileId: "work",
            },
        })).statusCode).toBe(200);

        const switched = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups/codex-main/active-profile",
            headers: authHeaders(user.id),
            payload: { profileId: "backup", expectedGeneration: 0 },
        });
        expect(switched.statusCode).toBe(200);
        expect(switched.json()).toEqual({
            group: expect.objectContaining({ activeProfileId: "backup", generation: 1 }),
        });

        const stale = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups/codex-main/active-profile",
            headers: authHeaders(user.id),
            payload: { profileId: "work", expectedGeneration: 0 },
        });
        expect(stale.statusCode).toBe(409);
        expect(stale.json()).toEqual({ error: "connect_group_generation_conflict", generation: 1 });
        await expect(readStoredAuthGroupActiveState({
            accountId: user.id,
            serviceId: "openai-codex",
            groupId: "codex-main",
        })).resolves.toEqual({ activeProfileId: "backup", generation: 1 });
    });

    it("rejects unauthenticated active-profile CAS without mutating server truth", async () => {
        const user = await createAccount("pk-groups-active-profile-unauthenticated");
        await createConnectedProfile(user.id, "openai-codex", "work");
        await createConnectedProfile(user.id, "openai-codex", "backup");
        await seedAuthGroup({
            accountId: user.id,
            serviceId: "openai-codex",
            groupId: "codex-main",
            memberProfileIds: ["work", "backup"],
            activeProfileId: "work",
        });
        const app = await createReadyApp();

        const response = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups/codex-main/active-profile",
            headers: { "content-type": "application/json" },
            payload: { profileId: "backup", expectedGeneration: 0 },
        });

        expect(response.statusCode).toBe(401);
        await expect(readStoredAuthGroupActiveState({
            accountId: user.id,
            serviceId: "openai-codex",
            groupId: "codex-main",
        })).resolves.toEqual({ activeProfileId: "work", generation: 0 });
    });

    it("rejects active profile switches that omit expectedGeneration", async () => {
        const user = await createAccount("pk-groups-active-profile-generation-required");
        await createConnectedProfile(user.id, "openai-codex", "work");
        await createConnectedProfile(user.id, "openai-codex", "backup");
        const app = await createReadyApp();

        expect((await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload: {
                groupId: "codex-main",
                members: [{ profileId: "work" }, { profileId: "backup" }],
                activeProfileId: "work",
            },
        })).statusCode).toBe(200);

        const omitted = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups/codex-main/active-profile",
            headers: authHeaders(user.id),
            payload: { profileId: "backup" },
        });

        expect(omitted.statusCode).toBe(400);
        expect(omitted.json()).toEqual({ error: "connect_group_generation_required" });

        const fetched = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/groups/codex-main",
            headers: authHeaders(user.id),
        });
        expect(fetched.statusCode).toBe(200);
        expect(fetched.json().group).toMatchObject({ activeProfileId: "work", generation: 0 });
    });

    it("publishes account projection updates for create, patch, member, active-profile, and delete mutations", async () => {
        const user = await createAccount("pk-groups-projection-updates");
        await createConnectedProfile(user.id, "openai-codex", "work");
        await createConnectedProfile(user.id, "openai-codex", "backup");
        const app = await createReadyApp();

        const created = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload: {
                groupId: "codex-main",
                displayName: "Codex Main",
                members: [{ profileId: "work" }],
                activeProfileId: "work",
            },
        });
        expect(created.statusCode).toBe(200);
        const createCursor = await readAccountChangeCursor(user.id);
        expect(createCursor).toEqual(expect.any(Number));
        expectLastProjectedGroup({
            accountId: user.id,
            group: {
                groupId: "codex-main",
                displayName: "Codex Main",
                activeProfileId: "work",
                generation: 0,
                memberProfileIds: ["work"],
            },
        });

        const patched = await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/codex-main",
            headers: authHeaders(user.id),
            payload: { displayName: "Codex Primary" },
        });
        expect(patched.statusCode).toBe(200);
        const patchCursor = await readAccountChangeCursor(user.id);
        expect(patchCursor).toBeGreaterThan(createCursor ?? -1);
        expectLastProjectedGroup({
            accountId: user.id,
            group: {
                groupId: "codex-main",
                displayName: "Codex Primary",
                activeProfileId: "work",
                generation: 0,
                memberProfileIds: ["work"],
            },
        });

        const added = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups/codex-main/members",
            headers: authHeaders(user.id),
            payload: { profileId: "backup", priority: 200, expectedGeneration: 0 },
        });
        expect(added.statusCode).toBe(200);
        const addCursor = await readAccountChangeCursor(user.id);
        expect(addCursor).toBeGreaterThan(patchCursor ?? -1);
        expectLastProjectedGroup({
            accountId: user.id,
            group: {
                groupId: "codex-main",
                displayName: "Codex Primary",
                activeProfileId: "work",
                generation: 1,
                memberProfileIds: ["work", "backup"],
            },
        });

        const switched = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups/codex-main/active-profile",
            headers: authHeaders(user.id),
            payload: { profileId: "backup", expectedGeneration: 1 },
        });
        expect(switched.statusCode).toBe(200);
        const switchCursor = await readAccountChangeCursor(user.id);
        expect(switchCursor).toBeGreaterThan(addCursor ?? -1);
        expectLastProjectedGroup({
            accountId: user.id,
            group: {
                groupId: "codex-main",
                displayName: "Codex Primary",
                activeProfileId: "backup",
                generation: 2,
                memberProfileIds: ["work", "backup"],
            },
        });

        const disabled = await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/codex-main/members/backup",
            headers: authHeaders(user.id),
            payload: { enabled: false, expectedGeneration: 2 },
        });
        expect(disabled.statusCode).toBe(200);
        const disableCursor = await readAccountChangeCursor(user.id);
        expect(disableCursor).toBeGreaterThan(switchCursor ?? -1);
        expectLastProjectedGroup({
            accountId: user.id,
            group: {
                groupId: "codex-main",
                displayName: "Codex Primary",
                activeProfileId: "work",
                generation: 3,
                memberProfileIds: ["work"],
            },
        });

        const deleted = await app.inject({
            method: "DELETE",
            url: "/v3/connect/openai-codex/groups/codex-main",
            headers: { "x-test-user-id": user.id },
        });
        expect(deleted.statusCode).toBe(200);
        expect(deleted.json()).toEqual({ success: true });
        const deleteCursor = await readAccountChangeCursor(user.id);
        expect(deleteCursor).toBeGreaterThan(disableCursor ?? -1);
        expectLastProjectedGroup({
            accountId: user.id,
            group: null,
        });
    });

    it("rejects manual switches for quota reset waits but not auth action-required state", async () => {
        const user = await createAccount("pk-groups-active-profile-runtime-cooldown");
        await createConnectedProfile(user.id, "openai-codex", "work");
        await createConnectedProfile(user.id, "openai-codex", "backup");
        const app = await createReadyApp();
        const resetAtMs = Date.now() + 60_000;

        expect((await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload: {
                groupId: "codex-main",
                members: [{ profileId: "work" }, { profileId: "backup" }],
                activeProfileId: "backup",
            },
        })).statusCode).toBe(200);
        expect((await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/codex-main/runtime-state",
            headers: authHeaders(user.id),
            payload: {
                expectedGeneration: 0,
                expectedRuntimeStateRevision: 0,
                memberStates: [
                    {
                        profileId: "work",
                        state: { quotaExhaustedUntilMs: resetAtMs },
                    },
                ],
            },
        })).statusCode).toBe(200);

        const blocked = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups/codex-main/active-profile",
            headers: authHeaders(user.id),
            payload: { profileId: "work", expectedGeneration: 0 },
        });

        expect(blocked.statusCode).toBe(409);
        expect(blocked.json()).toEqual({ error: "connect_group_profile_runtime_cooldown", resetAtMs });

        const authInvalidUntilMs = resetAtMs + 30_000;
        expect((await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/codex-main/runtime-state",
            headers: authHeaders(user.id),
            payload: {
                expectedGeneration: 0,
                expectedRuntimeStateRevision: 1,
                memberStates: [
                    {
                        profileId: "work",
                        state: { authInvalidUntilMs },
                    },
                ],
            },
        })).statusCode).toBe(200);

        const authAllowed = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups/codex-main/active-profile",
            headers: authHeaders(user.id),
            payload: { profileId: "work", expectedGeneration: 0 },
        });

        expect(authAllowed.statusCode).toBe(200);
        expect(authAllowed.json().group).toEqual(expect.objectContaining({
            activeProfileId: "work",
            generation: 1,
        }));

        const patchAllowed = await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/codex-main",
            headers: authHeaders(user.id),
            payload: { activeProfileId: "backup", expectedGeneration: 1 },
        });

        expect(patchAllowed.statusCode).toBe(200);
        expect(patchAllowed.json().group).toEqual(expect.objectContaining({
            activeProfileId: "backup",
            generation: 2,
        }));
    });

    it("allows manual active profile switches to action-required runtime states", async () => {
        const user = await createAccount("pk-groups-active-profile-new-runtime-blockers");
        await createConnectedProfile(user.id, "openai-codex", "work");
        await createConnectedProfile(user.id, "openai-codex", "plan-blocked");
        await createConnectedProfile(user.id, "openai-codex", "validation-blocked");
        await createConnectedProfile(user.id, "openai-codex", "reauth-blocked");
        const app = await createReadyApp();
        const planUnavailableUntilMs = Date.now() + 60_000;
        const validationBlockedUntilMs = planUnavailableUntilMs + 30_000;

        expect((await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload: {
                groupId: "codex-main",
                members: [
                    { profileId: "work" },
                    { profileId: "plan-blocked" },
                    { profileId: "validation-blocked" },
                    { profileId: "reauth-blocked" },
                ],
                activeProfileId: "work",
            },
        })).statusCode).toBe(200);
        expect((await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/codex-main/runtime-state",
            headers: authHeaders(user.id),
            payload: {
                expectedGeneration: 0,
                expectedRuntimeStateRevision: 0,
                memberStates: [
                    {
                        profileId: "plan-blocked",
                        state: { planUnavailableUntilMs },
                    },
                    {
                        profileId: "validation-blocked",
                        state: { validationBlockedUntilMs },
                    },
                    {
                        profileId: "reauth-blocked",
                        state: { credentialHealthStatus: "needs_reauth" },
                    },
                ],
            },
        })).statusCode).toBe(200);

        const cases = [
            {
                profileId: "plan-blocked",
                entrypoint: "active-profile",
            },
            {
                profileId: "validation-blocked",
                entrypoint: "group-patch",
            },
            {
                profileId: "reauth-blocked",
                entrypoint: "active-profile",
            },
        ] as const;

        let expectedGeneration = 0;
        for (const testCase of cases) {
            const switched = await app.inject({
                method: testCase.entrypoint === "active-profile" ? "POST" : "PATCH",
                url: testCase.entrypoint === "active-profile"
                    ? "/v3/connect/openai-codex/groups/codex-main/active-profile"
                    : "/v3/connect/openai-codex/groups/codex-main",
                headers: authHeaders(user.id),
                payload: testCase.entrypoint === "active-profile"
                    ? { profileId: testCase.profileId, expectedGeneration }
                    : { activeProfileId: testCase.profileId, expectedGeneration },
            });

            expectedGeneration += 1;
            expect(switched.statusCode).toBe(200);
            expect(switched.json().group).toEqual(expect.objectContaining({
                activeProfileId: testCase.profileId,
                generation: expectedGeneration,
            }));
        }

        const fetched = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/groups/codex-main",
            headers: authHeaders(user.id),
        });

        expect(fetched.statusCode).toBe(200);
        expect(fetched.json().group).toEqual(expect.objectContaining({
            activeProfileId: "reauth-blocked",
            generation: 3,
        }));
    });

    it("allows explicit overrides to switch to members with plan, validation, and reauth blockers", async () => {
        const user = await createAccount("pk-groups-active-profile-new-runtime-blockers-override");
        await createConnectedProfile(user.id, "openai-codex", "work");
        await createConnectedProfile(user.id, "openai-codex", "backup");
        const app = await createReadyApp();
        const blockedState = {
            planUnavailableUntilMs: Date.now() + 60_000,
            validationBlockedUntilMs: Date.now() + 90_000,
            credentialHealthStatus: "needs_reauth",
        };

        for (const groupId of ["codex-post", "codex-patch"] as const) {
            expect((await app.inject({
                method: "POST",
                url: "/v3/connect/openai-codex/groups",
                headers: authHeaders(user.id),
                payload: {
                    groupId,
                    members: [{ profileId: "work" }, { profileId: "backup" }],
                    activeProfileId: "work",
                },
            })).statusCode).toBe(200);
            expect((await app.inject({
                method: "PATCH",
                url: `/v3/connect/openai-codex/groups/${groupId}/runtime-state`,
                headers: authHeaders(user.id),
                payload: {
                    expectedGeneration: 0,
                    expectedRuntimeStateRevision: 0,
                    memberStates: [{ profileId: "backup", state: blockedState }],
                },
            })).statusCode).toBe(200);
        }

        const postOverride = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups/codex-post/active-profile",
            headers: authHeaders(user.id),
            payload: {
                profileId: "backup",
                expectedGeneration: 0,
                overrideRuntimeCooldown: true,
            },
        });

        expect(postOverride.statusCode).toBe(200);
        expect(postOverride.json()).toEqual({
            group: expect.objectContaining({
                activeProfileId: "backup",
                generation: 1,
            }),
        });

        const patchOverride = await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/codex-patch",
            headers: authHeaders(user.id),
            payload: {
                activeProfileId: "backup",
                expectedGeneration: 0,
                overrideRuntimeCooldown: true,
            },
        });

        expect(patchOverride.statusCode).toBe(200);
        expect(patchOverride.json()).toEqual({
            group: expect.objectContaining({
                activeProfileId: "backup",
                generation: 1,
            }),
        });
    });

    it("does not treat providerResetsAtMs by itself as a manual active-profile blocker", async () => {
        const user = await createAccount("pk-groups-active-profile-provider-reset-policy");
        await createConnectedProfile(user.id, "openai-codex", "work");
        await createConnectedProfile(user.id, "openai-codex", "backup");
        const app = await createReadyApp();

        for (const groupId of ["codex-post", "codex-patch"] as const) {
            expect((await app.inject({
                method: "POST",
                url: "/v3/connect/openai-codex/groups",
                headers: authHeaders(user.id),
                payload: {
                    groupId,
                    members: [{ profileId: "work" }, { profileId: "backup" }],
                    activeProfileId: "work",
                },
            })).statusCode).toBe(200);
            expect((await app.inject({
                method: "PATCH",
                url: `/v3/connect/openai-codex/groups/${groupId}/runtime-state`,
                headers: authHeaders(user.id),
                payload: {
                    expectedGeneration: 0,
                    expectedRuntimeStateRevision: 0,
                    memberStates: [
                        {
                            profileId: "backup",
                            state: { providerResetsAtMs: Date.now() + 60_000 },
                        },
                    ],
                },
            })).statusCode).toBe(200);
        }

        const postSwitch = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups/codex-post/active-profile",
            headers: authHeaders(user.id),
            payload: { profileId: "backup", expectedGeneration: 0 },
        });

        expect(postSwitch.statusCode).toBe(200);
        expect(postSwitch.json()).toEqual({
            group: expect.objectContaining({
                activeProfileId: "backup",
                generation: 1,
            }),
        });

        const patchSwitch = await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/codex-patch",
            headers: authHeaders(user.id),
            payload: { activeProfileId: "backup", expectedGeneration: 0 },
        });

        expect(patchSwitch.statusCode).toBe(200);
        expect(patchSwitch.json()).toEqual({
            group: expect.objectContaining({
                activeProfileId: "backup",
                generation: 1,
            }),
        });
    });

    it("allows explicit manual active profile switches to override runtime cooldown", async () => {
        const user = await createAccount("pk-groups-active-profile-runtime-cooldown-override");
        await createConnectedProfile(user.id, "openai-codex", "work");
        await createConnectedProfile(user.id, "openai-codex", "backup");
        const app = await createReadyApp();
        const resetAtMs = Date.now() + 60_000;

        expect((await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload: {
                groupId: "codex-main",
                members: [{ profileId: "work" }, { profileId: "backup" }],
                activeProfileId: "backup",
            },
        })).statusCode).toBe(200);
        expect((await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/codex-main/runtime-state",
            headers: authHeaders(user.id),
            payload: {
                expectedGeneration: 0,
                expectedRuntimeStateRevision: 0,
                memberStates: [
                    {
                        profileId: "work",
                        state: { authInvalidUntilMs: resetAtMs },
                    },
                ],
            },
        })).statusCode).toBe(200);

        const overridden = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups/codex-main/active-profile",
            headers: authHeaders(user.id),
            payload: {
                profileId: "work",
                expectedGeneration: 0,
                overrideRuntimeCooldown: true,
            },
        });

        expect(overridden.statusCode).toBe(200);
        expect(overridden.json()).toEqual({
            group: expect.objectContaining({
                activeProfileId: "work",
                generation: 1,
                members: expect.arrayContaining([
                    expect.objectContaining({
                        profileId: "work",
                        enabled: true,
                        state: { authInvalidUntilMs: resetAtMs },
                    }),
                ]),
            }),
        });

        const staleOverride = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups/codex-main/active-profile",
            headers: authHeaders(user.id),
            payload: {
                profileId: "backup",
                expectedGeneration: 0,
                overrideRuntimeCooldown: true,
            },
        });
        expect(staleOverride.statusCode).toBe(409);
        expect(staleOverride.json()).toEqual({ error: "connect_group_generation_conflict", generation: 1 });
    });

    it("allows explicit group patch active profile switches to override runtime cooldown", async () => {
        const user = await createAccount("pk-groups-patch-active-profile-runtime-cooldown-override");
        await createConnectedProfile(user.id, "openai-codex", "work");
        await createConnectedProfile(user.id, "openai-codex", "backup");
        const app = await createReadyApp();
        const resetAtMs = Date.now() + 60_000;

        expect((await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload: {
                groupId: "codex-main",
                members: [{ profileId: "work" }, { profileId: "backup" }],
                activeProfileId: "backup",
            },
        })).statusCode).toBe(200);
        expect((await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/codex-main/runtime-state",
            headers: authHeaders(user.id),
            payload: {
                expectedGeneration: 0,
                expectedRuntimeStateRevision: 0,
                memberStates: [
                    {
                        profileId: "work",
                        state: { authInvalidUntilMs: resetAtMs },
                    },
                ],
            },
        })).statusCode).toBe(200);

        const overridden = await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/codex-main",
            headers: authHeaders(user.id),
            payload: {
                activeProfileId: "work",
                expectedGeneration: 0,
                overrideRuntimeCooldown: true,
            },
        });

        expect(overridden.statusCode).toBe(200);
        expect(overridden.json()).toEqual({
            group: expect.objectContaining({
                activeProfileId: "work",
                generation: 1,
                members: expect.arrayContaining([
                    expect.objectContaining({
                        profileId: "work",
                        enabled: true,
                        state: { authInvalidUntilMs: resetAtMs },
                    }),
                ]),
            }),
        });

        const staleOverride = await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/codex-main",
            headers: authHeaders(user.id),
            payload: {
                activeProfileId: "backup",
                expectedGeneration: 0,
                overrideRuntimeCooldown: true,
            },
        });
        expect(staleOverride.statusCode).toBe(409);
        expect(staleOverride.json()).toEqual({ error: "connect_group_generation_conflict", generation: 1 });
    });

    it("applies the group patch active profile contract", async () => {
        const user = await createAccount("pk-groups-patch-active");
        await createConnectedProfile(user.id, "openai-codex", "work");
        await createConnectedProfile(user.id, "openai-codex", "backup");
        const app = await createReadyApp();

        expect((await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload: {
                groupId: "codex-main",
                members: [{ profileId: "work" }, { profileId: "backup" }],
                activeProfileId: "work",
            },
        })).statusCode).toBe(200);

        const patched = await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/codex-main",
            headers: authHeaders(user.id),
            payload: { activeProfileId: "backup", expectedGeneration: 0 },
        });

        expect(patched.statusCode).toBe(200);
        expect(patched.json()).toEqual({
            group: expect.objectContaining({ activeProfileId: "backup", generation: 1 }),
        });
    });

    it("preserves stored-null active profile truth until an explicit mutation selects a member", async () => {
        const user = await createAccount("pk-groups-stored-null-fallback-canonicalize");
        await createConnectedProfile(user.id, "openai-codex", "work");
        await createConnectedProfile(user.id, "openai-codex", "backup");
        await seedAuthGroup({
            accountId: user.id,
            serviceId: "openai-codex",
            groupId: "codex-patch",
            memberProfileIds: ["work", "backup"],
            activeProfileId: null,
        });
        await seedAuthGroup({
            accountId: user.id,
            serviceId: "openai-codex",
            groupId: "codex-post",
            memberProfileIds: ["work", "backup"],
            activeProfileId: null,
        });
        const app = await createReadyApp();

        const patchBefore = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/groups/codex-patch",
            headers: authHeaders(user.id),
        });
        expect(patchBefore.statusCode).toBe(200);
        expect(patchBefore.json().group).toMatchObject({ activeProfileId: null, generation: 0 });
        expect(await readStoredAuthGroupActiveState({
            accountId: user.id,
            serviceId: "openai-codex",
            groupId: "codex-patch",
        })).toEqual({ activeProfileId: null, generation: 0 });

        const beforeCursor = await readAccountChangeCursor(user.id);
        const patched = await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/codex-patch",
            headers: authHeaders(user.id),
            payload: { activeProfileId: "work", expectedGeneration: 0 },
        });

        expect(patched.statusCode).toBe(200);
        expect(patched.json().group).toMatchObject({ activeProfileId: "work", generation: 1 });
        expect(await readStoredAuthGroupActiveState({
            accountId: user.id,
            serviceId: "openai-codex",
            groupId: "codex-patch",
        })).toEqual({ activeProfileId: "work", generation: 1 });
        const patchCursor = await readAccountChangeCursor(user.id);
        expect(patchCursor).toEqual(expect.any(Number));
        expect(patchCursor).toBeGreaterThan(beforeCursor ?? -1);

        const repeatedPatch = await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/codex-patch",
            headers: authHeaders(user.id),
            payload: { activeProfileId: "work", expectedGeneration: 1 },
        });

        expect(repeatedPatch.statusCode).toBe(200);
        expect(repeatedPatch.json().group).toMatchObject({ activeProfileId: "work", generation: 1 });
        expect(await readStoredAuthGroupActiveState({
            accountId: user.id,
            serviceId: "openai-codex",
            groupId: "codex-patch",
        })).toEqual({ activeProfileId: "work", generation: 1 });
        expect(await readAccountChangeCursor(user.id)).toBe(patchCursor);

        const posted = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups/codex-post/active-profile",
            headers: authHeaders(user.id),
            payload: { profileId: "work", expectedGeneration: 0 },
        });

        expect(posted.statusCode).toBe(200);
        expect(posted.json().group).toMatchObject({ activeProfileId: "work", generation: 1 });
        expect(await readStoredAuthGroupActiveState({
            accountId: user.id,
            serviceId: "openai-codex",
            groupId: "codex-post",
        })).toEqual({ activeProfileId: "work", generation: 1 });
        const postCursor = await readAccountChangeCursor(user.id);
        expect(postCursor).toEqual(expect.any(Number));
        expect(postCursor).toBeGreaterThan(patchCursor ?? -1);
    });

    it("treats explicit null PATCH against a stored-null active profile as idempotent", async () => {
        const user = await createAccount("pk-groups-stored-null-fallback-null-idempotent");
        await createConnectedProfile(user.id, "openai-codex", "work");
        await createConnectedProfile(user.id, "openai-codex", "backup");
        await seedAuthGroup({
            accountId: user.id,
            serviceId: "openai-codex",
            groupId: "codex-main",
            memberProfileIds: ["work", "backup"],
            activeProfileId: null,
        });
        const app = await createReadyApp();

        const before = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/groups/codex-main",
            headers: authHeaders(user.id),
        });
        expect(before.statusCode).toBe(200);
        expect(before.json().group).toMatchObject({ activeProfileId: null, generation: 0 });
        expect(await readStoredAuthGroupActiveState({
            accountId: user.id,
            serviceId: "openai-codex",
            groupId: "codex-main",
        })).toEqual({ activeProfileId: null, generation: 0 });

        const beforeCursor = await readAccountChangeCursor(user.id);
        const patched = await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/codex-main",
            headers: authHeaders(user.id),
            payload: { activeProfileId: null, expectedGeneration: 0 },
        });

        expect(patched.statusCode).toBe(200);
        expect(patched.json().group).toMatchObject({ activeProfileId: null, generation: 0 });
        expect(await readStoredAuthGroupActiveState({
            accountId: user.id,
            serviceId: "openai-codex",
            groupId: "codex-main",
        })).toEqual({ activeProfileId: null, generation: 0 });
        expect(await readAccountChangeCursor(user.id)).toBe(beforeCursor);

        const repeated = await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/codex-main",
            headers: authHeaders(user.id),
            payload: { activeProfileId: null, expectedGeneration: 0 },
        });

        expect(repeated.statusCode).toBe(200);
        expect(repeated.json().group).toMatchObject({ activeProfileId: null, generation: 0 });
        expect(await readStoredAuthGroupActiveState({
            accountId: user.id,
            serviceId: "openai-codex",
            groupId: "codex-main",
        })).toEqual({ activeProfileId: null, generation: 0 });
        expect(await readAccountChangeCursor(user.id)).toBe(beforeCursor);
    });

    it("applies the group patch policy contract with generation CAS", async () => {
        const user = await createAccount("pk-groups-patch-policy-cas");
        await createConnectedProfile(user.id, "openai-codex", "work");
        const app = await createReadyApp();

        expect((await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload: {
                groupId: "codex-main",
                members: [{ profileId: "work" }],
                activeProfileId: "work",
            },
        })).statusCode).toBe(200);

        const omittedGeneration = await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/codex-main",
            headers: authHeaders(user.id),
            payload: { policy: { softSwitchRemainingPercent: 9 } },
        });

        expect(omittedGeneration.statusCode).toBe(400);
        expect(omittedGeneration.json()).toEqual({ error: "connect_group_generation_required" });

        const patched = await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/codex-main",
            headers: authHeaders(user.id),
            payload: { policy: { softSwitchRemainingPercent: 9 }, expectedGeneration: 0 },
        });

        expect(patched.statusCode).toBe(200);
        expect(patched.json()).toEqual({
            group: expect.objectContaining({
                generation: 1,
                policy: expect.objectContaining({ softSwitchRemainingPercent: 9 }),
            }),
        });

        const stale = await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/codex-main",
            headers: authHeaders(user.id),
            payload: { policy: { softSwitchRemainingPercent: 10 }, expectedGeneration: 0 },
        });

        expect(stale.statusCode).toBe(409);
        expect(stale.json()).toEqual({ error: "connect_group_generation_conflict", generation: 1 });
    });

    it("defaults create activeProfileId to the first enabled member and rejects explicit disabled active members", async () => {
        const user = await createAccount("pk-groups-disabled-active-create");
        await createConnectedProfile(user.id, "openai-codex", "disabled-backup");
        await createConnectedProfile(user.id, "openai-codex", "work");
        const app = await createReadyApp();

        const defaulted = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload: {
                groupId: "codex-default",
                members: [
                    { profileId: "disabled-backup", enabled: false, priority: 10 },
                    { profileId: "work", priority: 20 },
                ],
            },
        });

        expect(defaulted.statusCode).toBe(200);
        expect(defaulted.json()).toEqual({
            group: expect.objectContaining({
                activeProfileId: "work",
                members: expect.arrayContaining([
                    expect.objectContaining({ profileId: "disabled-backup", enabled: false }),
                    expect.objectContaining({ profileId: "work", enabled: true }),
                ]),
            }),
        });

        const explicitNullDefaulted = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload: {
                groupId: "codex-explicit-null",
                members: [
                    { profileId: "disabled-backup", enabled: false, priority: 10 },
                    { profileId: "work", priority: 20 },
                ],
                activeProfileId: null,
            },
        });

        expect(explicitNullDefaulted.statusCode).toBe(200);
        expect(explicitNullDefaulted.json()).toEqual({
            group: expect.objectContaining({
                activeProfileId: "work",
            }),
        });

        const rejected = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload: {
                groupId: "codex-explicit-disabled",
                members: [
                    { profileId: "disabled-backup", enabled: false },
                    { profileId: "work" },
                ],
                activeProfileId: "disabled-backup",
            },
        });

        expect(rejected.statusCode).toBe(400);
        expect(rejected.json()).toEqual({ error: "connect_group_active_profile_not_member" });
    });

    it("bumps generation for member additions, updates, and non-active removals", async () => {
        const user = await createAccount("pk-groups-members");
        await createConnectedProfile(user.id, "openai-codex", "work");
        await createConnectedProfile(user.id, "openai-codex", "backup");
        const app = await createReadyApp();

        const created = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload: {
                groupId: "codex-main",
                members: [{ profileId: "work" }],
                activeProfileId: "work",
            },
        });
        expect(created.statusCode).toBe(200);
        expect(created.json()).toEqual({
            group: expect.objectContaining({ generation: 0 }),
        });

        const added = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups/codex-main/members",
            headers: authHeaders(user.id),
            payload: { profileId: "backup", priority: 75, expectedGeneration: 0 },
        });
        expect(added.statusCode).toBe(200);
        expect(added.json()).toEqual({
            group: expect.objectContaining({
                generation: 1,
                members: expect.arrayContaining([
                    expect.objectContaining({ profileId: "backup", priority: 75, enabled: true }),
                ]),
            }),
        });

        const disabled = await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/codex-main/members/backup",
            headers: authHeaders(user.id),
            payload: { enabled: false, priority: 50, expectedGeneration: 1 },
        });
        expect(disabled.statusCode).toBe(200);
        expect(disabled.json()).toEqual({
            group: expect.objectContaining({
                generation: 2,
                members: expect.arrayContaining([
                    expect.objectContaining({ profileId: "backup", enabled: false, priority: 50 }),
                ]),
            }),
        });

        const removed = await app.inject({
            method: "DELETE",
            url: "/v3/connect/openai-codex/groups/codex-main/members/backup?expectedGeneration=2",
            headers: { "x-test-user-id": user.id },
        });
        expect(removed.statusCode).toBe(200);
        expect(removed.json()).toEqual({
            group: expect.objectContaining({
                activeProfileId: "work",
                generation: 3,
                members: [
                    expect.objectContaining({ profileId: "work" }),
                ],
            }),
        });

        const credential = await db.serviceAccountToken.findUnique({
            where: { accountId_vendor_profileId: { accountId: user.id, vendor: "openai-codex", profileId: "backup" } },
            select: { id: true },
        });
        expect(credential).not.toBeNull();
    });

    it("cleans exact group-member usage sources through member and group DELETE routes without deleting shared usage records", async () => {
        const user = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        await createConnectedProfile(user.id, "openai-codex", "work");
        await createConnectedProfile(user.id, "openai-codex", "backup");
        await db.serviceAccountToken.updateMany({
            where: { accountId: user.id, vendor: "openai-codex" },
            data: {
                metadata: {
                    v: 3,
                    storage: "plain_json_v1",
                    kind: "token",
                    providerAccountId: "acct-route-cleanup",
                    providerEmail: null,
                },
            },
        });
        const app = await createReadyApp();

        for (const group of [
            { groupId: "left", members: [{ profileId: "work" }, { profileId: "backup" }], activeProfileId: "work" },
            { groupId: "right", members: [{ profileId: "backup" }], activeProfileId: "backup" },
        ]) {
            const created = await app.inject({
                method: "POST",
                url: "/v3/connect/openai-codex/groups",
                headers: authHeaders(user.id),
                payload: group,
            });
            expect(created.statusCode).toBe(200);
            expect(created.json().group).toMatchObject({ groupId: group.groupId, generation: 0 });
        }

        const snapshot = createUsageSnapshot({
            fetchedAt: Date.now(),
            recordKey: createProviderAccountUsageRecordKey({ accountSubjectId: "acct-route-cleanup" }),
            profileId: "backup",
        });
        await upsertProviderAccountUsageRecord({
            accountId: user.id,
            recordId: snapshot.recordId,
            recordKey: snapshot.recordKey,
            payloadMode: "plain_json_v1",
            snapshot,
            status: "ok",
            fetchedAt: snapshot.fetchedAtMs,
            staleAfterMs: snapshot.staleAfterMs,
        });
        for (const groupId of ["left", "right"] as const) {
            await upsertConnectedServiceUsageSource({
                accountId: user.id,
                serviceId: "openai-codex",
                profileId: "backup",
                providerAccountUsageRecordId: snapshot.recordId,
                bindingKind: "group_member",
                groupId,
                groupGeneration: 0,
            });
        }

        const removedMember = await app.inject({
            method: "DELETE",
            url: "/v3/connect/openai-codex/groups/left/members/backup?expectedGeneration=0",
            headers: { "x-test-user-id": user.id },
        });
        expect(removedMember.statusCode).toBe(200);
        expect(removedMember.json().group).toMatchObject({ groupId: "left", generation: 1 });
        expect(await db.connectedServiceUsageSource.findMany({
            where: { accountId: user.id },
            select: { groupId: true, groupGeneration: true },
        })).toEqual([{ groupId: "right", groupGeneration: 0 }]);

        expect((await app.inject({
            method: "DELETE",
            url: "/v3/connect/openai-codex/groups/left",
            headers: { "x-test-user-id": user.id },
        })).statusCode).toBe(200);
        expect((await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload: {
                groupId: "left",
                members: [{ profileId: "backup" }],
                activeProfileId: "backup",
            },
        })).json().group).toMatchObject({ groupId: "left", generation: 0 });
        await upsertConnectedServiceUsageSource({
            accountId: user.id,
            serviceId: "openai-codex",
            profileId: "backup",
            providerAccountUsageRecordId: snapshot.recordId,
            bindingKind: "group_member",
            groupId: "left",
            groupGeneration: 0,
        });

        const deletedGroup = await app.inject({
            method: "DELETE",
            url: "/v3/connect/openai-codex/groups/right",
            headers: { "x-test-user-id": user.id },
        });
        expect(deletedGroup.statusCode).toBe(200);
        expect(await db.connectedServiceUsageSource.findMany({
            where: { accountId: user.id },
            select: { groupId: true, groupGeneration: true },
        })).toEqual([{ groupId: "left", groupGeneration: 0 }]);
        expect(await db.providerAccountUsageRecord.count({ where: { accountId: user.id } })).toBe(1);
    });

    it("deletes an active setup-token-like member at high generation and returns a valid envelope", async () => {
        const user = await createAccount("pk-groups-delete-setup-token-member");
        const profileId = "leeroy_new_setuptoken";
        await createConnectedProfile(user.id, "claude-subscription", profileId);
        const app = await createReadyApp();

        expect((await app.inject({
            method: "POST",
            url: "/v3/connect/claude-subscription/groups",
            headers: authHeaders(user.id),
            payload: {
                groupId: "claude",
                members: [{ profileId }],
                activeProfileId: profileId,
            },
        })).statusCode).toBe(200);
        await db.connectedServiceAuthGroup.update({
            where: {
                accountId_vendor_groupId: {
                    accountId: user.id,
                    vendor: "claude-subscription",
                    groupId: "claude",
                },
            },
            data: { generation: 51 },
        });

        const removed = await app.inject({
            method: "DELETE",
            url: `/v3/connect/claude-subscription/groups/claude/members/${profileId}?expectedGeneration=51`,
            headers: { "x-test-user-id": user.id },
        });

        expect(removed.statusCode).toBe(200);
        expect(ConnectedServiceAuthGroupResponseV1Schema.safeParse(removed.json()).success).toBe(true);
        expect(removed.json()).toEqual({
            group: expect.objectContaining({
                serviceId: "claude-subscription",
                groupId: "claude",
                activeProfileId: null,
                generation: 52,
                members: [],
            }),
        });
    });

    it("defaults member additions and active-member removals to an enabled member", async () => {
        const user = await createAccount("pk-groups-active-profile-member-defaults");
        await createConnectedProfile(user.id, "openai-codex", "work");
        await createConnectedProfile(user.id, "openai-codex", "backup");
        const app = await createReadyApp();

        const created = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload: {
                groupId: "codex-main",
                members: [],
                activeProfileId: null,
            },
        });
        expect(created.statusCode).toBe(200);
        expect(created.json()).toEqual({
            group: expect.objectContaining({
                activeProfileId: null,
                generation: 0,
                members: [],
            }),
        });

        const addedBackup = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups/codex-main/members",
            headers: authHeaders(user.id),
            payload: { profileId: "backup", priority: 20, expectedGeneration: 0 },
        });
        expect(addedBackup.statusCode).toBe(200);
        expect(addedBackup.json()).toEqual({
            group: expect.objectContaining({
                activeProfileId: "backup",
                generation: 1,
            }),
        });

        const addedWork = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups/codex-main/members",
            headers: authHeaders(user.id),
            payload: { profileId: "work", priority: 10, expectedGeneration: 1 },
        });
        expect(addedWork.statusCode).toBe(200);
        expect(addedWork.json()).toEqual({
            group: expect.objectContaining({
                activeProfileId: "backup",
                generation: 2,
            }),
        });

        const removedActive = await app.inject({
            method: "DELETE",
            url: "/v3/connect/openai-codex/groups/codex-main/members/backup?expectedGeneration=2",
            headers: { "x-test-user-id": user.id },
        });
        expect(removedActive.statusCode).toBe(200);
        expect(removedActive.json()).toEqual({
            group: expect.objectContaining({
                activeProfileId: "work",
                generation: 3,
                members: [expect.objectContaining({ profileId: "work", enabled: true })],
            }),
        });
    });

    it("requires expectedGeneration for member create, update, and delete without bumping rejected mutations", async () => {
        const user = await createAccount("pk-groups-member-generation-required");
        await createConnectedProfile(user.id, "openai-codex", "work");
        await createConnectedProfile(user.id, "openai-codex", "backup");
        const app = await createReadyApp();

        expect((await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload: {
                groupId: "codex-main",
                members: [{ profileId: "work" }],
                activeProfileId: "work",
            },
        })).statusCode).toBe(200);

        const omittedCreate = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups/codex-main/members",
            headers: authHeaders(user.id),
            payload: { profileId: "backup", priority: 75 },
        });
        expect(omittedCreate.statusCode).toBe(400);
        expect(omittedCreate.json()).toEqual({ error: "connect_group_generation_required" });

        const staleCreate = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups/codex-main/members",
            headers: authHeaders(user.id),
            payload: { profileId: "backup", priority: 75, expectedGeneration: 9 },
        });
        expect(staleCreate.statusCode).toBe(409);
        expect(staleCreate.json()).toEqual({ error: "connect_group_generation_conflict", generation: 0 });

        const afterRejectedCreate = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/groups/codex-main",
            headers: { "x-test-user-id": user.id },
        });
        expect(afterRejectedCreate.json().group).toMatchObject({
            generation: 0,
            members: [expect.objectContaining({ profileId: "work" })],
        });

        const added = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups/codex-main/members",
            headers: authHeaders(user.id),
            payload: { profileId: "backup", priority: 75, expectedGeneration: 0 },
        });
        expect(added.statusCode).toBe(200);
        expect(added.json().group).toMatchObject({ generation: 1 });

        const omittedPatch = await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/codex-main/members/backup",
            headers: authHeaders(user.id),
            payload: { enabled: false },
        });
        expect(omittedPatch.statusCode).toBe(400);
        expect(omittedPatch.json()).toEqual({ error: "connect_group_generation_required" });

        const stalePatch = await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/codex-main/members/backup",
            headers: authHeaders(user.id),
            payload: { enabled: false, expectedGeneration: 0 },
        });
        expect(stalePatch.statusCode).toBe(409);
        expect(stalePatch.json()).toEqual({ error: "connect_group_generation_conflict", generation: 1 });

        const afterRejectedPatch = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/groups/codex-main",
            headers: { "x-test-user-id": user.id },
        });
        expect(afterRejectedPatch.json().group).toMatchObject({
            generation: 1,
            members: expect.arrayContaining([
                expect.objectContaining({ profileId: "backup", enabled: true }),
            ]),
        });

        const patched = await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/codex-main/members/backup",
            headers: authHeaders(user.id),
            payload: { enabled: false, expectedGeneration: 1 },
        });
        expect(patched.statusCode).toBe(200);
        expect(patched.json().group).toMatchObject({ generation: 2 });

        const omittedDelete = await app.inject({
            method: "DELETE",
            url: "/v3/connect/openai-codex/groups/codex-main/members/backup",
            headers: { "x-test-user-id": user.id },
        });
        expect(omittedDelete.statusCode).toBe(400);
        expect(omittedDelete.json()).toEqual({ error: "connect_group_generation_required" });

        const staleDelete = await app.inject({
            method: "DELETE",
            url: "/v3/connect/openai-codex/groups/codex-main/members/backup?expectedGeneration=1",
            headers: { "x-test-user-id": user.id },
        });
        expect(staleDelete.statusCode).toBe(409);
        expect(staleDelete.json()).toEqual({ error: "connect_group_generation_conflict", generation: 2 });

        const afterRejectedDelete = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/groups/codex-main",
            headers: { "x-test-user-id": user.id },
        });
        expect(afterRejectedDelete.json().group).toMatchObject({
            generation: 2,
            members: expect.arrayContaining([
                expect.objectContaining({ profileId: "backup" }),
            ]),
        });

        const deleted = await app.inject({
            method: "DELETE",
            url: "/v3/connect/openai-codex/groups/codex-main/members/backup?expectedGeneration=2",
            headers: { "x-test-user-id": user.id },
        });
        expect(deleted.statusCode).toBe(200);
        expect(deleted.json().group).toMatchObject({
            generation: 3,
            members: [expect.objectContaining({ profileId: "work" })],
        });
    });

    it("falls back from disabled active profiles and blocks patch or switch routes from reselecting them", async () => {
        const user = await createAccount("pk-groups-disabled-active-retain");
        await createConnectedProfile(user.id, "openai-codex", "work");
        await createConnectedProfile(user.id, "openai-codex", "backup");
        const app = await createReadyApp();

        expect((await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload: {
                groupId: "codex-main",
                members: [{ profileId: "work" }, { profileId: "backup" }],
                activeProfileId: "backup",
            },
        })).statusCode).toBe(200);

        const disabled = await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/codex-main/members/backup",
            headers: authHeaders(user.id),
            payload: { enabled: false, expectedGeneration: 0 },
        });

        expect(disabled.statusCode).toBe(200);
        expect(disabled.json()).toEqual({
            group: expect.objectContaining({
                activeProfileId: "work",
                generation: 1,
                members: expect.arrayContaining([
                    expect.objectContaining({ profileId: "backup", enabled: false }),
                ]),
            }),
        });

        const patchRes = await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/codex-main",
            headers: authHeaders(user.id),
            payload: { activeProfileId: "backup", expectedGeneration: 1 },
        });
        expect(patchRes.statusCode).toBe(400);
        expect(patchRes.json()).toEqual({ error: "connect_group_active_profile_not_member" });

        const switchRes = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups/codex-main/active-profile",
            headers: authHeaders(user.id),
            payload: { profileId: "backup", expectedGeneration: 1 },
        });
        expect(switchRes.statusCode).toBe(400);
        expect(switchRes.json()).toEqual({ error: "connect_group_active_profile_not_member" });
    });

    it("prevents deleting a credential while it is referenced by any group member", async () => {
        const user = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        await createConnectedProfile(user.id, "openai-codex", "work");
        const app = await createReadyApp();

        expect((await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload: { groupId: "codex-main", members: [{ profileId: "work" }], activeProfileId: "work" },
        })).statusCode).toBe(200);

        expect((await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/codex-main/members/work",
            headers: authHeaders(user.id),
            payload: { enabled: false, expectedGeneration: 0 },
        })).statusCode).toBe(200);

        const res = await app.inject({
            method: "DELETE",
            url: "/v3/connect/openai-codex/profiles/work/credential",
            headers: { "x-test-user-id": user.id },
        });

        expect(res.statusCode).toBe(409);
        expect(res.json()).toEqual({ error: "connect_credential_referenced_by_group" });

        const v2Res = await app.inject({
            method: "DELETE",
            url: "/v2/connect/openai-codex/profiles/work/credential",
            headers: { "x-test-user-id": user.id },
        });
        expect(v2Res.statusCode).toBe(409);
        expect(v2Res.json()).toEqual({ error: "connect_credential_referenced_by_group" });

        const wrongModeCleanup = await app.inject({
            method: "DELETE",
            url: "/v2/connect/openai-codex/profiles/work/credential?cleanupGroupReferences=true",
            headers: { "x-test-user-id": user.id },
        });
        expect(wrongModeCleanup.statusCode).toBe(400);
        expect(wrongModeCleanup.json()).toEqual({ error: "connect_credential_invalid" });
    });

    it("allows explicit v3 credential cleanup to remove group references and bump affected groups", async () => {
        const user = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        await createConnectedProfile(user.id, "openai-codex", "work");
        await createConnectedProfile(user.id, "openai-codex", "backup");
        const app = await createReadyApp();

        expect((await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload: {
                groupId: "codex-main",
                members: [{ profileId: "work" }, { profileId: "backup" }],
                activeProfileId: "work",
            },
        })).statusCode).toBe(200);
        expect((await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload: {
                groupId: "codex-secondary",
                members: [{ profileId: "work" }, { profileId: "backup" }],
                activeProfileId: "backup",
            },
        })).statusCode).toBe(200);
        const beforeCursor = await readAccountChangeCursor(user.id);

        const res = await app.inject({
            method: "DELETE",
            url: "/v3/connect/openai-codex/profiles/work/credential?cleanupGroupReferences=true",
            headers: { "x-test-user-id": user.id },
        });

        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ success: true });
        const afterCursor = await readAccountChangeCursor(user.id);
        expect(afterCursor).toBeGreaterThan(beforeCursor ?? -1);

        const main = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/groups/codex-main",
            headers: { "x-test-user-id": user.id },
        });
        expect(main.statusCode).toBe(200);
        expect(main.json().group).toMatchObject({
            activeProfileId: "backup",
            generation: 1,
            members: [expect.objectContaining({ profileId: "backup" })],
        });

        const secondary = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/groups/codex-secondary",
            headers: { "x-test-user-id": user.id },
        });
        expect(secondary.statusCode).toBe(200);
        expect(secondary.json().group).toMatchObject({
            activeProfileId: "backup",
            generation: 1,
            members: [expect.objectContaining({ profileId: "backup" })],
        });

        const credential = await db.serviceAccountToken.findUnique({
            where: { accountId_vendor_profileId: { accountId: user.id, vendor: "openai-codex", profileId: "work" } },
            select: { id: true },
        });
        expect(credential).toBeNull();
    });

    it("allows explicit v2 credential cleanup to remove group references", async () => {
        const user = await db.account.create({
            data: { publicKey: "pk-groups-v2-cleanup", encryptionMode: "e2ee" },
            select: { id: true },
        });
        await createConnectedProfile(user.id, "openai-codex", "work");
        const app = await createReadyApp();

        expect((await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload: {
                groupId: "codex-main",
                members: [{ profileId: "work" }],
                activeProfileId: "work",
            },
        })).statusCode).toBe(200);

        const res = await app.inject({
            method: "DELETE",
            url: "/v2/connect/openai-codex/profiles/work/credential?cleanupGroupReferences=true",
            headers: { "x-test-user-id": user.id },
        });

        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ success: true });

        const group = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/groups/codex-main",
            headers: { "x-test-user-id": user.id },
        });
        expect(group.statusCode).toBe(200);
        expect(group.json().group).toMatchObject({
            activeProfileId: null,
            generation: 1,
            members: [],
        });
    });

    it("gates active profile switching on the account-fallback feature", async () => {
        const user = await createAccount("pk-groups-active-profile-fallback-gate");
        await createConnectedProfile(user.id, "openai-codex", "work");
        await createConnectedProfile(user.id, "openai-codex", "backup");
        const app = await createReadyApp();

        expect((await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload: {
                groupId: "codex-main",
                members: [{ profileId: "work" }, { profileId: "backup" }],
                activeProfileId: "work",
            },
        })).statusCode).toBe(200);

        harness.resetEnv({ HAPPIER_FEATURE_CONNECTED_SERVICES_ACCOUNT_FALLBACK__ENABLED: "0" });
        const res = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups/codex-main/active-profile",
            headers: authHeaders(user.id),
            payload: { profileId: "backup", expectedGeneration: 0 },
        });

        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: "connect_group_fallback_disabled" });
        await expect(readStoredAuthGroupActiveState({
            accountId: user.id,
            serviceId: "openai-codex",
            groupId: "codex-main",
        })).resolves.toEqual({ activeProfileId: "work", generation: 0 });

        const patchRes = await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/codex-main",
            headers: authHeaders(user.id),
            payload: { activeProfileId: "backup" },
        });

        expect(patchRes.statusCode).toBe(400);
        expect(patchRes.json()).toEqual({ error: "connect_group_fallback_disabled" });
    });

    it("preserves stored groups when the feature gate is rolled back", async () => {
        const user = await createAccount("pk-groups-forward-only");
        await createConnectedProfile(user.id, "openai-codex", "work");
        const app = await createReadyApp();

        expect((await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload: { groupId: "codex-main", members: [{ profileId: "work" }], activeProfileId: "work" },
        })).statusCode).toBe(200);

        harness.resetEnv({ HAPPIER_FEATURE_CONNECTED_SERVICES_ACCOUNT_GROUPS__ENABLED: "0" });
        const disabled = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/groups/codex-main",
            headers: { "x-test-user-id": user.id },
        });
        expect(disabled.statusCode).toBe(404);
        expect(disabled.json()).toEqual({ error: "not_found" });

        harness.resetEnv();
        const restored = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/groups/codex-main",
            headers: { "x-test-user-id": user.id },
        });
        expect(restored.statusCode).toBe(200);
        expect(restored.json()).toEqual({
            group: expect.objectContaining({ groupId: "codex-main", activeProfileId: "work" }),
        });
    });

    it("allows the mode-correct stable v2 credential delete API to clean hidden group references after account-groups rollback", async () => {
        const user = await db.account.create({
            data: { publicKey: "pk-groups-v2-rollback-cleanup", encryptionMode: "e2ee" },
            select: { id: true },
        });
        await createConnectedProfile(user.id, "openai-codex", "work");
        await createConnectedProfile(user.id, "openai-codex", "backup");
        const app = await createReadyApp();

        expect((await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload: {
                groupId: "codex-main",
                members: [{ profileId: "work" }, { profileId: "backup" }],
                activeProfileId: "work",
            },
        })).statusCode).toBe(200);
        expect((await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload: {
                groupId: "codex-secondary",
                members: [{ profileId: "backup" }, { profileId: "work" }],
                activeProfileId: "backup",
            },
        })).statusCode).toBe(200);

        harness.resetEnv({ HAPPIER_FEATURE_CONNECTED_SERVICES_ACCOUNT_GROUPS__ENABLED: "0" });

        const firstV2Delete = await app.inject({
            method: "DELETE",
            url: "/v2/connect/openai-codex/profiles/work/credential",
            headers: { "x-test-user-id": user.id },
        });

        expect(firstV2Delete.statusCode).toBe(200);
        expect(firstV2Delete.json()).toEqual({ success: true });

        expect(await db.connectedServiceAuthGroup.findUnique({
            where: {
                accountId_vendor_groupId: {
                    accountId: user.id,
                    vendor: "openai-codex",
                    groupId: "codex-main",
                },
            },
            select: { activeProfileId: true, generation: true },
        })).toEqual({ activeProfileId: "backup", generation: 1 });
        expect(await db.connectedServiceAuthGroup.findUnique({
            where: {
                accountId_vendor_groupId: {
                    accountId: user.id,
                    vendor: "openai-codex",
                    groupId: "codex-secondary",
                },
            },
            select: { activeProfileId: true, generation: true },
        })).toEqual({ activeProfileId: "backup", generation: 1 });

        const v2Delete = await app.inject({
            method: "DELETE",
            url: "/v2/connect/openai-codex/profiles/backup/credential",
            headers: { "x-test-user-id": user.id },
        });

        expect(v2Delete.statusCode).toBe(200);
        expect(v2Delete.json()).toEqual({ success: true });

        expect(await db.serviceAccountToken.findMany({
            where: { accountId: user.id, vendor: "openai-codex" },
            select: { profileId: true },
            orderBy: { profileId: "asc" },
        })).toEqual([]);

        expect(await db.connectedServiceAuthGroup.findUnique({
            where: {
                accountId_vendor_groupId: {
                    accountId: user.id,
                    vendor: "openai-codex",
                    groupId: "codex-main",
                },
            },
            select: { activeProfileId: true, generation: true },
        })).toEqual({ activeProfileId: null, generation: 2 });
        expect(await db.connectedServiceAuthGroup.findUnique({
            where: {
                accountId_vendor_groupId: {
                    accountId: user.id,
                    vendor: "openai-codex",
                    groupId: "codex-secondary",
                },
            },
            select: { activeProfileId: true, generation: true },
        })).toEqual({ activeProfileId: null, generation: 2 });

        expect(await db.connectedServiceAuthGroupMember.findMany({
            where: { accountId: user.id, vendor: "openai-codex", groupId: "codex-main" },
            select: { profileId: true },
        })).toEqual([]);
        expect(await db.connectedServiceAuthGroupMember.findMany({
            where: { accountId: user.id, vendor: "openai-codex", groupId: "codex-secondary" },
            select: { profileId: true },
        })).toEqual([]);
    });

    it("cascades auth-group members when a referenced credential row is deleted directly", async () => {
        const user = await createAccount("pk-groups-db-cascade");
        await createConnectedProfile(user.id, "openai-codex", "work");
        const app = await createReadyApp();

        expect((await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload: {
                groupId: "codex-main",
                members: [{ profileId: "work" }],
                activeProfileId: "work",
            },
        })).statusCode).toBe(200);

        await db.serviceAccountToken.delete({
            where: {
                accountId_vendor_profileId: {
                    accountId: user.id,
                    vendor: "openai-codex",
                    profileId: "work",
                },
            },
        });

        expect(await db.connectedServiceAuthGroupMember.findMany({
            where: { accountId: user.id, vendor: "openai-codex", groupId: "codex-main" },
            select: { profileId: true },
        })).toEqual([]);
    });

    it("gates automatic fallback policy fields on the account-fallback feature", async () => {
        harness.resetEnv({ HAPPIER_FEATURE_CONNECTED_SERVICES_ACCOUNT_FALLBACK__ENABLED: "0" });
        const user = await createAccount("pk-groups-fallback-gate");
        await createConnectedProfile(user.id, "openai-codex", "work");
        const app = await createReadyApp();

        const res = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload: {
                groupId: "codex-main",
                members: [{ profileId: "work" }],
                activeProfileId: "work",
                policy: { autoSwitch: true },
            },
        });

        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: "connect_group_fallback_disabled" });
    });

    it("accepts automatic fallback policy when account fallback dependencies are enabled", async () => {
        const user = await createAccount("pk-groups-fallback-enabled");
        await createConnectedProfile(user.id, "openai-codex", "work");
        const app = await createReadyApp();

        const res = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload: {
                groupId: "codex-main",
                members: [{ profileId: "work" }],
                activeProfileId: "work",
                policy: { autoSwitch: true },
            },
        });

        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({
            group: expect.objectContaining({
                policy: expect.objectContaining({ autoSwitch: true }),
            }),
        });
    });

    it("defaults autoSwitch to true at create when the account-fallback feature is enabled", async () => {
        const user = await createAccount("pk-groups-autoswitch-default-on");
        await createConnectedProfile(user.id, "openai-codex", "work");
        const app = await createReadyApp();

        const res = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload: {
                groupId: "codex-main",
                members: [{ profileId: "work" }],
                activeProfileId: "work",
            },
        });

        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({
            group: expect.objectContaining({
                policy: expect.objectContaining({ autoSwitch: true }),
            }),
        });
    });

    it("keeps autoSwitch false at create when the account-fallback feature is disabled (fail-closed, no 400)", async () => {
        harness.resetEnv({ HAPPIER_FEATURE_CONNECTED_SERVICES_ACCOUNT_FALLBACK__ENABLED: "0" });
        const user = await createAccount("pk-groups-autoswitch-default-off");
        await createConnectedProfile(user.id, "openai-codex", "work");
        const app = await createReadyApp();

        const res = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload: {
                groupId: "codex-main",
                members: [{ profileId: "work" }],
                activeProfileId: "work",
            },
        });

        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({
            group: expect.objectContaining({
                policy: expect.objectContaining({ autoSwitch: false }),
            }),
        });
    });

    it("fails closed when no runtime supports connected-service fallback for the service", async () => {
        const user = await createAccount("pk-groups-runtime-fallback-unsupported-create");
        await createConnectedProfile(user.id, "github", "work");
        const app = await createReadyApp();

        const create = await app.inject({
            method: "POST",
            url: "/v3/connect/github/groups",
            headers: authHeaders(user.id),
            payload: {
                groupId: "github-main",
                members: [{ profileId: "work" }],
                activeProfileId: "work",
            },
        });

        expect(create.statusCode).toBe(400);
        expect(create.json()).toEqual({ error: "connect_group_runtime_fallback_unsupported" });
    });

    it("rejects active-profile and fallback-policy mutations for services without runtime fallback support", async () => {
        const user = await createAccount("pk-groups-runtime-fallback-unsupported-mutations");
        await createConnectedProfile(user.id, "github", "work");
        await createConnectedProfile(user.id, "github", "backup");
        await seedAuthGroup({
            accountId: user.id,
            serviceId: "github",
            groupId: "github-main",
            memberProfileIds: ["work", "backup"],
            activeProfileId: "work",
        });
        const app = await createReadyApp();

        const patch = await app.inject({
            method: "PATCH",
            url: "/v3/connect/github/groups/github-main",
            headers: authHeaders(user.id),
            payload: {
                activeProfileId: "backup",
                expectedGeneration: 0,
            },
        });

        expect(patch.statusCode).toBe(400);
        expect(patch.json()).toEqual({ error: "connect_group_runtime_fallback_unsupported" });

        const post = await app.inject({
            method: "POST",
            url: "/v3/connect/github/groups/github-main/active-profile",
            headers: authHeaders(user.id),
            payload: { profileId: "backup", expectedGeneration: 0 },
        });

        expect(post.statusCode).toBe(400);
        expect(post.json()).toEqual({ error: "connect_group_runtime_fallback_unsupported" });
    });

    it("roundtrips quota-aware auth-group policy fields through PATCH", async () => {
        const user = await createAccount("pk-groups-policy-roundtrip");
        await createConnectedProfile(user.id, "openai-codex", "work");
        const app = await createReadyApp();

        expect((await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload: {
                groupId: "codex-main",
                members: [{ profileId: "work" }],
                activeProfileId: "work",
            },
        })).statusCode).toBe(200);

        const patched = await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/codex-main",
            headers: authHeaders(user.id),
            payload: {
                policy: {
                    softSwitchRemainingPercent: 9,
                    probeIfSnapshotOlderThanMs: 120_000,
                    preTurnProbeMode: "always_for_group",
                    preTurnProbeOrder: "candidates_first_then_current",
                    recoveryMode: "wait_until_reset",
                    resumePromptMode: "standard",
                },
                expectedGeneration: 0,
            },
        });

        expect(patched.statusCode).toBe(200);
        expect(patched.json()).toEqual({
            group: expect.objectContaining({
                policy: expect.objectContaining({
                    softSwitchRemainingPercent: 9,
                    probeIfSnapshotOlderThanMs: 120_000,
                    preTurnProbeMode: "always_for_group",
                    preTurnProbeOrder: "candidates_first_then_current",
                    recoveryMode: "wait_until_reset",
                    resumePromptMode: "standard",
                }),
            }),
        });
        expect(patched.json().group.policy).not.toHaveProperty("recoveryPromptMode");
        expect(patched.json().group.policy).not.toHaveProperty("effectiveMeterStrategy");
        expect(patched.json().group.policy).not.toHaveProperty("memberRuntimeStatePersistence");

        const fetched = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/groups/codex-main",
            headers: { "x-test-user-id": user.id },
        });

        expect(fetched.statusCode).toBe(200);
        expect(fetched.json().group.policy.preTurnProbeMode).toBe("always_for_group");
        expect(fetched.json().group.policy).not.toHaveProperty("effectiveMeterStrategy");
    });

    it("rejects removed unreleased auth-group policy keys", async () => {
        const user = await createAccount("pk-groups-policy-removed-keys");
        await createConnectedProfile(user.id, "openai-codex", "work");
        const app = await createReadyApp();

        const res = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload: {
                groupId: "codex-main",
                members: [{ profileId: "work" }],
                policy: {
                    recoveryPromptMode: "standard",
                    effectiveMeterStrategy: "weekly",
                    memberRuntimeStatePersistence: "server_state_json",
                },
            },
        });

        expect(res.statusCode).toBe(400);
    });

    it("rejects malformed request policy", async () => {
        const user = await createAccount("pk-groups-policy-reject");
        await createConnectedProfile(user.id, "openai-codex", "work");
        const app = await createReadyApp();

        const res = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload: {
                groupId: "codex-main",
                members: [{ profileId: "work" }],
                policy: { strategy: "round_robin" },
            },
        });

        expect(res.statusCode).toBe(400);
    });

    it("falls back to the fail-closed default when stored policy is malformed", async () => {
        const user = await createAccount("pk-groups-policy-fallback");
        await createConnectedProfile(user.id, "openai-codex", "work");
        const app = await createReadyApp();

        const created = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload: { groupId: "codex-main", members: [{ profileId: "work" }], activeProfileId: "work" },
        });
        expect(created.statusCode).toBe(200);

        await db.connectedServiceAuthGroup.update({
            where: { accountId_vendor_groupId: { accountId: user.id, vendor: "openai-codex", groupId: "codex-main" } },
            data: { policyJson: "{malformed" },
        });

        const res = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/groups/codex-main",
            headers: { "x-test-user-id": user.id },
        });

        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({
            group: expect.objectContaining({
                policy: expect.objectContaining({
                    v: 1,
                    strategy: "least_limited",
                    autoSwitch: false,
                    recoveryMode: "switch_or_wait",
                }),
            }),
        });
    });

    it("roundtrips persisted auth-group runtime state from stateJson", async () => {
        const user = await createAccount("pk-groups-state-json");
        await createConnectedProfile(user.id, "openai-codex", "work");
        const app = await createReadyApp();

        expect((await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload: { groupId: "codex-main", members: [{ profileId: "work" }], activeProfileId: "work" },
        })).statusCode).toBe(200);

        await db.connectedServiceAuthGroup.update({
            where: { accountId_vendor_groupId: { accountId: user.id, vendor: "openai-codex", groupId: "codex-main" } },
            data: { stateJson: JSON.stringify({ status: "exhausted", lastSwitchReason: "usage_limit" }) },
        });
        await db.connectedServiceAuthGroupMember.update({
            where: {
                accountId_vendor_groupId_profileId: {
                    accountId: user.id,
                    vendor: "openai-codex",
                    groupId: "codex-main",
                    profileId: "work",
                },
            },
            data: {
                stateJson: JSON.stringify({
                    quotaExhaustedUntilMs: 10,
                    rateLimitedUntilMs: 20,
                    capacityLimitedUntilMs: 30,
                    authInvalidUntilMs: 40,
                    lastFailureKind: "usage_limit",
                    lastFailureCode: "usage_limit_reached",
                    lastObservedPlanType: "team",
                    lastObservedAtMs: 50,
                }),
            },
        });

        const res = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/groups/codex-main",
            headers: { "x-test-user-id": user.id },
        });

        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({
            group: expect.objectContaining({
                state: expect.objectContaining({ status: "exhausted", lastSwitchReason: "usage_limit" }),
                members: [
                    expect.objectContaining({
                        profileId: "work",
                        state: {
                            quotaExhaustedUntilMs: 10,
                            rateLimitedUntilMs: 20,
                            capacityLimitedUntilMs: 30,
                            authInvalidUntilMs: 40,
                            lastFailureKind: "usage_limit",
                            lastFailureCode: "usage_limit_reached",
                            lastObservedPlanType: "team",
                            lastObservedAtMs: 50,
                        },
                    }),
                ],
            }),
        });
    });

    it("updates group and member runtime state with generation guard", async () => {
        const user = await createAccount("pk-groups-runtime-state-update");
        await createConnectedProfile(user.id, "openai-codex", "work");
        const app = await createReadyApp();

        expect((await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload: { groupId: "codex-main", members: [{ profileId: "work" }], activeProfileId: "work" },
        })).statusCode).toBe(200);

        const updated = await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/codex-main/runtime-state",
            headers: authHeaders(user.id),
            payload: {
                expectedGeneration: 0,
                expectedRuntimeStateRevision: 0,
                state: {
                    status: "exhausted",
                    lastSwitchReason: "usage_limit",
                },
                memberStates: [
                    {
                        profileId: "work",
                        state: {
                            quotaExhaustedUntilMs: 10,
                            rateLimitedUntilMs: 20,
                            capacityLimitedUntilMs: 30,
                            authInvalidUntilMs: 40,
                            lastFailureKind: "usage_limit",
                            lastFailureCode: "usage_limit_reached",
                            lastObservedPlanType: "team",
                            lastObservedAtMs: 50,
                        },
                    },
                ],
            },
        });

        expect(updated.statusCode).toBe(200);
        expect(updated.json()).toEqual({
            group: expect.objectContaining({
                generation: 0,
                runtimeStateRevision: 1,
                state: expect.objectContaining({ status: "exhausted", lastSwitchReason: "usage_limit" }),
                members: [
                    expect.objectContaining({
                        profileId: "work",
                        state: {
                            quotaExhaustedUntilMs: 10,
                            rateLimitedUntilMs: 20,
                            capacityLimitedUntilMs: 30,
                            authInvalidUntilMs: 40,
                            lastFailureKind: "usage_limit",
                            lastFailureCode: "usage_limit_reached",
                            lastObservedPlanType: "team",
                            lastObservedAtMs: 50,
                        },
                    }),
                ],
            }),
        });
    });

    it("rejects a second same-generation runtime writer with a stale runtime-state revision", async () => {
        const user = await createAccount("pk-groups-runtime-state-revision-conflict");
        await createConnectedProfile(user.id, "openai-codex", "work");
        const app = await createReadyApp();
        const created = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload: { groupId: "codex-main", members: [{ profileId: "work" }], activeProfileId: "work" },
        });
        expect(created.statusCode).toBe(200);
        expect(created.json().group.runtimeStateRevision).toBe(0);

        const first = await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/codex-main/runtime-state",
            headers: authHeaders(user.id),
            payload: {
                expectedGeneration: 0,
                expectedRuntimeStateRevision: 0,
                memberStates: [{ profileId: "work", state: { quotaExhaustedUntilMs: 10 } }],
            },
        });
        expect(first.statusCode).toBe(200);
        expect(first.json().group.runtimeStateRevision).toBe(1);

        const stale = await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/codex-main/runtime-state",
            headers: authHeaders(user.id),
            payload: {
                expectedGeneration: 0,
                expectedRuntimeStateRevision: 0,
                memberStates: [{ profileId: "work", state: { authInvalidUntilMs: 20 } }],
            },
        });
        expect(stale.statusCode).toBe(409);
        expect(stale.json()).toEqual({
            error: "connect_group_runtime_state_revision_conflict",
            runtimeStateRevision: 1,
        });
        const fetched = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/groups/codex-main",
            headers: authHeaders(user.id),
        });
        expect(fetched.json().group.members).toEqual(expect.arrayContaining([
            expect.objectContaining({
                profileId: "work",
                state: { quotaExhaustedUntilMs: 10 },
            }),
        ]));
    });

    it("rejects changed runtime state updates that omit expectedGeneration", async () => {
        const user = await createAccount("pk-groups-runtime-state-generation-optional");
        await createConnectedProfile(user.id, "openai-codex", "work");
        const app = await createReadyApp();

        expect((await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload: { groupId: "codex-main", members: [{ profileId: "work" }], activeProfileId: "work" },
        })).statusCode).toBe(200);

        const updated = await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/codex-main/runtime-state",
            headers: authHeaders(user.id),
            payload: {
                state: {
                    status: "exhausted",
                    lastSwitchReason: "usage_limit",
                },
                memberStates: [
                    {
                        profileId: "work",
                        state: { quotaExhaustedUntilMs: 10 },
                    },
                ],
            },
        });

        expect(updated.statusCode).toBe(400);
        expect(updated.json()).toEqual({ error: "connect_group_generation_required" });

        const missingRuntimeRevision = await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/codex-main/runtime-state",
            headers: authHeaders(user.id),
            payload: {
                expectedGeneration: 0,
                memberStates: [{
                    profileId: "work",
                    state: { quotaExhaustedUntilMs: 10 },
                }],
            },
        });
        expect(missingRuntimeRevision.statusCode).toBe(400);
        expect(missingRuntimeRevision.json()).toEqual({
            error: "connect_group_runtime_state_revision_required",
        });

        const fetched = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/groups/codex-main",
            headers: authHeaders(user.id),
        });
        expect(fetched.statusCode).toBe(200);
        expect(fetched.json().group.generation).toBe(0);
        expect(fetched.json().group.state).toEqual({});
        expect(fetched.json().group.members).toEqual(expect.arrayContaining([
            expect.objectContaining({ profileId: "work", state: {} }),
        ]));
    });

    it("broadcasts active member limiter clears once and treats repeat clears as idempotent", async () => {
        const user = await createAccount("pk-groups-runtime-state-limiter-clear-broadcast");
        await createConnectedProfile(user.id, "openai-codex", "work");
        const app = await createReadyApp();
        const resetAtMs = Date.now() + 60_000;

        expect((await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload: { groupId: "codex-main", members: [{ profileId: "work" }], activeProfileId: "work" },
        })).statusCode).toBe(200);
        expect((await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/codex-main/runtime-state",
            headers: authHeaders(user.id),
            payload: {
                expectedGeneration: 0,
                expectedRuntimeStateRevision: 0,
                memberStates: [
                    {
                        profileId: "work",
                        state: {
                            quotaExhaustedUntilMs: resetAtMs,
                            lastFailureKind: "usage_limit",
                            lastFailureCode: "usage_limit_reached",
                        },
                    },
                ],
            },
        })).statusCode).toBe(200);
        const blockerCursor = await readAccountChangeCursor(user.id);
        expect(blockerCursor).toEqual(expect.any(Number));
        emitUpdate.mockClear();

        const clearPayload = {
            expectedGeneration: 0,
            expectedRuntimeStateRevision: 1,
            memberStates: [
                {
                    profileId: "work",
                    state: {
                        quotaExhaustedUntilMs: null,
                        rateLimitedUntilMs: null,
                        capacityLimitedUntilMs: null,
                        authInvalidUntilMs: null,
                        lastFailureKind: null,
                        lastFailureCode: null,
                        lastObservedAtMs: resetAtMs + 1,
                    },
                },
            ],
        };

        const cleared = await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/codex-main/runtime-state",
            headers: authHeaders(user.id),
            payload: clearPayload,
        });

        expect(cleared.statusCode).toBe(200);
        expect(cleared.json().group).toEqual(expect.objectContaining({
            generation: 0,
            activeProfileId: "work",
        }));
        expect(cleared.json().group.members).toEqual(expect.arrayContaining([
            expect.objectContaining({
                profileId: "work",
                state: expect.objectContaining({
                    quotaExhaustedUntilMs: null,
                    rateLimitedUntilMs: null,
                    capacityLimitedUntilMs: null,
                    authInvalidUntilMs: null,
                    lastFailureKind: null,
                    lastFailureCode: null,
                    lastObservedAtMs: resetAtMs + 1,
                }),
            }),
        ]));

        const clearCursor = await readAccountChangeCursor(user.id);
        expect(clearCursor).toBeGreaterThan(blockerCursor ?? -1);
        expect(emitUpdate).toHaveBeenCalledTimes(2);
        expect(emitUpdate).toHaveBeenCalledWith(expect.objectContaining({
            userId: user.id,
            recipientFilter: { type: "user-machine-scoped-only" },
        }));
        expectLastProjectedGroup({
            accountId: user.id,
            group: {
                groupId: "codex-main",
                displayName: null,
                activeProfileId: "work",
                generation: 0,
                memberProfileIds: ["work"],
            },
        });

        emitUpdate.mockClear();
        const repeated = await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/codex-main/runtime-state",
            headers: authHeaders(user.id),
            payload: clearPayload,
        });

        expect(repeated.statusCode).toBe(200);
        expect(await readAccountChangeCursor(user.id)).toBe(clearCursor);
        expect(emitUpdate).not.toHaveBeenCalled();
    });

    it("rejects stale runtime state updates without overwriting group or member state", async () => {
        const user = await createAccount("pk-groups-runtime-state-conflict");
        await createConnectedProfile(user.id, "openai-codex", "work");
        await createConnectedProfile(user.id, "openai-codex", "backup");
        const app = await createReadyApp();

        expect((await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload: {
                groupId: "codex-main",
                members: [{ profileId: "work" }, { profileId: "backup" }],
                activeProfileId: "work",
            },
        })).statusCode).toBe(200);
        expect((await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups/codex-main/active-profile",
            headers: authHeaders(user.id),
            payload: { profileId: "backup", expectedGeneration: 0 },
        })).statusCode).toBe(200);

        const stale = await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/codex-main/runtime-state",
            headers: authHeaders(user.id),
            payload: {
                expectedGeneration: 0,
                state: {
                    status: "exhausted",
                    lastSwitchReason: "usage_limit",
                },
                memberStates: [
                    {
                        profileId: "work",
                        state: { quotaExhaustedUntilMs: 10 },
                    },
                ],
            },
        });

        expect(stale.statusCode).toBe(409);
        expect(stale.json()).toEqual({ error: "connect_group_generation_conflict", generation: 1 });

        const fetched = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/groups/codex-main",
            headers: { "x-test-user-id": user.id },
        });
        expect(fetched.statusCode).toBe(200);
        expect(fetched.json().group.state).toEqual({});
        expect(fetched.json().group.members).toEqual(expect.arrayContaining([
            expect.objectContaining({ profileId: "work", state: {} }),
        ]));
    });
});
