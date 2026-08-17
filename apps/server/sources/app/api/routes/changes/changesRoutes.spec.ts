import { beforeEach, describe, expect, it, vi } from "vitest";

import { createDbMocks, createDbTransactionMock, installDbModuleMock } from "../../testkit/dbMocks";
import { createRouteTestBuilder } from "../../testkit/routeTestBuilder";

const { db, reset: resetDbMocks } = createDbMocks({
    account: ["findUnique"],
    accountChange: ["findMany", "findUnique"],
    session: ["findUnique"],
    sessionShare: ["findUnique"],
});

const accountFindUnique = db.account.findUnique;
const accountChangeFindMany = db.accountChange.findMany;
const accountChangeFindUnique = db.accountChange.findUnique;
const sessionFindUnique = db.session.findUnique;
const sessionShareFindUnique = db.sessionShare.findUnique;
const { transaction, wrapDb } = createDbTransactionMock(() => db);

const changesRequestsInc = vi.fn();
const changesReturnedInc = vi.fn();

vi.mock("@/app/monitoring/metrics/index", () => ({
    changesRequestsCounter: { inc: changesRequestsInc },
    changesReturnedChangesCounter: { inc: changesReturnedInc },
}));

const debugSpy = vi.fn();
const warnSpy = vi.fn();

const currentSessionAccessWitnessCompatibility = {
    supportsCurrentProtocol: true,
    supportsPluginDataProtocol: true,
    supportsSessionAccessWitnessProtocol: true,
    outcome: "accepted" as const,
    declaration: { v: 1, protocolVersion: 4 },
    upgradeRequired: null,
};

vi.mock("@/utils/logging/log", () => ({
    debug: debugSpy,
    warn: warnSpy,
}));

installDbModuleMock(() => ({
    db: wrapDb(db),
}));

