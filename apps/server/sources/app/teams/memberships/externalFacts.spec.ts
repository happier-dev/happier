import { describe, expect, it } from "vitest";
import type { Tx } from "@/storage/inTx";

import { withdrawIneligibleDirectoryGroupContributionsInTx } from "./externalFacts";

describe("directory management handoff contributions", () => {
    it.each(["active", "suspended"] as const)("withdraws only newly ineligible contributions when a %s identity loses management", async (releasedIdentityState) => {
        const externalBindingIds = new Set(["old-binding", "independent-binding"]);
        // Prisma is the persistence boundary; the contribution union and
        // session-access effects below execute their real internal logic.
        const tx = {
            teamDirectoryGroupMember: { findMany: async () => [] },
            teamGroupMembershipExternalContribution: {
                findMany: async () => [{
                    teamGroupId: "group", externalGroupBindingId: "old-binding",
                    binding: { externalGroupId: "upstream-group" },
                }],
                delete: async (input: { where: { teamGroupId_teamMembershipId_externalGroupBindingId: { externalGroupBindingId: string } } }) => {
                    externalBindingIds.delete(input.where.teamGroupId_teamMembershipId_externalGroupBindingId.externalGroupBindingId);
                },
            },
            teamGroupMembership: { findUnique: async () => ({
                nativeContribution: false,
                externalContributions: [...externalBindingIds].map((externalGroupBindingId) => ({ externalGroupBindingId })),
            }) },
            teamMembership: { findUnique: async () => ({ accountId: "account" }) },
            session: { findMany: async () => [] },
            machine: { findMany: async () => [] },
        } as unknown as Tx;
        const handoff = {
            teamId: "team", teamMembershipId: "membership", accountId: "account",
            directorySourceId: "source", releasedIdentityState,
            sessionAccessImpacts: new Map(),
        };
        await withdrawIneligibleDirectoryGroupContributionsInTx(tx, handoff);
        expect([...externalBindingIds]).toEqual(releasedIdentityState === "active"
            ? ["old-binding", "independent-binding"]
            : ["independent-binding"]);
    });
});
