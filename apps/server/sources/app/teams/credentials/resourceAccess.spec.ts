import { describe, expect, it } from "vitest";
import { projectTeamCredentialEntitlement, type TeamCredentialEntitlementInput } from "./resourceAccess";

const membership = {
    teamMembershipId: "member-current", teamId: "team", accountId: "recipient",
    role: "member", status: "active", sessionAccessStartsAt: null,
    historyAccess: "all_existing", effective: true,
} as const;
const input: TeamCredentialEntitlementInput = {
    resource: {
        id: "resource", teamId: "team", custodianAccountId: "custodian", revision: 3, enabled: true,
        disclosureCeiling: "direct_allowed", allMembersDeliveryMode: "brokered",
        groupGrants: [{ teamGroupId: "group", deliveryMode: "direct" }],
        memberGrants: [{ teamMembershipId: membership.teamMembershipId, deliveryMode: "brokered" }],
    },
    membership,
    custodianMembership: { ...membership, accountId: "custodian", teamMembershipId: "custodian-current" },
    groupMemberships: [{ ...membership, teamGroupId: "group", nativeContribution: true }],
};

describe("current Team credential audience entitlement", () => {
    it("intersects explicitly opted-in native consent with the exact independent audience routes", () => {
        const resource = { ...input.resource,
            disclosureCeiling: JSON.stringify({ policy: { preferredAllowedModes: ["vendor-native", "brokered"] }, experimentalBindingConfirmations: [] }),
            allMembersDeliveryMode: null, groupGrants: [],
            memberGrants: [{ teamMembershipId: membership.teamMembershipId, deliveryMode: '["vendor-native"]' }],
        };
        expect(projectTeamCredentialEntitlement({ ...input, resource })).toMatchObject({
            ok: true, allowedRoutes: ["vendor-native"], mayBroker: false, mayReceiveDirect: false,
            deliveryPolicy: { preferredAllowedModes: ["vendor-native", "brokered"] },
        });
        expect(projectTeamCredentialEntitlement({ ...input, resource: { ...resource, disclosureCeiling: "direct_allowed" } }))
            .toEqual({ ok: false, reason: "resource_corrupt" });
    });

    it("retains overlapping audiences and independent broker/direct capabilities", () => {
        expect(projectTeamCredentialEntitlement(input)).toEqual({
            ok: true, resourceId: "resource", resourceRevision: 3,
            matchedGrants: [
                { kind: "team" }, { kind: "team_group", teamGroupId: "group" },
                { kind: "team_member", teamMembershipId: "member-current" },
            ],
            mayBroker: true, mayReceiveDirect: true,
            allowedRoutes: ["brokered", "direct"],
            deliveryPolicy: { preferredAllowedModes: ["brokered", "direct"] },
        });
    });

    it("does not restore old membership grants or grant a guest the Team-wide audience", () => {
        const guest = { ...membership, role: "guest" as const, teamMembershipId: "rejoined" };
        expect(projectTeamCredentialEntitlement({ ...input, membership: guest })).toEqual({ ok: false, reason: "access_removed" });
        expect(projectTeamCredentialEntitlement({
            ...input, membership: guest,
            groupMemberships: [{ ...input.groupMemberships[0], teamMembershipId: "rejoined" }],
        })).toMatchObject({
            ok: true, matchedGrants: [{ kind: "team_group", teamGroupId: "group" }],
            mayBroker: false, mayReceiveDirect: true,
        });
    });

    it("requires current same-Team recipient and source-custodian memberships", () => {
        for (const invalid of [null, { ...membership, effective: false }, { ...membership, teamId: "other" }]) {
            expect(projectTeamCredentialEntitlement({ ...input, membership: invalid })).toEqual({ ok: false, reason: "access_removed" });
            expect(projectTeamCredentialEntitlement({ ...input, custodianMembership: invalid })).toEqual({ ok: false, reason: "source_owner_required" });
        }
        expect(projectTeamCredentialEntitlement({ ...input, custodianMembership: membership }))
            .toEqual({ ok: false, reason: "source_owner_required" });
    });

    it("ignores ineffective, wrong-Team, and wrong-Account Group membership projections", () => {
        const groupOnly = { ...input.resource, allMembersDeliveryMode: null, memberGrants: [] };
        for (const group of [
            { ...input.groupMemberships[0], effective: false },
            { ...input.groupMemberships[0], teamId: "other" },
            { ...input.groupMemberships[0], accountId: "other" },
        ]) {
            expect(projectTeamCredentialEntitlement({ ...input, resource: groupOnly, groupMemberships: [group] }))
                .toEqual({ ok: false, reason: "access_removed" });
        }
    });

    // A same-Team member outside the audience learns only that they have no
    // access. Custodian standing, enablement and ceiling state belong to the
    // audience, so the match decision comes first.
    it("tells a same-Team non-audience caller nothing but access_removed", () => {
        const outsideAudience = {
            ...input.resource,
            allMembersDeliveryMode: null,
            groupGrants: [],
            memberGrants: [],
        };
        expect(projectTeamCredentialEntitlement({
            ...input, resource: { ...outsideAudience, enabled: false },
        })).toEqual({ ok: false, reason: "access_removed" });
        expect(projectTeamCredentialEntitlement({
            ...input, resource: outsideAudience, custodianMembership: null,
        })).toEqual({ ok: false, reason: "access_removed" });
        expect(projectTeamCredentialEntitlement({
            ...input, resource: { ...outsideAudience, disclosureCeiling: "unknown" },
        })).toEqual({ ok: false, reason: "access_removed" });
    });

    it("fails closed for disabled resources, malformed modes, and direct grants beyond the owner's ceiling", () => {
        expect(projectTeamCredentialEntitlement({ ...input, resource: { ...input.resource, enabled: false } }))
            .toEqual({ ok: false, reason: "disabled" });
        for (const resource of [
            { ...input.resource, disclosureCeiling: "unknown" },
            { ...input.resource, disclosureCeiling: "brokered_only" },
            { ...input.resource, allMembersDeliveryMode: "unknown" },
            { ...input.resource, memberGrants: [{ teamMembershipId: "unmatched", deliveryMode: "unknown" }] },
        ]) {
            expect(projectTeamCredentialEntitlement({ ...input, resource })).toEqual({ ok: false, reason: "resource_corrupt" });
        }
    });
});
