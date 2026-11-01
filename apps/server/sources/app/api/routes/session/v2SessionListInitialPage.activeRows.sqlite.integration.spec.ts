import { randomUUID } from "node:crypto";

import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";

import { encodeV2SessionListCursorV2 } from "@happier-dev/protocol";
import { auth } from "@/app/auth/auth";
import { enableAuthentication } from "@/app/api/utils/enableAuthentication";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { createAppCloseTracker } from "../../testkit/appLifecycle";
import { sessionRoutes } from "./sessionRoutes";
import { createV2SessionListInitialPage } from "./v2SessionListInitialPage";
import {
    ACTIVE_SESSION_WINDOW_MS,
    findV2SessionListRows,
    V2_SESSION_LIST_ORDER_BY,
} from "./v2SessionListPage";

const { trackApp, closeTrackedApps } = createAppCloseTracker();

function createTestApp() {
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    // Test-boundary bridge: route helpers use the app-local Fastify alias with auth decorations.
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;
    enableAuthentication(typed);
    sessionRoutes(typed);
    return trackApp(typed);
}

/**
 * The active-session family used to arrive over its own `GET /v2/sessions/active` round trip, issued
 * in parallel with the initial list page. Measured on a device: that call carried ~1.08 MB of
 * per-session e2ee metadata and, because the server holds a single database connection, the list
 * page queued behind it — both requests reported 2,946 ms. `includeActive` merges the family into
 * the page the client already asks for, so the rows are identical and the round trip is gone.
 *
 * These tests run against a real database rather than a query-shape mock because the two things
 * worth pinning are which *rows* the merge yields: the family must still be defined by
 * `active AND lastActiveAt > now - window`, and — the defect this found — it must carry the
 * `archivedAt IS NULL` conjunct every other list read has, which the standalone endpoint never had.
 */
