import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createPresentUserSessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication.testkit";

import { setSessionPin, setSessionTagAssignments } from "./organizationMutations";
import { reorderSessionPins } from "./organizationOrdering";

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

    it("keeps one retained pin row and one order while each surface changes independently", async () => {
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
        await setSessionPin({ accountId: account.id, sessionId: session.id, authentication,
            request: { surface: "rail", pinned: true, sortKey: "ignored" } });
        await expect(db.sessionPin.findUnique({ where: { id: retained.id } })).resolves.toMatchObject({
            listPinned: true, railPinned: true, sortKey: "saved", pinnedAt: new Date(1234),
        });
        await setSessionPin({ accountId: account.id, sessionId: session.id, authentication, request: { surface: "list", pinned: false } });
        await reorderSessionPins({ accountId: account.id, authentication, request: {
            scopeKind: "pinned", scopeKey: "root", entries: [{ itemKind: "session", itemKey: session.id, sortKey: "moved" }],
        } });
        await expect(db.sessionPin.findUnique({ where: { id: retained.id } })).resolves.toMatchObject({
            listPinned: false, railPinned: true, sortKey: "moved", pinnedAt: new Date(1234),
        });
        const compiledRailReorder = {
            scopeKind: "pinned" as const, scopeKey: "root",
            entries: [{ itemKind: "session" as const, itemKey: session.id, sortKey: "stale" }],
        };
        await setSessionPin({ accountId: account.id, sessionId: session.id, authentication, request: { surface: "rail", pinned: false } });
        await expect(db.sessionPin.findUnique({ where: { id: retained.id } })).resolves.toBeNull();
        const checkpoint = await db.sessionOrganizationCheckpoint.findUnique({ where: { accountId: account.id } });
        const staleReorder = await reorderSessionPins({ accountId: account.id, authentication, request: compiledRailReorder });
        expect(staleReorder).toEqual({ orderEntries: [] });
        await expect(db.sessionPin.findUnique({ where: { accountId_sessionId: { accountId: account.id, sessionId: session.id } } }))
            .resolves.toBeNull();
        await expect(db.sessionPin.findMany({ where: untouchedWhere, orderBy: { id: "asc" } })).resolves.toEqual(beforeNeighbors);
        await expect(db.sessionOrganizationCheckpoint.findUnique({ where: { accountId: account.id } })).resolves.toEqual(checkpoint);
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

        expect(result).toEqual({
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
