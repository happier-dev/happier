import { beforeEach, describe, expect, it } from "vitest";

import * as protocol from "@happier-dev/protocol";
import type { FakeRouteApp } from "../../testkit/routeHarness";
import {
    createSessionRouteTestBuilder,
    markAccountChanged,
    resetSessionRouteMocks,
    sessionFindFirst,
    sessionFindMany,
    sessionFolderAssignmentFindMany,
    txSessionFolderAssignmentDeleteMany,
    txSessionFolderAssignmentFindMany,
    txSessionFolderAssignmentUpdateMany,
    txSessionFolderAssignmentUpsert,
} from "./sessionRoutes.testkit";

type RouteMethod = "GET" | "POST" | "PUT";

const protocolExports = protocol as Record<string, unknown>;

function readNumberExport(name: string, fallback: number): number {
    const value = protocolExports[name];
    return typeof value === "number" ? value : fallback;
}

function requireRouteHandler(app: FakeRouteApp, method: RouteMethod, path: string) {
    const entry = app.routes.get(`${method} ${path}`);
    expect(entry).toBeDefined();
    return entry?.handler;
}

async function invokeRawRoute(params: Readonly<{
    method: RouteMethod;
    path: string;
    request?: Record<string, unknown>;
}>) {
    const route = await createSessionRouteTestBuilder(params.method, params.path);
    const handler = requireRouteHandler(route.app, params.method, params.path);
    if (!handler) return { route, response: undefined, reply: route.createReply() };

    const reply = route.createReply();
    const response = await handler(route.createAuthenticatedRequest(params.request ?? {}), reply);
    return { route, response, reply };
}

function sessionListRow(id: string, overrides: Record<string, unknown> = {}) {
    const now = new Date(1000);
    return {
        id,
        seq: 1,
        accountId: "u1",
        encryptionMode: "plain",
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        metadata: "{}",
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 0,
        lastViewedSessionSeq: 0,
        pendingPermissionRequestCount: 0,
        pendingUserActionRequestCount: 0,
        latestTurnStatus: null,
        lastRuntimeIssue: null,
        dataEncryptionKey: null,
        pendingCount: 0,
        pendingVersion: 0,
        active: false,
        lastActiveAt: now,
        shares: [],
        ...overrides,
    };
}

