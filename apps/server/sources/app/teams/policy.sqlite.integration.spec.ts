import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { HOME_GOVERNANCE_POLICY_ID } from "@/app/home/governance/governancePolicy";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { createTeamInTx } from "./lifecycle";
import { authorizeTeamPolicyPatch, setTeamPolicyInTx } from "./policy";

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
