import { describe, expect, it } from "vitest";
import { AccountStatus, TeamMembershipStatus } from "@/storage/enums.generated";
import { isEffectiveTeamMembership } from "./effectiveMembership";

describe("Structural Team-membership predicate", () => {
    const active = {
        accountStatus: AccountStatus.active,
        membershipStatus: TeamMembershipStatus.active,
        teamArchivedAt: null,
    } as const;

    it("is effective only when Account, membership, and Team are all current", () => {
        expect(isEffectiveTeamMembership(active)).toBe(true);
    });

    it("fails for each structural input independently", () => {
        expect(isEffectiveTeamMembership({ ...active, accountStatus: AccountStatus.suspended })).toBe(false);
        expect(isEffectiveTeamMembership({ ...active, accountStatus: AccountStatus.disabled })).toBe(false);
        expect(isEffectiveTeamMembership({ ...active, membershipStatus: TeamMembershipStatus.suspended })).toBe(false);
        expect(isEffectiveTeamMembership({ ...active, teamArchivedAt: new Date("2026-04-01T00:00:00.000Z") })).toBe(false);
    });
});
