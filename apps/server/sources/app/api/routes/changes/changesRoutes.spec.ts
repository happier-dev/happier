import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createDbMocks, createDbTransactionMock, installDbModuleMock, inTxPostgresControlStatementMock } from "../../testkit/dbMocks";
import { createRouteTestBuilder } from "../../testkit/routeTestBuilder";

const { db, reset: resetDbMocks } = createDbMocks({
    account: ["findUnique"],
    accountChange: ["findMany", "findUnique"],
    session: ["findUnique", "findMany"],
    sessionGrant: ["findUnique"],
    sessionPendingMessage: ["findMany"],
    teamMembership: ["findFirst"],
});

const accountFindUnique = db.account.findUnique;
const accountChangeFindMany = db.accountChange.findMany;
const accountChangeFindUnique = db.accountChange.findUnique;
const sessionFindUnique = db.session.findUnique;
const sessionFindMany = db.session.findMany;
const sessionShareFindUnique = db.sessionGrant.findUnique;
const { transaction, wrapDb } = createDbTransactionMock(() => ({ ...inTxPostgresControlStatementMock, ...db }));

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
    supportsMachinePoolChangeProtocol: true,
    supportsSavedSecretResourceChangeProtocol: true,
    outcome: "accepted" as const,
    declaration: { v: 1, protocolVersion: 4 },
    upgradeRequired: null,
};

function hostedSession(accountId: string, id = "session-current") {
    return {
        id,
        accountId,
        account: { status: "active" },
        primaryTeamId: null,
        active: false,
        lastActiveAt: new Date(1),
        currentStorageState: "hosted",
        acceptedThroughServerSeq: null,
        materializationPublicationId: null,
        materializedThroughSourceAt: null,
        publishedThroughServerSeq: null,
        grants: [],
        
        
    };
}

function credentialRestrictedTeamSession(accountId: string, id = "session-restricted") {
    return {
        ...hostedSession("owner", id),
        grants: [{ id: 'team-grant', principalKind: 'team', accountId: null, teamGroupId: null, account: null, teamGroup: null, 
            teamId: "team-restricted",
            effectiveAt: new Date(2),
            accessLevel: "view",
            canApprovePermissions: false,
            requiredByTeamPolicy: false,
            team: {
                // An unreadable policy is an indeterminate authentication
                // boundary, not structural evidence that the grant vanished.
                authenticationPolicy: { v: 999 },
                memberships: [{ accountId, role: "member", sessionAccessStartsAt: null }],
            },
         }],
    };
}

vi.mock("@/utils/logging/log", () => ({
    debug: debugSpy,
    warn: warnSpy,
}));

installDbModuleMock(() => ({
    db: wrapDb(db),
}));

