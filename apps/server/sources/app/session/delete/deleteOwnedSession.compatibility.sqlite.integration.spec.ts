import {
    afterAll,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";

import { db } from "@/storage/db";
import {
    createLightSqliteHarness,
    type LightSqliteHarness,
} from "@/testkit/lightSqliteHarness";

const emitUpdate = vi.fn();
vi.mock("@/app/events/eventRouter", async () => {
    const actual = await vi.importActual<
        typeof import("@/app/events/eventRouter")
    >("@/app/events/eventRouter");
    return {
        ...actual,
        eventRouter: {
            ...actual.eventRouter,
            emitUpdate,
        },
    };
});

describe("deleteOwnedSession stored-content compatibility (SQLite)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "session-delete-compatibility-",
        });
    });

    afterAll(async () => {
        await harness.close();
    });

    beforeEach(async () => {
        emitUpdate.mockReset();
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.accountChange.deleteMany(),
            () => db.session.deleteMany(),
            () => db.account.deleteMany(),
        ]);
        await db.account.create({ data: { id: "owner" } });
    });

    it("allows a caller to delete layout 1 without interpreting its content", async () => {
        await db.session.create({
            data: {
                id: "layout-1",
                tag: "layout-1",
                accountId: "owner",
                metadata: "shared",
                metadataLayoutVersion: 1,
                ownerMetadata: JSON.stringify({
                    t: "plain",
                    v: { path: "/private" },
                }),
            },
        });

        const { deleteOwnedSession } = await import(
            "./deleteOwnedSession"
        );
        const result = await deleteOwnedSession({
            sessionId: "layout-1",
            ownerAccountId: "owner",
            reason: "user_request",
        });

        expect(result).toEqual({ ok: true });
        expect(await db.session.findUnique({
            where: { id: "layout-1" },
        })).toBeNull();
        expect(await db.accountChange.findMany({
            where: { accountId: "owner" },
            select: {
                kind: true,
                entityId: true,
                hint: true,
            },
        })).toEqual([{
            kind: "session",
            entityId: "layout-1",
            hint: { v: 1, lifecycle: "deleted" },
        }]);
        expect(emitUpdate).toHaveBeenCalled();
    });

    it("preserves released layout-0 deletion for a legacy caller", async () => {
        await db.session.create({
            data: {
                id: "layout-0",
                tag: "layout-0",
                accountId: "owner",
                metadata: "legacy-ciphertext",
                metadataLayoutVersion: 0,
            },
        });

        const { deleteOwnedSession } = await import(
            "./deleteOwnedSession"
        );
        const result = await deleteOwnedSession({
            sessionId: "layout-0",
            ownerAccountId: "owner",
            reason: "user_request",
        });

        expect(result).toEqual({ ok: true });
        expect(await db.session.findUnique({
            where: { id: "layout-0" },
        })).toBeNull();
        expect(await db.accountChange.count({
            where: { accountId: "owner", kind: "session" },
        })).toBe(1);
    });

    it("rolls the durable deletion hint back when the physical delete loses its condition", async () => {
        await db.session.create({
            data: {
                id: "delete-condition-lost",
                tag: "delete-condition-lost",
                accountId: "owner",
                metadata: "legacy-ciphertext",
                metadataLayoutVersion: 0,
            },
        });

        const { deleteOwnedSession } = await import(
            "./deleteOwnedSession"
        );
        const result = await deleteOwnedSession({
            sessionId: "delete-condition-lost",
            reason: "retention_policy",
            // The deletion owner increments seq at its writer boundary. Keeping
            // the pre-claim value in the final predicate deterministically
            // forces the final physical delete to lose its condition after the
            // AccountChange write, exercising the real transaction rollback.
            sessionWhereGuard: { seq: 0 },
        });

        expect(result).toEqual({ ok: false, error: "conflict" });
        expect(await db.session.findUnique({
            where: { id: "delete-condition-lost" },
            select: { seq: true },
        })).toEqual({ seq: 0 });
        expect(await db.accountChange.count({
            where: {
                accountId: "owner",
                kind: "session",
                entityId: "delete-condition-lost",
            },
        })).toBe(0);
        expect(emitUpdate).not.toHaveBeenCalled();
    });
});
