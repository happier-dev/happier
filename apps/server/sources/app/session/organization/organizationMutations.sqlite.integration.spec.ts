import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
    DeleteSessionOrganizationFolderResponseSchema,
    ReorderSessionOrganizationResponseSchema,
    SessionOrganizationSnapshotResponseSchema,
    SetSessionPinResponseSchema,
    SetSessionTagAssignmentsResponseSchema,
} from "@happier-dev/protocol";
import { SessionOrganizationChangeHintSchema } from "@happier-dev/protocol/changes";
import { UpdateContainerSchema } from "@happier-dev/protocol/updates";

import { createAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { registerSessionOrganizationRoutes } from "@/app/api/routes/session/registerSessionOrganizationRoutes";
import { getAccountStoredContentV3SocketRoom } from "@/app/api/socketRooms";
import { eventRouter } from "@/app/events/connectionEventRouter";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createPresentUserSessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication.testkit";
import { observePrismaReads } from "@/testkit/observePrismaReads";
import type { Tx } from "@/storage/inTx";

import { setSessionTagAssignments } from "./organizationMutations";
import { hashSessionOrganizationKey } from "./hashKeys";

const authentication = createPresentUserSessionAccessAuthentication();

describe("session organization mutations on SQLite", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-session-organization-sqlite-",
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
        });
    });

    beforeEach(() => {
        harness.resetEnv();
    });

    afterAll(async () => {
        await harness.close();
    });

    it('patches only named tag assignments and rejects another Account tag without changing membership', async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID() } });
        const foreign = await db.account.create({ data: { publicKey: randomUUID() } });
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: '{}', agentState: null } });
        const tags = await Promise.all(['ordinary', 'space-a', 'space-b', 'space-c'].map(async tagKey =>
            await db.sessionOrganizationTag.create({ data: { accountId: account.id, tagKey, tagHash: hashSessionOrganizationKey(tagKey) } })));
        const foreignTag = await db.sessionOrganizationTag.create({ data: { accountId: foreign.id, tagKey: 'foreign', tagHash: hashSessionOrganizationKey('foreign') } });
        await db.sessionTagAssignment.createMany({ data: tags.slice(0, 3).map(tag => ({ accountId: account.id, sessionId: session.id, tagId: tag.id })) });
        const app = createAuthenticatedTestApp();
        registerSessionOrganizationRoutes(app);
        await app.ready();
        const headers = { 'x-test-user-id': account.id };
        const url = `/v2/session-organization/tag-assignments/${session.id}`;
        try {
            const moved = await app.inject({ method: 'PUT', url, headers,
                payload: { addTagIds: [tags[3]!.id], removeTagIds: [tags[1]!.id] } });
            expect(moved.statusCode).toBe(200);
            expect(SetSessionTagAssignmentsResponseSchema.parse(moved.json()).tagIds.slice().sort())
                .toEqual([tags[0]!.id, tags[2]!.id, tags[3]!.id].sort());
            const refused = await app.inject({ method: 'PUT', url, headers,
                payload: { addTagIds: [foreignTag.id], removeTagIds: [tags[0]!.id] } });
            expect(refused.statusCode).toBe(400);
            expect((await db.sessionTagAssignment.findMany({ where: { accountId: account.id, sessionId: session.id } })).map(row => row.tagId).sort())
                .toEqual([tags[0]!.id, tags[2]!.id, tags[3]!.id].sort());
        } finally { await app.close(); }
    });

    it.each([false, true])("removes only the named folder through HTTP, preserving descendants (nested=%s)", async (nested) => {
        const account = await db.account.create({ data: { publicKey: randomUUID() } });
        const createFolder = async (key: string, parentKey: string | null) => await db.sessionOrganizationFolder.create({
            data: { accountId: account.id, folderKey: key, folderHash: hashSessionOrganizationKey(key),
                parentKey, parentHash: parentKey === null ? null : hashSessionOrganizationKey(parentKey), sortKey: key },
        });
        const parent = nested ? await createFolder("parent", null) : null;
        const removed = await createFolder("removed", parent?.folderKey ?? null);
        const child = await createFolder("child", removed.folderKey);
        const grandchild = await createFolder("grandchild", child.folderKey);
        const neighbor = await createFolder("neighbor", null);
        await db.sessionOrganizationFolder.createMany({ data: Array.from({ length: 100 }, (_, index) => {
            const folderKey = `unrelated-${index}`;
            return { accountId: account.id, folderKey, folderHash: hashSessionOrganizationKey(folderKey) };
        }) });
        const foldersBefore = [child, grandchild, neighbor];
        const sessions = await Promise.all([removed, child, grandchild, neighbor].map(async (folder) => {
            const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: "{}", agentState: null } });
            await db.sessionFolderAssignment.create({ data: { accountId: account.id, sessionId: session.id, folderId: folder.id } });
            return session;
        }));
        const app = createAuthenticatedTestApp();
        registerSessionOrganizationRoutes(app);
        await app.ready();
        const headers = { "x-test-user-id": account.id };
        const url = `/v2/session-organization/folders/${removed.id}`;
        const readFolderIds: string[] = [];
        const originalTransaction = db.$transaction;
        // Observe actual SQLite reads without replacing query results or domain logic.
        db.$transaction = new Proxy(originalTransaction, {
            apply(target, thisArg, args) {
                const operation: unknown = args[0];
                if (typeof operation !== "function") return Reflect.apply(target, thisArg, args);
                return Reflect.apply(target, thisArg, [async (tx: Tx) => {
                    const observed = observePrismaReads(tx, ["sessionOrganizationFolder"]);
                    try { return await Reflect.apply(operation, undefined, [observed.tx]); }
                    finally { readFolderIds.push(...observed.rows.flatMap(row => row.ids)); }
                }, ...args.slice(1)]);
            },
        });
        try {
            const response = await app.inject({ method: "DELETE", url, headers,
                payload: { folderId: removed.id, assignmentBehavior: "moveAssignmentsToParent" } });
            expect(response.statusCode).toBe(200);
            expect(readFolderIds.sort()).toEqual([removed.id, child.id, ...(parent ? [parent.id] : [])].sort());
            expect(DeleteSessionOrganizationFolderResponseSchema.parse(response.json())).toEqual({
                deletedFolderIds: [removed.id], assignmentTargetFolderId: parent?.id ?? null, affectedAssignmentCount: 1,
            });
            const folderChange = await db.accountChange.findUniqueOrThrow({ where: {
                accountId_kind_entityId: { accountId: account.id, kind: "account", entityId: "session-organization" },
            } });
            const folderHint = SessionOrganizationChangeHintSchema.parse(folderChange.hint);
            expect(folderHint.folderIds?.slice().sort()).toEqual([removed.id, child.id].sort());
            await expect(db.sessionOrganizationFolder.findUniqueOrThrow({ where: { id: removed.id } }))
                .resolves.toMatchObject({ archivedAt: expect.any(Date) });
            for (const folder of foldersBefore) {
                const retained = await db.sessionOrganizationFolder.findUniqueOrThrow({ where: { id: folder.id } });
                expect(retained).toMatchObject({ folderKey: folder.folderKey, sortKey: folder.sortKey, archivedAt: null,
                    parentKey: folder.id === child.id ? parent?.folderKey ?? null : folder.parentKey,
                    parentHash: folder.id === child.id ? parent?.folderHash ?? null : folder.parentHash });
            }
            const assignments = await db.sessionFolderAssignment.findMany({ where: { accountId: account.id },
                select: { sessionId: true, folderId: true }, orderBy: { sessionId: "asc" } });
            expect(assignments).toEqual([
                ...(parent ? [{ sessionId: sessions[0]!.id, folderId: parent.id }] : []),
                ...[child, grandchild, neighbor].map((folder, index) => ({ sessionId: sessions[index + 1]!.id, folderId: folder.id })),
            ].sort((left, right) => left.sessionId.localeCompare(right.sessionId)));
            expect(await db.session.count({ where: { accountId: account.id } })).toBe(4);
            const checkpoint = await db.sessionOrganizationCheckpoint.findUnique({ where: { accountId: account.id } });
            // The retired opt-in cannot block Sections, including an idempotent repeat.
            harness.resetEnv({ HAPPIER_FEATURE_SESSIONS_FOLDERS__ENABLED: "0" });
            const repeated = await app.inject({ method: "DELETE", url, headers,
                payload: { folderId: removed.id, assignmentBehavior: "moveAssignmentsToParent" } });
            expect(repeated.statusCode).toBe(200);
            expect(DeleteSessionOrganizationFolderResponseSchema.parse(repeated.json())).toEqual({
                deletedFolderIds: [], assignmentTargetFolderId: null, affectedAssignmentCount: 0,
            });
            await expect(db.sessionOrganizationCheckpoint.findUnique({ where: { accountId: account.id } })).resolves.toEqual(checkpoint);
        } finally {
            db.$transaction = originalTransaction;
            await app.close();
        }
    });

    it("keeps independent pin memberships and shared order through authenticated HTTP and SQLite", async () => {
        const account = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` }, select: { id: true } });
        const session = await db.session.create({ data: {
            accountId: account.id, tag: `session-${randomUUID()}`, metadata: "{}", metadataVersion: 0,
            agentState: null, agentStateVersion: 0,
        }, select: { id: true } });
        const retained = await db.sessionPin.create({ data: {
            accountId: account.id, sessionId: session.id, sortKey: "saved", pinnedAt: new Date(1234),
        } });
        const neighbor = await db.session.create({ data: {
            accountId: account.id, tag: `session-${randomUUID()}`, metadata: "{}", metadataVersion: 0,
            agentState: null, agentStateVersion: 0,
        }, select: { id: true } });
        const otherAccount = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` }, select: { id: true } });
        const untouchedPins = await db.sessionPin.createMany({ data: [
            { accountId: account.id, sessionId: neighbor.id, sortKey: "neighbor", listPinned: true, railPinned: true },
            { accountId: otherAccount.id, sessionId: session.id, sortKey: "foreign", listPinned: true, railPinned: false },
        ] });
        expect(untouchedPins.count).toBe(2);
        const untouchedWhere = { OR: [{ accountId: account.id, sessionId: neighbor.id }, { accountId: otherAccount.id }] };
        const beforeNeighbors = await db.sessionPin.findMany({ where: untouchedWhere, orderBy: { id: "asc" } });
        expect(retained).toMatchObject({ listPinned: true, railPinned: false });
        const app = createAuthenticatedTestApp();
        registerSessionOrganizationRoutes(app);
        await app.ready();
        const headers = { "x-test-user-id": account.id };
        const pinUrl = `/v2/session-organization/pins/${session.id}`;
        const deliveredUpdates: Array<{ rooms: string | string[]; payload: unknown }> = [];
        // Socket.IO is the transport boundary; keep the real mutation, transaction,
        // after-commit publisher, event routing, and wire consumer schemas beneath it.
        eventRouter.setIo({
            to: (rooms) => ({
                emit: (event, payload) => {
                    if (event === "update") deliveredUpdates.push({ rooms, payload });
                },
                disconnectSockets: () => {},
            }),
        });
        try {
            const pinned = await app.inject({ method: "PUT", url: pinUrl, headers,
                payload: { surface: "rail", pinned: true, sortKey: "ignored" } });
            expect(pinned.statusCode).toBe(200);
            expect(SetSessionPinResponseSchema.parse(pinned.json())).toEqual({ pin: {
                sessionId: session.id, listPinned: true, railPinned: true, sortKey: "saved", pinnedAt: 1234,
            } });
            await expect(db.sessionPin.findUnique({ where: { id: retained.id } })).resolves.toMatchObject({
                listPinned: true, railPinned: true, sortKey: "saved", pinnedAt: new Date(1234),
            });
            const clearedList = await app.inject({ method: "PUT", url: pinUrl, headers,
                payload: { surface: "list", pinned: false } });
            expect(clearedList.statusCode).toBe(200);
            expect(SetSessionPinResponseSchema.parse(clearedList.json())).toEqual({ pin: {
                sessionId: session.id, listPinned: false, railPinned: true, sortKey: "saved", pinnedAt: 1234,
            } });
            // A retained caller omitting surface still changes only list membership.
            const legacyList = await app.inject({ method: "PUT", url: pinUrl, headers,
                payload: { pinned: true, sortKey: "replacement" } });
            expect(legacyList.statusCode).toBe(200);
            expect(SetSessionPinResponseSchema.parse(legacyList.json())).toEqual({ pin: {
                sessionId: session.id, listPinned: true, railPinned: true, sortKey: "saved", pinnedAt: 1234,
            } });
            await expect(db.sessionPin.findUnique({ where: { id: retained.id } })).resolves.toMatchObject({
                listPinned: true, railPinned: true, sortKey: "saved", pinnedAt: new Date(1234),
            });
            const reclearedList = await app.inject({ method: "PUT", url: pinUrl, headers,
                payload: { surface: "list", pinned: false } });
            expect(reclearedList.statusCode).toBe(200);
            expect(SetSessionPinResponseSchema.parse(reclearedList.json()).pin?.listPinned).toBe(false);
            deliveredUpdates.length = 0;
            const reordered = await app.inject({ method: "PUT", url: "/v2/session-organization/order", headers, payload: {
                scopeKind: "pinned", scopeKey: "root", entries: [{ itemKind: "session", itemKey: session.id, sortKey: "moved" }],
            } });
            expect(reordered.statusCode).toBe(200);
            expect(ReorderSessionOrganizationResponseSchema.parse(reordered.json())).toEqual({ orderEntries: [{
                scopeKind: "pinned", scopeKey: "root", itemKind: "session", itemKey: session.id, sortKey: "moved",
            }] });
            await expect(db.sessionPin.findUnique({ where: { id: retained.id } })).resolves.toMatchObject({
                listPinned: false, railPinned: true, sortKey: "moved", pinnedAt: new Date(1234),
            });
            const organizationChange = await db.accountChange.findUniqueOrThrow({ where: {
                accountId_kind_entityId: { accountId: account.id, kind: "account", entityId: "session-organization" },
            } });
            expect(SessionOrganizationChangeHintSchema.parse(organizationChange.hint)).toEqual({
                sessionOrganization: true, scope: "pins", sessionIds: [session.id],
            });
            const pinWakes = deliveredUpdates.filter(({ payload }) =>
                UpdateContainerSchema.parse(payload).body.t === "account-change");
            expect(pinWakes).toHaveLength(1);
            expect(pinWakes[0]?.rooms).toBe(getAccountStoredContentV3SocketRoom(account.id));
            expect(UpdateContainerSchema.parse(pinWakes[0]?.payload)).toMatchObject({
                seq: organizationChange.cursor, body: { t: "account-change" },
            });
            const snapshot = await app.inject({ method: "GET", url: "/v2/session-organization", headers });
            expect(snapshot.statusCode).toBe(200);
            expect(SessionOrganizationSnapshotResponseSchema.parse(snapshot.json()).snapshot.pins).toEqual([
                { sessionId: session.id, listPinned: false, railPinned: true, sortKey: "moved", pinnedAt: 1234 },
                expect.objectContaining({ sessionId: neighbor.id, sortKey: "neighbor", listPinned: true, railPinned: true }),
            ]);
            const compiledRailReorder = {
                scopeKind: "pinned" as const, scopeKey: "root",
                entries: [{ itemKind: "session" as const, itemKey: session.id, sortKey: "stale" }],
            };
            const clearedRail = await app.inject({ method: "PUT", url: pinUrl, headers,
                payload: { surface: "rail", pinned: false } });
            expect(clearedRail.statusCode).toBe(200);
            expect(SetSessionPinResponseSchema.parse(clearedRail.json())).toEqual({ pin: null });
            await expect(db.sessionPin.findUnique({ where: { id: retained.id } })).resolves.toBeNull();
            const checkpoint = await db.sessionOrganizationCheckpoint.findUnique({ where: { accountId: account.id } });
            const staleReorder = await app.inject({ method: "POST", url: "/v2/session-organization/pins/reorder", headers,
                payload: compiledRailReorder });
            expect(staleReorder.statusCode).toBe(200);
            expect(ReorderSessionOrganizationResponseSchema.parse(staleReorder.json())).toEqual({ orderEntries: [] });
            await expect(db.sessionPin.findUnique({ where: { accountId_sessionId: { accountId: account.id, sessionId: session.id } } }))
                .resolves.toBeNull();
            await expect(db.sessionPin.findMany({ where: untouchedWhere, orderBy: { id: "asc" } })).resolves.toEqual(beforeNeighbors);
            await expect(db.sessionOrganizationCheckpoint.findUnique({ where: { accountId: account.id } })).resolves.toEqual(checkpoint);
            const railOnly = await app.inject({ method: "PUT", url: pinUrl, headers,
                payload: { surface: "rail", pinned: true } });
            expect(railOnly.statusCode).toBe(200);
            expect(SetSessionPinResponseSchema.parse(railOnly.json()).pin).toMatchObject({
                sessionId: session.id, listPinned: false, railPinned: true,
            });
            await expect(db.sessionPin.findUnique({ where: { accountId_sessionId: {
                accountId: account.id, sessionId: session.id,
            } } })).resolves.toMatchObject({ listPinned: false, railPinned: true });
        } finally {
            eventRouter.clearIo();
            await app.close();
        }
    });

    it("persists tag assignments through the real SQLite Prisma client", async () => {
        const account = await db.account.create({
            data: { publicKey: `pk-${randomUUID()}` },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                accountId: account.id,
                tag: `session-${randomUUID()}`,
                metadata: "{}",
                metadataVersion: 0,
                agentState: null,
                agentStateVersion: 0,
            },
            select: { id: true },
        });
        const [firstTag, secondTag] = await Promise.all([
            db.sessionOrganizationTag.create({
                data: {
                    accountId: account.id,
                    tagKey: `tag-${randomUUID()}`,
                    tagHash: `tag-hash-${randomUUID()}`,
                },
                select: { id: true },
            }),
            db.sessionOrganizationTag.create({
                data: {
                    accountId: account.id,
                    tagKey: `tag-${randomUUID()}`,
                    tagHash: `tag-hash-${randomUUID()}`,
                },
                select: { id: true },
            }),
        ]);

        const result = await setSessionTagAssignments({
            accountId: account.id,
            sessionId: session.id,
            request: { tagIds: [firstTag.id, secondTag.id] },
            authentication,
        });

        expect(SetSessionTagAssignmentsResponseSchema.parse(result)).toEqual({
            sessionId: session.id,
            tagIds: [firstTag.id, secondTag.id].sort(),
        });
        await expect(
            db.sessionTagAssignment.findMany({
                where: { accountId: account.id, sessionId: session.id },
                orderBy: { tagId: "asc" },
                select: { tagId: true },
            }),
        ).resolves.toEqual([
            { tagId: firstTag.id },
            { tagId: secondTag.id },
        ].sort((left, right) => left.tagId.localeCompare(right.tagId)));
        await expect(
            db.sessionOrganizationCheckpoint.findUnique({
                where: { accountId: account.id },
                select: { version: true },
            }),
        ).resolves.toEqual({ version: 1 });
    });
});
