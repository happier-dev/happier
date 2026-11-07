import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { HOME_GOVERNANCE_POLICY_ID } from "@/app/home/governance/governancePolicy";
import type { HomeRole, TeamCreationPolicy } from "@/storage/enums.generated";

import {
    archiveTeamInTx,
    createTeamInTx,
    readTeamSummaryForActorInTx,
    restoreTeamInTx,
    updateTeamInTx,
} from "./lifecycle";
import { setTeamPolicyInTx } from "./policy";

describe("Team lifecycle (SQLite integration)", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-team-lifecycle-", initAuth: false });
    }, 180_000);
    afterAll(async () => { if (harness) await harness.close(); });

    async function account(
        homeRole: HomeRole = "member",
        status: "active" | "suspended" | "disabled" = "active",
        encryptionMode: "plain" | "e2ee" = "plain",
    ) {
        return db.account.create({
            data: { publicKey: crypto.randomUUID(), encryptionMode, homeRole, status },
        });
    }

    async function setTeamCreationPolicy(teamCreationPolicy: TeamCreationPolicy) {
        await db.homeGovernancePolicy.upsert({
            where: { id: HOME_GOVERNANCE_POLICY_ID },
            create: { id: HOME_GOVERNANCE_POLICY_ID, revision: 1, teamCreationPolicy },
            update: { teamCreationPolicy },
        });
    }

    async function create(actorAccountId: string, overrides: Record<string, unknown> = {}) {
        return inTx(tx => createTeamInTx(tx, {
            actorAccountId,
            name: "Acme",
            requestKey: crypto.randomUUID(),
            ...overrides,
        }));
    }

    describe("creation", () => {
        it("commits the Team and its initial owner atomically and publishes invalidation", async () => {
            await setTeamCreationPolicy("self_service");
            const founder = await account();
            const before = await db.account.findUniqueOrThrow({ where: { id: founder.id }, select: { seq: true } });

            const result = await create(founder.id, { name: "  Acme   Rockets ", description: " Ships rockets. " });

            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.team.name).toBe("Acme Rockets");
            expect(result.team.description).toBe("Ships rockets.");
            expect(result.team.archivedAt).toBeNull();
            expect(result.team.recovery).toBeNull();
            expect(result.team.viewerRole).toBe("owner");
            expect(result.team.capabilities.manageSettings).toBe(true);
            expect(result.team.policy).toEqual({
                v: 1,
                sessionCreationPolicy: "private_default",
                externalSharingPolicy: "allowed",
                defaultSessionHistoryAccess: "from_membership",
                admissionMode: "invite_only",
                // A new Team inherits the Home's accepted authentication; `null`
                // is inheritance, not an empty explicit selection.
                authenticationPolicy: null,
                authenticationPolicyStatus: "available",
                managedDefaults: null,
                managedDefaultsStatus: "available",
            });
            expect(result.team.admission.historyChoice).toEqual({
                admin: "choice", member: "choice", guest: "hidden",
            });

            const memberships = await db.teamMembership.findMany({ where: { teamId: result.team.id } });
            expect(memberships).toHaveLength(1);
            expect(memberships[0]).toMatchObject({ accountId: founder.id, role: "owner", status: "active" });
            // A new Team has no prior Sessions, so its founder gets no fictional cutoff.
            expect(memberships[0]?.sessionAccessStartsAt).toBeNull();

            const after = await db.account.findUniqueOrThrow({ where: { id: founder.id }, select: { seq: true } });
            expect(after.seq).toBeGreaterThan(before.seq);
        });

        it("leaves no Team behind when the initial owner cannot be admitted", async () => {
            await setTeamCreationPolicy("self_service");
            const admin = await account("admin");
            const retired = await account("member", "disabled");

            const result = await create(admin.id, { name: "Orphan", initialOwnerAccountId: retired.id });

            expect(result).toEqual({ ok: false, error: "invalid_team_input" });
            expect(await db.team.findFirst({ where: { name: "Orphan" } })).toBeNull();
        });

        it("never makes a managing Home administrator an implicit member", async () => {
            await setTeamCreationPolicy("managed_only");
            const admin = await account("admin");
            const owner = await account();

            const result = await create(admin.id, { name: "Managed", initialOwnerAccountId: owner.id });

            expect(result.ok).toBe(true);
            if (!result.ok) return;
            const memberships = await db.teamMembership.findMany({ where: { teamId: result.team.id } });
            expect(memberships.map(m => m.accountId)).toEqual([owner.id]);
            // The administrator can govern the Team without holding membership.
            expect(result.team.viewerRole).toBeNull();
            expect(result.team.capabilities.viewTeam).toBe(true);
            expect(result.team.capabilities.manageMembers).toBe(false);
        });

        it("requires managed creation to name its initial Team owner explicitly", async () => {
            // Under `managed_only` the Home administrator is creating a Team for
            // somebody, and the product asks them to choose who. Falling back to
            // the creator would silently make an administrator the owner of a
            // Team they were provisioning for another person.
            await setTeamCreationPolicy("managed_only");
            const admin = await account("admin");

            expect(await create(admin.id, { name: "Managed omission" }))
                .toEqual({ ok: false, error: "invalid_team_input" });
            expect(await db.team.findFirst({ where: { name: "Managed omission" } })).toBeNull();

            // Naming themselves stays legal, and self-service creation keeps the
            // creator fallback it has always had.
            expect(await create(admin.id, { name: "Managed explicit", initialOwnerAccountId: admin.id }))
                .toMatchObject({ ok: true });
            await setTeamCreationPolicy("self_service");
            const ordinary = await account();
            const selfService = await create(ordinary.id, { name: "Self service omission" });
            expect(selfService.ok).toBe(true);
            if (!selfService.ok) return;
            expect((await db.teamMembership.findMany({ where: { teamId: selfService.team.id } }))
                .map(m => m.accountId)).toEqual([ordinary.id]);
        });

        it("refuses creation the Home policy does not permit and self-service creation for somebody else", async () => {
            await setTeamCreationPolicy("managed_only");
            const ordinary = await account();
            expect(await create(ordinary.id, { name: "Nope" })).toEqual({ ok: false, error: "team_forbidden" });

            await setTeamCreationPolicy("self_service");
            const other = await account();
            expect(await create(ordinary.id, { name: "Nope", initialOwnerAccountId: other.id }))
                .toEqual({ ok: false, error: "team_forbidden" });

            await setTeamCreationPolicy("disabled");
            expect(await create(ordinary.id, { name: "Nope" })).toEqual({ ok: false, error: "team_forbidden" });
            await setTeamCreationPolicy("self_service");
        });

        it("fails closed when the Teams feature bit is missing or malformed", async () => {
            const founder = await account();
            const result = await inTx(tx => createTeamInTx(tx, {
                actorAccountId: founder.id,
                name: "Gated",
                requestKey: crypto.randomUUID(),
                env: { ...process.env, HAPPIER_BUILD_FEATURES_DENY: "teams" },
            }));
            expect(result).toEqual({ ok: false, error: "teams_unavailable" });
        });

        it("returns the same Team for a retried request key and conflicts on an altered payload", async () => {
            await setTeamCreationPolicy("self_service");
            const founder = await account();
            const requestKey = crypto.randomUUID();

            const first = await create(founder.id, { name: "Retryable", requestKey });
            const retry = await create(founder.id, { name: "Retryable", requestKey });
            expect(first.ok && retry.ok).toBe(true);
            if (!first.ok || !retry.ok) return;
            expect(retry.team.id).toBe(first.team.id);
            expect(await db.team.count({ where: { name: "Retryable" } })).toBe(1);

            // The same retry identity carrying different content is a client bug,
            // not licence to create a second Team or to overwrite the first.
            expect(await create(founder.id, { name: "Different", requestKey }))
                .toEqual({ ok: false, error: "team_conflict" });
        });

        it("keeps Team-create replay live when the process clock is behind the database clock", async () => {
            await setTeamCreationPolicy("self_service");
            const founder = await account();
            const requestKey = crypto.randomUUID();
            const processClock = vi.spyOn(Date, "now").mockReturnValue(0);
            try {
                const first = await create(founder.id, { name: "Database-clock retry", requestKey });
                const replay = await create(founder.id, { name: "Database-clock retry", requestKey });
                expect(first.ok && replay.ok).toBe(true);
                if (!first.ok || !replay.ok) return;
                expect(replay.team.id).toBe(first.team.id);
                expect(await db.team.count({ where: { name: "Database-clock retry" } })).toBe(1);
                expect(await create(founder.id, { name: "Altered intent", requestKey }))
                    .toEqual({ ok: false, error: "team_conflict" });
            } finally {
                processClock.mockRestore();
            }
        });

        it("accepts duplicate names that stay distinguishable by opaque ID", async () => {
            await setTeamCreationPolicy("self_service");
            const founder = await account();
            const first = await create(founder.id, { name: "Platform" });
            const second = await create(founder.id, { name: "Platform" });
            expect(first.ok && second.ok).toBe(true);
            if (!first.ok || !second.ok) return;
            expect(first.team.id).not.toBe(second.team.id);
            expect(first.team.name).toBe(second.team.name);
        });

        it("rejects an empty, oversized, or control-character name", async () => {
            const founder = await account();
            expect(await create(founder.id, { name: "   " })).toEqual({ ok: false, error: "invalid_team_input" });
            expect(await create(founder.id, { name: "a".repeat(81) })).toEqual({ ok: false, error: "invalid_team_input" });
            expect(await create(founder.id, { name: "Acme\u0000" })).toEqual({ ok: false, error: "invalid_team_input" });
        });
    });

    describe("metadata, archive, and restore", () => {
        async function ownedTeam(encryptionMode: "plain" | "e2ee" = "plain") {
            await setTeamCreationPolicy("self_service");
            const owner = await account("member", "active", encryptionMode);
            const created = await create(owner.id, { name: `Team ${crypto.randomUUID()}` });
            if (!created.ok) throw new Error("fixture Team creation failed");
            return { owner, teamId: created.team.id };
        }

        it("renames without changing identity and keeps the description optional", async () => {
            const { owner, teamId } = await ownedTeam();

            const renamed = await inTx(tx => updateTeamInTx(tx, {
                actorAccountId: owner.id, teamId, name: "Renamed", description: "  ",
            }));

            expect(renamed.ok).toBe(true);
            if (!renamed.ok) return;
            expect(renamed.team.id).toBe(teamId);
            expect(renamed.team.name).toBe("Renamed");
            expect(renamed.team.description).toBeNull();
        });

        it("requires the current credential to qualify before mutating a restricted Team", async () => {
            const { owner, teamId } = await ownedTeam("e2ee");
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

            expect(await inTx(tx => updateTeamInTx(tx, {
                actorAccountId: owner.id,
                teamId,
                name: "Unqualified rename",
            }))).toEqual({ ok: false, error: "team_authentication_required" });
            expect(await inTx(tx => archiveTeamInTx(tx, {
                actorAccountId: owner.id,
                teamId,
            }))).toEqual({ ok: false, error: "team_authentication_required" });

            const renamed = await inTx(tx => updateTeamInTx(tx, {
                actorAccountId: owner.id,
                teamId,
                name: "Qualified rename",
                authentication: {
                    authenticationEvidence: [{ kind: "home_method", methodId: "key_challenge" }],
                    authenticationAuthority: "present_user",
                },
            }));
            expect(renamed.ok).toBe(true);
            if (!renamed.ok) return;
            expect(renamed.team.name).toBe("Qualified rename");

            const authentication = {
                authenticationEvidence: [{ kind: "home_method" as const, methodId: "key_challenge" }],
                authenticationAuthority: "present_user" as const,
            };
            expect((await inTx(tx => archiveTeamInTx(tx, {
                actorAccountId: owner.id, teamId, authentication,
            }))).ok).toBe(true);
            expect(await inTx(tx => archiveTeamInTx(tx, { actorAccountId: owner.id, teamId })))
                .toEqual({ ok: false, error: "team_authentication_required" });
            expect((await inTx(tx => restoreTeamInTx(tx, {
                actorAccountId: owner.id, teamId, authentication,
            }))).ok).toBe(true);
            expect(await inTx(tx => restoreTeamInTx(tx, { actorAccountId: owner.id, teamId })))
                .toEqual({ ok: false, error: "team_authentication_required" });
        });

        it("lets structural Team administrators read malformed policy for repair while mutations stay closed", async () => {
            const { owner, teamId } = await ownedTeam();
            const admin = await account();
            const ordinary = await account();
            const outsider = await account();
            await db.teamMembership.createMany({ data: [
                { teamId, accountId: admin.id, role: "admin" },
                { teamId, accountId: ordinary.id, role: "member" },
            ] });
            await db.team.update({
                where: { id: teamId },
                data: { authenticationPolicy: { v: 99, mode: "restricted", providerSecret: "must-not-leak" } },
            });

            for (const actorAccountId of [owner.id, admin.id]) {
                const result = await inTx(tx => readTeamSummaryForActorInTx(tx, { teamId, actorAccountId }));
                expect(result.ok).toBe(true);
                if (!result.ok) continue;
                expect(result.team.policy).toMatchObject({
                    authenticationPolicy: null,
                    authenticationPolicyStatus: "repair_required",
                });
                expect(JSON.stringify(result.team)).not.toContain("must-not-leak");
            }

            expect(await inTx(tx => readTeamSummaryForActorInTx(tx, {
                teamId, actorAccountId: ordinary.id,
            }))).toEqual({ ok: false, error: "team_authentication_unavailable" });
            expect(await inTx(tx => readTeamSummaryForActorInTx(tx, {
                teamId, actorAccountId: outsider.id,
            }))).toEqual({ ok: false, error: "team_not_found" });
            expect(await inTx(tx => updateTeamInTx(tx, {
                actorAccountId: owner.id, teamId, name: "Must stay unchanged",
            }))).toEqual({ ok: false, error: "team_authentication_unavailable" });
        });

        it("refuses metadata, policy, and branding mutations on an archived Team but allows restore", async () => {
            const { owner, teamId } = await ownedTeam();
            const invitation = await db.teamInvitation.create({
                data: {
                    teamId,
                    tokenHash: Buffer.from(crypto.randomUUID()),
                    role: "member",
                    historyAccess: "from_membership",
                    expiresAt: new Date(Date.now() + 86_400_000),
                },
            });

            const archived = await inTx(tx => archiveTeamInTx(tx, { actorAccountId: owner.id, teamId }));
            expect(archived.ok).toBe(true);
            if (!archived.ok) return;
            expect(archived.team.archivedAt).not.toBeNull();
            expect(archived.team.capabilities.restoreTeam).toBe(true);
            expect(archived.team.capabilities.manageSettings).toBe(false);

            // Outstanding invitations are revoked in the archiving transaction: a
            // link that survived archive would readmit people to an unmanaged Team.
            const revoked = await db.teamInvitation.findUniqueOrThrow({ where: { id: invitation.id } });
            expect(revoked.revokedAt).not.toBeNull();

            expect(await inTx(tx => updateTeamInTx(tx, { actorAccountId: owner.id, teamId, name: "Nope" })))
                .toEqual({ ok: false, error: "team_archived" });
            expect(await inTx(tx => setTeamPolicyInTx(tx, {
                actorAccountId: owner.id, teamId, externalSharingPolicy: "disabled",
            }))).toEqual({ ok: false, error: "team_archived" });

            const restored = await inTx(tx => restoreTeamInTx(tx, { actorAccountId: owner.id, teamId }));
            expect(restored.ok).toBe(true);
            if (!restored.ok) return;
            expect(restored.team.archivedAt).toBeNull();
            expect(restored.team.capabilities.manageSettings).toBe(true);
            // Restore does not resurrect revoked invitation links.
            const stillRevoked = await db.teamInvitation.findUniqueOrThrow({ where: { id: invitation.id } });
            expect(stillRevoked.revokedAt).toEqual(revoked.revokedAt);
        });

        it("answers a repeated archive or restore as unchanged, re-checking authority", async () => {
            const { owner, teamId } = await ownedTeam();
            const stranger = await account();

            const first = await inTx(tx => archiveTeamInTx(tx, { actorAccountId: owner.id, teamId }));
            const again = await inTx(tx => archiveTeamInTx(tx, { actorAccountId: owner.id, teamId }));
            expect(first.ok && again.ok).toBe(true);
            if (!first.ok || !again.ok) return;
            expect(again.team.archivedAt).toEqual(first.team.archivedAt);

            // A stranger learns nothing from the repeat: the Team is not theirs to see.
            expect(await inTx(tx => archiveTeamInTx(tx, { actorAccountId: stranger.id, teamId })))
                .toEqual({ ok: false, error: "team_not_found" });

            await inTx(tx => restoreTeamInTx(tx, { actorAccountId: owner.id, teamId }));
            const restoredAgain = await inTx(tx => restoreTeamInTx(tx, { actorAccountId: owner.id, teamId }));
            expect(restoredAgain.ok).toBe(true);
            if (!restoredAgain.ok) return;
            expect(restoredAgain.team.archivedAt).toBeNull();
        });

        it("hides an unreadable Team behind the same answer as a missing one", async () => {
            const { teamId } = await ownedTeam();
            const stranger = await account();

            expect(await inTx(tx => readTeamSummaryForActorInTx(tx, {
                teamId, actorAccountId: stranger.id,
            }))).toEqual({ ok: false, error: "team_not_found" });
            expect(await inTx(tx => readTeamSummaryForActorInTx(tx, {
                teamId: "team-that-does-not-exist", actorAccountId: stranger.id,
            }))).toEqual({ ok: false, error: "team_not_found" });
        });

        it("retains only self-leave for a suspended native member and hides an inactive Account", async () => {
            const { owner, teamId } = await ownedTeam();
            const member = await account();
            await db.teamMembership.create({ data: { teamId, accountId: member.id, role: "admin" } });

            await db.teamMembership.updateMany({
                where: { teamId, accountId: member.id },
                data: { status: "suspended" },
            });
            const suspended = await inTx(tx => readTeamSummaryForActorInTx(tx, { teamId, actorAccountId: member.id }));
            expect(suspended).toMatchObject({ ok: true, team: { id: teamId, viewerRole: "admin", counts: null, recovery: null } });
            if (!suspended.ok) return;
            expect(Object.entries(suspended.team.capabilities)
                .filter(([, allowed]) => allowed)
                .map(([capability]) => capability)).toEqual(["leave"]);

            await db.account.update({ where: { id: owner.id }, data: { status: "suspended" } });
            expect(await inTx(tx => readTeamSummaryForActorInTx(tx, { teamId, actorAccountId: owner.id })))
                .toEqual({ ok: false, error: "team_not_found" });
            await db.account.update({ where: { id: owner.id }, data: { status: "active" } });
        });
    });

    describe("policy", () => {
        it("changes only the requested fields and never rewrites membership horizons", async () => {
            await setTeamCreationPolicy("self_service");
            const owner = await account();
            const created = await create(owner.id, { name: "Policy" });
            if (!created.ok) return expect(created.ok).toBe(true);
            const member = await account();
            const membership = await db.teamMembership.create({
                data: {
                    teamId: created.team.id,
                    accountId: member.id,
                    role: "member",
                    sessionAccessStartsAt: new Date(1_700_000_000_000),
                },
            });

            const updated = await inTx(tx => setTeamPolicyInTx(tx, {
                actorAccountId: owner.id,
                teamId: created.team.id,
                sessionCreationPolicy: "team_required",
                defaultSessionHistoryAccess: "all_existing",
            }));

            expect(updated.ok).toBe(true);
            if (!updated.ok) return;
            expect(updated.team.policy).toEqual({
                v: 1,
                sessionCreationPolicy: "team_required",
                externalSharingPolicy: "allowed",
                defaultSessionHistoryAccess: "all_existing",
                admissionMode: "invite_only",
                // A Session-policy patch leaves authentication narrowing alone.
                authenticationPolicy: null,
                authenticationPolicyStatus: "available",
                managedDefaults: null,
                managedDefaultsStatus: "available",
            });
            // A history default is the intent for the next admission; an existing
            // horizon was minted once at activation and is never rewritten.
            const unchanged = await db.teamMembership.findUniqueOrThrow({ where: { id: membership.id } });
            expect(unchanged.sessionAccessStartsAt?.getTime()).toBe(1_700_000_000_000);
        });

        it("refuses a policy patch from a member without managePolicy", async () => {
            await setTeamCreationPolicy("self_service");
            const owner = await account();
            const created = await create(owner.id, { name: "Guarded" });
            if (!created.ok) return expect(created.ok).toBe(true);
            const ordinary = await account();
            await db.teamMembership.create({
                data: { teamId: created.team.id, accountId: ordinary.id, role: "member" },
            });

            const denied = await inTx(tx => setTeamPolicyInTx(tx, {
                actorAccountId: ordinary.id,
                teamId: created.team.id,
                admissionMode: "jit",
            }));

            expect(denied).toEqual({ ok: false, error: "team_forbidden" });
            const stored = await db.team.findUniqueOrThrow({ where: { id: created.team.id } });
            expect(stored.admissionMode).toBe("invite_only");
        });

        it("fails every lifecycle mutation closed when Teams is disabled at the deciding transaction", async () => {
            await setTeamCreationPolicy("self_service");
            const owner = await account();
            const created = await create(owner.id, { name: `Gated ${crypto.randomUUID()}` });
            if (!created.ok) throw new Error("fixture Team creation failed");
            const teamId = created.team.id;
            const disabled = { ...process.env, HAPPIER_BUILD_FEATURES_DENY: "teams" };

            expect(await inTx(tx => updateTeamInTx(tx, {
                actorAccountId: owner.id, teamId, name: "Nope", env: disabled,
            }))).toEqual({ ok: false, error: "teams_unavailable" });
            expect(await inTx(tx => archiveTeamInTx(tx, {
                actorAccountId: owner.id, teamId, env: disabled,
            }))).toEqual({ ok: false, error: "teams_unavailable" });
            expect(await inTx(tx => restoreTeamInTx(tx, {
                actorAccountId: owner.id, teamId, env: disabled,
            }))).toEqual({ ok: false, error: "teams_unavailable" });
            expect((await db.team.findUniqueOrThrow({ where: { id: teamId } })).name).not.toBe("Nope");
        });

        it("does not let Home administration reach Team membership, policy, or content", async () => {
            await setTeamCreationPolicy("self_service");
            const owner = await account();
            const created = await create(owner.id, { name: "Sovereign" });
            if (!created.ok) return expect(created.ok).toBe(true);
            const homeAdmin = await account("admin");
            await db.team.update({
                where: { id: created.team.id },
                data: { authenticationPolicy: {
                    v: 1,
                    mode: "restricted",
                    accepted: [{ kind: "home_method", methodId: "key_challenge" }],
                } },
            });

            const summary = await inTx(tx => readTeamSummaryForActorInTx(tx, {
                teamId: created.team.id, actorAccountId: homeAdmin.id,
            }));
            expect(summary.ok && summary.team.capabilities).toMatchObject({
                viewTeam: true,
                manageSettings: true,
                archiveTeam: true,
                managePolicy: false,
                manageMembers: false,
                manageInvitations: false,
                manageAuthentication: false,
            });
            const renamedByHome = await inTx(tx => updateTeamInTx(tx, {
                actorAccountId: homeAdmin.id,
                teamId: created.team.id,
                name: "Governed by Home",
            }));
            expect(renamedByHome.ok && renamedByHome.team.name).toBe("Governed by Home");
            expect(await inTx(tx => setTeamPolicyInTx(tx, {
                actorAccountId: homeAdmin.id, teamId: created.team.id, admissionMode: "jit",
            }))).toEqual({ ok: false, error: "team_forbidden" });

            // Still forbidden once archived, not "archived": a Home administrator
            // never holds `managePolicy`, so reporting the archive would falsely
            // imply that restoring the Team would grant it.
            expect((await inTx(tx => archiveTeamInTx(tx, {
                actorAccountId: homeAdmin.id, teamId: created.team.id,
            }))).ok).toBe(true);
            expect(await inTx(tx => setTeamPolicyInTx(tx, {
                actorAccountId: homeAdmin.id, teamId: created.team.id, admissionMode: "jit",
            }))).toEqual({ ok: false, error: "team_forbidden" });
            // The retained Team owner is told the real reason.
            expect(await inTx(tx => setTeamPolicyInTx(tx, {
                actorAccountId: owner.id, teamId: created.team.id, admissionMode: "jit",
            }))).toEqual({ ok: false, error: "team_archived" });
            expect((await inTx(tx => restoreTeamInTx(tx, {
                actorAccountId: homeAdmin.id, teamId: created.team.id,
            }))).ok).toBe(true);
        });

        it("projects owner-required recovery consistently on get and mutation results", async () => {
            const homeAdmin = await account("admin");
            const teamAdmin = await account();
            const ownerless = await db.team.create({
                data: { name: `Ownerless ${crypto.randomUUID()}` },
            });
            await db.teamMembership.create({
                data: { teamId: ownerless.id, accountId: teamAdmin.id, role: "admin" },
            });

            const asTeamAdmin = await inTx(tx => readTeamSummaryForActorInTx(tx, {
                teamId: ownerless.id,
                actorAccountId: teamAdmin.id,
            }));
            expect(asTeamAdmin.ok).toBe(true);
            if (!asTeamAdmin.ok) return;
            expect(asTeamAdmin.team.recovery).toEqual({
                kind: "owner_required",
                canAppointOwner: false,
            });

            const asHomeAdmin = await inTx(tx => readTeamSummaryForActorInTx(tx, {
                teamId: ownerless.id,
                actorAccountId: homeAdmin.id,
            }));
            expect(asHomeAdmin.ok).toBe(true);
            if (!asHomeAdmin.ok) return;
            expect(asHomeAdmin.team.recovery).toEqual({
                kind: "owner_required",
                canAppointOwner: true,
            });

            const renamed = await inTx(tx => updateTeamInTx(tx, {
                actorAccountId: homeAdmin.id,
                teamId: ownerless.id,
                name: `Recovered later ${crypto.randomUUID()}`,
            }));
            expect(renamed.ok).toBe(true);
            if (!renamed.ok) return;
            expect(renamed.team.recovery).toEqual({
                kind: "owner_required",
                canAppointOwner: true,
            });
        });
    });
});
