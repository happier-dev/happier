import { storedPlainPrivateLabel } from "@/testkit/privateLabelFixture";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { HOME_GOVERNANCE_POLICY_ID } from "@/app/home/governance/governancePolicy";
import { db } from "@/storage/db";
import { observePrismaReads } from "@/testkit/observePrismaReads";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { createTeamInTx, readTeamSummaryForActorInTx } from "./lifecycle";
import { authorizeTeamPolicyPatch, setTeamPolicyInTx } from "./policy";
import { listTeamsForActorInTx } from "./queries";
import { getTeamGroupForActorInTx } from "./groups/groupService";

/**
 * Accepted-authentication narrowing at its own owner.
 *
 * These run against the service rather than the transport so a producer fault
 * surfaces as a stack trace instead of a 500 body, and so the applicability
 * contract is pinned independently of any route.
 */
describe("Team accepted-authentication policy (SQLite integration)", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-team-auth-policy-",
            initAuth: false,
            env: {
                HAPPIER_PUBLIC_SERVER_URL: "https://home.example.test",
                WORKOS_API_KEY: "sk_test_exact",
                WORKOS_CLIENT_ID: "client_exact",
            },
        });
        await db.homeGovernancePolicy.upsert({
            where: { id: HOME_GOVERNANCE_POLICY_ID },
            create: {
                id: HOME_GOVERNANCE_POLICY_ID,
                revision: 1,
                teamCreationPolicy: "self_service",
                teamProviderPolicy: {
                    v: 1,
                    allowedTeamProviderKinds: ["workos_sso"],
                    teamJitAllowed: true,
                    approvedGitHubEnterpriseOrigins: [],
                },
            },
            update: {
                teamCreationPolicy: "self_service",
                teamProviderPolicy: {
                    v: 1,
                    allowedTeamProviderKinds: ["workos_sso"],
                    teamJitAllowed: true,
                    approvedGitHubEnterpriseOrigins: [],
                },
            },
        });
    }, 180_000);
    afterAll(async () => { if (harness) await harness.close(); });

    async function ownedTeam() {
        const owner = await db.account.create({
            data: { publicKey: crypto.randomUUID(), encryptionMode: "e2ee" },
        });
        const created = await inTx(tx => createTeamInTx(tx, {
            actorAccountId: owner.id,
            name: `Auth ${crypto.randomUUID()}`,
            requestKey: crypto.randomUUID(),
        }));
        if (!created.ok) throw new Error(`fixture Team creation failed: ${created.error}`);
        return { owner, teamId: created.team.id };
    }

    it("persists independent Review creation intent without rewriting Session policy", async () => {
        const { owner, teamId } = await ownedTeam();
        const input = { actorAccountId: owner.id, teamId, reviewCreationPolicy: "team_required" as const };
        const result = await inTx(tx => setTeamPolicyInTx(tx, input));
        expect(result).toMatchObject({ ok: true, team: { policy: {
            reviewCreationPolicy: "team_required", sessionCreationPolicy: "private_default",
        } } });
        const fresh = await inTx(tx => readTeamSummaryForActorInTx(tx, { actorAccountId: owner.id, teamId }));
        expect(fresh).toMatchObject({ ok: true, team: { policy: { reviewCreationPolicy: "team_required" } } });
    });

    it("persists managed defaults and patches one active Group without replacing sibling defaults", async () => {
        const { owner, teamId } = await ownedTeam();
        const first = await db.teamGroup.create({ data: { teamId, name: storedPlainPrivateLabel("First") } });
        const second = await db.teamGroup.create({ data: { teamId, name: storedPlainPrivateLabel("Second") } });
        const { source } = await addCurrentWorkosAdmissionEvidence(teamId);
        await db.teamExternalGroupBinding.create({ data: {
            teamId, teamGroupId: second.id, directorySourceId: source.id,
            externalGroupId: "directory-owned-group", bindingMode: "directory_created",
        } });
        const defaults = { team: {}, groups: { [first.id]: {}, [second.id]: {} } };
        const input = { actorAccountId: owner.id, teamId, managedDefaults: defaults };
        const result = await inTx(tx => setTeamPolicyInTx(tx, input));
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.team.policy.managedDefaults).toEqual(defaults);
        const patch = { actorAccountId: owner.id, teamId,
            managedGroupDefaults: { teamGroupId: first.id, defaults: null } };
        const updated = await inTx(tx => setTeamPolicyInTx(tx, patch));
        expect(updated.ok).toBe(true);
        expect((await db.team.findUniqueOrThrow({ where: { id: teamId } })).managedDefaults)
            .toEqual({ team: {}, groups: { [second.id]: {} } });
        const directoryPatch = { actorAccountId: owner.id, teamId,
            managedGroupDefaults: { teamGroupId: second.id, defaults: {} } };
        expect((await inTx(tx => setTeamPolicyInTx(tx, directoryPatch))).ok).toBe(true);
        const directoryGroup = await inTx(tx => getTeamGroupForActorInTx(tx, { teamId, actorAccountId: owner.id, groupId: second.id }));
        expect(directoryGroup.ok).toBe(true);
        if (directoryGroup.ok) expect(directoryGroup.value.capabilities.updateMetadata).toBe(false);
    });

    it("clears a Group default after an unchanged Team Machine loses member access", async () => {
        const { owner, teamId } = await ownedTeam();
        const member = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
        const membership = await db.teamMembership.create({ data: { teamId, accountId: member.id, role: "member" } });
        const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id, metadata: "{}" } });
        await db.machineGrant.create({ data: { principalKind: 'team', machineId: machine.id, teamId, accessLevel: "view", createdByAccountId: owner.id } });
        const first = await db.teamGroup.create({ data: { teamId, name: storedPlainPrivateLabel("First") } });
        await db.teamGroupMembership.create({ data: { teamId, teamGroupId: first.id, teamMembershipId: membership.id,
            nativeContribution: true, sessionAccessStartsAt: new Date() } });
        const sibling = await db.teamGroup.create({ data: { teamId, name: storedPlainPrivateLabel("Sibling") } });
        const placement = { kind: "machine" as const, target: { serverId: "server-a", machineId: machine.id } };
        const defaults = { team: { placement }, groups: { [first.id]: {}, [sibling.id]: {} } };
        expect((await inTx(tx => setTeamPolicyInTx(tx, { actorAccountId: owner.id, teamId, managedDefaults: defaults }))).ok).toBe(true);
        await db.machineGrant.deleteMany({ where: { machineId: machine.id, teamId } });
        const clear = await inTx(tx => setTeamPolicyInTx(tx, { actorAccountId: owner.id, teamId,
            managedGroupDefaults: { teamGroupId: first.id, defaults: null } }));
        expect(clear.ok).toBe(true);
        expect((await db.team.findUniqueOrThrow({ where: { id: teamId } })).managedDefaults)
            .toEqual({ team: { placement }, groups: { [sibling.id]: {} } });
        const changed = await inTx(tx => setTeamPolicyInTx(tx, { actorAccountId: owner.id, teamId,
            managedGroupDefaults: { teamGroupId: first.id, defaults: { placement } } }));
        expect(changed).toEqual({ ok: false, error: "managed_default_machine_not_member_usable" });
    });

    it.each(["team", "group"] as const)("refuses a %s Machine default shared only with the admin", async layer => {
        const { owner, teamId } = await ownedTeam();
        const member = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
        await db.teamMembership.create({ data: { teamId, accountId: member.id, role: "member" } });
        const custodian = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
        const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: custodian.id, metadata: "{}" } });
        await db.machineGrant.create({ data: { principalKind: 'account', machineId: machine.id, accountId: owner.id,
            accessLevel: "view", createdByAccountId: custodian.id } });
        const group = await db.teamGroup.create({ data: { teamId, name: storedPlainPrivateLabel("Engineering") } });
        const membership = await db.teamMembership.findUniqueOrThrow({ where: { teamId_accountId: { teamId, accountId: member.id } } });
        await db.teamGroupMembership.create({ data: { teamId, teamGroupId: group.id, teamMembershipId: membership.id, nativeContribution: true, sessionAccessStartsAt: new Date() } });
        const values = { placement: { kind: "machine" as const, target: { serverId: "server-a", machineId: machine.id } } };
        const defaults = { team: layer === "team" ? values : {}, groups: layer === "group" ? { [group.id]: values } : {} };
        expect(await inTx(tx => setTeamPolicyInTx(tx, { actorAccountId: owner.id, teamId, managedDefaults: defaults })))
            .toEqual({ ok: false, error: "managed_default_machine_not_member_usable" });
        await db.machineGrant.create({ data: { principalKind: 'team', machineId: machine.id, teamId, accessLevel: "view", createdByAccountId: owner.id } });
        expect((await inTx(tx => setTeamPolicyInTx(tx, { actorAccountId: owner.id, teamId, managedDefaults: defaults }))).ok).toBe(true);
    });

    it.each(["team", "group"] as const)("allows a %s Machine default when only a guest lacks Use access", async (layer) => {
        const { owner, teamId } = await ownedTeam();
        const member = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
        const guest = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
        const membership = await db.teamMembership.create({ data: { teamId, accountId: member.id, role: "member" } });
        const guestMembership = await db.teamMembership.create({ data: { teamId, accountId: guest.id, role: "guest" } });
        const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id, metadata: "{}" } });
        // Team grants give the member Use access, but intentionally exclude guests.
        await db.machineGrant.create({ data: { principalKind: 'team', machineId: machine.id, teamId, accessLevel: "view", createdByAccountId: owner.id } });
        const group = await db.teamGroup.create({ data: { teamId, name: storedPlainPrivateLabel("Default audience") } });
        for (const teamMembershipId of [membership.id, guestMembership.id]) {
            await db.teamGroupMembership.create({ data: {
                teamId, teamGroupId: group.id, teamMembershipId,
                nativeContribution: true, sessionAccessStartsAt: new Date(),
            } });
        }
        const defaults = { placement: { kind: "machine" as const,
            target: { serverId: "server-a", machineId: machine.id } } };
        const result = await inTx(tx => setTeamPolicyInTx(tx, {
            actorAccountId: owner.id, teamId,
            ...(layer === "team"
                ? { managedDefaults: { team: defaults, groups: {} } }
                : { managedGroupDefaults: { teamGroupId: group.id, defaults } }),
        }));
        expect(result.ok).toBe(true);
        expect((await db.team.findUniqueOrThrow({ where: { id: teamId } })).managedDefaults)
            .toEqual(layer === "team" ? { team: defaults, groups: {} } : { team: {}, groups: { [group.id]: defaults } });
    });

    it("refuses member writes and foreign or archived Group targets without changing defaults", async () => {
        const { owner, teamId } = await ownedTeam();
        const member = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
        await db.teamMembership.create({ data: { teamId, accountId: member.id, role: "member" } });
        const foreign = await ownedTeam();
        const other = await db.teamGroup.create({ data: { teamId: foreign.teamId, name: storedPlainPrivateLabel("Foreign") } });
        const archived = await db.teamGroup.create({ data: { teamId, name: storedPlainPrivateLabel("Archived"), archivedAt: new Date() } });
        const denied = { actorAccountId: member.id, teamId, managedDefaults: { team: {}, groups: {} } };
        expect(await inTx(tx => setTeamPolicyInTx(tx, denied))).toEqual({ ok: false, error: "team_forbidden" });
        for (const group of [other, archived]) {
            const patch = { actorAccountId: owner.id, teamId,
                managedGroupDefaults: { teamGroupId: group.id, defaults: {} } };
            expect((await inTx(tx => setTeamPolicyInTx(tx, patch))).ok).toBe(false);
        }
        expect((await db.team.findUniqueOrThrow({ where: { id: teamId } })).managedDefaults).toBeNull();
    });

    it("retains unchanged archived Group defaults when the Team layer changes, but refuses archived edits", async () => {
        const { owner, teamId } = await ownedTeam();
        const group = await db.teamGroup.create({ data: { teamId, name: storedPlainPrivateLabel("Retained") } });
        const groupDefaults = { permissionModeByAgentTargetKey: { "agent:example.agent/example": "read-only" as const } };
        const initial = { actorAccountId: owner.id, teamId, managedDefaults: { team: {}, groups: { [group.id]: groupDefaults } } };
        expect((await inTx(tx => setTeamPolicyInTx(tx, initial))).ok).toBe(true);
        await db.teamGroup.update({ where: { id: group.id }, data: { archivedAt: new Date() } });
        const teamDefaults = { permissionModeByAgentTargetKey: { "agent:example.agent/example": "safe-yolo" as const } };
        const replacement = { actorAccountId: owner.id, teamId,
            managedDefaults: { team: teamDefaults, groups: { [group.id]: groupDefaults } } };
        expect((await inTx(tx => setTeamPolicyInTx(tx, replacement))).ok).toBe(true);
        const changed = { actorAccountId: owner.id, teamId,
            managedDefaults: { team: teamDefaults, groups: { [group.id]: {} } } };
        expect((await inTx(tx => setTeamPolicyInTx(tx, changed))).ok).toBe(false);
        expect((await db.team.findUniqueOrThrow({ where: { id: teamId } })).managedDefaults).toEqual(replacement.managedDefaults);
    });

    it("projects only the member's effective Group defaults and exposes malformed storage for repair", async () => {
        const { owner, teamId } = await ownedTeam();
        const member = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
        const membership = await db.teamMembership.create({ data: { teamId, accountId: member.id, role: "member" } });
        const own = await db.teamGroup.create({ data: { teamId, name: storedPlainPrivateLabel("Own") } });
        const other = await db.teamGroup.create({ data: { teamId, name: storedPlainPrivateLabel("Other") } });
        await db.teamGroupMembership.create({ data: {
            teamId, teamGroupId: own.id, teamMembershipId: membership.id,
            nativeContribution: true, sessionAccessStartsAt: new Date(),
        } });
        const input = { actorAccountId: owner.id, teamId,
            managedDefaults: { team: {}, groups: { [own.id]: {}, [other.id]: {} } } };
        expect((await inTx(tx => setTeamPolicyInTx(tx, input))).ok).toBe(true);
        const projected = await inTx(tx => readTeamSummaryForActorInTx(tx, { teamId, actorAccountId: member.id }));
        expect(projected.ok).toBe(true);
        if (!projected.ok) return;
        expect(projected.team.managedDefaultsGroupIds).toEqual([own.id]);
        expect(projected.team.policy.managedDefaults).toEqual({ team: {}, groups: { [own.id]: {} } });
        const directory = await inTx(tx => listTeamsForActorInTx(tx, {
            v: 1, scope: "member", archived: "active", actorAccountId: member.id,
        }));
        expect(directory.ok).toBe(true);
        if (directory.ok) {
            const listed = directory.page.items.find(team => team.id === teamId);
            expect(listed?.managedDefaultsGroupIds).toEqual([own.id]);
            expect(listed?.policy.managedDefaults).toEqual(projected.team.policy.managedDefaults);
        }
        await db.$executeRaw`UPDATE "Team" SET "managedDefaults" = '{"invalid":true}' WHERE "id" = ${teamId}`;
        const broken = await inTx(tx => readTeamSummaryForActorInTx(tx, { teamId, actorAccountId: owner.id }));
        expect(broken.ok).toBe(true);
        if (!broken.ok) return;
        expect(broken.team.policy.managedDefaults).toBeNull();
        expect(broken.team.policy.managedDefaultsStatus).toBe("repair_required");
        const repair = { actorAccountId: owner.id, teamId, managedDefaults: null };
        expect((await inTx(tx => setTeamPolicyInTx(tx, repair))).ok).toBe(true);
    });

    async function addCurrentWorkosAdmissionEvidence(teamId: string) {
        const provider = await db.identityProviderInstance.create({
            data: {
                ownerTeamId: teamId,
                kind: "workos_sso",
                displayName: "Admission WorkOS",
                enabled: true,
                firstEnabledAt: new Date("2026-09-12T00:00:00.000Z"),
                config: { v: 1, kind: "workos_sso" },
            },
        });
        const connection = await db.teamIdentityConnection.create({
            data: {
                teamId,
                providerInstanceId: provider.id,
                externalReference: {
                    v: 1,
                    kind: "workos_sso",
                    organizationId: `org_${teamId}`,
                    connectionId: `conn_${teamId}`,
                },
                settings: { v: 1, kind: "workos_sso" },
                enabled: true,
                firstEnabledAt: new Date("2026-09-12T00:00:00.000Z"),
            },
        });
        const source = await db.teamDirectorySource.create({
            data: {
                teamId,
                kind: "workos_directory",
                state: "active",
                displayName: "Admission directory",
                externalSourceKey: `directory_${teamId}`,
                bindingConfig: { v: 1, kind: "workos_directory", workosDirectoryId: `directory_${teamId}` },
                teamIdentityConnectionId: connection.id,
            },
        });
        return { provider, connection, source };
    }

    it("refuses a selection naming a connection this Home does not have", async () => {
        const { owner, teamId } = await ownedTeam();

        const result = await inTx(tx => setTeamPolicyInTx(tx, {
            actorAccountId: owner.id,
            teamId,
            previousAuthenticationPolicy: null,
            authenticationPolicy: {
                v: 1,
                mode: "restricted",
                accepted: [{ kind: "team_connection", connectionId: "connection-z" }],
            },
        }));

        // An unknown connection is an unusable choice, not a crash and not a
        // silent narrowing to something the Home cannot actually satisfy.
        expect(result).toEqual({ ok: false, error: "team_authentication_policy_unavailable" });
        expect((await db.team.findUniqueOrThrow({ where: { id: teamId } })).authenticationPolicy).toBeNull();
    });

    it("refuses a selection naming a home method this Home does not offer", async () => {
        const { owner, teamId } = await ownedTeam();

        const result = await inTx(tx => setTeamPolicyInTx(tx, {
            actorAccountId: owner.id,
            teamId,
            previousAuthenticationPolicy: null,
            authenticationPolicy: {
                v: 1,
                mode: "restricted",
                accepted: [{ kind: "home_method", methodId: "not_a_configured_method" }],
            },
        }));

        expect(result).toEqual({ ok: false, error: "team_authentication_policy_unavailable" });
        expect((await db.team.findUniqueOrThrow({ where: { id: teamId } })).authenticationPolicy).toBeNull();
    });

    it("leaves an unrelated Session-default patch unaffected by authentication narrowing", async () => {
        const { owner, teamId } = await ownedTeam();

        const result = await inTx(tx => setTeamPolicyInTx(tx, {
            actorAccountId: owner.id,
            teamId,
            externalSharingPolicy: "disabled",
        }));

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.team.policy.externalSharingPolicy).toBe("disabled");
        expect(result.team.policy.authenticationPolicy).toBeNull();
    });

    it("accepts a restricted policy when the editor credential proves an accepted native method", async () => {
        const { owner, teamId } = await ownedTeam();

        const result = await inTx(tx => setTeamPolicyInTx(tx, {
            actorAccountId: owner.id,
            teamId,
            previousAuthenticationPolicy: null,
            authenticationPolicy: {
                v: 1,
                mode: "restricted",
                accepted: [{ kind: "home_method", methodId: "key_challenge" }],
            },
            authentication: {
                authenticationEvidence: [{ kind: "home_method", methodId: "key_challenge" }],
                authenticationAuthority: "present_user",
            },
        }));

        expect(result.ok).toBe(true);
        expect((await db.team.findUniqueOrThrow({ where: { id: teamId } })).authenticationPolicy).toEqual({
            v: 1,
            mode: "restricted",
            accepted: [{ kind: "home_method", methodId: "key_challenge" }],
        });
    });

    it("publishes a Team authentication change to each shared Session with one recipient census", async () => {
        const { owner, teamId } = await ownedTeam();
        const sessionIds = Array.from({ length: 16 }, () => crypto.randomUUID());
        await db.session.createMany({ data: sessionIds.map(id => ({
            id, accountId: owner.id, tag: id, metadata: "{}", encryptionMode: "e2ee",
        })) });
        await db.sessionGrant.createMany({ data: sessionIds.map(sessionId => ({
            principalKind: "team", sessionId, teamId, createdByAccountId: owner.id,
            accessLevel: "view", effectiveAt: new Date(),
        })) });

        const observed = await inTx(async tx => {
            const observed = observePrismaReads(tx, ["session"]);
            expect(await setTeamPolicyInTx(observed.tx, {
                actorAccountId: owner.id, teamId, previousAuthenticationPolicy: null,
                authenticationPolicy: { v: 1, mode: "restricted", accepted: [{ kind: "home_method", methodId: "key_challenge" }] },
                authentication: {
                    authenticationEvidence: [{ kind: "home_method", methodId: "key_challenge" }],
                    authenticationAuthority: "present_user",
                },
            })).toMatchObject({ ok: true });
            return observed;
        });

        const changes = await db.accountChange.findMany({
            where: { accountId: owner.id, kind: "session", entityId: { in: sessionIds } },
            select: { entityId: true },
        });
        expect(changes.map(change => change.entityId).sort()).toEqual(sessionIds.sort());
        // Admission reads remain set-oriented too. A singleton recipient census per Session
        // would alone exceed this bound before counting any admission queries.
        expect(observed.reads.filter(read => read === "session.findMany").length).toBeLessThan(sessionIds.length);
    });

    it("authorizes Session defaults and admission/authentication through their distinct capabilities", () => {
        const base = {
            viewTeam: true,
            viewRoster: true,
            manageSettings: false,
            manageMembers: false,
            manageGroups: false,
            manageInvitations: false,
            manageOwners: false,
            archiveTeam: false,
            restoreTeam: false,
            leave: false,
        };
        const managesPolicy = { ...base, managePolicy: true, manageAuthentication: false };
        const managesAuthentication = { ...base, managePolicy: false, manageAuthentication: true };

        expect(authorizeTeamPolicyPatch(managesPolicy, { sessionCreationPolicy: "team_default" })).toBe(true);
        expect(authorizeTeamPolicyPatch(managesPolicy, { admissionMode: "jit" })).toBe(false);
        expect(authorizeTeamPolicyPatch(managesAuthentication, { admissionMode: "jit" })).toBe(true);
        expect(authorizeTeamPolicyPatch(managesAuthentication, { externalSharingPolicy: "disabled" })).toBe(false);
        expect(authorizeTeamPolicyPatch(managesPolicy, {
            externalSharingPolicy: "disabled",
            authenticationPolicy: { v: 1, mode: "inherit" },
        })).toBe(false);
    });

    it("persists provisioned and JIT modes only with current canonical evidence", async () => {
        const { owner, teamId } = await ownedTeam();
        const evidence = await addCurrentWorkosAdmissionEvidence(teamId);

        const provisioned = await inTx(tx => setTeamPolicyInTx(tx, {
            actorAccountId: owner.id,
            teamId,
            admissionMode: "provisioned",
        }));
        expect(provisioned.ok).toBe(true);

        const jit = await inTx(tx => setTeamPolicyInTx(tx, {
            actorAccountId: owner.id,
            teamId,
            admissionMode: "jit",
        }));
        expect(jit.ok).toBe(true);
        expect((await db.team.findUniqueOrThrow({ where: { id: teamId } })).admissionMode).toBe("jit");

        await db.teamDirectorySource.update({
            where: { id: evidence.source.id },
            data: {
                activeReconcileRunId: "run_in_progress",
                activeReconcileStartedAt: new Date(),
            },
        });
        const fencedMixedPatch = await inTx(tx => setTeamPolicyInTx(tx, {
            actorAccountId: owner.id,
            teamId,
            admissionMode: "provisioned",
            externalSharingPolicy: "disabled",
        }));
        expect(fencedMixedPatch).toEqual({ ok: false, error: "team_authentication_policy_unavailable" });
        expect(await db.team.findUniqueOrThrow({ where: { id: teamId } })).toMatchObject({
            admissionMode: "jit",
            externalSharingPolicy: "allowed",
        });

        await db.teamIdentityConnection.update({
            where: { id: evidence.connection.id },
            data: { enabled: false, revision: { increment: 1 } },
        });
        const disabledMixedPatch = await inTx(tx => setTeamPolicyInTx(tx, {
            actorAccountId: owner.id,
            teamId,
            admissionMode: "jit",
            externalSharingPolicy: "disabled",
        }));
        expect(disabledMixedPatch).toEqual({ ok: false, error: "team_authentication_policy_unavailable" });

        expect(await db.team.findUniqueOrThrow({ where: { id: teamId } })).toMatchObject({
            admissionMode: "jit",
            externalSharingPolicy: "allowed",
        });
    });

    it("qualifies every direct policy mutation against the current restricted Team policy", async () => {
        const { owner, teamId } = await ownedTeam();
        await db.team.update({
            where: { id: teamId },
            data: {
                authenticationPolicy: {
                    v: 1,
                    mode: "restricted",
                    accepted: [{ kind: "home_method", methodId: "key_challenge" }],
                },
            },
        });

        const denied = await inTx(tx => setTeamPolicyInTx(tx, {
            actorAccountId: owner.id,
            teamId,
            externalSharingPolicy: "disabled",
        }));
        expect(denied).toEqual({ ok: false, error: "team_authentication_required" });
        expect((await db.team.findUniqueOrThrow({ where: { id: teamId } })).externalSharingPolicy).toBe("allowed");

        const qualified = await inTx(tx => setTeamPolicyInTx(tx, {
            actorAccountId: owner.id,
            teamId,
            externalSharingPolicy: "disabled",
            authentication: {
                authenticationEvidence: [{ kind: "home_method", methodId: "key_challenge" }],
                authenticationAuthority: "present_user",
            },
        }));
        expect(qualified.ok).toBe(true);
    });

    it("keeps malformed persisted authentication policy readable and repairs it only from an observed repair basis", async () => {
        const { owner, teamId } = await ownedTeam();
        await db.team.update({ where: { id: teamId }, data: { authenticationPolicy: { v: 99, mode: "restricted" } } });

        const unrelated = await inTx(tx => setTeamPolicyInTx(tx, {
            actorAccountId: owner.id,
            teamId,
            externalSharingPolicy: "disabled",
        }));
        expect(unrelated).toEqual({ ok: false, error: "team_authentication_unavailable" });
        expect((await db.team.findUniqueOrThrow({ where: { id: teamId } })).externalSharingPolicy).toBe("allowed");

        const mixedRepair = await inTx(tx => setTeamPolicyInTx(tx, {
            actorAccountId: owner.id,
            teamId,
            previousAuthenticationPolicy: { v: 1, status: "repair_required" },
            authenticationPolicy: { v: 1, mode: "inherit" },
            externalSharingPolicy: "disabled",
        }));
        expect(mixedRepair).toEqual({ ok: false, error: "team_authentication_unavailable" });
        expect((await db.team.findUniqueOrThrow({ where: { id: teamId } })).externalSharingPolicy).toBe("allowed");

        expect(await inTx(tx => setTeamPolicyInTx(tx, {
            actorAccountId: owner.id,
            teamId,
            previousAuthenticationPolicy: null,
            authenticationPolicy: { v: 1, mode: "inherit" },
        }))).toEqual({ ok: false, error: "team_authentication_policy_conflict" });

        const repaired = await inTx(tx => setTeamPolicyInTx(tx, {
            actorAccountId: owner.id,
            teamId,
            previousAuthenticationPolicy: { v: 1, status: "repair_required" },
            authenticationPolicy: { v: 1, mode: "inherit" },
            authentication: { authenticationAuthority: "present_user" },
        }));
        expect(repaired.ok).toBe(true);
        if (!repaired.ok) return;
        expect(repaired.team.policy).toMatchObject({
            authenticationPolicy: null,
            authenticationPolicyStatus: "available",
        });
    });

    it("commits no policy mutation while Teams is disabled", async () => {
        const { owner, teamId } = await ownedTeam();
        const result = await inTx(tx => setTeamPolicyInTx(tx, {
            actorAccountId: owner.id,
            teamId,
            externalSharingPolicy: "disabled",
            env: { ...process.env, HAPPIER_BUILD_FEATURES_DENY: "teams" },
        }));
        expect(result).toEqual({ ok: false, error: "teams_unavailable" });
        expect((await db.team.findUniqueOrThrow({ where: { id: teamId } })).externalSharingPolicy).toBe("allowed");
    });
});