describe("session folder assignment routes", () => {
    beforeEach(() => {
        resetSessionRouteMocks();
    });

    it("assigns a visible owned session to a folder for the current account", async () => {
        sessionFindFirst.mockResolvedValue({ id: "s1" });
        txSessionFolderAssignmentUpsert.mockResolvedValue({ sessionId: "s1", folderId: "folder-a" });

        const { response, reply } = await invokeRawRoute({
            method: "PUT",
            path: "/v2/session-folder-assignments/:sessionId",
            request: {
                params: { sessionId: "s1" },
                body: { folderId: "folder-a" },
            },
        });

        expect(reply.code).not.toHaveBeenCalledWith(404);
        expect(response).toEqual({ sessionId: "s1", folderId: "folder-a" });
        expect(sessionFindFirst).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                id: "s1",
                OR: expect.arrayContaining([
                    { accountId: "u1" },
                    { shares: { some: { sharedWithUserId: "u1" } } },
                ]),
            }),
        }));
        expect(txSessionFolderAssignmentUpsert).toHaveBeenCalledWith(expect.objectContaining({
            where: { accountId_sessionId: { accountId: "u1", sessionId: "s1" } },
            create: { accountId: "u1", sessionId: "s1", folderId: "folder-a" },
            update: { folderId: "folder-a" },
        }));
        expect(markAccountChanged).toHaveBeenCalledWith(expect.anything(), {
            accountId: "u1",
            kind: "session",
            entityId: "s1",
            hint: { sessionFolderAssignment: true, folderId: "folder-a" },
        });
    });

    it("deletes the assignment when folderId is null", async () => {
        sessionFindFirst.mockResolvedValue({ id: "s1" });
        txSessionFolderAssignmentDeleteMany.mockResolvedValue({ count: 1 });

        const { response } = await invokeRawRoute({
            method: "PUT",
            path: "/v2/session-folder-assignments/:sessionId",
            request: {
                params: { sessionId: "s1" },
                body: { folderId: null },
            },
        });

        expect(response).toEqual({ sessionId: "s1", folderId: null });
        expect(txSessionFolderAssignmentDeleteMany).toHaveBeenCalledWith({
            where: { accountId: "u1", sessionId: "s1" },
        });
    });

    it("rejects assignment for an invisible session", async () => {
        sessionFindFirst.mockResolvedValue(null);

        const { response, reply } = await invokeRawRoute({
            method: "PUT",
            path: "/v2/session-folder-assignments/:sessionId",
            request: {
                params: { sessionId: "hidden" },
                body: { folderId: "folder-a" },
            },
        });

        expect(reply.code).toHaveBeenCalledWith(404);
        expect(response).toEqual({ error: "Session not found" });
        expect(txSessionFolderAssignmentUpsert).not.toHaveBeenCalled();
        expect(markAccountChanged).not.toHaveBeenCalled();
    });

    it("returns only current-account assignments for visible requested sessions", async () => {
        sessionFolderAssignmentFindMany.mockResolvedValue([
            { sessionId: "shared-s1", folderId: "viewer-folder" },
        ]);

        const { response } = await invokeRawRoute({
            method: "GET",
            path: "/v2/session-folder-assignments",
            request: { query: { sessionIds: "shared-s1,owned-s2" }, userId: "viewer" },
        });

        expect(response).toEqual({
            assignments: [{ sessionId: "shared-s1", folderId: "viewer-folder" }],
        });
        expect(sessionFolderAssignmentFindMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                accountId: "viewer",
                sessionId: { in: ["shared-s1", "owned-s2"] },
                session: expect.objectContaining({
                    OR: expect.arrayContaining([
                        { accountId: "viewer" },
                        { shares: { some: { sharedWithUserId: "viewer" } } },
                    ]),
                }),
            }),
        }));
    });

    it("rejects assignment list queries that exceed the shared protocol session-id limit", async () => {
        const maxSessionIds = readNumberExport("SESSION_FOLDER_ASSIGNMENT_QUERY_MAX_SESSION_IDS", 500);
        const sessionIds = Array.from(
            { length: maxSessionIds + 1 },
            (_, index) => `session-${index}`,
        ).join(",");

        const { response, reply } = await invokeRawRoute({
            method: "GET",
            path: "/v2/session-folder-assignments",
            request: { query: { sessionIds } },
        });

        expect(reply.code).toHaveBeenCalledWith(400);
        expect(response).toEqual({ error: "invalid-session-ids" });
        expect(sessionFolderAssignmentFindMany).not.toHaveBeenCalled();
    });

    it("queries folder sessions through the shared v2 session-list pagination path across page 2", async () => {
        sessionFindMany
            .mockResolvedValueOnce([
                sessionListRow("s9", { meaningfulActivityAt: new Date(9_000) }),
                sessionListRow("s8", { meaningfulActivityAt: new Date(8_000) }),
                sessionListRow("s7", { meaningfulActivityAt: new Date(7_000) }),
            ])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([
                sessionListRow("s7", { meaningfulActivityAt: new Date(7_000) }),
            ])
            .mockResolvedValueOnce([]);

        const { response: firstPage } = await invokeRawRoute({
            method: "POST",
            path: "/v2/session-folder-assignments/query",
            request: {
                body: {
                    folderIds: ["folder-a"],
                    limit: 2,
                    archived: false,
                },
            },
        });

        expect(firstPage).toEqual({
            sessions: [
                expect.objectContaining({ id: "s9", meaningfulActivityAt: 9_000 }),
                expect.objectContaining({ id: "s8", meaningfulActivityAt: 8_000 }),
            ],
            nextCursor: protocol.encodeV2SessionListCursorV2({ sessionId: "s8", meaningfulActivityAt: 8_000 }),
            hasNext: true,
        });
        expect(sessionFindMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
            where: expect.objectContaining({
                archivedAt: null,
                meaningfulActivityAt: { not: null },
                sessionFolderAssignments: {
                    some: {
                        accountId: "u1",
                        folderId: { in: ["folder-a"] },
                    },
                },
            }),
            orderBy: [
                { meaningfulActivityAt: "desc" },
                { id: "desc" },
            ],
            take: 4,
        }));

        const { response: secondPage, reply: secondReply } = await invokeRawRoute({
            method: "POST",
            path: "/v2/session-folder-assignments/query",
            request: {
                body: {
                    folderIds: ["folder-a"],
                    cursor: (firstPage as { nextCursor: string }).nextCursor,
                    limit: 2,
                    archived: false,
                },
            },
        });

        expect(secondReply.code).not.toHaveBeenCalledWith(400);
        expect(secondPage).toEqual({
            sessions: [
                expect.objectContaining({ id: "s7", meaningfulActivityAt: 7_000 }),
            ],
            nextCursor: null,
            hasNext: false,
        });
        expect(sessionFindMany).toHaveBeenNthCalledWith(3, expect.objectContaining({
            where: expect.objectContaining({
                archivedAt: null,
                meaningfulActivityAt: { not: null },
                AND: [{
                    OR: [
                        { meaningfulActivityAt: { lt: new Date(8_000) } },
                        { meaningfulActivityAt: new Date(8_000), id: { lt: "s8" } },
                    ],
                }],
                sessionFolderAssignments: {
                    some: {
                        accountId: "u1",
                        folderId: { in: ["folder-a"] },
                    },
                },
            }),
            orderBy: [
                { meaningfulActivityAt: "desc" },
                { id: "desc" },
            ],
            take: 4,
        }));
    });

    it("accepts legacy v1 cursors for folder session pagination", async () => {
        sessionFindFirst.mockResolvedValue({
            id: "s5",
            createdAt: new Date(5_000),
            meaningfulActivityAt: new Date(4_500),
        });
        sessionFindMany.mockResolvedValue([]);

        const { response, reply } = await invokeRawRoute({
            method: "POST",
            path: "/v2/session-folder-assignments/query",
            request: {
                body: {
                    folderIds: ["folder-a"],
                    cursor: protocol.encodeV2SessionListCursorV1("s5"),
                    limit: 2,
                    archived: false,
                },
            },
        });

        expect(reply.code).not.toHaveBeenCalledWith(400);
        expect(sessionFindFirst).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                id: "s5",
                archivedAt: null,
                sessionFolderAssignments: {
                    some: {
                        accountId: "u1",
                        folderId: { in: ["folder-a"] },
                    },
                },
            }),
            select: { id: true, createdAt: true, meaningfulActivityAt: true },
        }));
        expect(sessionFindMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                AND: [{
                    OR: [
                        { meaningfulActivityAt: { lt: new Date(4_500) } },
                        { meaningfulActivityAt: new Date(4_500), id: { lt: "s5" } },
                    ],
                }],
            }),
        }));
        expect(response).toEqual({ sessions: [], nextCursor: null, hasNext: false });
    });

    it("paginates null meaningfulActivityAt folder rows by createdAt without skipping the next page", async () => {
        sessionFindMany
            .mockResolvedValueOnce([
                sessionListRow("s9", {
                    createdAt: new Date(900),
                    meaningfulActivityAt: new Date(9_000),
                }),
                sessionListRow("s7", {
                    createdAt: new Date(700),
                    meaningfulActivityAt: new Date(7_000),
                }),
            ])
            .mockResolvedValueOnce([
                sessionListRow("s8", {
                    createdAt: new Date(8_000),
                    meaningfulActivityAt: null,
                }),
            ])
            .mockResolvedValueOnce([
                sessionListRow("s7", {
                    createdAt: new Date(700),
                    meaningfulActivityAt: new Date(7_000),
                }),
            ])
            .mockResolvedValueOnce([]);

        const { response: firstPage } = await invokeRawRoute({
            method: "POST",
            path: "/v2/session-folder-assignments/query",
            request: {
                body: {
                    folderIds: ["folder-a"],
                    limit: 2,
                    archived: false,
                },
            },
        });

        expect(firstPage).toEqual({
            sessions: [
                expect.objectContaining({ id: "s9", meaningfulActivityAt: 9_000 }),
                expect.objectContaining({ id: "s8", meaningfulActivityAt: 8_000 }),
            ],
            nextCursor: protocol.encodeV2SessionListCursorV2({ sessionId: "s8", meaningfulActivityAt: 8_000 }),
            hasNext: true,
        });

        const { response: secondPage } = await invokeRawRoute({
            method: "POST",
            path: "/v2/session-folder-assignments/query",
            request: {
                body: {
                    folderIds: ["folder-a"],
                    cursor: (firstPage as { nextCursor: string }).nextCursor,
                    limit: 2,
                    archived: false,
                },
            },
        });

        expect(secondPage).toEqual({
            sessions: [
                expect.objectContaining({ id: "s7", meaningfulActivityAt: 7_000 }),
            ],
            nextCursor: null,
            hasNext: false,
        });
        expect(sessionFindMany).toHaveBeenNthCalledWith(3, expect.objectContaining({
            where: expect.objectContaining({
                archivedAt: null,
                meaningfulActivityAt: { not: null },
                AND: [{
                    OR: [
                        { meaningfulActivityAt: { lt: new Date(8_000) } },
                        { meaningfulActivityAt: new Date(8_000), id: { lt: "s8" } },
                    ],
                }],
                sessionFolderAssignments: {
                    some: {
                        accountId: "u1",
                        folderId: { in: ["folder-a"] },
                    },
                },
            }),
        }));
        expect(sessionFindMany).toHaveBeenNthCalledWith(4, expect.objectContaining({
            where: expect.objectContaining({
                archivedAt: null,
                meaningfulActivityAt: null,
                AND: [{
                    OR: [
                        { createdAt: { lt: new Date(8_000) } },
                        { createdAt: new Date(8_000), id: { lt: "s8" } },
                    ],
                }],
                sessionFolderAssignments: {
                    some: {
                        accountId: "u1",
                        folderId: { in: ["folder-a"] },
                    },
                },
            }),
        }));
    });

    it("bulk moves current-account assignments and marks a bulk assignment change", async () => {
        txSessionFolderAssignmentFindMany.mockResolvedValue([
            { sessionId: "s1", folderId: "old-a" },
            { sessionId: "s2", folderId: "old-b" },
        ]);
        txSessionFolderAssignmentUpdateMany.mockResolvedValue({ count: 2 });

        const { response } = await invokeRawRoute({
            method: "POST",
            path: "/v2/session-folder-assignments/move",
            request: {
                body: {
                    fromFolderIds: ["old-a", "old-b"],
                    toFolderId: "new-folder",
                },
            },
        });

        expect(response).toEqual({
            assignments: [
                { sessionId: "s1", folderId: "old-a" },
                { sessionId: "s2", folderId: "old-b" },
            ],
            affectedCount: 2,
            toFolderId: "new-folder",
        });
        expect(txSessionFolderAssignmentUpdateMany).toHaveBeenCalledWith({
            where: { accountId: "u1", folderId: { in: ["old-a", "old-b"] } },
            data: { folderId: "new-folder" },
        });
        expect(markAccountChanged).toHaveBeenCalledWith(expect.anything(), {
            accountId: "u1",
            kind: "account",
            entityId: "session-folder-assignments",
            hint: {
                sessionFolderAssignments: true,
                folderIds: ["old-a", "old-b"],
                toFolderId: "new-folder",
            },
        });
    });

    it("bulk deletes current-account assignments when the target folder is null", async () => {
        txSessionFolderAssignmentFindMany.mockResolvedValue([{ sessionId: "s1", folderId: "old-a" }]);
        txSessionFolderAssignmentDeleteMany.mockResolvedValue({ count: 1 });

        const { response } = await invokeRawRoute({
            method: "POST",
            path: "/v2/session-folder-assignments/move",
            request: {
                body: {
                    fromFolderIds: ["old-a"],
                    toFolderId: null,
                },
            },
        });

        expect(response).toEqual({
            assignments: [{ sessionId: "s1", folderId: "old-a" }],
            affectedCount: 1,
            toFolderId: null,
        });
        expect(txSessionFolderAssignmentDeleteMany).toHaveBeenCalledWith({
            where: { accountId: "u1", folderId: { in: ["old-a"] } },
        });
    });

    it("registers assignment routes behind the sessions.folders feature gate", async () => {
        const previous = process.env.HAPPIER_BUILD_FEATURES_DENY;
        process.env.HAPPIER_BUILD_FEATURES_DENY = "sessions.folders";
        try {
            const route = await createSessionRouteTestBuilder("GET", "/v2/session-folder-assignments");
            const { response, reply } = await route.invoke({ query: { sessionIds: "s1" } });

            expect(reply.code).toHaveBeenCalledWith(404);
            expect(response).toBeUndefined();
            expect(sessionFolderAssignmentFindMany).not.toHaveBeenCalled();
        } finally {
            if (typeof previous === "undefined") {
                delete process.env.HAPPIER_BUILD_FEATURES_DENY;
            } else {
                process.env.HAPPIER_BUILD_FEATURES_DENY = previous;
            }
        }
    });
});
