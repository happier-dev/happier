import { plainPrivateLabel, storedPlainPrivateLabel } from "@/testkit/privateLabelFixture";
import { MACHINE_RECIPIENT_ACCESS_CHANGE_KIND_V1 } from "@happier-dev/protocol/changes";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { homeDomainActionPathForMethod } from "@/app/api/routes/actions/homeDomainActionRoute";
import { peerMediationGrantSigningEnv } from "@/testkit/env";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { resolveEffectiveMachineRoleInTx } from "@/app/machines/machineAccess";
import { resolveStructuralSessionAccessForAccountsInTx } from "@/app/session/access/sessionAccess";
import { HOME_GOVERNANCE_POLICY_ID } from "@/app/home/governance/governancePolicy";
import { createQualifiedConnectedAccountGroupDigest, createQualifiedConnectedAccountServiceDigest } from "@/app/api/routes/connect/qualifiedConnectedAccounts/identity";
import { initEncrypt } from "@/modules/encrypt";
import { db, getDbProviderFromEnv, initDbPostgres } from "@/storage/db";
import { inTx, readPostgresTransactionSqlState, type Tx } from "@/storage/inTx";
import { registerTeamRoutes } from "./registerTeamRoutes";
import { registerTeamMemberRoutes } from "./memberships/registerTeamMemberRoutes";
import { registerTeamGroupRoutes } from "./groups/registerTeamGroupRoutes";
import { registerTeamInvitationRoutes } from "./invitations/registerTeamInvitationRoutes";
import { digestTeamInvitationToken, mintTeamInvitationToken } from "./invitations/token";
import { readWebLatencyRequestId } from "@/utils/webLatencyTrace";
import { enableMonitoring } from "@/app/api/utils/enableMonitoring";

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("Team write contention (PostgreSQL)", () => {
    const accountIds: string[] = [];
    const teamIds: string[] = [];
    let app: ReturnType<typeof createAuthenticatedTestApp>;
    let connected = false;
    const previousEnv = new Map<string, string | undefined>();

    beforeAll(async () => {
        // The runner creates this URL; never fall back to retained development data.
        const supplied = process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL;
        if (!supplied || process.env.DATABASE_URL !== supplied) throw new Error("Use the disposable PostgreSQL DB-contract harness");
        for (const [key, value] of Object.entries({
            HANDY_MASTER_SECRET: "fix-c74-disposable-test",
            HAPPIER_FEATURE_TEAMS__ENABLED: "1",
            HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED: "1",
            HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES_EXTERNAL_API__ENABLED: "1",
            HAPPIER_PUBLIC_SERVER_URL: "https://home.example.test",
            ...peerMediationGrantSigningEnv(),
            HAPPIER_DB_CONNECTION_LIMIT: "10",
        })) {
            previousEnv.set(key, process.env[key]);
            process.env[key] = value;
        }
        await initEncrypt();
        initDbPostgres();
        await db.$connect();
        connected = true;
        await db.homeGovernancePolicy.upsert({
            where: { id: HOME_GOVERNANCE_POLICY_ID },
            create: { id: HOME_GOVERNANCE_POLICY_ID, revision: 1, teamCreationPolicy: "self_service" },
            update: { teamCreationPolicy: "self_service" },
        });
        app = createAuthenticatedTestApp();
        enableMonitoring(app);
        registerTeamRoutes(app);
        registerTeamMemberRoutes(app);
        registerTeamGroupRoutes(app);
        registerTeamInvitationRoutes(app, {
            resolveJoinLinkTarget: async () => ({ applicationOrigin: "https://app.example.test", homeTarget: "contention-home" }),
            resolveJoinScreenHomeIdentity: async () => ({ serverId: "contention-home", displayName: "Contention Home", storageMode: "plain", hosting: null }),
            email: { delivery: { isReady: async () => true, deliver: async () => ({ status: "sent" }) }, isDeliveryReady: () => true },
        });
        await app.ready();
    });

    afterAll(async () => {
        if (app) await app.close();
        if (connected) {
            await db.teamCredentialExternalApiKey.deleteMany({ where: { resource: { teamId: { in: teamIds } } } });
            await db.teamCredentialResource.deleteMany({ where: { teamId: { in: teamIds } } });
            await db.team.deleteMany({ where: { id: { in: teamIds } } });
            await db.machine.deleteMany({ where: { accountId: { in: accountIds } } });
            await db.account.deleteMany({ where: { id: { in: accountIds } } });
            await db.$disconnect();
        }
        for (const [key, value] of previousEnv) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });

    async function account() {
        const row = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" } });
        accountIds.push(row.id);
        return row;
    }

    async function fixture(kind: "create" | "update" | "policy" | "group_update" | "role" | "invitation_revoke" | "invitation_reissue" | "invitation_accept" | "member" | "provider_resource" | "pool_resource" | "archive" | "restore" | "resource_delete" | "key_revoke" | "keys_revoke_all" | "limit_delete" | "material_withdraw") {
        const owner = await account();
        if (kind === "create") return {
            owner, url: "/v1/teams/create", payload: { v: 1, name: "Contended Team", requestKey: randomUUID() },
            verify: async (body: { id: string }) => {
                teamIds.push(body.id);
                expect(await db.teamMembership.findUniqueOrThrow({ where: {
                    teamId_accountId: { teamId: body.id, accountId: owner.id },
                } })).toMatchObject({ role: "owner", status: "active" });
            },
        };
        const team = await db.team.create({ data: { name: "Contended membership and credentials" } });
        teamIds.push(team.id);
        const membership = await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: "owner" } });
        if (kind === "update") return {
            owner, url: "/v1/teams/update", payload: { v: 1, teamId: team.id, name: "Updated under contention" },
            verify: async (body: { id: string }) => {
                expect(body.id).toBe(team.id);
                expect(await db.team.findUniqueOrThrow({ where: { id: team.id } }))
                    .toMatchObject({ name: "Updated under contention" });
            },
        };
        if (kind === "policy") return {
            owner, url: "/v1/teams/policy/set", payload: { v: 1, teamId: team.id,
                previousAuthenticationPolicy: null, authenticationPolicy: null, defaultSessionHistoryAccess: "all_existing" },
            verify: async (body: { id: string }) => {
                expect(body.id).toBe(team.id);
                expect(await db.team.findUniqueOrThrow({ where: { id: team.id } }))
                    .toMatchObject({ defaultSessionHistoryAccess: "all_existing" });
            },
        };
        if (kind === "group_update") {
            const group = await db.teamGroup.create({ data: { teamId: team.id, name: storedPlainPrivateLabel("Initial group") } });
            return {
                owner, url: "/v1/teams/groups/update", payload: { v: 1, teamId: team.id, groupId: group.id, name: plainPrivateLabel("Updated group") },
                verify: async () => {
                    expect(await db.teamGroup.findUniqueOrThrow({ where: { id: group.id } })).toMatchObject({ name: storedPlainPrivateLabel("Updated group") });
                },
            };
        }
        if (kind === "role") {
            const target = await account();
            const member = await db.teamMembership.create({ data: { teamId: team.id, accountId: target.id, role: "member" } });
            return {
                owner, url: "/v1/teams/members/role/set", payload: { v: 1, teamId: team.id, membershipId: member.id, role: "admin" },
                verify: async () => {
                    expect(await db.teamMembership.findUniqueOrThrow({ where: { id: member.id } })).toMatchObject({ role: "admin" });
                },
            };
        }
        if (kind === "invitation_revoke" || kind === "invitation_reissue" || kind === "invitation_accept") {
            const token = mintTeamInvitationToken();
            const invitation = await db.teamInvitation.create({ data: { teamId: team.id, tokenHash: new Uint8Array(digestTeamInvitationToken(token)),
                role: "member", historyAccess: "from_membership", expiresAt: new Date(Date.now() + 86_400_000) } });
            if (kind === "invitation_accept") {
                const recipient = await account();
                return {
                    owner: recipient, url: "/v1/team-invitations/accept", payload: { v: 1, token },
                    verify: async () => {
                        expect(await db.teamInvitation.findUniqueOrThrow({ where: { id: invitation.id } }))
                            .toMatchObject({ acceptedByAccountId: recipient.id });
                        expect(await db.teamMembership.count({ where: { teamId: team.id, accountId: recipient.id } })).toBe(1);
                    },
                };
            }
            return {
                owner, url: kind === "invitation_revoke" ? "/v1/teams/invitations/revoke" : "/v1/teams/invitations/reissue",
                payload: { v: 1, teamId: team.id, invitationId: invitation.id,
                    ...(kind === "invitation_reissue" ? { recipientEmail: null, requestKey: randomUUID() } : {}) },
                verify: async () => {
                    expect((await db.teamInvitation.findUniqueOrThrow({ where: { id: invitation.id } })).revokedAt).not.toBeNull();
                    expect(await db.teamInvitation.count({ where: { teamId: team.id } })).toBe(kind === "invitation_reissue" ? 2 : 1);
                },
            };
        }
        if (kind === "resource_delete" || kind === "key_revoke" || kind === "keys_revoke_all" || kind === "limit_delete" || kind === "material_withdraw") {
            const resource = await db.teamCredentialResource.create({ data: {
                teamId: team.id, custodianAccountId: owner.id, displayName: "Contended deletion",
                disclosureCeiling: "brokered_only", sessionUsePolicy: "personal_allowed",
                sourceBindingJson: JSON.stringify({ v: 1, kind: "provider_connection", connectionId: randomUUID(),
                    connectionSecurityFingerprint: `connection-security:v1:${"r".repeat(43)}`, credentialSlotId: "apiKey" }),
                directSourceVersionsJson: JSON.stringify({ member: "current", sibling: "retained" }),
            } });
            const key = await db.teamCredentialExternalApiKey.create({ data: {
                resourceId: resource.id, teamMembershipId: membership.id, label: "Disposable key",
                secretDigest: randomUUID(), displayPrefix: "fixture",
            } });
            if (kind === "limit_delete") {
                const limit = await db.teamCredentialUsageLimit.create({ data: {
                    resourceId: resource.id, subjectKind: "resource", period: "day", metric: "inference_requests", maximum: "10",
                } });
                return {
                    owner, url: homeDomainActionPathForMethod("teams.credentials.limits.delete", "POST"),
                    payload: { resourceId: resource.id, expectedRevision: resource.revision, limitId: limit.id },
                    verify: async () => {
                        expect(await db.teamCredentialUsageLimit.count({ where: { resourceId: resource.id } })).toBe(0);
                        expect(await db.teamCredentialResource.findUniqueOrThrow({ where: { id: resource.id } })).toMatchObject({ revision: resource.revision });
                    },
                };
            }
            if (kind === "material_withdraw") {
                for (const [sourceMemberKey, sourceVersion] of [["member", "current"], ["sibling", "retained"]]) {
                    await db.teamCredentialRecipientMaterial.create({ data: {
                        resourceId: resource.id, recipientAccountId: owner.id, sourceMemberKey, sourceVersion,
                        recipientMode: "plain", storedMaterial: Buffer.from("{}"),
                    } });
                }
                return {
                    owner, method: "DELETE" as const, url: `/v2/teams/${team.id}/credential-resources/${resource.id}/direct-material`,
                    payload: { sourceMemberKey: "member", expectedResourceRevision: resource.revision, expectedPublishedSourceVersion: "current" },
                    verify: async () => {
                        expect(await db.teamCredentialRecipientMaterial.findMany({ where: { resourceId: resource.id }, select: { sourceMemberKey: true } }))
                            .toEqual([{ sourceMemberKey: "sibling" }]);
                        expect((await db.teamCredentialResource.findUniqueOrThrow({ where: { id: resource.id } })).directSourceVersionsJson)
                            .toBe(JSON.stringify({ sibling: "retained" }));
                    },
                };
            }
            return {
                owner,
                url: homeDomainActionPathForMethod(kind === "resource_delete" ? "teams.credentials.delete"
                    : kind === "key_revoke" ? "teams.credentials.externalKeys.revoke" : "teams.credentials.externalKeys.revokeAll", "POST"),
                payload: { resourceId: resource.id, ...(kind === "resource_delete" ? { expectedRevision: resource.revision }
                    : kind === "key_revoke" ? { keyId: key.id } : {}) },
                verify: async () => {
                    expect(await db.teamCredentialExternalApiKey.count({ where: { resourceId: resource.id } })).toBe(0);
                    expect(await db.teamCredentialResource.count({ where: { id: resource.id } })).toBe(kind === "resource_delete" ? 0 : 1);
                    expect(await db.teamCredentialActivityEvent.count({ where: {
                        resourceId: resource.id, kind: kind === "resource_delete" ? "resource_deleted" : "external_key_revoked",
                    } })).toBe(1);
                },
            };
        }
        if (kind === "archive" || kind === "restore") {
            if (kind === "restore") await db.team.update({ where: { id: team.id }, data: { archivedAt: new Date() } });
            return {
                owner, url: `/v1/teams/${kind}`, payload: { v: 1, teamId: team.id },
                verify: async (body: { id: string }) => {
                    expect(body.id).toBe(team.id);
                    const persisted = await db.team.findUniqueOrThrow({ where: { id: team.id } });
                    if (kind === "archive") expect(persisted.archivedAt).not.toBeNull();
                    else expect(persisted.archivedAt).toBeNull();
                },
            };
        }
        if (kind === "member") {
            const target = await account();
            return {
                owner, url: "/v1/teams/members/add",
                payload: { v: 1, teamId: team.id, accountId: target.id, role: "member", historyAccess: "all_existing" },
                verify: async (body: { id: string }) => {
                    expect(await db.teamMembership.findUniqueOrThrow({ where: { id: body.id } }))
                        .toMatchObject({ teamId: team.id, accountId: target.id, role: "member", status: "active" });
                },
            };
        }
        const machine = await db.machine.create({ data: {
            id: randomUUID(), accountId: owner.id, metadata: "{}", kind: "persistent",
            operationProtocolCapabilities: { providerBrokerIngress: { protocolVersions: [1] } },
            operationProtocolCapabilitiesRevision: 1,
        } });
        const service = { pluginId: "example.fix-c74", localId: "accounts" };
        const groupId = randomUUID();
        const group = await db.connectedServiceAuthGroup.create({ data: {
            accountId: owner.id, servicePluginId: service.pluginId, serviceLocalId: service.localId,
            qualifiedServiceDigest: createQualifiedConnectedAccountServiceDigest(service),
            qualifiedGroupDigest: createQualifiedConnectedAccountGroupDigest({ service, groupId }),
            groupId, displayName: "Contended Connected Pool", policyJson: "{}",
        } });
        const source = kind === "pool_resource" ? {
            v: 1, kind: "connected_pool", target: { kind: "group", service, groupId }, poolIncarnation: group.id,
        } : {
            v: 1, kind: "provider_connection", connectionId: `source-${randomUUID()}`,
            connectionSecurityFingerprint: `connection-security:v1:${"r".repeat(43)}`, credentialSlotId: "apiKey",
        };
        const resourceId = randomUUID();
        return {
            owner, url: "/v1/teams/credential-resources/create", payload: {
                teamId: team.id, resourceId, displayName: plainPrivateLabel("Contended broker resource"), source,
                deliveryPolicy: { preferredAllowedModes: ["brokered"] }, sessionUsePolicy: "personal_allowed",
                brokerPlacement: { kind: "machine", machineId: machine.id }, requestPolicy: null,
                allMembersAllowedRoutes: ["brokered"], groupGrants: [], memberGrants: [], usageLimits: [],
            },
            verify: async (body: { id: string }) => {
                expect(body.id).toBe(resourceId);
                expect(await db.teamCredentialResource.findUniqueOrThrow({ where: { id: resourceId } }))
                    .toMatchObject({ teamId: team.id, custodianAccountId: owner.id, sourceBindingJson: JSON.stringify(source) });
            },
        };
    }

    it("archives an otherwise idle Team and preserves the committed timestamp on retry", async () => {
        const input = await fixture("archive");
        const post = () => app.inject({ method: "POST", url: input.url,
            headers: { "x-test-user-id": input.owner.id }, payload: input.payload });
        const response = await post();
        expect(response.statusCode, response.body).toBe(200);
        await input.verify(response.json());
        const repeated = await post();
        expect(repeated.statusCode, repeated.body).toBe(200);
        expect(repeated.json().archivedAt).toBe(response.json().archivedAt);
    });

    it.each(["update", "policy"] as const)("rechecks Team %s authority after a membership change wins the Team lock", async kind => {
        const input = await fixture(kind);
        if (!("teamId" in input.payload) || typeof input.payload.teamId !== "string") throw new Error("Team update fixture requires a Team");
        const teamId = input.payload.teamId;
        const post = async () => await app.inject({ method: "POST", url: input.url,
            headers: { "x-test-user-id": input.owner.id }, payload: input.payload });
        let release!: () => void;
        let ready!: (pid: number) => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        const started = new Promise<number>(resolve => { ready = resolve; });
        const holder = db.$transaction(async tx => {
            const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
            await tx.$queryRaw`SELECT "id" FROM "Team" WHERE "id" = ${teamId} FOR NO KEY UPDATE`;
            await tx.teamMembership.update({ where: { teamId_accountId: {
                teamId, accountId: input.owner.id,
            } }, data: { role: "member" } });
            ready(pid);
            await held;
        });
        const holderOutcome = Promise.allSettled([holder]);
        let response: ReturnType<typeof post> | undefined;
        try {
            const pid = await Promise.race([started, holder.then(() => { throw new Error("Authority holder missed rendezvous"); })]);
            let finished = false;
            response = post().finally(() => { finished = true; });
            let blocked: Array<{ query: string }> = [];
            while (!finished && blocked.length === 0) {
                blocked = await db.$queryRaw<Array<{ query: string }>>`
                    SELECT query FROM pg_stat_activity WHERE datname = current_database()
                        AND ${pid}::int = ANY(pg_blocking_pids(pid))
                `;
            }
            expect(blocked, "Team update must wait for the resource before deciding authority").toHaveLength(1);
            expect(blocked[0].query).toMatch(/Team.*FOR NO KEY UPDATE/s);
            release();
            const result = await response;
            expect(result.statusCode, result.body).toBe(403);
            expect(result.json()).toMatchObject({ error: "team_forbidden" });
            expect((await db.team.findUniqueOrThrow({ where: { id: teamId } })).name)
                .toBe("Contended membership and credentials");
        } finally {
            release();
            await holderOutcome;
            await response;
        }
    });


    it("archives and restores retained Team access atomically without reviving invitations", async () => {
        const owner = await account();
        const member = await account();
        const outsider = await account();
        const team = await db.team.create({ data: { name: "Retained Team access" } });
        teamIds.push(team.id);
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: "owner" } });
        const membership = await db.teamMembership.create({ data: { teamId: team.id, accountId: member.id, role: "member" } });
        const group = await db.teamGroup.create({ data: { teamId: team.id, name: storedPlainPrivateLabel("Operators") } });
        await db.teamGroupMembership.create({ data: {
            teamId: team.id, teamGroupId: group.id, teamMembershipId: membership.id, nativeContribution: true,
        } });
        const session = await db.session.create({ data: {
            accountId: owner.id, tag: randomUUID(), metadata: "{}", encryptionMode: "plain", currentStorageState: "hosted",
            responsibleAccountId: member.id,
            grants: { create: { principalKind: "team", teamId: team.id, accessLevel: "edit", effectiveAt: new Date() } },
        } });
        const machine = await db.machine.create({ data: {
            id: randomUUID(), accountId: owner.id, metadata: "{}", kind: "persistent",
            grants: { create: { principalKind: 'group', teamGroupId: group.id, accessLevel: "view", createdByAccountId: owner.id } },
        } });
        const invitation = await db.teamInvitation.create({ data: {
            teamId: team.id, tokenHash: Buffer.from(randomUUID()), role: "member", historyAccess: "from_membership",
            expiresAt: new Date(Date.now() + 86_400_000),
        } });
        const sessionAccess = () => inTx(tx => resolveStructuralSessionAccessForAccountsInTx(tx, {
            sessionId: session.id, accountIds: [member.id],
        }));
        const machineRole = () => inTx(tx => resolveEffectiveMachineRoleInTx(tx, {
            actorAccountId: member.id, machineId: machine.id,
        }));
        const post = (operation: "archive" | "restore", actorAccountId = owner.id) => app.inject({
            method: "POST", url: `/v1/teams/${operation}`, headers: { "x-test-user-id": actorAccountId },
            payload: { v: 1, teamId: team.id },
        });
        try {
            expect((await sessionAccess()).get(member.id)?.capabilities.readTranscript).toBe(true);
            expect(await machineRole()).toBe("use");
            expect((await post("archive", outsider.id)).statusCode).toBe(404);
            expect((await db.team.findUniqueOrThrow({ where: { id: team.id } })).archivedAt).toBeNull();
            const archived = await post("archive");
            expect(archived.statusCode, archived.body).toBe(200);
            expect((await sessionAccess()).get(member.id)).toBeNull();
            expect(await machineRole()).toBeNull();
            expect((await db.session.findUniqueOrThrow({ where: { id: session.id } })).responsibleAccountId).toBeNull();
            const revokedAt = (await db.teamInvitation.findUniqueOrThrow({ where: { id: invitation.id } })).revokedAt;
            expect(revokedAt).not.toBeNull();
            for (const [kind, entityId] of [["session", session.id], [MACHINE_RECIPIENT_ACCESS_CHANGE_KIND_V1, machine.id]] as const) {
                expect(await db.accountChange.count({ where: { accountId: member.id, kind, entityId } })).toBeGreaterThan(0);
            }
            expect(await db.accountChange.count({ where: { accountId: member.id, kind: "machine", entityId: machine.id } })).toBe(0);
            const restored = await post("restore");
            expect(restored.statusCode, restored.body).toBe(200);
            expect((await sessionAccess()).get(member.id)?.capabilities.readTranscript).toBe(true);
            expect(await machineRole()).toBe("use");
            expect(await db.teamMembership.count({ where: { teamId: team.id } })).toBe(2);
            expect((await db.teamInvitation.findUniqueOrThrow({ where: { id: invitation.id } })).revokedAt).toEqual(revokedAt);
        } finally {
            await db.session.delete({ where: { id: session.id } });
        }
    });

    it("keeps one Team when the same creation intent arrives during its dedupe read", async () => {
        const input = await fixture("create");
        const original = db.$transaction;
        const competitorScope = new AsyncLocalStorage<boolean>();
        let scheduled = false;
        const post = async () => await app.inject({ method: "POST", url: input.url,
            headers: { "x-test-user-id": input.owner.id }, payload: input.payload });
        let competitor: ReturnType<typeof post> | undefined;
        let competitorOutcome: Promise<PromiseSettledResult<Awaited<ReturnType<typeof post>>>[]> | undefined;
        let blockedPeer = false;
        db.$transaction = new Proxy(original, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== "function") return Reflect.apply(target, receiver, args);
            const isCompetitor = competitorScope.getStore();
            return Reflect.apply(target, receiver, [async (tx: Tx) => {
                if (isCompetitor) {
                    return callback(tx);
                }
                const dedupe = new Proxy(tx.repeatKey, { get(owner, property, receiver) {
                    if (property !== "findUnique") return Reflect.get(owner, property, receiver);
                    return async (...values: Parameters<typeof owner.findUnique>) => {
                        const found = await owner.findUnique(...values);
                        if (!scheduled && found === null) {
                            scheduled = true;
                            const [{ pid: firstPid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
                            let settled = false;
                            competitor = competitorScope.run(true, post);
                            competitorOutcome = Promise.allSettled([competitor]).finally(() => { settled = true; });
                            // Authentication can use an earlier transaction on
                            // another backend. Observe the actual waiter on
                            // this admitted creation, not that earlier PID.
                            while (!settled) {
                                const [{ blocked }] = await db.$queryRaw<Array<{ blocked: boolean }>>`
                                    SELECT EXISTS (SELECT 1 FROM pg_stat_activity
                                        WHERE datname = current_database()
                                        AND ${firstPid}::int = ANY(pg_blocking_pids(pid))) AS blocked
                                `;
                                if (blocked) { blockedPeer = true; break; }
                            }
                        }
                        return found;
                    };
                } });
                return callback(new Proxy(tx, { get(owner, property, receiver) {
                    return property === "repeatKey" ? dedupe : Reflect.get(owner, property, receiver);
                } }));
            }, ...args.slice(1)]);
        } });
        try {
            const first = await post();
            expect(first.statusCode, first.body).toBe(200);
            teamIds.push(first.json().id);
            if (!competitor) throw new Error("Creation did not reach the dedupe boundary");
            const second = await competitor;
            expect(second.statusCode, second.body).toBe(200);
            teamIds.push(second.json().id);
            expect(second.json().id).toBe(first.json().id);
            expect(blockedPeer).toBe(true);
            expect(await db.teamMembership.count({ where: { accountId: input.owner.id } })).toBe(1);
        } finally {
            db.$transaction = original;
            if (competitorOutcome) await competitorOutcome;
        }
    });

    it.each(["archive", "restore", "resource_delete"] as const)("attributes the real %s route's idle Account holder", async kind => {
        const input = await fixture(kind);
        let requestId: string | undefined;
        const previousTrace = process.env.HAPPIER_WEB_LATENCY_TRACE;
        process.env.HAPPIER_WEB_LATENCY_TRACE = "1";
        const original = db.$transaction;
        const names: { application_name: string; state: string }[] = [];
        // Observe the real SQL transport after Account admission, keeping the
        // registered HTTP route, domain mutation, and inTx composition intact.
        db.$transaction = new Proxy(original, { apply(target, thisArg, args) {
            const callback = args[0] as (tx: Tx) => Promise<unknown>;
            return Reflect.apply(target, thisArg, [async (tx: Tx) => callback(new Proxy(tx, {
                get(owner, property) {
                    if (property === "$queryRawUnsafe") return async (sql: string, ...values: unknown[]) => {
                        const rows = await owner.$queryRawUnsafe(sql, ...values);
                        if (names.length === 0 && /FROM "Account".*FOR (?:KEY SHARE|NO KEY UPDATE|UPDATE)/u.test(sql)) {
                            requestId = readWebLatencyRequestId();
                            const [{ pid }] = await owner.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
                            const [holder] = await db.$queryRaw<Array<{ application_name: string; state: string }>>`
                                SELECT application_name, state FROM pg_stat_activity WHERE pid = ${pid}
                            `;
                            names.push(holder);
                        }
                        return rows;
                    };
                    return Reflect.get(owner, property, owner);
                },
            })), ...args.slice(1)]);
        } });
        try {
            const response = await app.inject({
                method: "POST", url: input.url, headers: { "x-test-user-id": input.owner.id }, payload: input.payload,
            });
            expect(response.statusCode, response.body).toBe(200);
            await input.verify(response.json());
            expect(requestId).toMatch(/^req-[0-9a-z]+$/iu);
            expect(names).toEqual([{
                application_name: `${kind === "resource_delete" ? "teams.credentials.delete" : `teams.${kind}`}:${requestId}`,
                state: "idle in transaction",
            }]);
        } finally {
            db.$transaction = original;
            if (previousTrace === undefined) delete process.env.HAPPIER_WEB_LATENCY_TRACE;
            else process.env.HAPPIER_WEB_LATENCY_TRACE = previousTrace;
        }
    });

    for (const competition of ["same-account-publication", "foreign-serializable"] as const) {
        it.each(["create", "update", "policy", "group_update", "role", "invitation_revoke", "invitation_reissue", "invitation_accept", "member", "provider_resource", "pool_resource", "archive", "restore", "resource_delete", "key_revoke", "keys_revoke_all", "limit_delete", "material_withdraw"] as const)(`%s commits with ${competition}`, async kind => {
            const input = await fixture(kind);
            const foreign = await account();
            await db.$executeRaw`ANALYZE "Account"`;
            const original = db.$transaction;
            const peerScope = new AsyncLocalStorage<boolean>();
            const peers: Promise<unknown>[] = [];
            let competitions = 0;
            // Observe only the genuine Prisma boundary. Routes, services, admission,
            // terminal publication, SQL isolation and error projection remain real.
            db.$transaction = new Proxy(original, { apply(target, receiver, args: unknown[]) {
                const callback = args[0];
                if (typeof callback !== "function" || peerScope.getStore()) return Reflect.apply(target, receiver, args);
                return Reflect.apply(target, receiver, [async (tx: Tx) => {
                    let scheduled = false;
                    const query = tx.$queryRawUnsafe.bind(tx);
                    const observed = new Proxy(tx, { get(owner, property, receiver) {
                        if (property !== "$queryRawUnsafe") return Reflect.get(owner, property, receiver);
                        return async (...values: Parameters<typeof query>) => {
                            const rows = await query(...values);
                            // PERFACCT reuses serializing/exclusive entry admission
                            // for publication. Rendezvous on the held native fence,
                            // whether acquired at entry or by terminal publication.
                            if (!scheduled && competition === "same-account-publication"
                                && values[0].includes('FROM "Account"') && /FOR (?:NO KEY UPDATE|UPDATE)$/u.test(values[0])) {
                                scheduled = true;
                                const [{ pid: holderPid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
                                let ready!: (pid: number) => void;
                                const started = new Promise<number>(resolve => { ready = resolve; });
                                let settled = false;
                                const peer = peerScope.run(true, () => inTx(async writer => {
                                    const [{ pid }] = await writer.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
                                    ready(pid);
                                    await markAccountChanged(writer, { accountId: input.owner.id, kind: "account", entityId: "fix-c74-peer" });
                                }));
                                peers.push(peer);
                                void peer.finally(() => { settled = true; }).catch(() => undefined);
                                const pid = await Promise.race([started, peer.then(() => { throw new Error("Publication missed rendezvous"); })]);
                                let competed = false;
                                while (!settled) {
                                    const [{ blocked }] = await db.$queryRaw<Array<{ blocked: boolean }>>`
                                        SELECT ${holderPid}::int = ANY(pg_blocking_pids(${pid}::int)) AS blocked
                                    `;
                                    if (blocked) {
                                        competed = true;
                                        break;
                                    }
                                }
                                expect(competed, "Peer publication must block on this route's held Account fence").toBe(true);
                                competitions++;
                            }
                            return rows;
                        };
                    } });
                    try {
                        const result = await callback(observed);
                        if (competition === "foreign-serializable") {
                            await original.call(db, async writer => {
                                await writer.account.findUniqueOrThrow({ where: { id: foreign.id } });
                                await writer.account.update({ where: { id: foreign.id }, data: { seq: { increment: 1 } } });
                            }, { isolationLevel: "Serializable" });
                            competitions++;
                        }
                        return result;
                    } catch (error) {
                        console.info("FIX_C74_TX_ROLLBACK", { kind, competition, sqlState: readPostgresTransactionSqlState(error) });
                        throw error;
                    }
                }, ...args.slice(1)]);
            } });
            try {
                const method = "method" in input ? input.method : "POST" as const;
                const response = await app.inject({ method, url: input.url,
                    headers: { "x-test-user-id": input.owner.id }, payload: input.payload });
                const diagnostic = kind.startsWith("invitation_")
                    ? JSON.stringify({ statusCode: response.statusCode, error: response.json().error }) : response.body;
                expect(response.statusCode, diagnostic).toBe(200);
                await input.verify(response.json());
                expect(competitions).toBeGreaterThan(0);
                // A lost response can replay each public operation without a
                // duplicate Team, membership lifetime or resource identity.
                const repeated = await app.inject({ method, url: input.url,
                    headers: { "x-test-user-id": input.owner.id }, payload: input.payload });
                if (kind === "resource_delete") {
                    expect(repeated.statusCode, repeated.body).toBe(404);
                } else if (kind === "limit_delete") {
                    expect(repeated.statusCode, repeated.body).toBe(404);
                    expect(repeated.json()).toEqual({ error: "not_found_or_not_visible" });
                } else {
                    const repeatedDiagnostic = kind.startsWith("invitation_")
                        ? JSON.stringify({ statusCode: repeated.statusCode, error: repeated.json().error }) : repeated.body;
                    expect(repeated.statusCode, repeatedDiagnostic).toBe(200);
                    expect(repeated.json().id).toBe(response.json().id);
                }
            } finally {
                db.$transaction = original;
                const outcomes = await Promise.allSettled(peers);
                expect(outcomes.filter(result => result.status === "rejected")).toEqual([]);
            }
        });
    }
});