describe("changesRoutes (/v2/changes cursor safety)", () => {
    let changesRoutes: typeof import("./changesRoutes").changesRoutes;

    beforeAll(async () => {
        ({ changesRoutes } = await import("./changesRoutes"));
    }, 60_000);

    beforeEach(() => {
        resetDbMocks();
        changesRequestsInc.mockClear();
        changesReturnedInc.mockClear();
        debugSpy.mockClear();
        warnSpy.mockClear();
        transaction.mockClear();
        db.sessionPendingMessage.findMany.mockResolvedValue([]);
    });

    it("returns 410 when after is in the future", async () => {
        accountFindUnique.mockResolvedValue({ seq: 10, changesFloor: 0 });
        accountChangeFindMany.mockResolvedValue([]);

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

        const route = createRouteTestBuilder({
            method: "GET",
            path: "/v2/changes",
            defaultRequest: {
                userId: "u1",
                authAuthority: "present_user",
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
        sessionFindMany.mockResolvedValue([hostedSession("u1", "s1")]);

        const route = createRouteTestBuilder({
            method: "GET",
            path: "/v2/changes",
            defaultRequest: {
                userId: "u1",
                authAuthority: "present_user",
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
                { cursor: 11, kind: "session", entityId: "s1", changedAt: 1, hint: { pendingExecutionRunIds: [] } },
                { cursor: 12, kind: "machine", entityId: "m1", changedAt: 2, hint: { a: 1 } },
            ],
            nextCursor: 12,
            full: false,
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
        sessionFindMany.mockResolvedValue([]);
        accountChangeFindMany.mockResolvedValueOnce([
            { cursor: 11, kind: "session", entityId: "session-deleted", changedAt: new Date(1), hint: null },
        ]).mockResolvedValueOnce([{ entityId: "session-deleted", sessionId: null }]);

        const route = createRouteTestBuilder({
            method: "GET",
            path: "/v2/changes",
            defaultRequest: {
                userId: "u1",
                authAuthority: "present_user",
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
        expect(accountChangeFindMany).toHaveBeenLastCalledWith({
            where: { accountId: "u1", kind: "session", entityId: { in: ["session-deleted"] } },
            select: { entityId: true, sessionId: true },
        });
    });

    it("carries the canonical unavailable Session witness when a share is revoked", async () => {
        accountFindUnique.mockResolvedValue({ seq: 100, changesFloor: 0 });
        accountChangeFindMany.mockResolvedValue([
            { cursor: 12, kind: "session", entityId: "session-revoked", changedAt: new Date(2), hint: null },
        ]);
        sessionFindMany.mockResolvedValue([hostedSession("owner", "session-revoked")]);
        sessionShareFindUnique.mockResolvedValue(null);
        accountChangeFindMany.mockResolvedValueOnce([
            { cursor: 12, kind: "session", entityId: "session-revoked", changedAt: new Date(2), hint: null },
        ]).mockResolvedValueOnce([{ entityId: "session-revoked", sessionId: "session-revoked" }]);

        const route = createRouteTestBuilder({
            method: "GET",
            path: "/v2/changes",
            defaultRequest: {
                userId: "recipient",
                authAuthority: "present_user",
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
        expect(sessionShareFindUnique).not.toHaveBeenCalled();
    });

    it.each([undefined, "machine"])("rejects a page when retention advances after its row read (kinds=%s)", async (kinds) => {
        accountFindUnique.mockResolvedValueOnce({ seq: 100, changesFloor: 0 })
            .mockResolvedValueOnce({ seq: 101, changesFloor: 11 });
        accountChangeFindMany.mockResolvedValue([
            { cursor: 12, kind: "machine", entityId: "machine-current", changedAt: new Date(2), hint: null },
        ]);
        const route = createRouteTestBuilder({
            method: "GET",
            path: "/v2/changes",
            defaultRequest: {
                userId: "recipient",
                authAuthority: "present_user",
                query: { after: 10, limit: 10, kinds },
                accountStoredContentCompatibility: currentSessionAccessWitnessCompatibility,
            },
            registerRoutes(app) {
                // The fixture implements Fastify's route-registration boundary.
                changesRoutes(app as unknown as Parameters<typeof changesRoutes>[0]);
            },
        });
        const { reply, response } = await route.invoke();
        expect(reply.code).toHaveBeenCalledWith(410);
        expect(response).toEqual({ error: "cursor-gone", currentCursor: 101 });
        expect(response).not.toHaveProperty("sessionAccessWitness");
    });

    it("collapses repeated Session changes to the latest canonical witness fact on one page", async () => {
        accountFindUnique.mockResolvedValue({ seq: 100, changesFloor: 0 });
        accountChangeFindMany.mockResolvedValue([
            { cursor: 11, kind: "session", entityId: "session-1", changedAt: new Date(1), hint: null },
            { cursor: 12, kind: "session", entityId: "session-1", changedAt: new Date(2), hint: null },
            { cursor: 13, kind: "machine", entityId: "m1", changedAt: new Date(3), hint: null },
        ]);
        sessionFindMany.mockResolvedValue([hostedSession("u1", "session-1")]);

        const route = createRouteTestBuilder({
            method: "GET",
            path: "/v2/changes",
            defaultRequest: {
                userId: "u1",
                authAuthority: "present_user",
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
        expect(sessionFindMany).toHaveBeenCalledTimes(1);
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
                supportsMachinePoolChangeProtocol: false,
                supportsSavedSecretResourceChangeProtocol: false,
                outcome: "accepted",
                declaration: { v: 1, protocolVersion: 2 },
                upgradeRequired: null,
            },
        })).resolves.toMatchObject({
            response: {
                changes: [
                    { cursor: 12, kind: "session", entityId: "s1", changedAt: 2, hint: { pendingExecutionRunIds: [] } },
                ],
                nextCursor: 12,
            },
        });
        const legacyResponse = await route.invoke({
            accountStoredContentCompatibility: {
                supportsCurrentProtocol: true,
                supportsPluginDataProtocol: true,
                supportsSessionAccessWitnessProtocol: false,
                supportsMachinePoolChangeProtocol: false,
                supportsSavedSecretResourceChangeProtocol: false,
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
                { cursor: 12, kind: "session", entityId: "s1", changedAt: 2, hint: { pendingExecutionRunIds: [] } },
            ],
            nextCursor: 12,
        });
        expect(legacyResponse.response).not.toHaveProperty("sessionAccessWitness");
    });

    it("filters machinePool rows for pre-V4 clients while advancing across the raw page", async () => {
        accountFindUnique.mockResolvedValue({ seq: 100, changesFloor: 0 });
        accountChangeFindMany.mockResolvedValue([
            { cursor: 11, kind: "machine", entityId: "m1", changedAt: new Date(1), hint: null },
            { cursor: 12, kind: "machinePool", entityId: "pool-1", changedAt: new Date(2), hint: null },
        ]);

        const route = createRouteTestBuilder({
            method: "GET",
            path: "/v2/changes",
            defaultRequest: { userId: "u1", query: { after: 10, limit: 10 } },
            registerRoutes(app) {
                changesRoutes(app as any);
            },
        });

        // The pre-V4 peer must not receive a kind it cannot parse, and must still checkpoint past
        // the withheld row so its poll does not stall on the raw page.
        await expect(route.invoke({
            accountStoredContentCompatibility: {
                supportsCurrentProtocol: true,
                supportsPluginDataProtocol: true,
                supportsSessionAccessWitnessProtocol: false,
                supportsMachinePoolChangeProtocol: false,
                supportsSavedSecretResourceChangeProtocol: false,
                outcome: "accepted",
                declaration: { v: 1, protocolVersion: 3 },
                upgradeRequired: null,
            },
        })).resolves.toMatchObject({
            response: {
                changes: [
                    { cursor: 11, kind: "machine", entityId: "m1", changedAt: 1, hint: null },
                ],
                nextCursor: 12,
            },
        });

        const currentResponse = await route.invoke({
            accountStoredContentCompatibility: {
                supportsCurrentProtocol: true,
                supportsPluginDataProtocol: true,
                supportsSessionAccessWitnessProtocol: true,
                supportsMachinePoolChangeProtocol: true,
                supportsSavedSecretResourceChangeProtocol: true,
                outcome: "accepted",
                declaration: { v: 1, protocolVersion: 4 },
                upgradeRequired: null,
            },
        });
        expect(currentResponse.response).toMatchObject({
            changes: [
                { cursor: 11, kind: "machine", entityId: "m1", changedAt: 1, hint: null },
                { cursor: 12, kind: "machinePool", entityId: "pool-1", changedAt: 2, hint: null },
            ],
            nextCursor: 12,
        });
    });

    it("filters savedSecretResource rows for pre-V4 clients while advancing across the raw page", async () => {
        accountFindUnique.mockResolvedValue({ seq: 100, changesFloor: 0 });
        accountChangeFindMany.mockResolvedValue([
            { cursor: 11, kind: "machine", entityId: "m1", changedAt: new Date(1), hint: null },
            { cursor: 12, kind: "savedSecretResource", entityId: "resource-1", changedAt: new Date(2), hint: null },
        ]);

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
                supportsPluginDataProtocol: true,
                supportsSessionAccessWitnessProtocol: false,
                supportsMachinePoolChangeProtocol: false,
                supportsSavedSecretResourceChangeProtocol: false,
                outcome: "accepted",
                declaration: { v: 1, protocolVersion: 3 },
                upgradeRequired: null,
            },
        })).resolves.toMatchObject({
            response: {
                changes: [{ cursor: 11, kind: "machine", entityId: "m1", changedAt: 1, hint: null }],
                nextCursor: 12,
            },
        });

        await expect(route.invoke({
            accountStoredContentCompatibility: currentSessionAccessWitnessCompatibility,
        })).resolves.toMatchObject({
            response: {
                changes: [
                    { cursor: 11, kind: "machine", entityId: "m1", changedAt: 1, hint: null },
                    { cursor: 12, kind: "savedSecretResource", entityId: "resource-1", changedAt: 2, hint: null },
                ],
                nextCursor: 12,
            },
        });
    });

    it("returns nextCursor==after when there are no changes", async () => {
        accountFindUnique.mockResolvedValue({ seq: 100, changesFloor: 0 });
        accountChangeFindMany.mockResolvedValue([]);

        const route = createRouteTestBuilder({
            method: "GET",
            path: "/v2/changes",
            defaultRequest: {
                userId: "u1",
                authAuthority: "present_user",
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
            full: false,
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
        sessionFindUnique.mockResolvedValue(hostedSession("u1"));

        const route = createRouteTestBuilder({
            method: "GET",
            path: "/v2/changes",
            defaultRequest: {
                userId: "u1",
                authAuthority: "present_user",
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

    it("fails an indeterminate exact probe recoverably instead of returning an unavailable revocation fact", async () => {
        accountFindUnique.mockResolvedValue({ seq: 101, changesFloor: 0 });
        sessionFindUnique.mockResolvedValue(credentialRestrictedTeamSession("recipient"));

        const route = createRouteTestBuilder({
            method: "GET",
            path: "/v2/changes",
            defaultRequest: {
                userId: "recipient",
                authAuthority: "present_user",
                authTokenAuthenticationEvidence: [],
                query: { after: 0, limit: 1, sessionAccessSessionId: "session-restricted" },
                accountStoredContentCompatibility: currentSessionAccessWitnessCompatibility,
            },
            registerRoutes(app) {
                changesRoutes(app as any);
            },
        });

        const { reply, response } = await route.invoke();
        expect(reply.code).toHaveBeenCalledWith(503);
        expect(response).toEqual({ error: "session_access_authentication_unavailable" });
        expect(response).not.toHaveProperty("sessionAccessProbe");
    });

    it("GET /v2/cursor returns current cursor and changesFloor", async () => {
        accountFindUnique.mockResolvedValue({ seq: 10, changesFloor: 7 });
        accountChangeFindMany.mockResolvedValue([]);

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
