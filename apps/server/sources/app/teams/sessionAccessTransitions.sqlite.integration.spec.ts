import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/storage/db";
import { resolveEffectiveSessionAccess } from "@/app/session/access/sessionAccess";
import { createPresentUserSessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication.testkit";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { sessionDraftPhysicalKey } from "@/app/account/sessionDrafts/sessionDraftPhysicalKey";
import { admitTeamMemberInTx } from "./memberships/membershipService";
import {
    removeTeamMemberForActorInTx, suspendTeamMemberForActorInTx,
    reactivateTeamMemberForActorInTx, setTeamMemberRoleForActorInTx,
} from "./memberships/memberAdministration";
import { applyTeamGroupContributionInTx } from "./groups/groupContributions";
import { archiveTeamGroupForActorInTx, restoreTeamGroupForActorInTx } from "./groups/groupService";
import { archiveTeamInTx, restoreTeamInTx } from "./lifecycle";
import { applyExternalTeamMembershipInTx, applyExternalManagedGroupInTx, applyExternalGroupContributionInTx, revokeExternalSourceFactsInTx } from "./memberships/externalFacts";
import { setExternalGroupBindingForActor } from "./directory/externalGroupBindingAdministration";

describe("Team mutations compose Session access transitions", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-team-session-transitions-",
            initAuth: false,
            env: {
                HAPPIER_FEATURE_SESSIONS_FOLLOWING__ENABLED: "1",
            },
        });
        await db.homeGovernancePolicy.create({
            data: {
                id: "home",
                teamProviderPolicy: {
                    v: 1,
                    allowedTeamProviderKinds: ["workos_sso"],
                    teamJitAllowed: false,
                    approvedGitHubEnterpriseOrigins: [],
                },
            },
        });
    }, 180_000);
    afterAll(async () => { if (harness) await harness.close(); });

    async function fixture() {
        const owner = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
        const member = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain", sessionAutoFollowGroup: true } });
        const team = await db.team.create({ data: { name: "Access transitions" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: "owner" } });
        const membership = await db.teamMembership.create({ data: { teamId: team.id, accountId: member.id, role: "member" } });
        const group = await db.teamGroup.create({ data: { teamId: team.id, name: "Group", nameKey: "group" } });
        await db.teamGroupMembership.create({ data: {
            teamId: team.id, teamGroupId: group.id, teamMembershipId: membership.id, nativeContribution: true,
        } });
        const session = await db.session.create({ data: {
            accountId: owner.id, tag: crypto.randomUUID(), metadata: "{}", encryptionMode: "plain", currentStorageState: "hosted",
            responsibleAccountId: member.id,
            grants: { create: [{ principalKind: 'team',  teamId: team.id, accessLevel: "edit", effectiveAt: new Date()  }, { principalKind: 'group',  teamGroupId: group.id, accessLevel: "view", effectiveAt: new Date()  }] },
            
        } });
        expect(await resolveEffectiveSessionAccess(db, { sessionId: session.id, accountId: member.id, authentication: createPresentUserSessionAccessAuthentication() }))
            .toMatchObject({ level: "edit", capabilities: { readTranscript: true } });
        const key = sessionDraftPhysicalKey({ kind: "session", sessionId: session.id });
        if (!key) throw new Error("expected Session draft key");
        await db.userKVStore.create({ data: { accountId: member.id, key, value: new Uint8Array([1]), version: 1 } });
        const memberInput = { teamId: team.id, actorAccountId: owner.id, membershipId: membership.id };
        const groupInput = { teamId: team.id, actorAccountId: owner.id, groupId: group.id };
        const teamInput = { teamId: team.id, actorAccountId: owner.id };
        return { owner, member, team, membership, group, session, key, memberInput, groupInput, teamInput };
    }

    async function expectPersonalState(f: Awaited<ReturnType<typeof fixture>>, retained: boolean) {
        expect(await db.session.findUnique({ where: { id: f.session.id }, select: { responsibleAccountId: true } }))
            .toEqual({ responsibleAccountId: retained ? f.member.id : null });
        expect(await db.userKVStore.findUnique({ where: { accountId_key: { accountId: f.member.id, key: f.key } }, select: { value: true } }))
            .toEqual({ value: retained ? new Uint8Array([1]) : null });
    }

    it("keeps readable state on guest downgrade, then clears it on final native Group loss", async () => {
        const f = await fixture();
        expect(await inTx(tx => setTeamMemberRoleForActorInTx(tx, { ...f.memberInput, role: "guest" }))).toMatchObject({ ok: true });
        await expectPersonalState(f, true);
        expect(await db.accountChange.count({ where: { accountId: f.member.id, entityId: f.session.id, kind: "session" } })).toBe(1);
        await inTx(tx => applyTeamGroupContributionInTx(tx, {
            teamId: f.team.id, teamGroupId: f.group.id, teamMembershipId: f.membership.id,
            contribution: { kind: "native" }, desired: "absent", historyAccess: "from_membership",
        }));
        await expectPersonalState(f, false);
        expect(await db.accountChange.count({ where: { entityId: f.session.id, kind: "share" } })).toBe(0);
    });

    it("clears final-access state on suspension and reactivation restores the lifetime without manufacturing a Follow", async () => {
        const f = await fixture();
        expect(await inTx(tx => suspendTeamMemberForActorInTx(tx, f.memberInput))).toMatchObject({ ok: true });
        await expectPersonalState(f, false);
        expect(await inTx(tx => reactivateTeamMemberForActorInTx(tx, f.memberInput))).toMatchObject({ ok: true });
        expect(await db.teamMembership.findUnique({ where: { id: f.membership.id } })).toMatchObject({ sessionAccessStartsAt: null, status: "active" });
        const where = { accountId_sessionId: { accountId: f.member.id, sessionId: f.session.id } };
        // Re-enabling a retained membership is not a new qualifying relationship (§6.3).
        expect(await db.accountSessionFollow.findUnique({ where })).toBeNull();
        await db.accountSessionFollow.create({ data: { accountId: f.member.id, sessionId: f.session.id, following: false, followPolicy: JSON.stringify({ preset: "custom", events: {} }) } });
        await inTx(tx => suspendTeamMemberForActorInTx(tx, f.memberInput));
        await inTx(tx => reactivateTeamMemberForActorInTx(tx, f.memberInput));
        expect(await db.accountSessionFollow.findUnique({ where })).toMatchObject({ following: false, followPolicy: JSON.stringify({ preset: "custom", events: {} }) });
    });

    it("removes final-access state but preserves state covered by an independent direct grant", async () => {
        for (const direct of [false, true]) {
            const f = await fixture();
            if (direct) await db.sessionGrant.create({ data: { principalKind: 'account',
                sessionId: f.session.id, createdByAccountId: f.owner.id, accountId: f.member.id, accessLevel: "admin",
            } });
            expect(await inTx(tx => removeTeamMemberForActorInTx(tx, f.memberInput))).toMatchObject({ ok: true });
            await expectPersonalState(f, direct);
            if (direct) {
                // The direct Admin survives, but the old Group context must be
                // refreshed when its applicable membership disappears.
                expect(await resolveEffectiveSessionAccess(db, { sessionId: f.session.id, accountId: f.member.id, authentication: createPresentUserSessionAccessAuthentication() }))
                    .toMatchObject({ level: "admin", audienceContext: null });
                expect(await db.accountChange.count({ where: { accountId: f.member.id, entityId: f.session.id } })).toBe(1);
            }
        }
    });

    it.each(["team", "group"] as const)("reconciles %s archive and restore against retained membership", async kind => {
        const f = await fixture();
        if (kind === "group") await db.teamMembership.update({ where: { id: f.membership.id }, data: { role: "guest" } });
        expect(await inTx(async tx => kind === "team" ? archiveTeamInTx(tx, f.teamInput) : archiveTeamGroupForActorInTx(tx, f.groupInput)))
            .toMatchObject({ ok: true });
        await expectPersonalState(f, false);
        expect(await inTx(async tx => kind === "team" ? restoreTeamInTx(tx, f.teamInput) : restoreTeamGroupForActorInTx(tx, f.groupInput)))
            .toMatchObject({ ok: true });
        // Restoration re-enables retained grants; it is not a new qualifying
        // relationship, so an opted-in member is not subscribed by a lifecycle replay.
        expect(await db.accountSessionFollow.findUnique({ where: { accountId_sessionId: { accountId: f.member.id, sessionId: f.session.id } } }))
            .toBeNull();
        expect(await db.teamGroupMembership.findUnique({ where: { teamGroupId_teamMembershipId: { teamGroupId: f.group.id, teamMembershipId: f.membership.id } } }))
            .toMatchObject({ sessionAccessStartsAt: null });
        await inTx(async tx => kind === "team" ? archiveTeamInTx(tx, f.teamInput) : archiveTeamGroupForActorInTx(tx, f.groupInput));
        await db.account.update({ where: { id: f.member.id }, data: { status: "disabled" } });
        await inTx(async tx => kind === "team" ? restoreTeamInTx(tx, f.teamInput) : restoreTeamGroupForActorInTx(tx, f.groupInput));
        expect(await resolveEffectiveSessionAccess(db, { sessionId: f.session.id, accountId: f.member.id, authentication: createPresentUserSessionAccessAuthentication() })).toBeNull();
        expect(await db.accountSessionFollow.findUnique({ where: { accountId_sessionId: { accountId: f.member.id, sessionId: f.session.id } } })).toBeNull();
    });

    it("admits opted-in Team access without enrolling a personal Follow and rolls back effects with the mutation", async () => {
        const f = await fixture();
        const newcomer = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain", sessionAutoFollowTeam: true } });
        await inTx(tx => admitTeamMemberInTx(tx, { teamId: f.team.id, accountId: newcomer.id, role: "member", historyAccess: "all_existing" }));
        expect(await db.accountSessionFollow.findUnique({ where: { accountId_sessionId: { accountId: newcomer.id, sessionId: f.session.id } } }))
            .toBeNull();
        expect(await resolveEffectiveSessionAccess(db, { sessionId: f.session.id, accountId: newcomer.id,
            authentication: createPresentUserSessionAccessAuthentication() })).not.toBeNull();
        await expect(inTx(async tx => {
            await removeTeamMemberForActorInTx(tx, f.memberInput);
            throw new Error("abort membership mutation");
        })).rejects.toThrow("abort membership mutation");
        await expectPersonalState(f, true);
        expect(await db.teamMembership.findUnique({ where: { id: f.membership.id } })).not.toBeNull();
    });

    async function directoryFixture() {
        const f = await fixture();
        const provider = await db.identityProviderInstance.create({ data: {
            ownerTeamId: f.team.id, kind: "workos_sso", displayName: "Directory", enabled: true,
            config: { v: 1, kind: "workos_sso" },
        } });
        const connection = await db.teamIdentityConnection.create({ data: {
            teamId: f.team.id, providerInstanceId: provider.id, externalReference: { v: 1 }, settings: { v: 1 },
        } });
        const source = await db.teamDirectorySource.create({ data: {
            teamId: f.team.id, kind: "workos_directory", state: "active", displayName: "Directory",
            externalSourceKey: crypto.randomUUID(), bindingConfig: { v: 1, kind: "workos_directory" }, teamIdentityConnectionId: connection.id,
        } });
        await db.teamProvisionedIdentity.create({ data: {
            directorySourceId: source.id, teamId: f.team.id, externalUserId: "person", state: "active", boundAccountId: f.member.id,
            teamMembershipId: f.membership.id, teamMembershipTeamId: f.team.id,
        } });
        const binding = await db.teamExternalGroupBinding.create({ data: {
            teamId: f.team.id, teamGroupId: f.group.id, directorySourceId: source.id, externalGroupId: "group", bindingMode: "directory_created",
        } });
        await db.teamGroupMembership.update({ where: { teamGroupId_teamMembershipId: {
            teamGroupId: f.group.id, teamMembershipId: f.membership.id,
        } }, data: { nativeContribution: false } });
        await db.teamGroupMembershipExternalContribution.create({ data: {
            teamGroupId: f.group.id, teamMembershipId: f.membership.id, externalGroupBindingId: binding.id,
        } });
        return { ...f, source, binding };
    }

    it("keeps Session state and its horizon when another Group contribution survives", async () => {
        const f = await directoryFixture();
        await db.teamMembership.update({ where: { id: f.membership.id }, data: { role: "guest" } });
        const native = {
            teamId: f.team.id, teamGroupId: f.group.id, teamMembershipId: f.membership.id,
            contribution: { kind: "native" as const }, historyAccess: "from_membership" as const,
        };
        await inTx(tx => applyTeamGroupContributionInTx(tx, { ...native, desired: "present" }));
        await inTx(tx => applyExternalGroupContributionInTx(tx, {
            teamId: f.team.id, groupId: f.group.id, accountId: f.member.id, externalGroupBindingId: f.binding.id,
            desired: "absent", historyAccess: "from_membership",
        }));
        await expectPersonalState(f, true);
        expect(await db.accountChange.count({ where: { accountId: f.member.id, entityId: f.session.id } })).toBe(0);
        expect(await db.teamGroupMembership.findUnique({ where: { teamGroupId_teamMembershipId: {
            teamGroupId: f.group.id, teamMembershipId: f.membership.id,
        } } })).toMatchObject({ sessionAccessStartsAt: null, nativeContribution: true });
        await inTx(tx => applyTeamGroupContributionInTx(tx, { ...native, desired: "absent" }));
        await expectPersonalState(f, false);
    });

    it("composes directory suspension and complete source removal with final-access effects", async () => {
        for (const operation of ["suspend", "revoke"] as const) {
            const f = await directoryFixture();
            await inTx(async tx => operation === "suspend"
                ? applyExternalTeamMembershipInTx(tx, {
                    teamId: f.team.id, accountId: f.member.id,
                    source: { kind: "directory_source", directorySourceId: f.source.id, externalUserId: "person" },
                    desired: "suspended", historyAccess: "all_existing",
                })
                : revokeExternalSourceFactsInTx(tx, { teamId: f.team.id, owner: { kind: "directory_source", directorySourceId: f.source.id } }));
            await expectPersonalState(f, false);
        }
    });

    it("composes directory-owned Group retirement and restoration", async () => {
        const f = await directoryFixture();
        await db.teamMembership.update({ where: { id: f.membership.id }, data: { role: "guest" } });
        await inTx(tx => applyExternalManagedGroupInTx(tx, { teamId: f.team.id, externalGroupBindingId: f.binding.id, desired: "retired" }));
        await expectPersonalState(f, false);
        await inTx(tx => applyExternalManagedGroupInTx(tx, { teamId: f.team.id, externalGroupBindingId: f.binding.id, desired: "active" }));
        expect(await resolveEffectiveSessionAccess(db, {
            sessionId: f.session.id,
            accountId: f.member.id,
            authentication: createPresentUserSessionAccessAuthentication(),
        })).toMatchObject({
            level: "view",
            audienceContext: { kind: "group", teamId: f.team.id, groupId: f.group.id },
        });
        // Restoring retained Group rows restores access, but is not a new
        // relationship and therefore cannot resurrect cleared personal state
        // or manufacture a personal Follow.
        await expectPersonalState(f, false);
        expect(await db.accountSessionFollow.findUnique({ where: { accountId_sessionId: {
            accountId: f.member.id,
            sessionId: f.session.id,
        } } })).toBeNull();
    });

    it("preserves readable state while an atomic directory mapping replaces its sole Group access path", async () => {
        const f = await directoryFixture();
        await db.team.update({ where: { id: f.team.id }, data: { defaultSessionHistoryAccess: "all_existing" } });
        await db.teamMembership.update({ where: { id: f.membership.id }, data: { role: "guest" } });
        const replacement = await db.teamGroup.create({ data: { teamId: f.team.id, name: "Replacement", nameKey: "replacement" } });
        await db.sessionGrant.create({ data: { principalKind: 'group', sessionId: f.session.id, teamGroupId: replacement.id, accessLevel: "view", effectiveAt: new Date() } });
        await db.teamDirectoryGroup.create({ data: { directorySourceId: f.source.id, externalGroupId: "group", externalDisplayName: "Directory Group", state: "active" } });
        await db.teamDirectoryGroupMember.create({ data: { directorySourceId: f.source.id, externalGroupId: "group", externalUserId: "person" } });
        const remapped = await setExternalGroupBindingForActor({
            v: 1, teamId: f.team.id, actorAccountId: f.owner.id,
            owner: { kind: "directory_source", directorySourceId: f.source.id }, externalGroupId: "group",
            target: { kind: "native_target", teamGroupId: replacement.id },
        });
        expect(remapped).toMatchObject({ ok: true });
        await expectPersonalState(f, true);
        expect(await resolveEffectiveSessionAccess(db, { sessionId: f.session.id, accountId: f.member.id, authentication: createPresentUserSessionAccessAuthentication() }))
            .toMatchObject({ audienceContext: { kind: "group", teamId: f.team.id, groupId: replacement.id } });
        expect(await db.accountChange.count({ where: { entityId: f.session.id, accountId: f.member.id } })).toBe(1);
    });

});
