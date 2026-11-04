import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createQualifiedConnectedAccountGroupDigest, createQualifiedConnectedAccountServiceDigest } from "@/app/api/routes/connect/qualifiedConnectedAccounts/identity";
import { createTeamCredentialResourceInTx } from "./resourceCreate";
import { deleteTeamCredentialResourceInTx } from "./resourceDelete";
import { updateTeamCredentialResourceInTx } from "./resourceUpdate";
import { readTeamCredentialSourceResourceAdministrationInTx } from "./resourceRead";
import { deleteMachinePool } from "@/app/machines/pools/machinePoolService";
import { TeamCredentialSourceBindingV1Schema, TeamCredentialSourceLocatorV1Schema, type TeamCredentialBrokerPlacementV1 } from "@happier-dev/protocol/teams";

const TEST_AUTHENTICATION = {
    authenticationAuthority: "present_user",
    authenticationEvidence: [],
} as const;
const EMPTY_CREATE_CONFIGURATION = {
    sessionUsePolicy: "personal_allowed" as const,
    brokerPlacement: null,
    requestPolicy: null,
    allMembersAllowedRoutes: null,
    groupGrants: [],
    memberGrants: [],
    usageLimits: [],
};

describe("Team credential resource lifecycle", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: "team-resource-lifecycle-" }); }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it.each(["create", "replacement", "patch"] as const)("validates selected broker locations independently from the audience on %s", async (operation) => {
        const custodian = await db.account.create({ data: { encryptionMode: "plain", publicKey: null } });
        const foreign = await db.account.create({ data: { encryptionMode: "plain", publicKey: null } });
        const team = await db.team.create({ data: { name: "Placement selection authority" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: custodian.id, role: "owner" } });
        const ownedPool = await db.machinePool.create({ data: {
            id: crypto.randomUUID(), accountId: custodian.id, name: "Empty repairable Pool",
        } });
        const foreignPool = await db.machinePool.create({ data: {
            id: crypto.randomUUID(), accountId: foreign.id, name: "Foreign Pool",
        } });
        const machine = await db.machine.create({ data: {
            id: crypto.randomUUID(), accountId: custodian.id, metadata: "{}", active: false,
            operationProtocolCapabilities: { providerBrokerIngress: { protocolVersions: [1] } },
            operationProtocolCapabilitiesRevision: 1,
        } });
        const foreignMachine = await db.machine.create({ data: {
            id: crypto.randomUUID(), accountId: foreign.id, metadata: "{}",
            operationProtocolCapabilities: { providerBrokerIngress: { protocolVersions: [1] } },
            operationProtocolCapabilitiesRevision: 1,
        } });
        const source = TeamCredentialSourceBindingV1Schema.parse({
            v: 1, kind: "provider_connection", connectionId: "placement-selection-source",
            connectionSecurityFingerprint: "connection-security:v1:placement-selection", credentialSlotId: "apiKey",
        });

        for (const deliveryMode of [null, "direct"] as const) {
            const save = async (brokerPlacement: TeamCredentialBrokerPlacementV1, expected: "accepted" | "refused") => {
                const resourceId = crypto.randomUUID();
                const draft = {
                    ...EMPTY_CREATE_CONFIGURATION,
                    actorAccountId: custodian.id, authentication: TEST_AUTHENTICATION,
                    teamId: team.id, resourceId, displayName: "Selected placement",
                    deliveryPolicy: { preferredAllowedModes: ["brokered" as const, "direct" as const] }, source,
                    allMembersAllowedRoutes: deliveryMode === null ? null : [deliveryMode],
                };
                if (operation !== "create") {
                    await expect(inTx(tx => createTeamCredentialResourceInTx(tx, draft)))
                        .resolves.toEqual({ ok: true, resourceId, revision: 0 });
                }
                const result = operation === "create"
                    ? await inTx(tx => createTeamCredentialResourceInTx(tx, { ...draft, brokerPlacement }))
                    : await inTx(tx => updateTeamCredentialResourceInTx(tx, {
                        actorAccountId: custodian.id, authentication: TEST_AUTHENTICATION,
                        patch: {
                            resourceId, expectedRevision: 0,
                            ...(operation === "patch" ? { brokerPlacement } : {
                                replacement: {
                                    enabled: true, displayName: draft.displayName,
                                    sessionUsePolicy: draft.sessionUsePolicy, requestPolicy: null,
                                    allMembersAllowedRoutes: deliveryMode === null ? null : [deliveryMode], groupGrants: [], memberGrants: [],
                                    usageLimitDelta: { upserts: [], deleteIds: [] },
                                    custodian: { source, deliveryPolicy: draft.deliveryPolicy, brokerPlacement },
                                },
                            }),
                        },
                    }));
                if (expected === "refused") {
                    expect(result).toEqual({ ok: false, error: "broker_unavailable" });
                    const stored = await db.teamCredentialResource.findUnique({ where: { id: resourceId } });
                    if (operation === "create") expect(stored).toBeNull();
                    else expect(stored).toMatchObject({ revision: 0, brokerMachineId: null, brokerPoolId: null });
                } else {
                    expect(result).toEqual({ ok: true, resourceId, revision: operation === "create" ? 0 : 1 });
                    expect(await db.teamCredentialResource.findUniqueOrThrow({ where: { id: resourceId } })).toMatchObject({
                        brokerMachineId: brokerPlacement.kind === "machine" ? brokerPlacement.machineId : null,
                        brokerPoolId: brokerPlacement.kind === "machine_pool" ? brokerPlacement.poolId : null,
                    });
                }
            };
            await save({ kind: "machine_pool", poolId: foreignPool.id }, "refused");
            await save({ kind: "machine", machineId: foreignMachine.id }, "refused");
            await save({ kind: "machine_pool", poolId: ownedPool.id }, "accepted");
            await save({ kind: "machine", machineId: machine.id }, "accepted");
            const previous = process.env.HAPPIER_FEATURE_MACHINES_POOLS__ENABLED;
            process.env.HAPPIER_FEATURE_MACHINES_POOLS__ENABLED = "false";
            try {
                await save({ kind: "machine_pool", poolId: ownedPool.id }, "refused");
            } finally {
                if (previous === undefined) delete process.env.HAPPIER_FEATURE_MACHINES_POOLS__ENABLED;
                else process.env.HAPPIER_FEATURE_MACHINES_POOLS__ENABLED = previous;
            }
        }
    });

    it("preserves omitted placement but clears an explicit null while repairing an unavailable Pool", async () => {
        const custodian = await db.account.create({ data: { encryptionMode: "plain", publicKey: null } });
        const team = await db.team.create({ data: { name: "Placement repair" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: custodian.id, role: "owner" } });
        const pool = await db.machinePool.create({ data: {
            id: crypto.randomUUID(), accountId: custodian.id, name: "Retained Pool",
        } });
        const source = TeamCredentialSourceBindingV1Schema.parse({
            v: 1, kind: "provider_connection", connectionId: "placement-repair",
            connectionSecurityFingerprint: "connection-security:v1:placement-repair", credentialSlotId: "apiKey",
        });
        const resource = await db.teamCredentialResource.create({ data: {
            teamId: team.id, custodianAccountId: custodian.id, displayName: "Repair source",
            disclosureCeiling: "direct_allowed", sessionUsePolicy: "personal_allowed",
            sourceBindingJson: JSON.stringify(source), brokerPoolId: pool.id,
        } });
        const replacement = {
            enabled: true, displayName: "Renamed repair source", sessionUsePolicy: "personal_allowed" as const,
            requestPolicy: null, allMembersAllowedRoutes: null, groupGrants: [], memberGrants: [],
            usageLimitDelta: { upserts: [], deleteIds: [] },
        };
        const previous = process.env.HAPPIER_FEATURE_MACHINES_POOLS__ENABLED;
        process.env.HAPPIER_FEATURE_MACHINES_POOLS__ENABLED = "false";
        try {
            await expect(inTx(tx => updateTeamCredentialResourceInTx(tx, {
                actorAccountId: custodian.id, authentication: TEST_AUTHENTICATION,
                patch: { resourceId: resource.id, expectedRevision: 0, replacement },
            }))).resolves.toEqual({ ok: true, resourceId: resource.id, revision: 0 });
            expect(await db.teamCredentialResource.findUniqueOrThrow({ where: { id: resource.id } }))
                .toMatchObject({ brokerPoolId: pool.id, brokerMachineId: null });
            await expect(inTx(tx => updateTeamCredentialResourceInTx(tx, {
                actorAccountId: custodian.id, authentication: TEST_AUTHENTICATION,
                patch: {
                    resourceId: resource.id, expectedRevision: 0,
                    replacement: { ...replacement, custodian: { source, deliveryPolicy: { preferredAllowedModes: ["brokered", "direct"] }, brokerPlacement: null } },
                },
            }))).resolves.toEqual({ ok: true, resourceId: resource.id, revision: 1 });
            expect(await db.teamCredentialResource.findUniqueOrThrow({ where: { id: resource.id } }))
                .toMatchObject({ brokerPoolId: null, brokerMachineId: null });
        } finally {
            if (previous === undefined) delete process.env.HAPPIER_FEATURE_MACHINES_POOLS__ENABLED;
            else process.env.HAPPIER_FEATURE_MACHINES_POOLS__ENABLED = previous;
        }
    });

    it("keeps credential-resource mutations fail closed for malformed Team authentication policy", async () => {
        const actor = await db.account.create({ data: { encryptionMode: "plain", publicKey: null } });
        const team = await db.team.create({
            data: { name: "Malformed resource policy", authenticationPolicy: { v: 99, mode: "restricted" } },
        });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: actor.id, role: "member" } });
        const service = { pluginId: "malformed.source", localId: "source" };
        const groupId = "malformed-pool";
        const pool = await db.connectedServiceAuthGroup.create({ data: {
            accountId: actor.id, groupId, servicePluginId: service.pluginId, serviceLocalId: service.localId,
            qualifiedServiceDigest: createQualifiedConnectedAccountServiceDigest(service),
            qualifiedGroupDigest: createQualifiedConnectedAccountGroupDigest({ service, groupId }), policyJson: "{}",
        } });

        await expect(inTx(tx => createTeamCredentialResourceInTx(tx, {
            ...EMPTY_CREATE_CONFIGURATION,
            actorAccountId: actor.id,
            teamId: team.id,
            resourceId: "malformed-policy-resource",
            authentication: TEST_AUTHENTICATION,
            displayName: "Must not be created",
            deliveryPolicy: { preferredAllowedModes: ["brokered", "direct"] },
            source: { v: 1, kind: "connected_pool", target: { kind: "group", service, groupId }, poolIncarnation: pool.id },
        }))).resolves.toEqual({ ok: false, error: "team_authentication_policy_unavailable" });
        await expect(db.teamCredentialResource.findUnique({
            where: { id: "malformed-policy-resource" },
        })).resolves.toBeNull();
    });

    it("offers an owned Pool without grants, settles replay, and permits revision-fenced withdrawal after departure", async () => {
        const actor = await db.account.create({ data: { encryptionMode: "plain", publicKey: null } });
        const team = await db.team.create({ data: { name: "Resource team" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: actor.id, role: "member" } });
        const service = { pluginId: "example.source", localId: "source" };
        const groupId = "source-pool";
        const pool = await db.connectedServiceAuthGroup.create({ data: {
            accountId: actor.id, groupId, servicePluginId: service.pluginId, serviceLocalId: service.localId,
            qualifiedServiceDigest: createQualifiedConnectedAccountServiceDigest(service),
            qualifiedGroupDigest: createQualifiedConnectedAccountGroupDigest({ service, groupId }), policyJson: "{}",
        } });
        const input = {
            ...EMPTY_CREATE_CONFIGURATION,
            actorAccountId: actor.id, teamId: team.id, resourceId: "resource-create-intent",
            authentication: TEST_AUTHENTICATION,
            displayName: "Shared source", deliveryPolicy: { preferredAllowedModes: ["brokered" as const] },
            source: { v: 1 as const, kind: "connected_pool" as const,
                target: { kind: "group" as const, service, groupId }, poolIncarnation: pool.id },
        };
        const create = () => inTx(tx => createTeamCredentialResourceInTx(tx, input));
        await expect(create()).resolves.toEqual({ ok: true, resourceId: input.resourceId, revision: 0 });
        await expect(db.teamCredentialResource.findUnique({ where: { id: input.resourceId } })).resolves.toMatchObject({
            teamId: team.id,
            custodianAccountId: actor.id,
            displayName: input.displayName,
            disclosureCeiling: JSON.stringify({ policy: input.deliveryPolicy, experimentalBindingConfirmations: [] }),
            sessionUsePolicy: input.sessionUsePolicy,
            requestPolicyJson: null,
            brokerMachineId: null,
            brokerPoolId: null,
            allMembersDeliveryMode: null,
            sourceBindingJson: JSON.stringify(input.source),
        });
        await expect(create()).resolves.toEqual({ ok: true, resourceId: input.resourceId, revision: 0 });
        const stored = await db.teamCredentialResource.findUniqueOrThrow({ where: { id: input.resourceId } });
        const annotatedSource = { ...TeamCredentialSourceBindingV1Schema.parse(JSON.parse(stored.sourceBindingJson)),
            retiredDisplay: { label: 'retained source annotation' } };
        await db.teamCredentialResource.update({ where: { id: input.resourceId },
            data: { sourceBindingJson: JSON.stringify(annotatedSource) } });
        await expect(create()).resolves.toEqual({ ok: true, resourceId: input.resourceId, revision: 0 });
        await expect(inTx(tx => createTeamCredentialResourceInTx(tx, {
            ...input, resourceId: 'strict-source-create-input', source: annotatedSource,
        }))).resolves.toEqual({ ok: false, error: 'invalid_resource_input' });
        expect(await db.teamCredentialResource.count({ where: { id: input.resourceId } })).toBe(1);
        expect(await db.teamCredentialActivityEvent.count({
            where: { resourceId: input.resourceId, kind: "resource_created" },
        })).toBe(1);
        await expect(inTx(tx => createTeamCredentialResourceInTx(tx, {
            ...input,
            resourceId: "member-cannot-create-team-policy",
            deliveryPolicy: { preferredAllowedModes: ["brokered", "direct"] },
            allMembersAllowedRoutes: ["direct"],
        }))).resolves.toEqual({ ok: false, error: "forbidden" });
        await expect(db.teamCredentialResource.count({ where: { id: "member-cannot-create-team-policy" } })).resolves.toBe(0);
        expect(await db.teamCredentialResource.findUnique({ where: { id: input.resourceId } })).toMatchObject({
            custodianAccountId: actor.id, allMembersDeliveryMode: null, sessionUsePolicy: "personal_allowed",
        });
        await expect(inTx(tx => createTeamCredentialResourceInTx(tx, { ...input, displayName: "Different" })))
            .resolves.toEqual({ ok: false, error: "resource_changed" });
        await db.teamCredentialResource.update({
            where: { id: input.resourceId },
            data: { sourceBindingJson: "{" },
        });
        await expect(create()).resolves.toEqual({ ok: false, error: "resource_changed" });
        await db.teamMembership.deleteMany({ where: { teamId: team.id, accountId: actor.id } });
        await expect(inTx(tx => deleteTeamCredentialResourceInTx(tx, {
            actorAccountId: actor.id, resourceId: input.resourceId, expectedRevision: 1, authentication: TEST_AUTHENTICATION,
        }))).resolves.toEqual({ ok: false, error: "resource_changed" });
        expect(await db.teamCredentialResource.count({ where: { id: input.resourceId } })).toBe(1);
        await expect(inTx(tx => deleteTeamCredentialResourceInTx(tx, {
            actorAccountId: actor.id, resourceId: input.resourceId, expectedRevision: 0, authentication: TEST_AUTHENTICATION,
        }))).resolves.toEqual({ ok: true });
        expect(await db.teamCredentialResource.count({ where: { id: input.resourceId } })).toBe(0);
        const history = await db.teamCredentialActivityEvent.findMany({
            where: { resourceId: input.resourceId }, orderBy: { createdAt: "asc" },
        });
        expect(history.map(event => event.kind)).toEqual(["resource_created", "resource_deleted"]);
        expect(history.every(event => event.actorAccountId === actor.id
            && event.teamId === team.id && event.subjectDisplayName === input.displayName)).toBe(true);
    });

    it("source-lists only exact Account, Pool, and Provider resources after Team departure", async () => {
        const custodian = await db.account.create({ data: { encryptionMode: "plain", publicKey: null } });
        const unrelated = await db.account.create({ data: { encryptionMode: "plain", publicKey: null } });
        const team = await db.team.create({ data: { name: "Source administration" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: custodian.id, role: "member" } });
        const service = { pluginId: "source.admin", localId: "primary" };
        const sources = {
            account: {
                v: 1 as const,
                kind: "connected_account" as const,
                target: { kind: "account" as const, account: { service, accountId: "account-1" } },
                credentialIncarnation: "credential-incarnation-1",
            },
            pool: {
                v: 1 as const,
                kind: "connected_pool" as const,
                target: { kind: "group" as const, service, groupId: "pool-1" },
                poolIncarnation: "pool-incarnation-1",
            },
            provider: {
                v: 1 as const,
                kind: "provider_connection" as const,
                connectionId: "provider-connection-1",
                connectionSecurityFingerprint: "connection-security:v1:source-admin",
                credentialSlotId: "apiKey",
            },
            otherProvider: {
                v: 1 as const,
                kind: "provider_connection" as const,
                connectionId: "provider-connection-2",
                connectionSecurityFingerprint: "connection-security:v1:other-source",
                credentialSlotId: "apiKey",
            },
        };
        for (const [id, source] of Object.entries(sources)) {
            await db.teamCredentialResource.create({ data: {
                id: `source-admin-${id}`,
                teamId: team.id,
                custodianAccountId: custodian.id,
                displayName: `${id} source`,
                disclosureCeiling: "direct_allowed",
                sessionUsePolicy: "personal_allowed",
                sourceBindingJson: JSON.stringify(source),
            } });
        }
        await db.teamMembership.deleteMany({ where: { teamId: team.id, accountId: custodian.id } });

        const list = (source: unknown, actorAccountId = custodian.id) => inTx(tx => (
            readTeamCredentialSourceResourceAdministrationInTx(tx, {
                actorAccountId,
                source: TeamCredentialSourceLocatorV1Schema.parse(source),
                authentication: TEST_AUTHENTICATION,
            })
        ));
        const account = await list({ v: 1, kind: "connected_account", target: sources.account.target });
        const pool = await list({ v: 1, kind: "connected_pool", target: sources.pool.target });
        const provider = await list({ v: 1, kind: "provider_connection", connectionId: sources.provider.connectionId });
        expect(account).toMatchObject({ ok: true, page: { resources: [{ id: "source-admin-account" }] } });
        expect(pool).toMatchObject({ ok: true, page: { resources: [{ id: "source-admin-pool" }] } });
        expect(provider).toMatchObject({ ok: true, page: { resources: [{
            id: "source-admin-provider",
            capabilities: {
                manageAudience: false,
                managePolicy: false,
                manageLimits: false,
                updateBrokerPlacement: true,
                narrowDisclosure: true,
                refreshDirectMaterial: false,
                disable: true,
                enable: false,
                delete: true,
            },
        }] } });
        expect(await list({
            v: 1,
            kind: "provider_connection",
            connectionId: sources.provider.connectionId,
        }, unrelated.id)).toEqual({ ok: true, page: { resources: [], nextCursor: null }, readinessResources: [] });
        const serialized = JSON.stringify(provider.ok ? provider.page : provider);
        expect(serialized).not.toContain(team.id);
        expect(serialized).not.toContain("custodianAccountId");
        expect(serialized).not.toContain("groupGrants");
        expect(serialized).not.toContain("memberGrants");
        expect(serialized).not.toContain("requestPolicy");
        expect(serialized).not.toContain("usageLimits");
        expect(serialized).not.toContain(sources.provider.connectionSecurityFingerprint);
        expect(serialized).not.toContain(sources.provider.credentialSlotId);
    });

    it("bounds authentication fact reads for one versus one hundred restricted source-owner Teams", async () => {
        const custodian = await db.account.create({
            data: { encryptionMode: "e2ee", publicKey: crypto.randomUUID() },
        });
        const authenticationPolicy = {
            v: 1,
            mode: "restricted",
            accepted: [{ kind: "home_method", methodId: "key_challenge" }],
        } as const;
        const createPage = async (prefix: string, count: number) => {
            const teams = Array.from({ length: count }, (_, index) => ({
                id: `${prefix}-team-${index}`,
                name: `${prefix} Team ${index}`,
                authenticationPolicy,
            }));
            await db.team.createMany({ data: teams });
            await db.teamMembership.createMany({ data: teams.map((team) => ({
                teamId: team.id,
                accountId: custodian.id,
                role: "member" as const,
            })) });
            await db.teamCredentialResource.createMany({ data: teams.map((team, index) => ({
                id: `${prefix}-resource-${index}`,
                teamId: team.id,
                custodianAccountId: custodian.id,
                displayName: `${prefix} Resource ${String(index).padStart(3, "0")}`,
                disclosureCeiling: "brokered_only",
                sessionUsePolicy: "personal_allowed",
                sourceBindingJson: JSON.stringify({
                    v: 1,
                    kind: "provider_connection",
                    connectionId: `${prefix}-connection`,
                    connectionSecurityFingerprint: `connection-security:v1:${prefix}`,
                    credentialSlotId: "apiKey",
                }),
            })) });
        };
        await createPage("bounded-auth-one", 1);
        await createPage("bounded-auth-many", 100);

        const readWithQueryCount = async (prefix: string, limit: number) => await inTx(async (tx) => {
            let queryCount = 0;
            const observedTx = new Proxy(tx, {
                get(target, property, receiver) {
                    const delegate = Reflect.get(target, property, receiver);
                    if (typeof delegate !== "object" || delegate === null) return delegate;
                    return new Proxy(delegate, {
                        get(delegateTarget, method, delegateReceiver) {
                            const operation = Reflect.get(delegateTarget, method, delegateReceiver);
                            if (typeof method !== "string" || !method.startsWith("find") || typeof operation !== "function") {
                                return operation;
                            }
                            return (...args: readonly unknown[]) => {
                                queryCount += 1;
                                return Reflect.apply(operation, delegateTarget, args);
                            };
                        },
                    });
                },
            }) as typeof tx;
            const result = await readTeamCredentialSourceResourceAdministrationInTx(observedTx, {
                actorAccountId: custodian.id,
                source: TeamCredentialSourceLocatorV1Schema.parse({
                    v: 1,
                    kind: "provider_connection",
                    connectionId: `${prefix}-connection`,
                }),
                authentication: {
                    authenticationAuthority: "present_user",
                    authenticationEvidence: [{ kind: "home_method", methodId: "key_challenge" }],
                    env: { HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "1" },
                },
                limit,
            });
            return { result, queryCount };
        });

        const one = await readWithQueryCount("bounded-auth-one", 1);
        const many = await readWithQueryCount("bounded-auth-many", 100);
        expect(one.result).toMatchObject({ ok: true, page: { resources: [{ id: "bounded-auth-one-resource-0" }] } });
        expect(many.result).toMatchObject({ ok: true, page: { resources: expect.arrayContaining([
            expect.objectContaining({ id: "bounded-auth-many-resource-0" }),
            expect.objectContaining({ id: "bounded-auth-many-resource-99" }),
        ]) } });
        expect(one.queryCount).toBeGreaterThan(0);
        expect(many.queryCount).toBe(one.queryCount);
    });

    it("creates the complete usable draft atomically and leaves no rows when audience validation fails", async () => {
        const actor = await db.account.create({ data: { encryptionMode: "plain", publicKey: null } });
        const team = await db.team.create({ data: { name: "Atomic resource team" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: actor.id, role: "owner" } });
        const service = { pluginId: "atomic.source", localId: "source" };
        const groupId = "atomic-source-pool";
        const pool = await db.connectedServiceAuthGroup.create({ data: {
            accountId: actor.id, groupId, servicePluginId: service.pluginId, serviceLocalId: service.localId,
            qualifiedServiceDigest: createQualifiedConnectedAccountServiceDigest(service),
            qualifiedGroupDigest: createQualifiedConnectedAccountGroupDigest({ service, groupId }), policyJson: "{}",
        } });
        const broker = await db.machine.create({ data: {
            id: `atomic-broker-${actor.id}`,
            accountId: actor.id,
            metadata: "{}",
            kind: "persistent",
            operationProtocolCapabilities: { providerBrokerIngress: { protocolVersions: [1] } },
            operationProtocolCapabilitiesRevision: 1,
        } });
        const base = {
            actorAccountId: actor.id, teamId: team.id, authentication: TEST_AUTHENTICATION,
            displayName: "Atomic source", deliveryPolicy: { preferredAllowedModes: ["brokered" as const] },
            source: { v: 1 as const, kind: "connected_pool" as const, target: { kind: "group" as const, service, groupId }, poolIncarnation: pool.id },
            sessionUsePolicy: "team_context_required" as const,
            brokerPlacement: { kind: "machine" as const, machineId: broker.id }, requestPolicy: {
                allowedProtocolKinds: ["openai_responses" as const], allowedModelIds: ["gpt-5"], reasoningEffort: null,
            }, allMembersAllowedRoutes: null, groupGrants: [], memberGrants: [],
            usageLimits: [{ subjectKind: "resource" as const, subjectId: "", period: "month" as const, metric: "inference_requests" as const, maximum: "100", enabled: true }],
        };
        await expect(inTx(tx => createTeamCredentialResourceInTx(tx, { ...base, resourceId: "atomic-complete" }))).resolves.toEqual({ ok: false, error: "invalid_limit" });
        await expect(db.teamCredentialResource.findUnique({ where: { id: "atomic-complete" } })).resolves.toBeNull();
        await expect(db.teamCredentialUsageLimit.count({ where: { resourceId: "atomic-complete" } })).resolves.toBe(0);

        await expect(inTx(tx => createTeamCredentialResourceInTx(tx, { ...base, resourceId: "atomic-refused", groupGrants: [{ teamGroupId: "missing-group", allowedRoutes: ["brokered"] }] }))).resolves.toEqual({ ok: false, error: "invalid_audience" });
        await expect(db.teamCredentialResource.count({ where: { id: "atomic-refused" } })).resolves.toBe(0);
        await expect(db.teamCredentialUsageLimit.count({ where: { resourceId: "atomic-refused" } })).resolves.toBe(0);
        await expect(db.teamCredentialActivityEvent.count({ where: { resourceId: "atomic-refused" } })).resolves.toBe(0);
        await expect(inTx(tx => createTeamCredentialResourceInTx(tx, {
            ...base,
            resourceId: "atomic-stale-source",
            source: { ...base.source, poolIncarnation: "replaced-pool-lifetime" },
        }))).resolves.toEqual({ ok: false, error: "source_replaced_or_missing" });
        await expect(db.teamCredentialResource.count({ where: { id: "atomic-stale-source" } })).resolves.toBe(0);
    });

    it("lets a departed source custodian withdraw and narrow disclosure, but not change Team policy", async () => {
        const custodian = await db.account.create({ data: { encryptionMode: "plain", publicKey: null } });
        const team = await db.team.create({ data: { name: "Custodian policy" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: custodian.id, role: "member" } });
        const resource = await db.teamCredentialResource.create({ data: {
            teamId: team.id, custodianAccountId: custodian.id, displayName: "Owned source",
            disclosureCeiling: "direct_allowed", sessionUsePolicy: "personal_allowed",
            allMembersDeliveryMode: "direct",
            sourceBindingJson: JSON.stringify({ v: 1, kind: "provider_connection", connectionId: "connection",
                connectionSecurityFingerprint: "connection-security:v1:test:source", credentialSlotId: "apiKey" }),
        } });
        await db.teamMembership.deleteMany({ where: { teamId: team.id, accountId: custodian.id } });
        await expect(inTx(tx => updateTeamCredentialResourceInTx(tx, {
            actorAccountId: custodian.id,
            authentication: TEST_AUTHENTICATION,
            patch: { resourceId: resource.id, expectedRevision: 0, enabled: false,
                deliveryPolicy: { preferredAllowedModes: ["brokered"] } },
        }))).resolves.toEqual({ ok: true, resourceId: resource.id, revision: 1 });
        // Narrowing the ceiling removes the direct audience; it never converts
        // a direct grant into broker authority the custodian never granted.
        await expect(db.teamCredentialResource.findUniqueOrThrow({ where: { id: resource.id } })).resolves.toMatchObject({
            enabled: false,
            disclosureCeiling: JSON.stringify({ policy: { preferredAllowedModes: ["brokered"] }, experimentalBindingConfirmations: [] }),
            allMembersDeliveryMode: null,
            sessionUsePolicy: "personal_allowed",
        });
        await expect(inTx(tx => updateTeamCredentialResourceInTx(tx, {
            actorAccountId: custodian.id,
            authentication: TEST_AUTHENTICATION,
            patch: { resourceId: resource.id, expectedRevision: 1, sessionUsePolicy: "team_context_required" },
        }))).resolves.toEqual({ ok: false, error: "resource_forbidden" });
        await expect(inTx(tx => updateTeamCredentialResourceInTx(tx, {
            actorAccountId: custodian.id,
            authentication: TEST_AUTHENTICATION,
            patch: { resourceId: resource.id, expectedRevision: 1, enabled: true },
        }))).resolves.toEqual({ ok: false, error: "resource_forbidden" });
    });

    it.each(["revoked_machine", "deleted_machine", "deleted_pool"] as const)("lets a source custodian withdraw through a %s broker placement", async (placementState) => {
        const custodian = await db.account.create({ data: { encryptionMode: "plain", publicKey: null } });
        const team = await db.team.create({ data: { name: "Broken broker withdrawal" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: custodian.id, role: "member" } });
        const broker = await db.machine.create({ data: {
            id: crypto.randomUUID(), accountId: custodian.id, active: true, kind: "persistent",
            metadata: "{}", metadataVersion: 1,
            operationProtocolCapabilities: { providerBrokerIngress: { protocolVersions: [1] } },
            operationProtocolCapabilitiesRevision: 1,
        } });
        const pool = placementState === "deleted_pool" ? await db.machinePool.create({ data: {
            id: crypto.randomUUID(), accountId: custodian.id, name: "Withdrawn broker Pool",
            members: { create: { machineId: broker.id, priorityTier: 0, enabled: true } },
        } }) : null;
        const resource = await db.teamCredentialResource.create({ data: {
            teamId: team.id, custodianAccountId: custodian.id, displayName: "Brokered source",
            disclosureCeiling: "direct_allowed", sessionUsePolicy: "personal_allowed",
            allMembersDeliveryMode: "both",
            brokerMachineId: pool ? null : broker.id,
            brokerPoolId: pool?.id ?? null,
            sourceBindingJson: JSON.stringify({ v: 1, kind: "provider_connection", connectionId: "connection",
                connectionSecurityFingerprint: "connection-security:v1:test:broken-broker", credentialSlotId: "apiKey" }),
        } });
        if (pool) await expect(deleteMachinePool({
            accountId: custodian.id,
            input: { poolId: pool.id, expectedRevision: pool.revision },
            io: { in: () => ({ fetchSockets: async () => [] }) },
        })).resolves.toMatchObject({ ok: true, value: { deleted: true } });
        else if (placementState === "deleted_machine") await db.machine.delete({ where: { id: broker.id } });
        else await db.machine.update({ where: { id: broker.id }, data: { revokedAt: new Date() } });
        const { revision } = await db.teamCredentialResource.findUniqueOrThrow({ where: { id: resource.id } });

        // Disabling and narrowing take authority away from exactly the Machine
        // that is gone, so its unusability must not block the withdrawal.
        await expect(inTx(tx => updateTeamCredentialResourceInTx(tx, {
            actorAccountId: custodian.id,
            authentication: TEST_AUTHENTICATION,
            patch: { resourceId: resource.id, expectedRevision: revision, enabled: false },
        }))).resolves.toEqual({ ok: true, resourceId: resource.id, revision: revision + 1 });
        // A manager cannot combine narrowing with re-enabling a broken broker.
        await db.teamMembership.updateMany({ where: { teamId: team.id, accountId: custodian.id }, data: { role: "owner" } });
        await expect(inTx(tx => updateTeamCredentialResourceInTx(tx, {
            actorAccountId: custodian.id,
            authentication: TEST_AUTHENTICATION,
            patch: { resourceId: resource.id, expectedRevision: revision + 1, enabled: true, deliveryPolicy: { preferredAllowedModes: ["brokered"] } },
        }))).resolves.toEqual({ ok: false, error: "broker_unavailable" });
        await db.teamMembership.updateMany({ where: { teamId: team.id, accountId: custodian.id }, data: { role: "member" } });
        await expect(inTx(tx => updateTeamCredentialResourceInTx(tx, {
            actorAccountId: custodian.id,
            authentication: TEST_AUTHENTICATION,
            patch: { resourceId: resource.id, expectedRevision: revision + 1, deliveryPolicy: { preferredAllowedModes: ["brokered"] } },
        }))).resolves.toEqual({ ok: true, resourceId: resource.id, revision: revision + 2 });

        // Selecting a new placement is still a selection and is validated.
        const replacement = await db.machine.create({ data: {
            id: crypto.randomUUID(), accountId: custodian.id, active: true, kind: "persistent",
            metadata: "{}", metadataVersion: 1,
            operationProtocolCapabilitiesRevision: 1,
        } });
        await expect(inTx(tx => updateTeamCredentialResourceInTx(tx, {
            actorAccountId: custodian.id,
            authentication: TEST_AUTHENTICATION,
            patch: {
                resourceId: resource.id, expectedRevision: revision + 2,
                brokerPlacement: { kind: "machine", machineId: replacement.id },
            },
        }))).resolves.toMatchObject({ ok: false });
    });

    // Child 01 §7.1 rule 5: narrowing the ceiling is a withdrawal of consent to
    // direct disclosure, not a grant of broker authority an ordinary custodian
    // may not create. `both` keeps its broker half; `direct` ends.
    it("ends direct-only grants when the ceiling narrows instead of converting them to brokered", async () => {
        const custodian = await db.account.create({ data: { encryptionMode: "plain", publicKey: null } });
        const directMember = await db.account.create({ data: { encryptionMode: "plain", publicKey: null } });
        const bothMember = await db.account.create({ data: { encryptionMode: "plain", publicKey: null } });
        const team = await db.team.create({ data: { name: "Ceiling narrowing" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: custodian.id, role: "member" } });
        const directMembership = await db.teamMembership.create({ data: { teamId: team.id, accountId: directMember.id, role: "member" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: bothMember.id, role: "member" } });
        const group = await db.teamGroup.create({ data: { teamId: team.id, name: "Both", nameKey: "both" } });
        const broker = await db.machine.create({ data: {
            id: `narrowing-broker-${custodian.id}`,
            accountId: custodian.id,
            metadata: "{}",
            kind: "persistent",
            operationProtocolCapabilities: { providerBrokerIngress: { protocolVersions: [1] } },
            operationProtocolCapabilitiesRevision: 1,
        } });
        const resource = await db.teamCredentialResource.create({ data: {
            teamId: team.id, custodianAccountId: custodian.id, displayName: "Narrowing source",
            disclosureCeiling: "direct_allowed", sessionUsePolicy: "personal_allowed",
            allMembersDeliveryMode: "direct", brokerMachineId: broker.id,
            sourceBindingJson: JSON.stringify({ v: 1, kind: "provider_connection", connectionId: "connection",
                connectionSecurityFingerprint: "connection-security:v1:test:narrowing", credentialSlotId: "apiKey" }),
            memberGrants: { create: { teamMembershipId: directMembership.id, deliveryMode: "direct" } },
            groupGrants: { create: { teamGroupId: group.id, deliveryMode: "both" } },
        } });

        await expect(inTx(tx => updateTeamCredentialResourceInTx(tx, {
            actorAccountId: custodian.id,
            authentication: TEST_AUTHENTICATION,
            patch: { resourceId: resource.id, expectedRevision: 0, deliveryPolicy: { preferredAllowedModes: ["brokered"] } },
        }))).resolves.toEqual({ ok: true, resourceId: resource.id, revision: 1 });

        await expect(db.teamCredentialResource.findUniqueOrThrow({ where: { id: resource.id } })).resolves.toMatchObject({
            disclosureCeiling: JSON.stringify({ policy: { preferredAllowedModes: ["brokered"] }, experimentalBindingConfirmations: [] }),
            allMembersDeliveryMode: null,
            revision: 1,
        });
        await expect(db.teamCredentialMemberGrant.findMany({ where: { resourceId: resource.id } })).resolves.toEqual([]);
        await expect(db.teamCredentialGroupGrant.findMany({
            where: { resourceId: resource.id }, select: { teamGroupId: true, deliveryMode: true },
        })).resolves.toEqual([{ teamGroupId: group.id, deliveryMode: JSON.stringify(["brokered"]) }]);
    });

    // The full editor's replacement narrows through the same rule as the PATCH
    // above. A source custodian can omit the audience it cannot read or edit;
    // narrowing still withdraws only its direct half.
    // A manager's deliberately chosen broker grant saved in the same
    // replacement is an explicit grant, not an automatic conversion.
    it.each(["full", "custodian-only"] as const)("applies the one narrowing rule when a %s replacement narrows the ceiling", async (mode) => {
        const custodian = await db.account.create({ data: { encryptionMode: "plain", publicKey: null } });
        const owner = await db.account.create({ data: { encryptionMode: "plain", publicKey: null } });
        const directMember = await db.account.create({ data: { encryptionMode: "plain", publicKey: null } });
        const team = await db.team.create({ data: { name: "Replacement narrowing" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: custodian.id, role: "member" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: "owner" } });
        const directMembership = await db.teamMembership.create({ data: { teamId: team.id, accountId: directMember.id, role: "member" } });
        const group = await db.teamGroup.create({ data: { teamId: team.id, name: "Both", nameKey: "both" } });
        const brokerFor = (accountId: string) => db.machine.create({ data: {
            id: `replacement-narrowing-broker-${accountId}`, accountId, metadata: "{}", kind: "persistent",
            operationProtocolCapabilities: { providerBrokerIngress: { protocolVersions: [1] } },
            operationProtocolCapabilitiesRevision: 1,
        } });
        const source = TeamCredentialSourceBindingV1Schema.parse({ v: 1, kind: "provider_connection", connectionId: "connection",
            connectionSecurityFingerprint: "connection-security:v1:test:replacement-narrowing", credentialSlotId: "apiKey" });
        const createResource = async (custodianAccountId: string, brokerMachineId: string) => await db.teamCredentialResource.create({ data: {
            teamId: team.id, custodianAccountId, displayName: "Replacement narrowing",
            disclosureCeiling: "direct_allowed", sessionUsePolicy: "personal_allowed",
            allMembersDeliveryMode: "direct", brokerMachineId, sourceBindingJson: JSON.stringify(source),
            memberGrants: { create: { teamMembershipId: directMembership.id, deliveryMode: "direct" } },
            groupGrants: { create: { teamGroupId: group.id, deliveryMode: "both" } },
        } });
        const replacementOf = (brokerMachineId: string) => ({
            enabled: true, displayName: "Replacement narrowing",
            sessionUsePolicy: "personal_allowed" as const, requestPolicy: null,
            allMembersAllowedRoutes: ["direct" as const],
            groupGrants: [{ teamGroupId: group.id, allowedRoutes: ["brokered" as const, "direct" as const] }],
            memberGrants: [{ teamMembershipId: directMembership.id, allowedRoutes: ["direct" as const] }],
            usageLimitDelta: { upserts: [], deleteIds: [] },
            custodian: {
                source, deliveryPolicy: { preferredAllowedModes: ["brokered" as const] },
                brokerPlacement: { kind: "machine" as const, machineId: brokerMachineId },
            },
        });

        const custodianBroker = await brokerFor(custodian.id);
        const custodianResource = await createResource(custodian.id, custodianBroker.id);
        await expect(inTx(tx => updateTeamCredentialResourceInTx(tx, {
            actorAccountId: custodian.id,
            authentication: TEST_AUTHENTICATION,
            patch: { resourceId: custodianResource.id, expectedRevision: 0, replacement: mode === "full"
                ? replacementOf(custodianBroker.id)
                : { custodian: replacementOf(custodianBroker.id).custodian } },
        }))).resolves.toEqual({ ok: true, resourceId: custodianResource.id, revision: 1 });
        await expect(db.teamCredentialResource.findUniqueOrThrow({ where: { id: custodianResource.id } })).resolves.toMatchObject({
            disclosureCeiling: JSON.stringify({ policy: { preferredAllowedModes: ["brokered"] }, experimentalBindingConfirmations: [] }),
            allMembersDeliveryMode: null,
        });
        await expect(db.teamCredentialMemberGrant.findMany({ where: { resourceId: custodianResource.id } })).resolves.toEqual([]);
        await expect(db.teamCredentialGroupGrant.findMany({
            where: { resourceId: custodianResource.id }, select: { teamGroupId: true, deliveryMode: true },
        })).resolves.toEqual([{ teamGroupId: group.id, deliveryMode: JSON.stringify(["brokered"]) }]);

        const ownerBroker = await brokerFor(owner.id);
        const ownerResource = await createResource(owner.id, ownerBroker.id);
        await expect(inTx(tx => updateTeamCredentialResourceInTx(tx, {
            actorAccountId: owner.id,
            authentication: TEST_AUTHENTICATION,
            patch: { resourceId: ownerResource.id, expectedRevision: 0, replacement: {
                ...replacementOf(ownerBroker.id),
                allMembersAllowedRoutes: null,
                groupGrants: [{ teamGroupId: group.id, allowedRoutes: ["brokered" as const] }],
                memberGrants: [{ teamMembershipId: directMembership.id, allowedRoutes: ["brokered" as const] }],
            } },
        }))).resolves.toEqual({ ok: true, resourceId: ownerResource.id, revision: 1 });
        await expect(db.teamCredentialMemberGrant.findMany({
            where: { resourceId: ownerResource.id }, select: { teamMembershipId: true, deliveryMode: true },
        })).resolves.toEqual([{ teamMembershipId: directMembership.id, deliveryMode: JSON.stringify(["brokered"]) }]);
    });

    it("keeps exact broker Machine selection under the source custodian authority", async () => {
        const custodian = await db.account.create({ data: { encryptionMode: "plain" } });
        const manager = await db.account.create({ data: { encryptionMode: "plain" } });
        const team = await db.team.create({ data: { name: "Broker authority" } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId: custodian.id, role: "member" },
            { teamId: team.id, accountId: manager.id, role: "admin" },
        ] });
        const broker = await db.machine.create({ data: {
            id: `private-broker-${custodian.id}`,
            accountId: custodian.id,
            metadata: "{}",
            kind: "persistent",
            operationProtocolCapabilities: { providerBrokerIngress: { protocolVersions: [1] } },
            operationProtocolCapabilitiesRevision: 1,
        } });
        const resource = await db.teamCredentialResource.create({ data: {
            teamId: team.id,
            custodianAccountId: custodian.id,
            displayName: "Owned broker source",
            disclosureCeiling: "direct_allowed",
            sessionUsePolicy: "personal_allowed",
            sourceBindingJson: JSON.stringify({
                v: 1,
                kind: "provider_connection",
                connectionId: "private-connection",
                connectionSecurityFingerprint: "connection-security:v1:private",
                credentialSlotId: "apiKey",
            }),
        } });

        await expect(inTx(tx => updateTeamCredentialResourceInTx(tx, {
            actorAccountId: manager.id,
            authentication: TEST_AUTHENTICATION,
            patch: { resourceId: resource.id, expectedRevision: 0, brokerPlacement: { kind: "machine", machineId: broker.id } },
        }))).resolves.toEqual({ ok: false, error: "resource_forbidden" });
        await expect(inTx(tx => updateTeamCredentialResourceInTx(tx, {
            actorAccountId: manager.id,
            authentication: TEST_AUTHENTICATION,
            patch: { resourceId: resource.id, expectedRevision: 0, deliveryPolicy: { preferredAllowedModes: ["brokered"] } },
        }))).resolves.toEqual({ ok: false, error: "resource_forbidden" });
        await db.teamMembership.deleteMany({ where: { teamId: team.id, accountId: custodian.id } });
        await expect(inTx(tx => updateTeamCredentialResourceInTx(tx, {
            actorAccountId: custodian.id,
            authentication: TEST_AUTHENTICATION,
            patch: { resourceId: resource.id, expectedRevision: 0, brokerPlacement: { kind: "machine", machineId: broker.id } },
        }))).resolves.toEqual({ ok: true, resourceId: resource.id, revision: 1 });
    });

    it("replaces the complete resource document and a bounded limit delta at one CAS revision", async () => {
        const custodian = await db.account.create({ data: { encryptionMode: "plain", publicKey: null } });
        const recipient = await db.account.create({ data: { encryptionMode: "plain", publicKey: null } });
        const team = await db.team.create({ data: { name: "Atomic replacement" } });
        const [custodianMembership, recipientMembership] = await Promise.all([
            db.teamMembership.create({ data: { teamId: team.id, accountId: custodian.id, role: "owner" } }),
            db.teamMembership.create({ data: { teamId: team.id, accountId: recipient.id, role: "member" } }),
        ]);
        const group = await db.teamGroup.create({ data: { teamId: team.id, name: "Builders", nameKey: "builders" } });
        const broker = await db.machine.create({ data: {
            id: `replacement-broker-${custodian.id}`, accountId: custodian.id, metadata: "{}", kind: "persistent",
            operationProtocolCapabilities: { providerBrokerIngress: { protocolVersions: [1] } },
            operationProtocolCapabilitiesRevision: 1,
        } });
        const originalSource = TeamCredentialSourceBindingV1Schema.parse({ v: 1, kind: "provider_connection", connectionId: "old-connection",
            connectionSecurityFingerprint: "connection-security:v1:old", credentialSlotId: "apiKey" });
        const nextSource = TeamCredentialSourceBindingV1Schema.parse({ ...originalSource, connectionId: "next-connection",
            connectionSecurityFingerprint: "connection-security:v1:next" });
        const resource = await db.teamCredentialResource.create({ data: {
            teamId: team.id, custodianAccountId: custodian.id, displayName: "Before",
            disclosureCeiling: "direct_allowed", sessionUsePolicy: "personal_allowed",
            sourceBindingJson: JSON.stringify(originalSource), directSourceVersionsJson: JSON.stringify({ old: "version" }),
        } });
        await db.teamCredentialRecipientMaterial.create({ data: {
            resourceId: resource.id, recipientAccountId: recipient.id, sourceMemberKey: "old", sourceVersion: "version",
            recipientMode: "plain", storedMaterial: new Uint8Array([1]),
        } });
        const [keptLimit, changedLimit, deletedLimit] = await Promise.all([
            db.teamCredentialUsageLimit.create({ data: { resourceId: resource.id, subjectKind: "resource", subjectId: "", period: "day", metric: "inference_requests", maximum: "5" } }),
            db.teamCredentialUsageLimit.create({ data: { resourceId: resource.id, subjectKind: "resource", subjectId: "", period: "week", metric: "inference_requests", maximum: "10" } }),
            db.teamCredentialUsageLimit.create({ data: { resourceId: resource.id, subjectKind: "resource", subjectId: "", period: "month", metric: "inference_requests", maximum: "20" } }),
        ]);
        const replacement = {
            enabled: false,
            displayName: "After",
            sessionUsePolicy: "team_context_required" as const,
            requestPolicy: null,
            allMembersAllowedRoutes: ["brokered" as const],
            groupGrants: [{ teamGroupId: group.id, allowedRoutes: ["brokered" as const] }],
            memberGrants: [{ teamMembershipId: recipientMembership.id, allowedRoutes: ["brokered" as const] }],
            usageLimitDelta: {
                upserts: [
                    { id: changedLimit.id, subjectKind: "resource" as const, subjectId: "", period: "week" as const, metric: "inference_requests" as const, maximum: "15", enabled: true },
                    { subjectKind: "team_member" as const, subjectId: recipient.id, period: "month" as const, metric: "inference_requests" as const, maximum: "30", enabled: true },
                ],
                deleteIds: [deletedLimit.id],
            },
            custodian: {
                source: nextSource,
                deliveryPolicy: { preferredAllowedModes: ["brokered" as const] },
                brokerPlacement: { kind: "machine" as const, machineId: broker.id },
            },
        };

        await expect(inTx(tx => updateTeamCredentialResourceInTx(tx, {
            actorAccountId: custodian.id, authentication: TEST_AUTHENTICATION,
            patch: { resourceId: resource.id, expectedRevision: 0, replacement },
        }))).resolves.toEqual({ ok: true, resourceId: resource.id, revision: 1 });
        await expect(db.teamCredentialResource.findUniqueOrThrow({ where: { id: resource.id } })).resolves.toMatchObject({
            enabled: false, displayName: "After", revision: 1, sourceBindingJson: JSON.stringify(nextSource),
            disclosureCeiling: JSON.stringify({ policy: { preferredAllowedModes: ["brokered"] }, experimentalBindingConfirmations: [] }), sessionUsePolicy: "team_context_required",
            brokerMachineId: broker.id, brokerPoolId: null, allMembersDeliveryMode: JSON.stringify(["brokered"]),
            directSourceVersionsJson: null,
        });
        await expect(db.teamCredentialGroupGrant.findMany({ where: { resourceId: resource.id } })).resolves.toEqual([
            expect.objectContaining({ teamGroupId: group.id, deliveryMode: JSON.stringify(["brokered"]) }),
        ]);
        await expect(db.teamCredentialMemberGrant.findMany({ where: { resourceId: resource.id } })).resolves.toEqual([
            expect.objectContaining({ teamMembershipId: recipientMembership.id, deliveryMode: JSON.stringify(["brokered"]) }),
        ]);
        const limits = await db.teamCredentialUsageLimit.findMany({ where: { resourceId: resource.id } });
        expect(limits).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: keptLimit.id, maximum: "5" }),
            expect.objectContaining({ id: changedLimit.id, maximum: "15" }),
            expect.objectContaining({ subjectKind: "team_member", subjectId: recipient.id, maximum: "30" }),
        ]));
        expect(limits.some(limit => limit.id === deletedLimit.id)).toBe(false);
        expect(await db.teamCredentialRecipientMaterial.count({ where: { resourceId: resource.id } })).toBe(0);
        expect(custodianMembership.accountId).toBe(custodian.id);
    });

    it("rejects stale sources, invalid limit deltas, and manager-authored source replacement without partial writes", async () => {
        const custodian = await db.account.create({ data: { encryptionMode: "plain", publicKey: null } });
        const manager = await db.account.create({ data: { encryptionMode: "plain", publicKey: null } });
        const team = await db.team.create({ data: { name: "Replacement validation" } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId: custodian.id, role: "owner" },
            { teamId: team.id, accountId: manager.id, role: "admin" },
        ] });
        const source = TeamCredentialSourceBindingV1Schema.parse({ v: 1, kind: "provider_connection", connectionId: "stable-connection",
            connectionSecurityFingerprint: "connection-security:v1:stable", credentialSlotId: "apiKey" });
        const resource = await db.teamCredentialResource.create({ data: {
            teamId: team.id, custodianAccountId: custodian.id, displayName: "Stable",
            disclosureCeiling: "brokered_only", sessionUsePolicy: "personal_allowed", sourceBindingJson: JSON.stringify(source),
        } });
        const limit = await db.teamCredentialUsageLimit.create({ data: {
            resourceId: resource.id, subjectKind: "resource", subjectId: "", period: "month",
            metric: "inference_requests", maximum: "10",
        } });
        const replacement = {
            enabled: true, displayName: "Must not persist",
            sessionUsePolicy: "personal_allowed" as const, requestPolicy: null,
            allMembersAllowedRoutes: null, groupGrants: [], memberGrants: [],
            usageLimitDelta: { upserts: [], deleteIds: [] },
            custodian: { source, deliveryPolicy: { preferredAllowedModes: ["brokered" as const] }, brokerPlacement: null },
        };
        const assertUnchanged = async () => {
            await expect(db.teamCredentialResource.findUniqueOrThrow({ where: { id: resource.id } })).resolves.toMatchObject({
                displayName: "Stable", revision: 0, sourceBindingJson: JSON.stringify(source),
            });
            await expect(db.teamCredentialUsageLimit.findUnique({ where: { id: limit.id } })).resolves.toMatchObject({ maximum: "10" });
        };

        await expect(inTx(tx => updateTeamCredentialResourceInTx(tx, {
            actorAccountId: custodian.id, authentication: TEST_AUTHENTICATION,
            patch: { resourceId: resource.id, expectedRevision: 0, replacement: {
                ...replacement,
                custodian: { ...replacement.custodian,
                    source: { v: 1, kind: "connected_pool", target: { kind: "group", service: { pluginId: "missing.source", localId: "source" }, groupId: "missing" }, poolIncarnation: "missing" } },
            } },
        }))).resolves.toEqual({ ok: false, error: "source_replaced_or_missing" });
        await assertUnchanged();
        await expect(inTx(tx => updateTeamCredentialResourceInTx(tx, {
            actorAccountId: custodian.id, authentication: TEST_AUTHENTICATION,
            patch: { resourceId: resource.id, expectedRevision: 0, replacement: {
                ...replacement,
                usageLimitDelta: { upserts: [{ id: "other-resource-limit", subjectKind: "resource", subjectId: "", period: "month", metric: "inference_requests", maximum: "20", enabled: true }], deleteIds: [] },
            } },
        }))).resolves.toEqual({ ok: false, error: "invalid_limit" });
        await assertUnchanged();
        await expect(inTx(tx => updateTeamCredentialResourceInTx(tx, {
            actorAccountId: manager.id, authentication: TEST_AUTHENTICATION,
            patch: { resourceId: resource.id, expectedRevision: 0, replacement: {
                ...replacement,
                custodian: { ...replacement.custodian, source: TeamCredentialSourceBindingV1Schema.parse({ ...source, connectionId: "manager-selected-source" }) },
            } },
        }))).resolves.toEqual({ ok: false, error: "resource_forbidden" });
        await assertUnchanged();
    });

    it("retains direct material for a policy-only replacement", async () => {
        const custodian = await db.account.create({ data: { encryptionMode: "plain", publicKey: null } });
        const recipient = await db.account.create({ data: { encryptionMode: "plain", publicKey: null } });
        const team = await db.team.create({ data: { name: "Policy-only replacement" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: custodian.id, role: "owner" } });
        const recipientMembership = await db.teamMembership.create({ data: {
            teamId: team.id,
            accountId: recipient.id,
            role: "member",
        } });
        const source = TeamCredentialSourceBindingV1Schema.parse({ v: 1, kind: "provider_connection", connectionId: "policy-connection",
            connectionSecurityFingerprint: "connection-security:v1:policy", credentialSlotId: "apiKey" });
        if (source.kind !== "provider_connection") throw new Error("Expected Provider Connection source");
        const resource = await db.teamCredentialResource.create({ data: {
            teamId: team.id, custodianAccountId: custodian.id, displayName: "Policy source", disclosureCeiling: "direct_allowed",
            sessionUsePolicy: "personal_allowed", sourceBindingJson: JSON.stringify(source), directSourceVersionsJson: JSON.stringify({ source: "v1" }),
        } });
        const material = await db.teamCredentialRecipientMaterial.create({ data: {
            resourceId: resource.id, recipientAccountId: recipient.id, sourceMemberKey: "source", sourceVersion: "v1",
            recipientMode: "plain", storedMaterial: new Uint8Array([7]),
        } });
        const grant = await db.teamCredentialMemberGrant.create({ data: {
            resourceId: resource.id,
            teamMembershipId: recipientMembership.id,
            deliveryMode: "direct",
        } });
        const limit = await db.teamCredentialUsageLimit.create({ data: {
            resourceId: resource.id,
            subjectKind: "resource",
            subjectId: "",
            period: "month",
            metric: "inference_requests",
            maximum: "10",
        } });
        const requestPolicy = {
            allowedProtocolKinds: ["openai_responses" as const], allowedModelIds: ["gpt-5"],
            reasoningEffort: null,
        };
        const requestPolicySupportModels = [{
            descriptor: { id: "gpt-5", name: "GPT-5" },
            application: {
                agentTargetKey: "agent:happier.agent.codex/codex",
                implementationIdentity: { pluginId: "happier.provider.openai", localId: "openai" },
                endpointTemplateId: "responses",
                protocol: "openai-responses" as const,
            },
            sourceRevision: "source-1",
            allowedProtocolKinds: ["openai_responses" as const],
            reasoningEffort: null,
        }];
        const requestPolicySupport = {
            source,
            sourceCurrentness: {
                kind: "provider_connection" as const,
                connectionId: source.connectionId,
                connectionSecurityFingerprint: source.connectionSecurityFingerprint,
                credentialSlotId: source.credentialSlotId,
            },
            models: requestPolicySupportModels,
        };
        const replacement = {
            enabled: true, displayName: "Policy source",
            sessionUsePolicy: "personal_allowed" as const, requestPolicy,
            allMembersAllowedRoutes: null,
            groupGrants: [],
            memberGrants: [{ teamMembershipId: recipientMembership.id, allowedRoutes: ["direct" as const] }],
            usageLimitDelta: { upserts: [], deleteIds: [] },
            custodian: { source, deliveryPolicy: { preferredAllowedModes: ["brokered" as const, "direct" as const] }, brokerPlacement: null },
        };
        await expect(inTx(tx => updateTeamCredentialResourceInTx(tx, {
            actorAccountId: custodian.id,
            authentication: TEST_AUTHENTICATION,
            patch: {
                resourceId: resource.id,
                expectedRevision: 0,
                replacement: {
                    ...replacement,
                    memberGrants: [],
                    usageLimitDelta: { upserts: [], deleteIds: [limit.id] },
                },
            },
        }))).resolves.toEqual({ ok: false, error: "update_required" });
        await expect(db.teamCredentialResource.findUniqueOrThrow({ where: { id: resource.id } })).resolves.toMatchObject({
            revision: 0,
            requestPolicyJson: null,
            directSourceVersionsJson: JSON.stringify({ source: "v1" }),
        });
        expect(await db.teamCredentialRecipientMaterial.count({ where: { id: material.id } })).toBe(1);
        expect(await db.teamCredentialMemberGrant.count({ where: {
            resourceId: resource.id,
            teamMembershipId: grant.teamMembershipId,
        } })).toBe(1);
        expect(await db.teamCredentialUsageLimit.count({ where: { id: limit.id } })).toBe(1);
        await expect(inTx(tx => updateTeamCredentialResourceInTx(tx, {
            actorAccountId: custodian.id,
            authentication: TEST_AUTHENTICATION,
            requestPolicySupport: {
                ...requestPolicySupport,
                sourceCurrentness: {
                    ...requestPolicySupport.sourceCurrentness,
                    connectionSecurityFingerprint: "connection-security:v1:stale-support",
                },
            },
            patch: { resourceId: resource.id, expectedRevision: 0, replacement },
        }))).resolves.toEqual({ ok: false, error: "update_required" });
        await expect(db.teamCredentialResource.findUniqueOrThrow({ where: { id: resource.id } }))
            .resolves.toMatchObject({ revision: 0, requestPolicyJson: null });
        await expect(inTx(tx => updateTeamCredentialResourceInTx(tx, {
            actorAccountId: custodian.id, authentication: TEST_AUTHENTICATION,
            requestPolicySupport,
            patch: { resourceId: resource.id, expectedRevision: 0, replacement },
        }))).resolves.toEqual({ ok: true, resourceId: resource.id, revision: 1 });
        expect(await db.teamCredentialRecipientMaterial.count({ where: { id: material.id } })).toBe(1);
        expect((await db.teamCredentialResource.findUniqueOrThrow({ where: { id: resource.id } })).directSourceVersionsJson).toBe(JSON.stringify({ source: "v1" }));
        await expect(inTx(tx => updateTeamCredentialResourceInTx(tx, {
            actorAccountId: custodian.id,
            authentication: TEST_AUTHENTICATION,
            patch: { resourceId: resource.id, expectedRevision: 1, enabled: false },
        }))).resolves.toEqual({ ok: true, resourceId: resource.id, revision: 2 });
        await expect(db.teamCredentialResource.findUniqueOrThrow({ where: { id: resource.id } }))
            .resolves.toMatchObject({
                enabled: false,
                requestPolicyJson: JSON.stringify(requestPolicy),
            });
    });

    it("lets a manager replace only public administration fields while preserving custodian authority", async () => {
        const custodian = await db.account.create({ data: { encryptionMode: "plain", publicKey: null } });
        const manager = await db.account.create({ data: { encryptionMode: "plain", publicKey: null } });
        const member = await db.account.create({ data: { encryptionMode: "plain", publicKey: null } });
        const team = await db.team.create({ data: { name: "Manager replacement" } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId: custodian.id, role: "owner" },
            { teamId: team.id, accountId: manager.id, role: "admin" },
            { teamId: team.id, accountId: member.id, role: "member" },
        ] });
        const broker = await db.machine.create({ data: {
            id: `manager-replacement-broker-${custodian.id}`,
            accountId: custodian.id,
            metadata: "{}",
            kind: "persistent",
            operationProtocolCapabilities: { providerBrokerIngress: { protocolVersions: [1] } },
            operationProtocolCapabilitiesRevision: 1,
        } });
        const source = TeamCredentialSourceBindingV1Schema.parse({
            v: 1,
            kind: "provider_connection",
            connectionId: "manager-hidden-connection",
            connectionSecurityFingerprint: "connection-security:v1:manager-hidden",
            credentialSlotId: "apiKey",
        });
        if (source.kind !== "provider_connection") throw new Error("Expected Provider Connection source");
        const resource = await db.teamCredentialResource.create({ data: {
            teamId: team.id,
            custodianAccountId: custodian.id,
            displayName: "Before manager edit",
            disclosureCeiling: "brokered_only",
            sessionUsePolicy: "personal_allowed",
            sourceBindingJson: JSON.stringify(source),
            brokerMachineId: broker.id,
        } });
        const managerReplacement = {
            enabled: true,
            displayName: "After manager edit",
            sessionUsePolicy: "team_context_required" as const,
            requestPolicy: {
                allowedProtocolKinds: ["openai_responses" as const],
                allowedModelIds: ["gpt-5"],
                reasoningEffort: null,
            },
            allMembersAllowedRoutes: ["brokered" as const],
            groupGrants: [],
            memberGrants: [],
            usageLimitDelta: { upserts: [], deleteIds: [] },
        };

        const unchangedManagerDocument = {
            ...managerReplacement,
            displayName: "Before manager edit",
            sessionUsePolicy: "personal_allowed" as const,
            requestPolicy: null,
            allMembersAllowedRoutes: null,
        };
        const requestPolicySupportModels = [{
            descriptor: { id: "gpt-5", name: "GPT-5" },
            application: {
                agentTargetKey: "agent:happier.agent.codex/codex",
                implementationIdentity: { pluginId: "happier.provider.openai", localId: "openai" },
                endpointTemplateId: "responses",
                protocol: "openai-responses" as const,
            },
            sourceRevision: "source-1",
            allowedProtocolKinds: ["openai_responses" as const],
            reasoningEffort: null,
        }];
        const requestPolicySupport = {
            source,
            sourceCurrentness: {
                kind: "provider_connection" as const,
                connectionId: source.connectionId,
                connectionSecurityFingerprint: source.connectionSecurityFingerprint,
                credentialSlotId: source.credentialSlotId,
            },
            models: requestPolicySupportModels,
        };
        await expect(inTx(tx => updateTeamCredentialResourceInTx(tx, {
            actorAccountId: member.id,
            authentication: TEST_AUTHENTICATION,
            patch: { resourceId: resource.id, expectedRevision: 0, replacement: unchangedManagerDocument },
        }))).resolves.toEqual({ ok: false, error: "resource_forbidden" });

        await expect(inTx(tx => updateTeamCredentialResourceInTx(tx, {
            actorAccountId: manager.id,
            authentication: TEST_AUTHENTICATION,
            requestPolicySupport,
            patch: { resourceId: resource.id, expectedRevision: 0, replacement: managerReplacement },
        }))).resolves.toEqual({ ok: true, resourceId: resource.id, revision: 1 });
        await expect(db.teamCredentialResource.findUniqueOrThrow({ where: { id: resource.id } })).resolves.toMatchObject({
            revision: 1,
            displayName: "After manager edit",
            sourceBindingJson: JSON.stringify(source),
            disclosureCeiling: JSON.stringify({ policy: { preferredAllowedModes: ["brokered"] }, experimentalBindingConfirmations: [] }),
            brokerMachineId: broker.id,
            brokerPoolId: null,
        });

        await expect(inTx(tx => updateTeamCredentialResourceInTx(tx, {
            actorAccountId: manager.id,
            authentication: TEST_AUTHENTICATION,
            patch: { resourceId: resource.id, expectedRevision: 0, replacement: managerReplacement },
        }))).resolves.toEqual({ ok: false, error: "resource_changed" });

        // A manager never carries the source custodian's consent, so a custodian
        // block from one is refused before any disclosure rule is consulted.
        await expect(inTx(tx => updateTeamCredentialResourceInTx(tx, {
            actorAccountId: manager.id,
            authentication: TEST_AUTHENTICATION,
            patch: { resourceId: resource.id, expectedRevision: 1, replacement: {
                ...managerReplacement,
                custodian: {
                    source,
                    deliveryPolicy: { preferredAllowedModes: ["brokered", "direct"] },
                    brokerPlacement: { kind: "machine", machineId: broker.id },
                },
            } },
        }))).resolves.toEqual({ ok: false, error: "resource_forbidden" });

        // A02: the active source custodian MAY widen brokered_only -> direct_allowed.
        // The widening arrives only inside the custodian block, which is that
        // custodian's own explicit disclosure consent; the source must still be
        // current and able to export direct material.
        await expect(inTx(tx => updateTeamCredentialResourceInTx(tx, {
            actorAccountId: custodian.id,
            authentication: TEST_AUTHENTICATION,
            patch: { resourceId: resource.id, expectedRevision: 1, replacement: {
                ...managerReplacement,
                custodian: {
                    source,
                    deliveryPolicy: { preferredAllowedModes: ["brokered", "direct"] },
                    brokerPlacement: { kind: "machine", machineId: broker.id },
                },
            } },
        }))).resolves.toEqual({ ok: true, resourceId: resource.id, revision: 2 });
        await expect(db.teamCredentialResource.findUniqueOrThrow({ where: { id: resource.id } })).resolves.toMatchObject({
            revision: 2,
            disclosureCeiling: JSON.stringify({ policy: { preferredAllowedModes: ["brokered", "direct"] }, experimentalBindingConfirmations: [] }),
            sourceBindingJson: JSON.stringify(source),
        });
    });
});
