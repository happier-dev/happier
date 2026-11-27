import { describe, expect, it } from "vitest";

import {
    conjoinSessionListWhereInputs,
    createFilteredSessionListWhere,
} from "./query";

describe("conjoinSessionListWhereInputs", () => {
    it("preserves every sibling predicate in one explicit conjunction", () => {
        const access = { OR: [{ accountId: "viewer" }, { shares: { some: { sharedWithUserId: "viewer" } } }] };
        const selection = {
            archivedAt: null,
            AND: [
                { OR: [{ active: true }, { id: { in: ["attention"] } }] },
                { sessionTagAssignments: { some: { accountId: "viewer", tagId: { in: ["tag"] } } } },
            ],
        };
        const cursor = { OR: [
            { meaningfulActivityAt: { lt: new Date(2_000) } },
            { meaningfulActivityAt: new Date(2_000), id: { lt: "cursor" } },
        ] };

        expect(conjoinSessionListWhereInputs(access, selection, cursor)).toEqual({
            AND: [
                access,
                { archivedAt: null },
                ...selection.AND,
                cursor,
            ],
        });
    });

    it("drops empty predicates without changing match semantics", () => {
        expect(conjoinSessionListWhereInputs({}, undefined, { AND: [] })).toEqual({ AND: [] });
    });
});

describe("createFilteredSessionListWhere", () => {
    it("conjoins access, storage, scope, audience, tags, attention and inactive selection", () => {
        const attentionWhere = { id: { in: ["attention"] } };

        expect(createFilteredSessionListWhere({
            accountId: "viewer",
            query: {
                v: 1,
                storage: "active",
                includeInactive: false,
                scope: "assigned_to_me",
                attention: "needs_my_attention",
                audiences: { include: [], exclude: [] },
                tagIds: { include: ["tag"], exclude: ["hidden"] },
            },
            accessWhere: { OR: [{ accountId: "viewer" }, { teamGrants: { some: { teamId: "team" } } }] },
            scopeWhere: { responsibleAccountId: "viewer" },
            audienceWhere: {},
            attentionWhere,
        })).toEqual({
            AND: [
                { OR: [{ accountId: "viewer" }, { teamGrants: { some: { teamId: "team" } } }] },
                { archivedAt: null },
                { responsibleAccountId: "viewer" },
                { sessionTagAssignments: { some: { accountId: "viewer", tagId: { in: ["tag"] } } } },
                { sessionTagAssignments: { none: { accountId: "viewer", tagId: { in: ["hidden"] } } } },
                attentionWhere,
                // "Hide inactive" selects the liveness the row projection publishes:
                // the stored column alone is not the answer, so a Session whose
                // transcript is not hosted is only admitted through attention.
                {
                    OR: [
                        { AND: [{ currentStorageState: "hosted" }, { active: true }] },
                        attentionWhere,
                    ],
                },
            ],
        });
    });

    it("omits optional predicates for an unfiltered archived corpus", () => {
        expect(createFilteredSessionListWhere({
            accountId: "viewer",
            query: {
                v: 1,
                storage: "archived",
                includeInactive: true,
                scope: "all_accessible",
                attention: "any",
                audiences: { include: [], exclude: [] },
                tagIds: { include: [], exclude: [] },
            },
            accessWhere: { accountId: "viewer" },
            scopeWhere: {},
            audienceWhere: {},
            attentionWhere: { id: { in: [] } },
        })).toEqual({
            AND: [
                { accountId: "viewer" },
                { archivedAt: { not: null } },
            ],
        });
    });
});
