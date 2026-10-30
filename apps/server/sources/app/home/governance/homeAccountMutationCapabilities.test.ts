import { describe, expect, it } from "vitest";

import { resolveHomeAccountMutationCapabilitiesV1 } from "./homeCapabilities";

describe("resolveHomeAccountMutationCapabilitiesV1", () => {
    const owner = { accountId: "owner", homeRole: "owner", status: "active" } as const;
    const admin = { accountId: "admin", homeRole: "admin", status: "active" } as const;

    it("projects administrator and last-owner decisions without client inference", () => {
        expect(resolveHomeAccountMutationCapabilitiesV1({
            actor: admin,
            target: { accountId: "member", homeRole: "member", status: "active" },
            activeOwnerCount: 1,
            teamOwnershipAllowsErasure: true,
        })).toMatchObject({
            setRole: {
                member: { status: "unavailable", reason: "unchanged" },
                admin: { status: "available" },
                owner: { status: "unavailable", reason: "not_authorized" },
            },
            disable: { status: "available" },
            reenable: { status: "unavailable", reason: "target_not_suspended" },
            delete: { status: "unavailable", reason: "not_authorized" },
        });

        expect(resolveHomeAccountMutationCapabilitiesV1({
            actor: owner,
            target: owner,
            activeOwnerCount: 1,
            teamOwnershipAllowsErasure: true,
        })).toMatchObject({
            setRole: {
                member: { status: "unavailable", reason: "last_active_owner" },
                admin: { status: "unavailable", reason: "last_active_owner" },
                owner: { status: "unavailable", reason: "unchanged" },
            },
            disable: { status: "unavailable", reason: "last_active_owner" },
            delete: { status: "unavailable", reason: "last_active_owner" },
        });
    });

    it("projects suspended, terminal retry, and Team ownership blockers exactly", () => {
        expect(resolveHomeAccountMutationCapabilitiesV1({
            actor: owner,
            target: { accountId: "suspended", homeRole: "member", status: "suspended" },
            activeOwnerCount: 1,
            teamOwnershipAllowsErasure: true,
        })).toMatchObject({
            setRole: {
                member: { status: "unavailable", reason: "unchanged" },
                admin: { status: "unavailable", reason: "target_inactive" },
                owner: { status: "unavailable", reason: "target_inactive" },
            },
            disable: { status: "unavailable", reason: "target_not_active" },
            reenable: { status: "available" },
            delete: { status: "available" },
        });

        expect(resolveHomeAccountMutationCapabilitiesV1({
            actor: owner,
            target: { accountId: "retired", homeRole: "member", status: "disabled" },
            activeOwnerCount: 1,
            teamOwnershipAllowsErasure: false,
        })).toMatchObject({
            reenable: { status: "unavailable", reason: "target_retired" },
            delete: { status: "unavailable", reason: "team_owner_transfer_required" },
        });

        expect(resolveHomeAccountMutationCapabilitiesV1({
            actor: owner,
            target: { accountId: "retired", homeRole: "member", status: "disabled" },
            activeOwnerCount: 1,
            teamOwnershipAllowsErasure: true,
        }).delete).toEqual({ status: "available" });
    });
});
