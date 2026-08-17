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

import {
    ConnectedServiceAuthGroupResponseV1Schema,
    type ConnectedServiceId,
} from "@happier-dev/protocol";

import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { db } from "@/storage/db";
import { createAppCloseTracker } from "../../testkit/appLifecycle";
import { connectRoutes } from "./connectRoutes";
import {
    writeQualifiedProviderAccountUsageRecordFromLegacyBoundary,
} from "./qualifiedConnectedAccounts/usageRepository";
import {
    createProviderAccountUsageRecordKey,
    createUsageSnapshot,
} from "./providerAccountUsageTestkit";
import {
    createLegacyCredentialFixtureIdentity,
    createLegacyGroupFixtureIdentity,
    createLegacyGroupMemberFixtureIdentity,
} from "./testkit/qualifiedConnectedAccountFixtureIdentity";
import {
    readQualifiedConnectedAccountGroup,
} from "./qualifiedConnectedAccounts/groupRepository";

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

async function createConnectedProfile(accountId: string, serviceId: ConnectedServiceId, profileId: string) {
    return await db.serviceAccountToken.create({
        data: {
            accountId,
            vendor: serviceId,
            profileId,
            ...createLegacyCredentialFixtureIdentity({
                serviceId,
                profileId,
            }),
            token: Buffer.from(`sealed:${serviceId}:${profileId}`, "utf8"),
            metadata: { kind: "oauth" },
        },
        select: { id: true },
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
        groups: expect.any(Array),
    }));
    const group = params.group;

    const projectedGroup = (projectedService?.groups as Array<{
        groupId: string;
        displayName: string | null;
        activeProfileId: string | null;
        generation: number;
        memberProfileIds: string[];
    }> | undefined)?.find((projectedGroupEntry) => projectedGroupEntry.groupId === group.groupId);

    expect(projectedGroup).toEqual(expect.objectContaining({
        groupId: group.groupId,
        displayName: group.displayName,
        activeProfileId: group.activeProfileId,
        generation: group.generation,
    }));
    expect(projectedGroup?.memberProfileIds.slice().sort()).toEqual(group.memberProfileIds.slice().sort());
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

        expect(await readAccountChangeCursor(user.id)).toEqual(expect.any(Number));
        expectLastProjectedGroup({
            accountId: user.id,
            group: {
                groupId: "codex-main",
                displayName: "Codex Main",
                activeProfileId: "work",
                generation: 0,
                memberProfileIds: ["work", "backup"],
            },
        });
    });

    it("fences delayed V3 writes after a group is recreated while the current V4 incarnation remains mutable", async () => {
        const user = await createAccount("pk-groups-v3-incarnation-fence");
        const app = await createReadyApp();
        const headers = authHeaders(user.id);

        const created = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers,
            payload: {
                groupId: "v3-incarnation-fence",
                displayName: "Original",
                members: [],
            },
        });
        expect(created.statusCode, created.body).toBe(200);

        const neverExistingMutation = await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/never-existing-v3-incarnation-fence",
            headers,
            payload: { displayName: "Never existing" },
        });
        expect(
            neverExistingMutation.statusCode,
            neverExistingMutation.body,
        ).toBe(404);
        expect(neverExistingMutation.json()).toEqual({
            error: "connect_group_not_found",
        });

        const legacyWriteBeforeDelete = await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/v3-incarnation-fence",
            headers,
            payload: { displayName: "Legacy write" },
        });
        expect(legacyWriteBeforeDelete.statusCode, legacyWriteBeforeDelete.body)
            .toBe(200);

        const eligibleCurrentDuplicateV3Create = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers,
            payload: {
                groupId: "v3-incarnation-fence",
                displayName: "Eligible duplicate",
                members: [],
            },
        });
        expect(
            eligibleCurrentDuplicateV3Create.statusCode,
            eligibleCurrentDuplicateV3Create.body,
        ).toBe(409);
        expect(eligibleCurrentDuplicateV3Create.json()).toEqual({
            error: "connect_group_already_exists",
        });

        const deleted = await app.inject({
            method: "DELETE",
            url: "/v3/connect/openai-codex/groups/v3-incarnation-fence",
            headers: { "x-test-user-id": user.id },
        });
        expect(deleted.statusCode, deleted.body).toBe(200);

        const delayedV3MutationWhileAbsent = await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/v3-incarnation-fence",
            headers,
            payload: { displayName: "Stale absent V3 write" },
        });
        expect(
            delayedV3MutationWhileAbsent.statusCode,
            delayedV3MutationWhileAbsent.body,
        ).toBe(409);
        expect(delayedV3MutationWhileAbsent.json()).toEqual({
            error: "connect_group_incarnation_conflict",
        });

        const delayedV3Create = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers,
            payload: {
                groupId: "v3-incarnation-fence",
                displayName: "Stale V3 recreation",
                members: [],
            },
        });
        expect(delayedV3Create.statusCode, delayedV3Create.body).toBe(409);
        expect(delayedV3Create.json()).toEqual({
            error: "connect_group_incarnation_conflict",
        });

        const absentAfterDelayedV3Create = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/groups/v3-incarnation-fence",
            headers,
        });
        expect(
            absentAfterDelayedV3Create.statusCode,
            absentAfterDelayedV3Create.body,
        ).toBe(404);

        const recreated = await app.inject({
            method: "POST",
            url: "/v4/connect/qualified/groups",
            headers,
            payload: {
                service: {
                    pluginId: "happier.agent.codex",
                    localId: "openai-codex",
                },
                group: { groupId: "v3-incarnation-fence" },
            },
        });
        expect(recreated.statusCode, recreated.body).toBe(200);

        const delayedV3CreateAgainstV4Recreated = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers,
            payload: {
                groupId: "v3-incarnation-fence",
                displayName: "Stale V3 duplicate against V4",
                members: [],
            },
        });
        expect(
            delayedV3CreateAgainstV4Recreated.statusCode,
            delayedV3CreateAgainstV4Recreated.body,
        ).toBe(409);
        expect(delayedV3CreateAgainstV4Recreated.json()).toEqual({
            error: "connect_group_incarnation_conflict",
        });

        const delayedV3Write = await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/v3-incarnation-fence",
            headers,
            payload: { displayName: "Stale V3 write" },
        });
        expect(delayedV3Write.statusCode, delayedV3Write.body).toBe(409);
        expect(delayedV3Write.json()).toEqual({
            error: "connect_group_incarnation_conflict",
        });

        const v3Read = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/groups/v3-incarnation-fence",
            headers,
        });
        expect(v3Read.statusCode, v3Read.body).toBe(200);
        expect(v3Read.json()).toEqual({
            group: expect.objectContaining({ displayName: null }),
        });

        const recreatedGroup = recreated.json().group;
        const currentV4Write = await app.inject({
            method: "PATCH",
            url: "/v4/connect/qualified/group",
            headers,
            payload: {
                service: {
                    pluginId: "happier.agent.codex",
                    localId: "openai-codex",
                },
                groupId: "v3-incarnation-fence",
                displayName: "Current V4 write",
                expectedIncarnation: recreatedGroup.incarnation,
            },
        });
        expect(currentV4Write.statusCode, currentV4Write.body).toBe(200);
        expect(currentV4Write.json()).toEqual({
            group: expect.objectContaining({
                displayName: "Current V4 write",
                incarnation: recreatedGroup.incarnation,
            }),
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

    it("rejects a legacy group route when its qualified service identity disagrees before effects", async () => {
        const user = await createAccount("pk-groups-qualified-mismatch");
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

        await db.connectedServiceAuthGroup.update({
            where: {
                accountId_vendor_groupId: {
                    accountId: user.id,
                    vendor: "openai-codex",
                    groupId: "codex-main",
                },
            },
            data: {
                servicePluginId: "happier.voice.openai",
                serviceLocalId: "openai",
            },
        });

        const response = await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/codex-main",
            headers: authHeaders(user.id),
            payload: { displayName: "must-not-write" },
        });

        expect(response.statusCode).toBe(500);
        await expect(db.connectedServiceAuthGroup.findFirstOrThrow({
            where: { accountId: user.id },
            select: { displayName: true },
        })).resolves.toEqual({ displayName: null });
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

        const omittedGeneration = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups/codex-main/active-profile",
            headers: authHeaders(user.id),
            payload: { profileId: "backup" },
        });
        expect(omittedGeneration.statusCode).toBe(400);
        expect(omittedGeneration.json()).toEqual({ error: "connect_group_generation_required" });

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
        expect(await readAccountChangeCursor(user.id)).toEqual(expect.any(Number));
        expectLastProjectedGroup({
            accountId: user.id,
            group: {
                groupId: "codex-main",
                displayName: null,
                activeProfileId: "backup",
                generation: 1,
                memberProfileIds: ["work", "backup"],
            },
        });

        const stale = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups/codex-main/active-profile",
            headers: authHeaders(user.id),
            payload: { profileId: "work", expectedGeneration: 0 },
        });
        expect(stale.statusCode).toBe(409);
        expect(stale.json()).toEqual({ error: "connect_group_generation_conflict", generation: 1 });
        await expect(readQualifiedConnectedAccountGroup({
            accountId: user.id,
            service: {
                pluginId: "happier.agent.codex",
                localId: "openai-codex",
            },
            groupId: "codex-main",
        })).resolves.toMatchObject({
            activeConnectedAccountId: "backup",
            generation: 1,
        });
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

    it("applies the group patch active profile contract and publishes the updated projection", async () => {
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
        vi.clearAllMocks();

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
        expect(await readAccountChangeCursor(user.id)).toEqual(expect.any(Number));
        expectLastProjectedGroup({
            accountId: user.id,
            group: {
                groupId: "codex-main",
                displayName: null,
                activeProfileId: "backup",
                generation: 1,
                memberProfileIds: ["work", "backup"],
            },
        });
        await expect(readQualifiedConnectedAccountGroup({
            accountId: user.id,
            service: {
                pluginId: "happier.agent.codex",
                localId: "openai-codex",
            },
            groupId: "codex-main",
        })).resolves.toMatchObject({
            activeConnectedAccountId: "backup",
            generation: 1,
        });
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

    it("rejects removed legacy auth-group policy keys at the current API boundary", async () => {
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
                    recoveryPromptMode: "standard",
                    effectiveMeterStrategy: "weekly",
                    memberRuntimeStatePersistence: "server_state_json",
                },
                expectedGeneration: 0,
            },
        });

        expect(patched.statusCode).toBe(400);
    });

    it("bumps generation when group membership candidates change", async () => {
        const user = await createAccount("pk-groups-member-generation");
        await createConnectedProfile(user.id, "openai-codex", "work");
        await createConnectedProfile(user.id, "openai-codex", "backup");
        const app = await createReadyApp();

        expect((await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload: { groupId: "codex-main", members: [{ profileId: "work" }], activeProfileId: "work" },
        })).statusCode).toBe(200);

        const added = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups/codex-main/members",
            headers: authHeaders(user.id),
            payload: { profileId: "backup", expectedGeneration: 0 },
        });
        expect(added.statusCode).toBe(200);
        expect(added.json()).toEqual({
            group: expect.objectContaining({ generation: 1 }),
        });
        expect(await readAccountChangeCursor(user.id)).toEqual(expect.any(Number));
        expectLastProjectedGroup({
            accountId: user.id,
            group: {
                groupId: "codex-main",
                displayName: null,
                activeProfileId: "work",
                generation: 1,
                memberProfileIds: ["work", "backup"],
            },
        });

        const updated = await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/codex-main/members/backup",
            headers: authHeaders(user.id),
            payload: { priority: 10, expectedGeneration: 1 },
        });
        expect(updated.statusCode).toBe(200);
        expect(updated.json()).toEqual({
            group: expect.objectContaining({ generation: 2 }),
        });
        expect(await readAccountChangeCursor(user.id)).toEqual(expect.any(Number));
        expectLastProjectedGroup({
            accountId: user.id,
            group: {
                groupId: "codex-main",
                displayName: null,
                activeProfileId: "work",
                generation: 2,
                memberProfileIds: ["work", "backup"],
            },
        });

        const removed = await app.inject({
            method: "DELETE",
            url: "/v3/connect/openai-codex/groups/codex-main/members/backup?expectedGeneration=2",
            headers: { "x-test-user-id": user.id },
        });
        expect(removed.statusCode, removed.body).toBe(200);
        expect(removed.json()).toEqual({
            group: expect.objectContaining({ generation: 3 }),
        });
        expect(await readAccountChangeCursor(user.id)).toEqual(expect.any(Number));
        expectLastProjectedGroup({
            accountId: user.id,
            group: {
                groupId: "codex-main",
                displayName: null,
                activeProfileId: "work",
                generation: 3,
                memberProfileIds: ["work"],
            },
        });
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
        for (const groupId of ["left", "right"] as const) {
            await writeQualifiedProviderAccountUsageRecordFromLegacyBoundary({
                accountId: user.id,
                recordId: snapshot.recordId,
                recordKey: snapshot.recordKey,
                payloadMode: "plain_json_v1",
                snapshot,
                status: "ok",
                fetchedAt: snapshot.fetchedAtMs,
                staleAfterMs: snapshot.staleAfterMs,
                source: {
                    ref: {
                        service: {
                            pluginId: "happier.agent.codex",
                            localId: "openai-codex",
                        },
                        accountId: "backup",
                    },
                    bindingKind: "group_member",
                    groupId,
                    groupGeneration: 0,
                },
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
        await writeQualifiedProviderAccountUsageRecordFromLegacyBoundary({
            accountId: user.id,
            recordId: snapshot.recordId,
            recordKey: snapshot.recordKey,
            payloadMode: "plain_json_v1",
            snapshot,
            status: "ok",
            fetchedAt: snapshot.fetchedAtMs,
            staleAfterMs: snapshot.staleAfterMs,
            source: {
                ref: {
                    service: {
                        pluginId: "happier.agent.codex",
                        localId: "openai-codex",
                    },
                    accountId: "backup",
                },
                bindingKind: "group_member",
                groupId: "left",
                groupGeneration: 0,
            },
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

    it("returns a schema-valid group envelope when deleting the active last setup-token member", async () => {
        const user = await createAccount("pk-groups-delete-active-last-member");
        await createConnectedProfile(user.id, "claude-subscription", "leeroy_new_setuptoken");
        const app = await createReadyApp();

        expect((await app.inject({
            method: "POST",
            url: "/v3/connect/claude-subscription/groups",
            headers: authHeaders(user.id),
            payload: {
                groupId: "claude",
                members: [{ profileId: "leeroy_new_setuptoken" }],
                activeProfileId: "leeroy_new_setuptoken",
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
            url: "/v3/connect/claude-subscription/groups/claude/members/leeroy_new_setuptoken?expectedGeneration=51",
            headers: { "x-test-user-id": user.id },
        });

        expect(removed.statusCode, removed.body).toBe(200);
        const body = removed.json();
        expect(ConnectedServiceAuthGroupResponseV1Schema.safeParse(body).success).toBe(true);
        expect(body).toEqual({
            group: expect.objectContaining({
                serviceId: "claude-subscription",
                groupId: "claude",
                activeProfileId: null,
                generation: 52,
                members: [],
            }),
        });
    });

    it("publishes an empty group projection when a group is deleted", async () => {
        const user = await createAccount("pk-groups-delete");
        await createConnectedProfile(user.id, "openai-codex", "work");
        const app = await createReadyApp();

        expect((await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload: { groupId: "codex-main", members: [{ profileId: "work" }], activeProfileId: "work" },
        })).statusCode).toBe(200);
        vi.clearAllMocks();

        const deleted = await app.inject({
            method: "DELETE",
            url: "/v3/connect/openai-codex/groups/codex-main",
            headers: { "x-test-user-id": user.id },
        });

        expect(deleted.statusCode).toBe(200);
        expect(deleted.json()).toEqual({ success: true });
        expect(await readAccountChangeCursor(user.id)).toEqual(expect.any(Number));
        expectLastProjectedGroup({ accountId: user.id, group: null });
    });

    it("allows explicit manual active profile switches to override persisted runtime cooldown", async () => {
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

        const overridden = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups/codex-main/active-profile",
            headers: authHeaders(user.id),
            payload: { profileId: "work", expectedGeneration: 0, overrideRuntimeCooldown: true },
        });

        expect(overridden.statusCode, overridden.body).toBe(200);
        expect(overridden.json()).toEqual({
            group: expect.objectContaining({ activeProfileId: "work", generation: 1 }),
        });

        const authInvalidUntilMs = resetAtMs + 30_000;
        const authStateUpdated = await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/codex-main/runtime-state",
            headers: authHeaders(user.id),
            payload: {
                expectedGeneration: 1,
                expectedRuntimeStateRevision: 1,
                memberStates: [
                    {
                        profileId: "backup",
                        state: { authInvalidUntilMs },
                    },
                ],
            },
        });
        expect(authStateUpdated.statusCode, authStateUpdated.body).toBe(200);
        expect(authStateUpdated.json().group.members).toEqual(expect.arrayContaining([
            expect.objectContaining({
                profileId: "backup",
                state: expect.objectContaining({ authInvalidUntilMs }),
            }),
        ]));

        const authSwitch = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups/codex-main/active-profile",
            headers: authHeaders(user.id),
            payload: { profileId: "backup", expectedGeneration: 1 },
        });

        expect(authSwitch.statusCode, authSwitch.body).toBe(200);
        expect(authSwitch.json()).toEqual({
            group: expect.objectContaining({ activeProfileId: "backup", generation: 2 }),
        });

        const patchBlocked = await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/codex-main",
            headers: authHeaders(user.id),
            payload: { activeProfileId: "work", expectedGeneration: 2 },
        });

        expect(patchBlocked.statusCode).toBe(409);
        expect(patchBlocked.json()).toEqual({ error: "connect_group_profile_runtime_cooldown", resetAtMs });
    });

    it("allows manual active profile switches through stale availability and credential-health evidence", async () => {
        const user = await createAccount("pk-groups-active-profile-availability-blockers");
        await createConnectedProfile(user.id, "openai-codex", "work");
        await createConnectedProfile(user.id, "openai-codex", "plan");
        await createConnectedProfile(user.id, "openai-codex", "validation");
        await createConnectedProfile(user.id, "openai-codex", "reauth");
        const app = await createReadyApp();
        const nowMs = Date.now();
        const planUnavailableUntilMs = nowMs + 60_000;
        const validationBlockedUntilMs = nowMs + 90_000;

        expect((await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload: {
                groupId: "codex-main",
                members: [
                    { profileId: "work" },
                    { profileId: "plan" },
                    { profileId: "validation" },
                    { profileId: "reauth" },
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
                        profileId: "plan",
                        state: { planUnavailableUntilMs },
                    },
                    {
                        profileId: "validation",
                        state: { validationBlockedUntilMs },
                    },
                    {
                        profileId: "reauth",
                        state: { credentialHealthStatus: "needs_reauth" },
                    },
                ],
            },
        })).statusCode).toBe(200);

        for (const [index, profileId] of ["plan", "validation", "reauth"].entries()) {
            const activeProfilePost = await app.inject({
                method: "POST",
                url: "/v3/connect/openai-codex/groups/codex-main/active-profile",
                headers: authHeaders(user.id),
                payload: { profileId, expectedGeneration: index * 2 },
            });
            expect(activeProfilePost.statusCode, activeProfilePost.body).toBe(200);
            expect(activeProfilePost.json()).toEqual({
                group: expect.objectContaining({ activeProfileId: profileId, generation: index * 2 + 1 }),
            });

            const groupPatch = await app.inject({
                method: "PATCH",
                url: "/v3/connect/openai-codex/groups/codex-main",
                headers: authHeaders(user.id),
                payload: { activeProfileId: "work", expectedGeneration: index * 2 + 1 },
            });
            expect(groupPatch.statusCode, groupPatch.body).toBe(200);
            expect(groupPatch.json()).toEqual({
                group: expect.objectContaining({ activeProfileId: "work", generation: index * 2 + 2 }),
            });
        }

        expect(await db.connectedServiceAuthGroup.findUnique({
            where: {
                accountId_vendor_groupId: {
                    accountId: user.id,
                    vendor: "openai-codex",
                    groupId: "codex-main",
                },
            },
            select: { activeProfileId: true, generation: true },
        })).toEqual({ activeProfileId: "work", generation: 6 });
    });

    it("allows explicit manual active profile switches to override persisted availability blockers", async () => {
        const user = await createAccount("pk-groups-active-profile-availability-override");
        await createConnectedProfile(user.id, "openai-codex", "work");
        await createConnectedProfile(user.id, "openai-codex", "plan");
        await createConnectedProfile(user.id, "openai-codex", "validation");
        await createConnectedProfile(user.id, "openai-codex", "reauth");
        const app = await createReadyApp();
        const nowMs = Date.now();

        expect((await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload: {
                groupId: "codex-main",
                members: [
                    { profileId: "work" },
                    { profileId: "plan" },
                    { profileId: "validation" },
                    { profileId: "reauth" },
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
                        profileId: "plan",
                        state: { planUnavailableUntilMs: nowMs + 60_000 },
                    },
                    {
                        profileId: "validation",
                        state: { validationBlockedUntilMs: nowMs + 90_000 },
                    },
                    {
                        profileId: "reauth",
                        state: { credentialHealthStatus: "needs_reauth" },
                    },
                ],
            },
        })).statusCode).toBe(200);

        const overriddenPost = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups/codex-main/active-profile",
            headers: authHeaders(user.id),
            payload: { profileId: "plan", expectedGeneration: 0, overrideRuntimeCooldown: true },
        });
        expect(overriddenPost.statusCode, overriddenPost.body).toBe(200);
        expect(overriddenPost.json()).toEqual({
            group: expect.objectContaining({ activeProfileId: "plan", generation: 1 }),
        });

        const overriddenPatch = await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/codex-main",
            headers: authHeaders(user.id),
            payload: { activeProfileId: "validation", expectedGeneration: 1, overrideRuntimeCooldown: true },
        });
        expect(overriddenPatch.statusCode, overriddenPatch.body).toBe(200);
        expect(overriddenPatch.json()).toEqual({
            group: expect.objectContaining({ activeProfileId: "validation", generation: 2 }),
        });

        const reauthOverride = await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/codex-main",
            headers: authHeaders(user.id),
            payload: { activeProfileId: "reauth", expectedGeneration: 2, overrideRuntimeCooldown: true },
        });
        expect(reauthOverride.statusCode, reauthOverride.body).toBe(200);
        expect(reauthOverride.json()).toEqual({
            group: expect.objectContaining({ activeProfileId: "reauth", generation: 3 }),
        });
    });

    it("does not treat providerResetsAtMs by itself as a manual active-profile blocker", async () => {
        const user = await createAccount("pk-groups-active-profile-provider-reset-only");
        await createConnectedProfile(user.id, "openai-codex", "work");
        await createConnectedProfile(user.id, "openai-codex", "provider-reset");
        const app = await createReadyApp();

        expect((await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload: {
                groupId: "codex-main",
                members: [{ profileId: "work" }, { profileId: "provider-reset" }],
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
                        profileId: "provider-reset",
                        state: { providerResetsAtMs: Date.now() + 60_000 },
                    },
                ],
            },
        })).statusCode).toBe(200);

        const patchSwitch = await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/codex-main",
            headers: authHeaders(user.id),
            payload: { activeProfileId: "provider-reset", expectedGeneration: 0 },
        });
        expect(patchSwitch.statusCode, patchSwitch.body).toBe(200);
        expect(patchSwitch.json()).toEqual({
            group: expect.objectContaining({ activeProfileId: "provider-reset", generation: 1 }),
        });

        expect((await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/codex-main",
            headers: authHeaders(user.id),
            payload: { activeProfileId: "work", expectedGeneration: 1 },
        })).statusCode).toBe(200);

        const postSwitch = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups/codex-main/active-profile",
            headers: authHeaders(user.id),
            payload: { profileId: "provider-reset", expectedGeneration: 2 },
        });
        expect(postSwitch.statusCode, postSwitch.body).toBe(200);
        expect(postSwitch.json()).toEqual({
            group: expect.objectContaining({ activeProfileId: "provider-reset", generation: 3 }),
        });
    });

    it("requires an explicit cleanup flag when deleting a credential referenced by a group member", async () => {
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

        const v3Res = await app.inject({
            method: "DELETE",
            url: "/v3/connect/openai-codex/profiles/work/credential",
            headers: { "x-test-user-id": user.id },
        });
        expect(v3Res.statusCode).toBe(409);
        expect(v3Res.json()).toEqual({ error: "connect_credential_referenced_by_group" });

        const v3CleanupRes = await app.inject({
            method: "DELETE",
            url: "/v3/connect/openai-codex/profiles/work/credential?cleanupGroupReferences=true",
            headers: { "x-test-user-id": user.id },
        });
        expect(v3CleanupRes.statusCode, v3CleanupRes.body).toBe(200);
        expect(v3CleanupRes.json()).toEqual({ success: true });
        expect(await db.serviceAccountToken.findUnique({
            where: {
                accountId_vendor_profileId: {
                    accountId: user.id,
                    vendor: "openai-codex",
                    profileId: "work",
                },
            },
        })).toBeNull();
        expect(await db.connectedServiceAuthGroupMember.findMany({
            where: { accountId: user.id, vendor: "openai-codex", groupId: "codex-main" },
            select: { profileId: true },
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

        await createConnectedProfile(user.id, "openai-codex", "work");
        expect((await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/codex-main/members/work",
            headers: authHeaders(user.id),
            payload: { enabled: false, expectedGeneration: 2 },
        })).statusCode).toBe(404);

        expect((await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups/codex-main/members",
            headers: authHeaders(user.id),
            payload: { profileId: "work", enabled: false, expectedGeneration: 2 },
        })).statusCode).toBe(200);

        const v2Res = await app.inject({
            method: "DELETE",
            url: "/v2/connect/openai-codex/profiles/work/credential",
            headers: { "x-test-user-id": user.id },
        });
        expect(v2Res.statusCode).toBe(409);
        expect(v2Res.json()).toEqual({ error: "connect_credential_referenced_by_group" });

        const v2CleanupRes = await app.inject({
            method: "DELETE",
            url: "/v2/connect/openai-codex/profiles/work/credential?cleanupGroupReferences=true",
            headers: { "x-test-user-id": user.id },
        });
        expect(v2CleanupRes.statusCode, v2CleanupRes.body).toBe(400);
        expect(v2CleanupRes.json()).toEqual({ error: "connect_credential_invalid" });
    });

    it("selects the canonical enabled fallback and bumps the group generation once when cleanup deletes the active credential", async () => {
        const user = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        for (const profileId of ["active", "later", "preferred"]) {
            await createConnectedProfile(user.id, "openai-codex", profileId);
        }
        const app = await createReadyApp();

        expect((await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload: {
                groupId: "codex-main",
                members: [
                    { profileId: "active", priority: 1 },
                    { profileId: "later", priority: 30 },
                    { profileId: "preferred", priority: 10 },
                ],
                activeProfileId: "active",
            },
        })).statusCode).toBe(200);

        const deleted = await app.inject({
            method: "DELETE",
            url: "/v3/connect/openai-codex/profiles/active/credential?cleanupGroupReferences=true",
            headers: { "x-test-user-id": user.id },
        });

        expect(deleted.statusCode, deleted.body).toBe(200);
        expect(await db.connectedServiceAuthGroup.findUnique({
            where: {
                accountId_vendor_groupId: {
                    accountId: user.id,
                    vendor: "openai-codex",
                    groupId: "codex-main",
                },
            },
            select: { activeProfileId: true, generation: true },
        })).toEqual({
            activeProfileId: "preferred",
            generation: 1,
        });
        expect(await db.connectedServiceAuthGroupMember.findMany({
            where: {
                accountId: user.id,
                vendor: "openai-codex",
                groupId: "codex-main",
            },
            orderBy: { profileId: "asc" },
            select: { profileId: true },
        })).toEqual([
            { profileId: "later" },
            { profileId: "preferred" },
        ]);
    });

    it("still deletes referenced credentials when account-groups is disabled and bumps hidden group references", async () => {
        harness.resetEnv({ HAPPIER_FEATURE_CONNECTED_SERVICES_ACCOUNT_GROUPS__ENABLED: "1" });
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
            payload: { groupId: "codex-main", members: [{ profileId: "work" }, { profileId: "backup" }], activeProfileId: "backup" },
        })).statusCode).toBe(200);

        harness.resetEnv({ HAPPIER_FEATURE_CONNECTED_SERVICES_ACCOUNT_GROUPS__ENABLED: "0" });
        emitUpdate.mockClear();
        const res = await app.inject({
            method: "DELETE",
            url: "/v3/connect/openai-codex/profiles/work/credential",
            headers: { "x-test-user-id": user.id },
        });

        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ success: true });
        expect(await db.serviceAccountToken.findUnique({
            where: {
                accountId_vendor_profileId: {
                    accountId: user.id,
                    vendor: "openai-codex",
                    profileId: "work",
                },
            },
        })).toBeNull();
        const group = await db.connectedServiceAuthGroup.findUnique({
            where: {
                accountId_vendor_groupId: {
                    accountId: user.id,
                    vendor: "openai-codex",
                    groupId: "codex-main",
                },
            },
            select: { activeProfileId: true, generation: true },
        });
        expect(group).toEqual({
            activeProfileId: "backup",
            generation: 1,
        });
        const qualifiedGroupIdentity =
            createLegacyGroupFixtureIdentity({
                serviceId: "openai-codex",
                groupId: "codex-main",
            });
        expect(emitUpdate.mock.lastCall?.[0]).toEqual(
            expect.objectContaining({
                userId: user.id,
                recipientFilter: { type: "user-scoped-only" },
                payload: expect.objectContaining({
                    body: expect.objectContaining({
                        t: "update-account",
                        connectedServicesV2: expect.arrayContaining([
                            expect.objectContaining({
                                serviceId: "openai-codex",
                                groups: [],
                            }),
                        ]),
                        connectedAccountGroupsV4:
                            expect.arrayContaining([
                                expect.objectContaining({
                                    ref: {
                                        service: {
                                            pluginId:
                                                qualifiedGroupIdentity
                                                    .servicePluginId,
                                            localId:
                                                qualifiedGroupIdentity
                                                    .serviceLocalId,
                                        },
                                        groupId: "codex-main",
                                    },
                                    activeConnectedAccountId:
                                        "backup",
                                    members: [
                                        expect.objectContaining({
                                            connectedAccountId:
                                                "backup",
                                        }),
                                    ],
                                }),
                            ]),
                    }),
                }),
            }),
        );
    });

    it("cascades auth-group members when a referenced credential is deleted directly", async () => {
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

        const credential = await db.serviceAccountToken.findUniqueOrThrow({
            where: {
                accountId_vendor_profileId: {
                    accountId: user.id,
                    vendor: "openai-codex",
                    profileId: "work",
                },
            },
            select: { id: true },
        });
        await db.serviceAccountToken.delete({ where: { id: credential.id } });

        const members = await db.connectedServiceAuthGroupMember.findMany({
            where: {
                accountId: user.id,
                vendor: "openai-codex",
                groupId: "codex-main",
            },
            select: { profileId: true },
        });
        expect(members).toEqual([]);
    });

    it("translates raced credential loss during member writes into connect_group_member_profile_not_found", async () => {
        const user = await createAccount("pk-groups-fk-race");
        await createConnectedProfile(user.id, "openai-codex", "work");
        await createConnectedProfile(user.id, "openai-codex", "backup");
        const app = await createReadyApp();

        expect((await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload: { groupId: "codex-main", members: [{ profileId: "work" }], activeProfileId: "work" },
        })).statusCode).toBe(200);

        const triggerName = "connected_service_auth_group_member_fk_race";
        await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}"`);
        await db.$executeRawUnsafe(`
            CREATE TRIGGER "${triggerName}"
            BEFORE INSERT ON "ConnectedServiceAuthGroupMember"
            WHEN NEW."profileId" = 'backup'
            BEGIN
                DELETE FROM "ServiceAccountToken"
                WHERE "accountId" = NEW."accountId"
                    AND "vendor" = NEW."vendor"
                    AND "profileId" = NEW."profileId";
            END
        `);

        const res = await (async () => {
            try {
                return await app.inject({
                    method: "POST",
                    url: "/v3/connect/openai-codex/groups/codex-main/members",
                    headers: authHeaders(user.id),
                    payload: { profileId: "backup", expectedGeneration: 0 },
                });
            } finally {
                await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}"`);
            }
        })();

        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: "connect_group_member_profile_not_found" });
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
            payload: { activeProfileId: "backup", expectedGeneration: 1 },
        });

        expect(patchRes.statusCode).toBe(400);
        expect(patchRes.json()).toEqual({ error: "connect_group_fallback_disabled" });
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

    it("allows gemini group configuration while rejecting same-group runtime fallback controls", async () => {
        const user = await createAccount("pk-groups-gemini-group-config-without-runtime-fallback");
        await createConnectedProfile(user.id, "gemini", "work");
        await createConnectedProfile(user.id, "gemini", "backup");
        const app = await createReadyApp();

        const create = await app.inject({
            method: "POST",
            url: "/v3/connect/gemini/groups",
            headers: authHeaders(user.id),
            payload: {
                groupId: "gemini-main",
                members: [{ profileId: "work" }, { profileId: "backup" }],
                activeProfileId: "work",
            },
        });
        expect(create.statusCode).toBe(200);

        const patchPolicy = await app.inject({
            method: "PATCH",
            url: "/v3/connect/gemini/groups/gemini-main",
            headers: authHeaders(user.id),
            payload: {
                policy: { autoSwitch: true },
                expectedGeneration: 1,
            },
        });

        expect(patchPolicy.statusCode).toBe(400);
        expect(patchPolicy.json()).toEqual({ error: "connect_group_runtime_fallback_unsupported" });

        const setActive = await app.inject({
            method: "POST",
            url: "/v3/connect/gemini/groups/gemini-main/active-profile",
            headers: authHeaders(user.id),
            payload: { profileId: "backup", expectedGeneration: 1 },
        });

        expect(setActive.statusCode).toBe(400);
        expect(setActive.json()).toEqual({ error: "connect_group_runtime_fallback_unsupported" });
    });

    it("rejects active-profile and fallback-policy mutations for services without runtime fallback support", async () => {
        const user = await createAccount("pk-groups-runtime-fallback-unsupported-mutations");
        const workCredential = await createConnectedProfile(user.id, "github", "work");
        const backupCredential = await createConnectedProfile(user.id, "github", "backup");
        const app = await createReadyApp();

        const group = await db.connectedServiceAuthGroup.create({
            data: {
                accountId: user.id,
                vendor: "github",
                groupId: "github-main",
                ...createLegacyGroupFixtureIdentity({
                    serviceId: "github",
                    groupId: "github-main",
                }),
                displayName: null,
                policyJson: JSON.stringify({ v: 1, strategy: "priority", autoSwitch: false }),
                activeProfileId: "work",
                activeConnectedAccountId: "work",
                stateJson: null,
            },
            select: { id: true },
        });
        await db.connectedServiceAuthGroupMember.createMany({
            data: [
                {
                    groupDbId: group.id,
                    accountId: user.id,
                    vendor: "github",
                    groupId: "github-main",
                    profileId: "work",
                    ...createLegacyGroupMemberFixtureIdentity({
                        serviceId: "github",
                        profileId: "work",
                        groupId: "github-main",
                        credentialId: workCredential.id,
                    }),
                    priority: 10,
                    enabled: true,
                    stateJson: null,
                },
                {
                    groupDbId: group.id,
                    accountId: user.id,
                    vendor: "github",
                    groupId: "github-main",
                    profileId: "backup",
                    ...createLegacyGroupMemberFixtureIdentity({
                        serviceId: "github",
                        profileId: "backup",
                        groupId: "github-main",
                        credentialId: backupCredential.id,
                    }),
                    priority: 20,
                    enabled: true,
                    stateJson: null,
                },
            ],
        });

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

    it("activates the first enabled member added to an existing empty legacy group", async () => {
        const user = await createAccount("pk-groups-first-added-active");
        await createConnectedProfile(user.id, "openai-codex", "work");
        const app = await createReadyApp();

        const created = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload: {
                groupId: "codex-empty",
                members: [],
                activeProfileId: null,
            },
        });
        expect(created.statusCode).toBe(200);
        expect(created.json()).toEqual({
            group: expect.objectContaining({
                activeProfileId: null,
                members: [],
            }),
        });

        const added = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups/codex-empty/members",
            headers: authHeaders(user.id),
            payload: {
                profileId: "work",
                enabled: true,
                expectedGeneration: 0,
            },
        });

        expect(added.statusCode, added.body).toBe(200);
        expect(added.json()).toEqual({
            group: expect.objectContaining({
                activeProfileId: "work",
                generation: 1,
                members: [
                    expect.objectContaining({
                        profileId: "work",
                        enabled: true,
                    }),
                ],
            }),
        });
    });

    it("clears disabled active profiles and blocks patch or switch routes from reselecting them", async () => {
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
        vi.clearAllMocks();

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
        expectLastProjectedGroup({
            accountId: user.id,
            group: {
                groupId: "codex-main",
                displayName: null,
                activeProfileId: "work",
                generation: 1,
                memberProfileIds: ["work"],
            },
        });

        await db.connectedServiceAuthGroup.update({
            where: { accountId_vendor_groupId: { accountId: user.id, vendor: "openai-codex", groupId: "codex-main" } },
            data: { activeProfileId: null },
        });
        const legacyNull = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/groups/codex-main",
            headers: authHeaders(user.id),
        });
        expect(legacyNull.statusCode).toBe(200);
        expect(legacyNull.json()).toEqual({
            group: expect.objectContaining({ activeProfileId: null, generation: 1 }),
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

    it("compares group PATCH active-profile changes against stored null without synthesizing read truth", async () => {
        const user = await createAccount("pk-groups-stored-null-patch-active-profile");
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
            data: { activeProfileId: null, generation: 0 },
        });
        vi.clearAllMocks();

        const synthesizedFallbackPatch = await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/codex-main",
            headers: authHeaders(user.id),
            payload: { activeProfileId: "work", expectedGeneration: 0 },
        });

        expect(synthesizedFallbackPatch.statusCode, synthesizedFallbackPatch.body).toBe(200);
        expect(synthesizedFallbackPatch.json()).toEqual({
            group: expect.objectContaining({ activeProfileId: "work", generation: 1 }),
        });
        expect(await db.connectedServiceAuthGroup.findUnique({
            where: { accountId_vendor_groupId: { accountId: user.id, vendor: "openai-codex", groupId: "codex-main" } },
            select: { activeProfileId: true, generation: true },
        })).toEqual({ activeProfileId: "work", generation: 1 });
        expectLastProjectedGroup({
            accountId: user.id,
            group: {
                groupId: "codex-main",
                displayName: null,
                activeProfileId: "work",
                generation: 1,
                memberProfileIds: ["work"],
            },
        });

        await db.connectedServiceAuthGroup.update({
            where: { accountId_vendor_groupId: { accountId: user.id, vendor: "openai-codex", groupId: "codex-main" } },
            data: { activeProfileId: null, generation: 0 },
        });
        vi.clearAllMocks();

        const explicitNullPatch = await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/codex-main",
            headers: authHeaders(user.id),
            payload: { activeProfileId: null, expectedGeneration: 0 },
        });

        expect(explicitNullPatch.statusCode, explicitNullPatch.body).toBe(200);
        expect(explicitNullPatch.json()).toEqual({
            group: expect.objectContaining({ activeProfileId: null, generation: 0 }),
        });
        expect(await db.connectedServiceAuthGroup.findUnique({
            where: { accountId_vendor_groupId: { accountId: user.id, vendor: "openai-codex", groupId: "codex-main" } },
            select: { activeProfileId: true, generation: true },
        })).toEqual({ activeProfileId: null, generation: 0 });
        expect(emitUpdate).not.toHaveBeenCalled();
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
                            planUnavailableUntilMs: 45,
                            validationBlockedUntilMs: 46,
                            providerResetsAtMs: 60,
                            credentialHealthStatus: "needs_reauth",
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
                            planUnavailableUntilMs: 45,
                            validationBlockedUntilMs: 46,
                            providerResetsAtMs: 60,
                            credentialHealthStatus: "needs_reauth",
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

    it("rejects a same-generation stale runtime-state writer without overwriting newer runtime state", async () => {
        const user = await createAccount("pk-groups-runtime-state-revision-conflict");
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
            url: "/v3/connect/openai-codex/groups/codex-main/runtime-state",
            headers: authHeaders(user.id),
            payload: {
                expectedGeneration: 0,
                expectedRuntimeStateRevision: 0,
                memberStates: [{
                    profileId: "work",
                    state: { quotaExhaustedUntilMs: 10, lastObservedAtMs: 10 },
                }],
            },
        })).statusCode).toBe(200);

        const stale = await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/codex-main/runtime-state",
            headers: authHeaders(user.id),
            payload: {
                expectedGeneration: 0,
                expectedRuntimeStateRevision: 0,
                memberStates: [{
                    profileId: "work",
                    state: { rateLimitedUntilMs: 20, lastObservedAtMs: 20 },
                }],
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
        expect(fetched.json().group).toEqual(expect.objectContaining({
            generation: 0,
            runtimeStateRevision: 1,
        }));
        expect(fetched.json().group.members).toEqual([
            expect.objectContaining({
                profileId: "work",
                state: expect.objectContaining({
                    quotaExhaustedUntilMs: 10,
                    lastObservedAtMs: 10,
                }),
            }),
        ]);
    });

    it("rejects generation-sensitive runtime state updates when expectedGeneration is omitted", async () => {
        const user = await createAccount("pk-groups-runtime-state-generation-required");
        await createConnectedProfile(user.id, "openai-codex", "work");
        const app = await createReadyApp();

        expect((await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload: { groupId: "codex-main", members: [{ profileId: "work" }], activeProfileId: "work" },
        })).statusCode).toBe(200);

        const missingGeneration = await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/codex-main/runtime-state",
            headers: authHeaders(user.id),
            payload: {
                state: {
                    status: "exhausted",
                    lastSwitchReason: "usage_limit",
                },
                memberStates: [],
            },
        });

        expect(missingGeneration.statusCode).toBe(400);
        expect(missingGeneration.json()).toEqual({ error: "connect_group_generation_required" });

        const missingRuntimeStateRevision = await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/codex-main/runtime-state",
            headers: authHeaders(user.id),
            payload: {
                expectedGeneration: 0,
                state: {
                    status: "exhausted",
                    lastSwitchReason: "usage_limit",
                },
                memberStates: [],
            },
        });
        expect(missingRuntimeStateRevision.statusCode).toBe(400);
        expect(missingRuntimeStateRevision.json()).toEqual({
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
    });

    it("requires expectedGeneration on active-profile switches before resolving the group", async () => {
        const user = await createAccount("pk-groups-active-profile-generation-precedence");
        const app = await createReadyApp();

        const missingGenerationUnknownGroup = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups/codex-missing/active-profile",
            headers: authHeaders(user.id),
            payload: { profileId: "work" },
        });

        expect(missingGenerationUnknownGroup.statusCode).toBe(400);
        expect(missingGenerationUnknownGroup.json()).toEqual({ error: "connect_group_generation_required" });
    });

    it("broadcasts member limiter changes once and treats repeat writes as generationless no-ops", async () => {
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
        const [machineScopedUpdate, userScopedUpdate] =
            emitUpdate.mock.calls.map(([update]) => update);
        expect(machineScopedUpdate).toEqual({
            userId: user.id,
            recipientFilter: { type: "user-machine-scoped-only" },
            payload: userScopedUpdate?.payload,
        });
        expect(userScopedUpdate).toEqual({
            userId: user.id,
            recipientFilter: { type: "user-scoped-only" },
            payload: expect.any(Object),
        });
        expect(machineScopedUpdate?.payload).toBe(userScopedUpdate?.payload);
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

        const { expectedGeneration: _omitted, ...generationlessClearPayload } = clearPayload;
        const generationlessRepeat = await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/codex-main/runtime-state",
            headers: authHeaders(user.id),
            payload: generationlessClearPayload,
        });

        expect(generationlessRepeat.statusCode).toBe(200);
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
