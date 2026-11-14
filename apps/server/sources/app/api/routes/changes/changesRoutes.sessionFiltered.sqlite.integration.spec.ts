import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { withAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { changesRoutes } from "./changesRoutes";
import { auth } from "@/app/auth/auth";
import { enableAuthentication } from "@/app/api/utils/enableAuthentication";
import type { Fastify as AppFastify } from "../../types";
import { buildChangesReadRequest, CHANGES_AFTER_CURSOR_HTTP_HEADER } from '@happier-dev/protocol/changes';
import { preparePlainAccountApiTokenLabel } from "@/testkit/privateLabelFixture";

describe("Session-filtered changes replay (SQLite)", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-session-changes-", initAuth: true,
            env: { AUTH_REQUIRED_LOGIN_PROVIDERS: "" } });
    }, 180_000);
    afterAll(async () => { await harness?.close(); });

    it("admits a scoped token only for its exact feed or supported witness, never the account feed", async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const [a, b] = await Promise.all([0, 1].map(() => db.session.create({ data: {
            accountId: account.id, tag: randomUUID(), metadata: "{}", encryptionMode: "plain",
        } })));
        if (!a || !b) throw new Error("Missing Session fixture");
        for (const session of [a, b]) await inTx(tx => markAccountChanged(tx, {
            accountId: account.id, kind: "session", entityId: session.id,
        }));
        const token = await auth.createApiToken({ accountId: account.id, tokenId: randomUUID(), label: await preparePlainAccountApiTokenLabel(account.id, "feed"), grant: {
            v: 1, actions: { families: [], ids: ["session.transcript.get"] }, targets: { sessions: [a.id], machines: [] },
            approve: false, origins: [], models: null, permissionModes: null, create: null,
        } });
        const app = Fastify().withTypeProvider<ZodTypeProvider>() as AppFastify;
        app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app); changesRoutes(app);
        const headers = { authorization: `Bearer ${token.token}` };
        try {
            const own = await app.inject({ method: "GET", url: `/v2/changes?sessionId=${a.id}`, headers });
            expect(own.statusCode).toBe(200);
            expect(own.json().changes).toEqual([expect.objectContaining({ entityId: a.id, kind: "session" })]);
            const scopedHeaderRead = buildChangesReadRequest({ after: 0, limit: 200, sessionId: a.id, cursorHeader: true });
            expect((await app.inject({ method: "GET", url: scopedHeaderRead.path, headers: { ...headers, ...scopedHeaderRead.headers } })).statusCode).toBe(200);
            expect((await app.inject({ method: "GET", url: '/v2/changes?limit=200',
                headers: { ...headers, [CHANGES_AFTER_CURSOR_HTTP_HEADER]: '0' } })).statusCode).toBe(403);
            for (const url of ["/v2/changes", `/v2/changes?sessionId=${b.id}`,
                `/v2/changes?sessionAccessSessionId=${a.id}`]) {
                const denied = await app.inject({ method: "GET", url, headers });
                expect(denied.statusCode).toBe(403);
                expect(denied.json()).toMatchObject({ error: "credential_scope_denied" });
            }
            const both = await app.inject({ method: "GET", url: `/v2/changes?sessionId=${a.id}&sessionAccessSessionId=${b.id}`, headers });
            expect(both.statusCode).toBe(400);
            const probe = await app.inject({ method: "GET", url: `/v2/changes?sessionAccessSessionId=${a.id}`,
                headers: { ...headers, "x-happier-account-stored-content-protocol": "4" } });
            expect(probe.statusCode).toBe(200);
            expect(probe.json()).toMatchObject({ changes: [], sessionAccessProbe: { sessionId: a.id, status: "available" } });
            expect((await app.inject({ method: "GET", url: "/v2/cursor", headers })).statusCode).toBe(200);
        } finally { await app.close(); }
    });

    it("reads advancing cursor headers through the same scoped page and retention owner as released query cursors", async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const sessions = await Promise.all([0, 1].map(() => db.session.create({ data: {
            accountId: account.id, tag: randomUUID(), metadata: "{}", encryptionMode: "plain",
        } })));
        const [selected, other] = sessions;
        if (!selected || !other) throw new Error("Missing Session fixture");
        const cursors: number[] = [];
        for (const session of [selected, other, selected]) {
            cursors.push(await inTx(tx => markAccountChanged(tx, { accountId: account.id, kind: "session", entityId: session.id }))
                .then(publication => publication.resolveCursor()));
        }
        await withAuthenticatedTestApp(changesRoutes, async app => {
            const url = `/v2/changes?limit=1&sessionId=${selected.id}`;
            const headers = { "x-test-user-id": account.id };
            for (const after of [0, cursors[0]!, cursors[2]!, cursors[2]! + 1]) {
                const legacy = await app.inject({ method: "GET", url: `${url}&after=${after}`, headers });
                const read = buildChangesReadRequest({ after, limit: 1, sessionId: selected.id, cursorHeader: true });
                expect(read.path).toBe(url);
                const stable = await app.inject({ method: "GET", url: read.path, headers: { ...headers, ...read.headers } });
                expect(stable.statusCode).toBe(legacy.statusCode);
                expect(stable.json()).toEqual(legacy.json());
                expect(stable.headers["x-happier-changes-after"]).toBe(String(after));
                expect(stable.headers["cache-control"]).toBe("no-store");
            }
            await db.account.update({ where: { id: account.id }, data: { changesFloor: cursors[2]! } });
            const gone = await app.inject({ method: "GET", url, headers: { ...headers, "x-happier-changes-after": "0" } });
            expect(gone.statusCode).toBe(410);
            for (const value of ["invalid", "-1", "1.5"]) {
                expect((await app.inject({ method: "GET", url, headers: { ...headers, "x-happier-changes-after": value } })).statusCode).toBe(400);
            }
        });
    });

    it("replays only exact Session and share entries with revision hints and stable cursors", async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const sessions = await Promise.all([0, 1].map(() => db.session.create({ data: {
            accountId: account.id, tag: randomUUID(), metadata: "{}", encryptionMode: "plain",
        } })));
        const [a, b] = sessions;
        const mark = (kind: "session" | "share" | "automation", entityId: string, hint: unknown = null) => inTx((tx) => markAccountChanged(tx, {
            accountId: account.id, kind, entityId, hint,
        })).then(publication => publication.resolveCursor());
        const revisionCursor = await mark("session", a!.id, { updatedMessageSeq: 7, updatedMessageId: "message-revised" });
        await mark("session", b!.id, { updatedMessageSeq: 2, updatedMessageId: "other-message" });
        // Same entity id in another namespace must not enter the Session read.
        await mark("automation", a!.id);
        const shareCursor = await mark("share", a!.id, { reason: "access-updated" });
        await withAuthenticatedTestApp(changesRoutes, async (app) => {
            const headers = { "x-test-user-id": account.id };
            const first = await app.inject({ method: "GET", url: `/v2/changes?sessionId=${a!.id}&limit=1`, headers });
            expect(first.statusCode).toBe(200);
            expect(first.json()).toMatchObject({
                changes: [{ cursor: revisionCursor, kind: "session", entityId: a!.id,
                    hint: { updatedMessageSeq: 7, updatedMessageId: "message-revised" } }],
                nextCursor: revisionCursor,
            });
            const next = await app.inject({ method: "GET", url: `/v2/changes?sessionId=${a!.id}&after=${revisionCursor}&limit=1`, headers });
            expect(next.json()).toMatchObject({
                changes: [{ cursor: shareCursor, kind: "share", entityId: a!.id }], nextCursor: shareCursor,
            });
            const other = await app.inject({ method: "GET", url: `/v2/changes?sessionId=${b!.id}`, headers });
            expect(other.json().changes).toEqual([expect.objectContaining({ kind: "session", entityId: b!.id,
                hint: expect.objectContaining({ updatedMessageSeq: 2 }) })]);
            const drained = await app.inject({ method: "GET", url: `/v2/changes?sessionId=${a!.id}&after=${shareCursor}`, headers });
            expect(drained.json()).toMatchObject({ changes: [], nextCursor: shareCursor });
            const laterCursor = await mark("session", a!.id, { updatedMessageSeq: 7, updatedMessageId: "message-revised-again" });
            const later = await app.inject({ method: "GET", url: `/v2/changes?sessionId=${a!.id}&after=${shareCursor}`, headers });
            expect(later.json()).toMatchObject({ changes: [{ cursor: laterCursor, kind: "session", entityId: a!.id,
                hint: { updatedMessageSeq: 7, updatedMessageId: "message-revised-again" } }], nextCursor: laterCursor });
            await db.account.update({ where: { id: account.id }, data: { changesFloor: revisionCursor } });
            for (const after of [0, laterCursor + 1]) {
                const filtered = await app.inject({ method: "GET", url: `/v2/changes?sessionId=${a!.id}&after=${after}`, headers });
                const unfiltered = await app.inject({ method: "GET", url: `/v2/changes?after=${after}`, headers });
                expect(filtered.statusCode).toBe(410);
                expect(filtered.json()).toEqual(unfiltered.json());
            }
        });
    });

    it("serves one exact Session page despite one thousand unrelated Account changes", async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const session = await db.session.create({ data: {
            accountId: account.id, tag: randomUUID(), metadata: "{}", encryptionMode: "plain",
        } });
        const unrelatedCount = 1_000;
        await db.accountChange.createMany({ data: [
            ...Array.from({ length: unrelatedCount }, (_, index) => ({
                accountId: account.id,
                kind: "automation",
                entityId: `unrelated-${index}`,
                cursor: index + 1,
            })),
            {
                accountId: account.id,
                kind: "session",
                entityId: session.id,
                sessionId: session.id,
                cursor: unrelatedCount + 1,
            },
        ] });
        await db.account.update({ where: { id: account.id }, data: { seq: unrelatedCount + 1 } });

        await withAuthenticatedTestApp(changesRoutes, async (app) => {
            const response = await app.inject({
                method: "GET",
                url: `/v2/changes?sessionId=${session.id}&limit=1`,
                headers: { "x-test-user-id": account.id },
            });

            expect(response.statusCode).toBe(200);
            expect(response.json()).toMatchObject({
                changes: [{ cursor: unrelatedCount + 1, kind: "session", entityId: session.id }],
                nextCursor: unrelatedCount + 1,
            });
        });
    });

    it("selects kinds before paging and advances only through the captured Account cursor", async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const unrelatedCount = 1_000;
        const boundary = unrelatedCount + 2;
        const throughCursor = boundary + 2;
        await db.accountChange.createMany({ data: [
            { accountId: account.id, kind: "machine", entityId: "acknowledged", cursor: 1 },
            ...Array.from({ length: unrelatedCount }, (_, index) => ({
                accountId: account.id, kind: "automation", entityId: `irrelevant-${index}`, cursor: index + 2,
            })),
            { accountId: account.id, kind: "machine", entityId: "boundary", cursor: boundary },
            { accountId: account.id, kind: "share", entityId: "tail", cursor: boundary + 1 },
            { accountId: account.id, kind: "automation", entityId: "irrelevant-tail", cursor: throughCursor },
            { accountId: account.id, kind: "machine", entityId: "beyond-snapshot", cursor: throughCursor + 1 },
        ] });
        await db.account.update({ where: { id: account.id }, data: { seq: throughCursor } });
        await withAuthenticatedTestApp(changesRoutes, async (app) => {
            const headers = { "x-test-user-id": account.id };
            const first = await app.inject({ method: "GET", url: "/v2/changes?kinds=machine,share&after=1&limit=1", headers });
            expect(first.statusCode).toBe(200);
            expect(first.json()).toMatchObject({ changes: [{ kind: "machine", entityId: "boundary", cursor: boundary }], nextCursor: boundary });
            const tail = await app.inject({ method: "GET", url: `/v2/changes?kinds=machine,share&after=${boundary}&limit=2`, headers });
            expect(tail.json()).toMatchObject({ changes: [{ kind: "share", entityId: "tail", cursor: boundary + 1 }], nextCursor: throughCursor });
            const drained = await app.inject({ method: "GET", url: `/v2/changes?kinds=machine,share&after=${throughCursor}`, headers });
            expect(drained.json()).toMatchObject({ changes: [], nextCursor: throughCursor });
            const noMatch = await app.inject({ method: "GET", url: "/v2/changes?kinds=session&after=1", headers });
            expect(noMatch.json()).toMatchObject({ changes: [], nextCursor: throughCursor });
            const unselected = await app.inject({ method: "GET", url: "/v2/changes?after=1&limit=1", headers });
            expect(unselected.json()).toMatchObject({ changes: [{ kind: "automation", cursor: 2 }], nextCursor: 2 });
            for (const kinds of ["", "unknown", "machine,", "machine,unknown"]) {
                expect((await app.inject({ method: "GET", url: `/v2/changes?kinds=${kinds}`, headers })).statusCode).toBe(400);
            }
            await db.account.update({ where: { id: account.id }, data: { changesFloor: 1 } });
            for (const after of [0, throughCursor + 1]) {
                const selected = await app.inject({ method: "GET", url: `/v2/changes?kinds=machine&after=${after}`, headers });
                const unselected = await app.inject({ method: "GET", url: `/v2/changes?after=${after}`, headers });
                expect(selected.statusCode).toBe(410);
                expect(selected.json()).toEqual(unselected.json());
            }
        });
    });

    it("intersects kinds with exact Session selection and retains removal access witnesses", async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const sessionId = randomUUID();
        await db.accountChange.createMany({ data: [
            { accountId: account.id, kind: "session", entityId: sessionId, cursor: 1, hint: { v: 1, lifecycle: "deleted" } },
            { accountId: account.id, kind: "share", entityId: sessionId, cursor: 2 },
            { accountId: account.id, kind: "machine", entityId: sessionId, cursor: 3 },
        ] });
        await db.account.update({ where: { id: account.id }, data: { seq: 3 } });
        await withAuthenticatedTestApp(changesRoutes, async (app) => {
            const headers = { "x-test-user-id": account.id, "x-happier-account-stored-content-protocol": "4" };
            const selected = await app.inject({ method: "GET", url: `/v2/changes?sessionId=${sessionId}&kinds=session,machine`, headers });
            expect(selected.statusCode).toBe(200);
            expect(selected.json()).toMatchObject({ changes: [{ kind: "session", entityId: sessionId, hint: { v: 1, lifecycle: "deleted" } }], nextCursor: 3,
                sessionAccessWitness: { throughCursor: 3, entries: [{ sessionId, cursor: 1, status: "unavailable" }] } });
            const emptyIntersection = await app.inject({ method: "GET", url: `/v2/changes?sessionId=${sessionId}&kinds=machine`, headers });
            expect(emptyIntersection.json()).toMatchObject({ changes: [], nextCursor: 3, sessionAccessWitness: { entries: [] } });
        });
    });

    it("rejects combined selectors before the access probe and preserves the probe alone", async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: "{}", encryptionMode: "plain" } });
        await db.account.update({ where: { id: account.id }, data: { seq: 10, changesFloor: 5 } });
        await withAuthenticatedTestApp(changesRoutes, async (app) => {
            const headers = { "x-test-user-id": account.id, "x-happier-account-stored-content-protocol": "4" };
            const both = await app.inject({ method: "GET", url: `/v2/changes?sessionId=${session.id}&sessionAccessSessionId=${session.id}`, headers });
            expect(both.statusCode).toBe(400);
            expect(both.json()).toMatchObject({ error: "invalid_params" });
            const kindProbe = await app.inject({ method: "GET", url: `/v2/changes?sessionAccessSessionId=${session.id}&kinds=session`, headers });
            expect(kindProbe.statusCode).toBe(400);
            expect(kindProbe.json()).toMatchObject({ error: "invalid_params" });
            const probe = await app.inject({ method: "GET", url: `/v2/changes?sessionAccessSessionId=${session.id}`, headers });
            expect(probe.statusCode).toBe(200);
            expect(probe.json()).toMatchObject({ changes: [], nextCursor: 10,
                sessionAccessProbe: { v: 1, sessionId: session.id, throughCursor: 10, status: "available" } });
        });
    });
});
