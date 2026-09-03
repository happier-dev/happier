import { describe, expect, it, vi } from "vitest";

/**
 * Boundary stub, not a logic mock: the legacy attention predicate compares two columns, which Prisma
 * expresses with a field reference taken from a *connected* client. These tests only inspect the
 * predicate's shape, so the client is stubbed down to the one field reference it reads. The same
 * predicate is exercised against a real database, with the column physically absent, in
 * `v2SessionListPage.preMigrationSchema.sqlite.integration.spec.ts`.
 */
vi.mock("@/storage/db", () => ({
    db: {
        session: {
            fields: { lastViewedSessionSeq: { _ref: "lastViewedSessionSeq", _container: "Session" } },
        },
    },
}));

import { createV2SessionListAttentionRowsWhere } from "./v2SessionListInitialPage";
import {
    isMissingSessionProjectionColumnError,
    runWithSessionListProjectionFallback,
} from "./v2SessionListPage";
import {
    createV2SessionListLegacyRowSelect,
    createV2SessionListRowSelect,
    omitSessionListProjectionFallbackColumns,
    SESSION_LIST_PROJECTION_FALLBACK_COLUMNS,
} from "./v2SessionListRows";

/**
 * The projection fallback is what keeps a binary that is running ahead of `prisma migrate deploy`
 * serving session lists: the primary projection selects columns the old schema does not have, the
 * query fails, and the legacy projection answers instead.
 *
 * Its matcher used to restate the column list by hand, so `unreadSince` was added to the primary
 * projection while the matcher still did not recognise it — that shape of query failed outright.
 * These tests pin the matcher against the projections themselves.
 *
 * The fallback has a second half, which the same class of drift broke: the retry must also stop
 * *filtering* on the columns it stopped selecting. `findV2SessionListRows` takes a `legacyWhere` for
 * that, and the tests below pin the one predicate that needs it against the fallback column list, so
 * a column added to the attention predicate later cannot silently reintroduce the failure. The
 * end-to-end proof, against a database with the column physically absent, is
 * `v2SessionListPage.preMigrationSchema.sqlite.integration.spec.ts`.
 */

/** The shape Prisma reports for a column the connected database does not have. */
function missingColumnError(column: string): Error {
    const error = new Error(
        `Invalid \`prisma.session.findMany()\` invocation:\n\nThe column \`main.Session.${column}\` does not exist in the current database.`,
    );
    error.name = "PrismaClientKnownRequestError";
    Object.assign(error, { code: "P2022", meta: { column: `main.Session.${column}` } });
    return error;
}

function columnsAddedByPrimaryProjection(): string[] {
    const primary = createV2SessionListRowSelect({ userId: "u1" }) as Record<string, unknown>;
    const legacy = createV2SessionListLegacyRowSelect({ userId: "u1" }) as Record<string, unknown>;
    return Object.keys(primary).filter((column) => !(column in legacy));
}

/** Every column a where-input names, at any nesting depth. */
function collectWhereColumns(node: unknown, out: Set<string> = new Set()): Set<string> {
    if (Array.isArray(node)) {
        for (const member of node) collectWhereColumns(member, out);
        return out;
    }
    if (typeof node !== "object" || node === null || node instanceof Date) return out;
    for (const [key, value] of Object.entries(node)) {
        out.add(key);
        collectWhereColumns(value, out);
    }
    return out;
}

function fallbackColumnsNamedBy(where: unknown): string[] {
    const named = collectWhereColumns(where);
    return SESSION_LIST_PROJECTION_FALLBACK_COLUMNS.filter((column) => named.has(column));
}