describe("changesRoutes (/v2/changes cursor safety)", () => {
    beforeEach(() => {
        resetDbMocks();
        changesRequestsInc.mockClear();
        changesReturnedInc.mockClear();
        debugSpy.mockClear();
        warnSpy.mockClear();
        transaction.mockClear();
    });

    it("returns 410 when after is in the future", async () => {
        accountFindUnique.mockResolvedValue({ seq: 10, changesFloor: 0 });
        accountChangeFindMany.mockResolvedValue([]);

        const { changesRoutes } = await import("./changesRoutes");
        const route = createRouteTestBuilder({
            method: "GET",
            path: "/v2/changes",
            defaultRequest: { userId: "u1", query: { after: 999, limit: 10 } },
            registerRoutes(app) {
                changesRoutes(app as any);
            },
        });

        const { reply, response } = await route.invoke();

        expect(reply.code).toHaveBeenCalledWith(410);
        expect(response).toEqual({ error: "cursor-gone", currentCursor: 10 });
        expect(changesRequestsInc).toHaveBeenCalledWith({ result: "cursor-gone" });
        expect(warnSpy).toHaveBeenCalledWith(
            expect.objectContaining({ module: "changes", userId: "u1…", reason: "cursor-in-future" }),
            expect.any(String),
        );
    });

    it("returns 410 when after is behind changesFloor", async () => {
        accountFindUnique.mockResolvedValue({ seq: 100, changesFloor: 50 });
        accountChangeFindMany.mockResolvedValue([]);

        const { changesRoutes } = await import("./changesRoutes");
        const route = createRouteTestBuilder({
            method: "GET",
            path: "/v2/changes",
            defaultRequest: {
                userId: "u1",
                query: { after: 10, limit: 10 },
                accountStoredContentCompatibility: currentSessionAccessWitnessCompatibility,
            },
            registerRoutes(app) {
                changesRoutes(app as any);
            },
        });

        const { reply, response } = await route.invoke();

        expect(reply.code).toHaveBeenCalledWith(410);
        expect(response).toEqual({ error: "cursor-gone", currentCursor: 100 });
        expect(changesRequestsInc).toHaveBeenCalledWith({ result: "cursor-gone" });
        expect(warnSpy).toHaveBeenCalledWith(
            expect.objectContaining({ module: "changes", userId: "u1…", reason: "cursor-behind-floor" }),
            expect.any(String),
        );
    });

    it("returns ordered changes and nextCursor when cursor is valid", async () => {
        accountFindUnique.mockResolvedValue({ seq: 100, changesFloor: 0 });
        accountChangeFindMany.mockResolvedValue([
            { cursor: 11, kind: "session", entityId: "s1", changedAt: new Date(1), hint: null },
            { cursor: 12, kind: "machine", entityId: "m1", changedAt: new Date(2), hint: { a: 1 } },
        ]);
        sessionFindUnique.mockResolvedValue({
            accountId: "u1",
            active: false,
            lastActiveAt: new Date(1),
            currentStorageState: "hosted",
            acceptedThroughServerSeq: null,
            materializationPublicationId: null,
            materializedThroughSourceAt: null,
            publishedThroughServerSeq: null,
        });

        const { changesRoutes } = await import("./changesRoutes");
        const route = createRouteTestBuilder({
            method: "GET",
            path: "/v2/changes",
            defaultRequest: {
                userId: "u1",
                query: { after: 10, limit: 10 },
                accountStoredContentCompatibility: currentSessionAccessWitnessCompatibility,
            },
            registerRoutes(app) {
                changesRoutes(app as any);
            },
        });

        const { reply, response } = await route.invoke();

        expect(reply.code).not.toHaveBeenCalled();
        expect(response).toEqual({
            changes: [
                { cursor: 11, kind: "session", entityId: "s1", changedAt: 1, hint: null },
                { cursor: 12, kind: "machine", entityId: "m1", changedAt: 2, hint: { a: 1 } },
            ],
            nextCursor: 12,
            sessionAccessWitness: {
                v: 1,
                throughCursor: 12,
                entries: [{ sessionId: "s1", cursor: 11, status: "available" }],
            },
        });
        expect(changesRequestsInc).toHaveBeenCalledWith({ result: "ok" });
        expect(changesReturnedInc).toHaveBeenCalledWith(2);
        expect(debugSpy).toHaveBeenCalledWith(
            expect.objectContaining({ module: "changes", userId: "u1…", after: 10, nextCursor: 12, returned: 2, limit: 10 }),
            expect.any(String),
        );
    });

    it("carries the canonical unavailable Session witness for a deleted Session through the acknowledged cursor", async () => {
        accountFindUnique.mockResolvedValue({ seq: 100, changesFloor: 0 });
        accountChangeFindMany.mockResolvedValue([
            { cursor: 11, kind: "session", entityId: "session-deleted", changedAt: new Date(1), hint: null },
        ]);
        // The Session domain's canonical adapter recognizes this AccountChange
        // as a durable deletion tombstone after the Session foreign key clears.
        sessionFindUnique.mockResolvedValue(null);
        accountChangeFindUnique.mockResolvedValue({ sessionId: null });

        const { changesRoutes } = await import("./changesRoutes");
        const route = createRouteTestBuilder({
            method: "GET",
            path: "/v2/changes",
            defaultRequest: {
                userId: "u1",
                query: { after: 10, limit: 10 },
                accountStoredContentCompatibility: currentSessionAccessWitnessCompatibility,
            },
            registerRoutes(app) {
                changesRoutes(app as any);
            },
        });

        await expect(route.invoke()).resolves.toMatchObject({
            response: {
                nextCursor: 11,
                sessionAccessWitness: {
                    v: 1,
                    throughCursor: 11,
                    entries: [{
                        sessionId: "session-deleted",
                        cursor: 11,
                        status: "unavailable",
                    }],
                },
            },
        });
        expect(accountChangeFindUnique).toHaveBeenCalledWith({
            where: {
                accountId_kind_entityId: {
                    accountId: "u1",
                    kind: "session",
                    entityId: "session-deleted",
                },
            },
            select: { sessionId: true },
        });
    });

    it("carries the canonical unavailable Session witness when a share is revoked", async () => {
        accountFindUnique.mockResolvedValue({ seq: 100, changesFloor: 0 });
        accountChangeFindMany.mockResolvedValue([
            { cursor: 12, kind: "session", entityId: "session-revoked", changedAt: new Date(2), hint: null },
        ]);
        sessionFindUnique.mockResolvedValue({
            accountId: "owner",
            active: false,
            lastActiveAt: new Date(1),
            currentStorageState: "hosted",
            acceptedThroughServerSeq: null,
            materializationPublicationId: null,
            materializedThroughSourceAt: null,
            publishedThroughServerSeq: null,
        });
        sessionShareFindUnique.mockResolvedValue(null);
        accountChangeFindUnique.mockResolvedValue({ sessionId: "session-revoked" });

        const { changesRoutes } = await import("./changesRoutes");
        const route = createRouteTestBuilder({
            method: "GET",
            path: "/v2/changes",
            defaultRequest: {
                userId: "recipient",
                query: { after: 10, limit: 10 },
                accountStoredContentCompatibility: currentSessionAccessWitnessCompatibility,
            },
            registerRoutes(app) {
                changesRoutes(app as any);
            },
        });

        await expect(route.invoke()).resolves.toMatchObject({
            response: {
                nextCursor: 12,
                sessionAccessWitness: {
                    v: 1,
                    throughCursor: 12,
                    entries: [{
                        sessionId: "session-revoked",
                        cursor: 12,
                        status: "unavailable",
                    }],
                },
            },
        });
        expect(sessionShareFindUnique).toHaveBeenCalledWith({
            where: {
                sessionId_sharedWithUserId: {
                    sessionId: "session-revoked",
                    sharedWithUserId: "recipient",
                },
            },
            select: { accessLevel: true },
        });
    });

    it("collapses repeated Session changes to the latest canonical witness fact on one page", async () => {
        accountFindUnique.mockResolvedValue({ seq: 100, changesFloor: 0 });
        accountChangeFindMany.mockResolvedValue([
            { cursor: 11, kind: "session", entityId: "session-1", changedAt: new Date(1), hint: null },
            { cursor: 12, kind: "session", entityId: "session-1", changedAt: new Date(2), hint: null },
            { cursor: 13, kind: "machine", entityId: "m1", changedAt: new Date(3), hint: null },
        ]);
        sessionFindUnique.mockResolvedValue({
            accountId: "u1",
            active: false,
            lastActiveAt: new Date(1),
            currentStorageState: "hosted",
            acceptedThroughServerSeq: null,
            materializationPublicationId: null,
            materializedThroughSourceAt: null,
            publishedThroughServerSeq: null,
        });

        const { changesRoutes } = await import("./changesRoutes");
        const route = createRouteTestBuilder({
            method: "GET",
            path: "/v2/changes",
            defaultRequest: {
                userId: "u1",
                query: { after: 10, limit: 10 },
                accountStoredContentCompatibility: currentSessionAccessWitnessCompatibility,
            },
            registerRoutes(app) {
                changesRoutes(app as any);
            },
        });

        await expect(route.invoke()).resolves.toMatchObject({
            response: {
                nextCursor: 13,
                sessionAccessWitness: {
                    v: 1,
                    throughCursor: 13,
                    entries: [{ sessionId: "session-1", cursor: 12, status: "available" }],
                },
            },
        });
        expect(sessionFindUnique).toHaveBeenCalledTimes(1);
    });

    it("filters pluginDomain rows for V1/V2 clients while advancing across the raw page", async () => {
        accountFindUnique.mockResolvedValue({ seq: 100, changesFloor: 0 });
        accountChangeFindMany.mockResolvedValue([
            {
                cursor: 11,
                kind: "pluginDomain",
                entityId: "pluginDomain/example.tasks/availability",
                changedAt: new Date(1),
                hint: {
                    pluginDomain: "availability",
                    pluginId: "example.tasks",
                },
            },
            { cursor: 12, kind: "session", entityId: "s1", changedAt: new Date(2), hint: null },
        ]);

        const { changesRoutes } = await import("./changesRoutes");
        const route = createRouteTestBuilder({
            method: "GET",
            path: "/v2/changes",
            defaultRequest: { userId: "u1", query: { after: 10, limit: 10 } },
            registerRoutes(app) {
                changesRoutes(app as any);
            },
        });

        await expect(route.invoke({
            accountStoredContentCompatibility: {
                supportsCurrentProtocol: true,
                supportsPluginDataProtocol: false,
                supportsSessionAccessWitnessProtocol: false,
                outcome: "accepted",
                declaration: { v: 1, protocolVersion: 2 },
                upgradeRequired: null,
            },
        })).resolves.toMatchObject({
            response: {
                changes: [
                    { cursor: 12, kind: "session", entityId: "s1", changedAt: 2, hint: null },
                ],
                nextCursor: 12,
            },
        });
        const legacyResponse = await route.invoke({
            accountStoredContentCompatibility: {
                supportsCurrentProtocol: true,
                supportsPluginDataProtocol: true,
                supportsSessionAccessWitnessProtocol: false,
                outcome: "accepted",
                declaration: { v: 1, protocolVersion: 3 },
                upgradeRequired: null,
            },
        });
        expect(legacyResponse.response).toMatchObject({
            changes: [
                {
                    cursor: 11,
                    kind: "pluginDomain",
                    entityId: "pluginDomain/example.tasks/availability",
                    changedAt: 1,
                    hint: {
                        pluginDomain: "availability",
                        pluginId: "example.tasks",
                    },
                },
                { cursor: 12, kind: "session", entityId: "s1", changedAt: 2, hint: null },
            ],
            nextCursor: 12,
        });
        expect(legacyResponse.response).not.toHaveProperty("sessionAccessWitness");
    });

    it("returns nextCursor==after when there are no changes", async () => {
        accountFindUnique.mockResolvedValue({ seq: 100, changesFloor: 0 });
        accountChangeFindMany.mockResolvedValue([]);

        const { changesRoutes } = await import("./changesRoutes");
        const route = createRouteTestBuilder({
            method: "GET",
            path: "/v2/changes",
            defaultRequest: {
                userId: "u1",
                query: { after: 50, limit: 3 },
                accountStoredContentCompatibility: currentSessionAccessWitnessCompatibility,
            },
            registerRoutes(app) {
                changesRoutes(app as any);
            },
        });

        const { response } = await route.invoke();

        expect(accountChangeFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { accountId: "u1", cursor: { gt: 50 } },
                orderBy: [{ cursor: "asc" }, { kind: "asc" }, { entityId: "asc" }],
                take: 3,
            }),
        );

        expect(response).toEqual({
            changes: [],
            nextCursor: 50,
            sessionAccessWitness: {
                v: 1,
                throughCursor: 50,
                entries: [],
            },
        });
        expect(changesRequestsInc).toHaveBeenCalledWith({ result: "ok" });
        expect(changesReturnedInc).toHaveBeenCalledWith(0);
    });

    it("resolves one exact Session access probe with the current Account cursor and no feed acknowledgement", async () => {
        accountFindUnique.mockResolvedValue({ seq: 101, changesFloor: 0 });
        accountChangeFindMany.mockResolvedValue([]);
        sessionFindUnique.mockResolvedValue({
            accountId: "u1",
            active: false,
            lastActiveAt: new Date(1),
            currentStorageState: "hosted",
            acceptedThroughServerSeq: null,
            materializationPublicationId: null,
            materializedThroughSourceAt: null,
            publishedThroughServerSeq: null,
        });

        const { changesRoutes } = await import("./changesRoutes");
        const route = createRouteTestBuilder({
            method: "GET",
            path: "/v2/changes",
            defaultRequest: {
                userId: "u1",
                query: { after: 0, limit: 1, sessionAccessSessionId: "session-current" },
                accountStoredContentCompatibility: currentSessionAccessWitnessCompatibility,
            },
            registerRoutes(app) {
                changesRoutes(app as any);
            },
        });

        await expect(route.invoke()).resolves.toMatchObject({
            response: {
                changes: [],
                nextCursor: 101,
                sessionAccessProbe: {
                    v: 1,
                    sessionId: "session-current",
                    throughCursor: 101,
                    status: "available",
                },
            },
        });
        expect(transaction).toHaveBeenCalledTimes(1);
        expect(accountChangeFindMany).not.toHaveBeenCalled();
    });

    it("GET /v2/cursor returns current cursor and changesFloor", async () => {
        accountFindUnique.mockResolvedValue({ seq: 10, changesFloor: 7 });
        accountChangeFindMany.mockResolvedValue([]);

        const { changesRoutes } = await import("./changesRoutes");
        const route = createRouteTestBuilder({
            method: "GET",
            path: "/v2/cursor",
            defaultRequest: { userId: "u1" },
            registerRoutes(app) {
                changesRoutes(app as any);
            },
        });

        const { reply, response } = await route.invoke();

        expect(reply.code).not.toHaveBeenCalled();
        expect(response).toEqual({ cursor: 10, changesFloor: 7 });
    });
});
