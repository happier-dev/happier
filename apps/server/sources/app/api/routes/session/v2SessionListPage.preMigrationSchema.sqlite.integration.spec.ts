import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { createV2SessionListInitialPage } from "./v2SessionListInitialPage";
import { findV2SessionListRows, mapV2SessionListRows, V2_SESSION_LIST_ORDER_BY } from "./v2SessionListPage";

/**
 * A binary running ahead of `prisma migrate deploy` reads a schema that does not have the columns
 * its primary projection selects. The projection fallback exists so that read degrades instead of
 * failing, and it derives the legacy *select* from the primary one so new columns self-register.
 *
 * The **predicate** half was missing: the attention read filters on a materialized column, and the
 * fallback re-issued the same `where` on the legacy attempt, so the retry failed identically and the
 * whole `GET /v2/sessions?includeAttention=true` request failed on a pre-migration schema.
 *
 * These tests run against a real SQLite database with the materialized attention columns and the
 * Pending activation authorization columns physically absent, which is the oldest schema the
 * single legacy projection has to answer for.
 */
describe("session list on a pre-migration schema (SQLite integration)", () => {
    let harness: LightSqliteHarness;
    let ownerId = "";
    let unreadWithCursorId = "";
    let unreadWithoutCursorId = "";
    let pendingPermissionId = "";
    let readId = "";
    let archivedUnreadId = "";

    const BASE_AT = 1_700_000_000_000;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-session-list-pre-migration-sqlite-",
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
        });

        const owner = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` }, select: { id: true } });
        ownerId = owner.id;

        const createSession = async (params: Readonly<{
            seq: number;
            lastViewedSessionSeq: number | null;
            activityAt: number;
            archived?: boolean;
            pendingPermissionRequestCount?: number;
        }>): Promise<string> => {
            const created = await db.session.create({
                data: {
                    accountId: ownerId,
                    tag: `tag-${randomUUID()}`,
                    metadata: "{}",
                    seq: params.seq,
                    lastViewedSessionSeq: params.lastViewedSessionSeq,
                    meaningfulActivityAt: new Date(params.activityAt),
                    archivedAt: params.archived ? new Date(params.activityAt) : null,
                    ...(params.pendingPermissionRequestCount !== undefined
                        ? { pendingPermissionRequestCount: params.pendingPermissionRequestCount }
                        : {}),
                },
                select: { id: true },
            });
            return created.id;
        };

        unreadWithCursorId = await createSession({ seq: 7, lastViewedSessionSeq: 3, activityAt: BASE_AT + 4000 });
        // A session that has never been viewed: `seq > lastViewedSessionSeq` is NULL-valued for it, so
        // it needs the second arm of the predecessor predicate to be seen at all.
        unreadWithoutCursorId = await createSession({ seq: 2, lastViewedSessionSeq: null, activityAt: BASE_AT + 3000 });
        // Read, but needs attention through a non-unread arm. It is the case that distinguishes a
        // legacy predicate that kept all four arms from one that only restored the unread comparison.
        pendingPermissionId = await createSession({
            seq: 5,
            lastViewedSessionSeq: 5,
            activityAt: BASE_AT + 3500,
            pendingPermissionRequestCount: 1,
        });
        readId = await createSession({ seq: 4, lastViewedSessionSeq: 4, activityAt: BASE_AT + 2000 });
        archivedUnreadId = await createSession({ seq: 9, lastViewedSessionSeq: 1, activityAt: BASE_AT + 1000, archived: true });

        // Roll the physical schema back to its shape before either materialized attention column.
        // Prisma still believes they exist, which is exactly the new-binary/old-database skew being
        // reproduced.
        await db.$executeRawUnsafe(`DROP INDEX IF EXISTS "Session_accountId_needsAttention_meaningfulActivityAt_id_idx"`);
        await db.$executeRawUnsafe(`ALTER TABLE "Session" DROP COLUMN "needsAttention"`);
        await db.$executeRawUnsafe(`ALTER TABLE "Session" DROP COLUMN "unreadSince"`);
        await db.$executeRawUnsafe(`ALTER TABLE "Session" DROP COLUMN "pendingActivationRequestId"`);
        await db.$executeRawUnsafe(`ALTER TABLE "Session" DROP COLUMN "pendingActivationRequestedAt"`);
        await db.$executeRawUnsafe(`ALTER TABLE "Session" DROP COLUMN "pendingActivationStatus"`);
        await db.$executeRawUnsafe(`ALTER TABLE "Session" DROP COLUMN "pendingActivationFailureCode"`);
    }, 180_000);

    beforeEach(() => harness.resetEnv());

    afterAll(async () => {
        await harness.close();
    });

    it("fixture control: the database cannot answer a query that names an intentionally absent column", async () => {
        // Anti-vacuity for every other test in this file: if either of these ever starts succeeding,
        // the fixture stopped reproducing a pre-migration schema and the rest proves nothing.
        await expect(db.session.findMany({
            where: { accountId: ownerId, needsAttention: true },
            select: { id: true },
        })).rejects.toThrow(/needsAttention/);
        await expect(db.session.findMany({
            where: { accountId: ownerId, unreadSince: { not: null } },
            select: { id: true },
        })).rejects.toThrow(/unreadSince/);
        await expect(db.session.findMany({
            where: { accountId: ownerId },
            select: { pendingActivationRequestId: true },
        })).rejects.toThrow(/pendingActivationRequestId/);
    });

    it("KEYSTONE: still answers the attention read, from the predecessor derived predicate", async () => {
        const page = await createV2SessionListInitialPage({
            userId: ownerId,
            pageRows: [],
            limit: 20,
            pinnedSessionIds: [],
            includeAttentionRows: true,
        });

        const ids = page.sessions.map((session) => session.id);
        // Both unread shapes must survive: dropping the unread arms on the legacy retry would lose
        // them here, and re-issuing the primary predicate throws.
        expect(ids).toContain(unreadWithCursorId);
        expect(ids).toContain(unreadWithoutCursorId);
        // And the arms the materialized column also folds in must survive with them.
        expect(ids).toContain(pendingPermissionId);
        // Anti-vacuity: the predicate still discriminates. A read session and an archived one are
        // not attention rows, so "everything is returned" cannot pass this test.
        expect(ids).not.toContain(readId);
        expect(ids).not.toContain(archivedUnreadId);
    });

    it("keeps serving an ordinary page read, with the absent column reported as null", async () => {
        const rows = await findV2SessionListRows({
            userId: ownerId,
            where: { archivedAt: null },
            orderBy: V2_SESSION_LIST_ORDER_BY,
            take: 10,
        });
        const sessions = mapV2SessionListRows({ rows, userId: ownerId });

        expect(sessions.map((session) => session.id)).toEqual([
            unreadWithCursorId,
            pendingPermissionId,
            unreadWithoutCursorId,
            readId,
        ]);
        expect(sessions.every((session) => session.unreadSince === null)).toBe(true);
        expect(sessions.every((session) => session.pendingActivationAuthorization === undefined)).toBe(true);
    });
});