describe("v2 session list initial page: merged active rows (SQLite integration)", () => {
    let harness: LightSqliteHarness;
    const restoreQueryObservers: Array<() => void> = [];

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-session-list-active-rows-sqlite-",
            initAuth: true,
            initEncrypt: false,
            initFiles: false,
        });
    }, 180_000);

    afterEach(async () => {
        for (const restore of restoreQueryObservers.splice(0)) restore();
        await closeTrackedApps();
        harness.resetEnv();
        await db.accessKey.deleteMany();
        await db.session.deleteMany();
        await db.account.deleteMany();
    });

    afterAll(async () => await harness.close());

    async function createAccount(): Promise<string> {
        const account = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` }, select: { id: true } });
        return account.id;
    }

    async function createSession(params: Readonly<{
        accountId: string;
        id: string;
        activityAt: number;
        active?: boolean;
        lastActiveAt?: number;
        archivedAt?: number;
        metadata?: string;
    }>): Promise<string> {
        const created = await db.session.create({
            data: {
                id: params.id,
                accountId: params.accountId,
                tag: `tag-${params.id}`,
                metadata: params.metadata ?? "{}",
                meaningfulActivityAt: new Date(params.activityAt),
                createdAt: new Date(params.activityAt),
                active: params.active ?? false,
                lastActiveAt: new Date(params.lastActiveAt ?? params.activityAt),
                archivedAt: params.archivedAt === undefined ? null : new Date(params.archivedAt),
            },
            select: { id: true },
        });
        return created.id;
    }

    /**
     * One recent-activity row that the page itself returns, plus three rows that only the active
     * family could reach: a live one, a live-but-archived one, and one whose heartbeat has aged out.
     */
    async function seed(): Promise<Readonly<{ userId: string; pageRowActivityAt: number }>> {
        const userId = await createAccount();
        const now = Date.now();
        const stale = now - 30 * 24 * 60 * 60 * 1000;

        await createSession({ accountId: userId, id: "page-row", activityAt: now });
        await createSession({
            accountId: userId,
            id: "live-row",
            activityAt: stale,
            active: true,
            lastActiveAt: now - 1_000,
        });
        await createSession({
            accountId: userId,
            id: "live-but-archived-row",
            activityAt: stale,
            active: true,
            lastActiveAt: now - 1_000,
            archivedAt: now - 500,
        });
        await createSession({
            accountId: userId,
            id: "live-flag-without-heartbeat-row",
            activityAt: stale,
            active: true,
            lastActiveAt: now - ACTIVE_SESSION_WINDOW_MS - 1_000,
        });

        return { userId, pageRowActivityAt: now };
    }

    async function readInitialPage(params: Readonly<{ userId: string; includeActiveRows: boolean }>) {
        const pageRows = await findV2SessionListRows({
            userId: params.userId,
            where: { archivedAt: null },
            orderBy: V2_SESSION_LIST_ORDER_BY,
            take: 2,
        });
        const page = await createV2SessionListInitialPage({
            userId: params.userId,
            pageRows,
            limit: 1,
            pinnedSessionIds: [],
            includeAttentionRows: false,
            includeActiveRows: params.includeActiveRows,
        });
        return page.sessions.map((session) => session.id);
    }

    it("merges live sessions the page misses and excludes archived and aged-out ones", async () => {
        const { userId } = await seed();

        expect(await readInitialPage({ userId, includeActiveRows: true })).toEqual([
            "live-row",
            "page-row",
        ]);
    });

    it("orders tied active heartbeats by id across reused and queried rows", async () => {
        const userId = await createAccount();
        const now = Date.now();
        const heartbeat = now - 1_000;
        await createSession({
            accountId: userId,
            id: "m-page",
            activityAt: now,
            active: true,
            lastActiveAt: heartbeat,
        });
        await createSession({
            accountId: userId,
            id: "a-probe",
            activityAt: now - 1,
            active: true,
            lastActiveAt: heartbeat,
        });
        await createSession({
            accountId: userId,
            id: "z-read",
            activityAt: now - 2,
            active: true,
            lastActiveAt: heartbeat,
        });

        const pageRows = await findV2SessionListRows({
            userId,
            where: { archivedAt: null },
            orderBy: V2_SESSION_LIST_ORDER_BY,
            take: 2,
        });
        const page = await createV2SessionListInitialPage({
            userId,
            pageRows,
            limit: 1,
            pinnedSessionIds: [],
            includeAttentionRows: false,
            includeActiveRows: true,
        });

        expect(page.sessions.map((session) => session.id)).toEqual(["z-read", "m-page", "a-probe"]);
    });

    it("reads no active rows at all when includeActive is not requested", async () => {
        const { userId } = await seed();

        // The discriminator for "the flag is wired": without it the same fixture yields only the page.
        expect(await readInitialPage({ userId, includeActiveRows: false })).toEqual(["page-row"]);
    });

    /**
     * The wire half of the same contract.
     *
     * `includeActive` is only worth sending if the client can tell whether the server honoured it,
     * and it cannot infer that from the rows: a server that predates the flag drops the unknown query
     * key in its zod querystring schema and answers with a valid page, while an account with no live
     * session legitimately yields no extra rows either way. So absence proves nothing and the client
     * (`sessionHttpCompat.ts`, `parsed.includedActive === true`) keeps issuing the separate
     * `GET /v2/sessions/active` call unless the response says the merge happened.
     *
     * These assert on the serialized body rather than the builder's return value because that is
     * exactly where the two halves previously disagreed: the merge shipped without the marker, so
     * every client paid for both the merge and the round trip it was supposed to remove.
     * `V2SessionListResponseSchema` is `.passthrough()`, so the marker survives response
     * serialization without a protocol format change — which is itself part of what is pinned here.
     */
    describe("advertises the merge on the wire", () => {
        async function fetchSessionListBody(params: Readonly<{
            userId: string;
            query: string;
        }>): Promise<Record<string, unknown>> {
            const app = createTestApp();
            const token = await auth.createToken(params.userId);
            const response = await app.inject({
                method: "GET",
                url: `/v2/sessions?limit=1${params.query}`,
                headers: { authorization: `Bearer ${token}` },
            });
            expect(response.statusCode, response.body).toBe(200);
            return response.json() as Record<string, unknown>;
        }

        function readSessionIds(body: Record<string, unknown>): string[] {
            const sessions = body.sessions;
            if (!Array.isArray(sessions)) throw new Error("response carried no sessions array");
            return sessions.map((session) => (session as { id: string }).id);
        }

        it("adds only accessible required rows, including archived shares, without changing pagination", async () => {
            const { userId } = await seed();
            const ownerId = await createAccount();
            const archivedAt = Date.now() - 500;
            await createSession({ accountId: ownerId, id: "required-shared", activityAt: 1, archivedAt });
            await createSession({ accountId: ownerId, id: "required-denied", activityAt: 1 });
            await db.sessionShare.create({ data: {
                sessionId: "required-shared", sharedByUserId: ownerId, sharedWithUserId: userId,
                encryptedDataKey: new Uint8Array([1, 2, 3]),
            } });
            const ordinary = await fetchSessionListBody({ userId, query: "&includeActive=true" });
            const requiredIds = ["required-shared", "live-but-archived-row", "live-flag-without-heartbeat-row",
                "required-denied", "required-missing", "page-row", "required-shared"];
            const merged = await fetchSessionListBody({
                userId, query: `&includeActive=true&requiredSessionIds=${encodeURIComponent(JSON.stringify(requiredIds))}`,
            });

            expect(readSessionIds(merged)).toEqual([
                "live-row", "page-row", "required-shared", "live-but-archived-row", "live-flag-without-heartbeat-row",
            ]);
            expect(merged.nextCursor).toBe(ordinary.nextCursor);
            expect(merged.hasNext).toBe(ordinary.hasNext);
            expect(merged.includedActive).toBe(true);
            expect(merged.sessions).toEqual(expect.arrayContaining([
                expect.objectContaining({ id: "required-shared", archivedAt, share: { accessLevel: "view", canApprovePermissions: false }, dataEncryptionKey: "AQID" }),
            ]));
        });

        it("serves required-only chunks without reading or returning any other row family", async () => {
            const { userId } = await seed();
            // Observe the real database boundary: every session read must be scoped to the requested ids.
            function observeReads(delegate: unknown): unknown[] {
                // Prisma's proxy methods need explicit binding; keep every real query intact.
                const model = delegate as { findMany: (args: unknown) => Promise<unknown> };
                const original = model.findMany.bind(model);
                const reads: unknown[] = [];
                model.findMany = async (args) => { reads.push(args); return await original(args); };
                restoreQueryObservers.push(() => { model.findMany = original; });
                return reads;
            }
            const sessionReads = observeReads(db.session);
            const pinReads = observeReads(db.sessionPin);
            const requiredIds = ["live-but-archived-row", "live-flag-without-heartbeat-row", "missing"];
            const body = await fetchSessionListBody({ userId, query:
                `&requiredOnly=true&includeActive=true&includeAttention=true&cursor=ignored&requiredSessionIds=${encodeURIComponent(JSON.stringify(requiredIds))}`,
            });

            expect(readSessionIds(body)).toEqual(["live-but-archived-row", "live-flag-without-heartbeat-row"]);
            expect(body.nextCursor).toBeNull();
            expect(body.hasNext).toBe(false);
            expect("includedActive" in body).toBe(false);
            expect(pinReads).toHaveLength(0);
            expect(sessionReads.length).toBeGreaterThan(0);
            for (const args of sessionReads) {
                expect(args).toEqual(expect.objectContaining({ where: expect.objectContaining({ id: { in: requiredIds } }) }));
            }
        });

        it("returns an empty required-only response without an ordinary page", async () => {
            const { userId } = await seed();
            const body = await fetchSessionListBody({ userId, query: "&requiredOnly=true&requiredSessionIds=%5B%5D" });
            expect(body).toEqual({ sessions: [], nextCursor: null, hasNext: false });
        });

        it("marks the initial page that merged the active family with includedActive", async () => {
            const { userId } = await seed();

            const body = await fetchSessionListBody({ userId, query: "&includeActive=true" });

            expect(body.includedActive).toBe(true);
            // Anti-vacuity: the marker must accompany the rows it describes, not stand in for them.
            expect(readSessionIds(body)).toEqual(["live-row", "page-row"]);
        });

        it("leaves a response that did not merge indistinguishable from an older server's", async () => {
            const { userId } = await seed();

            const body = await fetchSessionListBody({ userId, query: "" });

            expect("includedActive" in body).toBe(false);
            expect(readSessionIds(body)).toEqual(["page-row"]);
            expect(Object.keys(body).sort()).toEqual(["hasNext", "nextCursor", "sessions"]);
        });

        it("does not mark a cursor page, which never merges the family", async () => {
            const { userId, pageRowActivityAt } = await seed();
            const cursor = encodeV2SessionListCursorV2({
                sessionId: "page-row",
                meaningfulActivityAt: pageRowActivityAt,
            });

            const body = await fetchSessionListBody({
                userId,
                query: `&includeActive=true&cursor=${encodeURIComponent(cursor)}&requiredSessionIds=${encodeURIComponent(JSON.stringify(["live-but-archived-row"]))}`,
            });

            expect("includedActive" in body).toBe(false);
            // The page after the cursor is ordinary paging, so the family is not merged into it.
            expect(readSessionIds(body)).not.toContain("page-row");
            expect(readSessionIds(body)).not.toContain("live-but-archived-row");
        });
    });

    /**
     * What the merge is worth, in bytes.
     *
     * The device capture that motivated this lane compared wall clock — 2,933 ms merged against
     * 2,946 ms for the two-request shape — on a machine whose load average ranged from 6 to 37, and
     * concluded the merge "did not reduce one byte". Wall clock cannot settle that; serialized length
     * can, and it says otherwise: the two-request shape ships every session that is both live and
     * recently active **twice**, once per response, and the merged shape de-duplicates by session id.
     *
     * These assertions are on `Buffer.byteLength` of the real serialized bodies, so they are
     * deterministic under any load. The fixture gives each session a metadata blob of a known size
     * because that blob is what the payload actually is: e2ee ciphertext the server cannot project
     * away (measured at ~35.8 KB per session on the reference account).
     *
     * The correctness bar rides along in the same fixture: the merged response must still carry every
     * session either shape would have shown. A smaller payload that lost a live row would be a
     * regression, not an optimization, so the byte assertions are paired with a row-set assertion.
     */
    describe("merged payload bytes", () => {
        const METADATA_BLOB_BYTES = 4096;
        const PAGE_LIMIT = 3;

        /**
         * Five sessions in three groups: rows only the page reaches, rows both families reach (the
         * duplication the merge removes), and live rows whose meaningful activity is too old for the
         * page — the family's whole reason to exist.
         */
        async function seedPayloadFixture(): Promise<string> {
            const userId = await createAccount();
            const now = Date.now();
            const stale = now - 30 * 24 * 60 * 60 * 1000;
            const metadata = "m".repeat(METADATA_BLOB_BYTES);

            await createSession({ accountId: userId, id: "page-only", activityAt: now, metadata });
            await createSession({
                accountId: userId,
                id: "page-and-live-a",
                activityAt: now - 1,
                active: true,
                lastActiveAt: now - 1_000,
                metadata,
            });
            await createSession({
                accountId: userId,
                id: "page-and-live-b",
                activityAt: now - 2,
                active: true,
                lastActiveAt: now - 2_000,
                metadata,
            });
            await createSession({
                accountId: userId,
                id: "live-only-a",
                activityAt: stale,
                active: true,
                lastActiveAt: now - 3_000,
                metadata,
            });
            await createSession({
                accountId: userId,
                id: "live-only-b",
                activityAt: stale - 1,
                active: true,
                lastActiveAt: now - 4_000,
                metadata,
            });

            return userId;
        }

        async function fetchBody(params: Readonly<{ userId: string; url: string }>) {
            const app = createTestApp();
            const token = await auth.createToken(params.userId);
            const response = await app.inject({
                method: "GET",
                url: params.url,
                headers: { authorization: `Bearer ${token}` },
            });
            expect(response.statusCode).toBe(200);
            const sessions = (response.json() as { sessions: Array<{ id: string }> }).sessions;
            return { bytes: Buffer.byteLength(response.body, "utf8"), ids: sessions.map((s) => s.id) };
        }

        it("ships each session once, so the merged page costs less than the two responses it replaces", async () => {
            const userId = await seedPayloadFixture();

            const pageOnly = await fetchBody({ userId, url: `/v2/sessions?limit=${PAGE_LIMIT}` });
            const activeOnly = await fetchBody({ userId, url: "/v2/sessions/active" });
            const merged = await fetchBody({
                userId,
                url: `/v2/sessions?limit=${PAGE_LIMIT}&includeActive=true`,
            });

            // The fixture is the interesting one only if the two families genuinely overlap.
            expect(pageOnly.ids).toEqual(["page-only", "page-and-live-a", "page-and-live-b"]);
            expect(activeOnly.ids).toEqual([
                "page-and-live-a",
                "page-and-live-b",
                "live-only-a",
                "live-only-b",
            ]);

            // Measured on this fixture: page-only 14,940 B + active-only 19,738 B = 34,678 B for the
            // two-request shape, against 24,820 B merged — 9,858 B (28.4%) removed, which is exactly
            // the two rows both families carried. The saving scales with the overlap, not the cap.
            // No session appears twice in the merged body — the whole byte claim rests on this.
            expect(new Set(merged.ids).size).toBe(merged.ids.length);
            expect(merged.bytes).toBeLessThan(pageOnly.bytes + activeOnly.bytes);
            // The saving is the two duplicated rows, not serialization noise.
            expect(pageOnly.bytes + activeOnly.bytes - merged.bytes)
                .toBeGreaterThan(2 * METADATA_BLOB_BYTES);
        });

        it("adds exactly the live rows the page misses, and loses none of them", async () => {
            const userId = await seedPayloadFixture();

            const pageOnly = await fetchBody({ userId, url: `/v2/sessions?limit=${PAGE_LIMIT}` });
            const merged = await fetchBody({
                userId,
                url: `/v2/sessions?limit=${PAGE_LIMIT}&includeActive=true`,
            });

            // Correctness bar: every row either shape would have displayed is still here.
            expect(new Set(merged.ids)).toEqual(new Set([
                "page-only",
                "page-and-live-a",
                "page-and-live-b",
                "live-only-a",
                "live-only-b",
            ]));
            // Marginal cost of the family is the two rows the page could not reach and nothing else.
            const marginalBytes = merged.bytes - pageOnly.bytes;
            expect(marginalBytes).toBeGreaterThan(2 * METADATA_BLOB_BYTES);
            expect(marginalBytes).toBeLessThan(3 * METADATA_BLOB_BYTES);
        });
    });
});