describe("session list projection fallback", () => {
    it("KEYSTONE: recognises every column the primary projection adds over the legacy projection", () => {
        const addedColumns = columnsAddedByPrimaryProjection();

        expect(addedColumns.length).toBeGreaterThan(0);
        for (const column of addedColumns) {
            expect(
                isMissingSessionProjectionColumnError(missingColumnError(column)),
                `missing-column errors for \`${column}\` must fall back to the legacy projection`,
            ).toBe(true);
        }
    });

    it("builds an old-schema-safe projection that keeps everything the old schema does have", () => {
        // The v1 list depends on this to survive an old schema. A too-eager omission would only
        // fail in the fallback path — the least visible failure mode this change can produce.
        const primary = createV2SessionListRowSelect({ userId: "u1" }) as Record<string, unknown>;
        const addedColumns = columnsAddedByPrimaryProjection();
        const safe = omitSessionListProjectionFallbackColumns(primary) as Record<string, unknown>;

        expect(Object.keys(safe).sort()).toEqual(
            Object.keys(primary).filter((column) => !addedColumns.includes(column)).sort(),
        );
        expect(safe.id).toBe(true);
        expect(safe.shares).toBe(primary.shares);
    });

    it("drops every pending activation authorization column from the pre-migration projection", () => {
        const authorizationColumns = [
            "pendingActivationRequestId",
            "pendingActivationRequestedAt",
            "pendingActivationStatus",
            "pendingActivationFailureCode",
        ];
        const primary = createV2SessionListRowSelect({ userId: "u1" }) as Record<string, unknown>;
        const safe = omitSessionListProjectionFallbackColumns(primary) as Record<string, unknown>;

        expect(SESSION_LIST_PROJECTION_FALLBACK_COLUMNS).toEqual(
            expect.arrayContaining(authorizationColumns),
        );
        for (const column of authorizationColumns) {
            expect(primary).toHaveProperty(column, true);
            expect(safe).not.toHaveProperty(column);
            expect(isMissingSessionProjectionColumnError(missingColumnError(column))).toBe(true);
        }
    });

    it("recognises a missing unreadSince column so a new binary on an old schema still serves the list", () => {
        expect(isMissingSessionProjectionColumnError(missingColumnError("unreadSince"))).toBe(true);
    });

    it("KEYSTONE: the legacy attention predicate names no column the legacy projection had to drop", () => {
        // The select-side fallback protects what the read *returns*. This is the other half: a
        // predicate naming a dropped column makes the retry re-issue the same failing statement, so
        // the request fails outright on a pre-migration schema instead of degrading.
        expect(fallbackColumnsNamedBy(createV2SessionListAttentionRowsWhere("derived"))).toEqual([]);
        // Anti-vacuity: the same walk must find the materialized column on the primary predicate, or
        // this test would pass against a collector that sees nothing.
        expect(fallbackColumnsNamedBy(createV2SessionListAttentionRowsWhere("materialized")))
            .toContain("needsAttention");
    });

    it("keeps the legacy attention predicate equivalent to the primary one, not a narrower filter", () => {
        // A pre-migration schema has neither `needsAttention` nor `unreadSince`, so the legacy
        // predicate must supply the whole definition those columns materialize rather than dropping
        // arms — otherwise the attention page silently loses every row that qualifies only through a
        // dropped arm.
        const derived = createV2SessionListAttentionRowsWhere("derived");
        const named = collectWhereColumns(derived);

        expect(named.has("seq")).toBe(true);
        expect(named.has("lastViewedSessionSeq")).toBe(true);
        expect(named.has("archivedAt")).toBe(true);
        expect(named.has("latestTurnStatus")).toBe(true);
        expect(named.has("pendingPermissionRequestCount")).toBe(true);
        expect(named.has("pendingUserActionRequestCount")).toBe(true);
    });

    it("does not treat an unrelated failure as a missing projection column", () => {
        expect(isMissingSessionProjectionColumnError(new Error("connection terminated unexpectedly"))).toBe(false);
        expect(isMissingSessionProjectionColumnError(new Error("column \"tag\" is ambiguous"))).toBe(false);
    });

    it("answers a missing unreadSince column from the legacy projection instead of throwing", async () => {
        const primary = vi.fn(async () => {
            throw missingColumnError("unreadSince");
        });
        const legacy = vi.fn(async () => "legacy-rows");

        await expect(runWithSessionListProjectionFallback(primary, legacy)).resolves.toBe("legacy-rows");
        expect(legacy).toHaveBeenCalledTimes(1);
    });

    it("propagates an unrelated failure instead of silently downgrading the projection", async () => {
        const failure = new Error("connection terminated unexpectedly");
        const legacy = vi.fn(async () => "legacy-rows");

        await expect(runWithSessionListProjectionFallback(async () => {
            throw failure;
        }, legacy)).rejects.toBe(failure);
        expect(legacy).not.toHaveBeenCalled();
    });
});
