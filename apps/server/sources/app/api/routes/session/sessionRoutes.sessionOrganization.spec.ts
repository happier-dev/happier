import { beforeEach, describe, expect, it } from "vitest";
import tweetnacl from "tweetnacl";

import {
    ACCOUNT_STORED_CONTENT_COMPATIBILITY_HTTP_HEADER,
    CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
    SESSION_ORGANIZATION_MAX_FOLDERS,
    SESSION_ORGANIZATION_MAX_LABELS,
    SESSION_ORGANIZATION_MAX_PINNED_SESSIONS,
    SESSION_ORGANIZATION_MAX_TAGS,
    SESSION_ORGANIZATION_SNAPSHOT_VERSION,
    parseAccountStoredContentCompatibilityHttpHeadersV1,
} from "@happier-dev/protocol";
import {
    evaluateAccountStoredContentCompatibility,
} from "@/app/clientCompatibility/accountStoredContentCompatibility";
import {
    createSessionRouteTestBuilder,
    accountFindUnique,
    markAccountChanged,
    resetSessionRouteMocks,
    sessionFindFirst,
    sessionFindMany,
    sessionFolderAssignmentFindMany,
    sessionOrganizationCheckpointFindUnique,
    sessionOrganizationFolderFindMany,
    sessionOrganizationLabelFindMany,
    sessionOrganizationOrderEntryFindMany,
    sessionOrganizationTagFindMany,
    sessionPinFindMany,
    sessionTagAssignmentFindMany,
    txSessionFolderAssignmentDeleteMany,
    txSessionFolderAssignmentUpdateMany,
    txSessionFolderAssignmentUpsert,
    txSessionOrganizationCheckpointUpsert,
    txSessionOrganizationFolderCount,
    txSessionOrganizationFolderFindMany,
    txSessionOrganizationFolderUpdateMany,
    txSessionOrganizationFolderUpsert,
    txSessionOrganizationOrderEntryDeleteMany,
    txSessionOrganizationOrderEntryFindMany,
    txSessionOrganizationOrderEntryUpsert,
    txSessionOrganizationLabelCount,
    txSessionOrganizationLabelFindMany,
    txSessionOrganizationLabelUpdateMany,
    txSessionOrganizationLabelUpsert,
    txSessionOrganizationTagDeleteMany,
    txSessionOrganizationTagCount,
    txSessionOrganizationTagFindMany,
    txSessionOrganizationTagUpdateMany,
    txSessionOrganizationTagUpsert,
    txSessionPinCount,
    txSessionPinFindMany,
    txSessionPinFindUnique,
    txSessionPinUpsert,
    txSessionFindFirst,
    txSessionFindMany,
    txSessionTagAssignmentCreateMany,
    txSessionTagAssignmentDeleteMany,
    txSessionTagAssignmentFindMany,
    txAccountFindUnique,
} from "./sessionRoutes.testkit";
import { hashSessionOrganizationKey } from "@/app/session/organization/hashKeys";

const encryptedDisplay = { t: "encrypted" as const, c: "ciphertext" };
const plainDisplay = { t: "plain" as const, v: { label: "Plain text" } };

function organizationDate(ms: number): Date {
    return new Date(ms);
}

function createCurrentE2eeAccountFixture() {
    const signing = tweetnacl.sign.keyPair();
    const content = tweetnacl.box.keyPair();
    return {
        encryptionMode: "e2ee" as const,
        publicKey: Buffer.from(signing.publicKey).toString("hex"),
        contentPublicKey: new Uint8Array(content.publicKey),
        contentPublicKeySig: new Uint8Array(tweetnacl.sign.detached(
            Buffer.concat([
                Buffer.from("Happy content key v1\u0000", "utf8"),
                Buffer.from(content.publicKey),
            ]),
            signing.secretKey,
        )),
    };
}

function organizationCompatibilityForHeaders(
    headers: Readonly<Record<string, unknown>>,
) {
    return evaluateAccountStoredContentCompatibility(
        parseAccountStoredContentCompatibilityHttpHeadersV1(headers),
    );
}

function arrangeLockedOrganizationFolder() {
    sessionOrganizationFolderFindMany.mockResolvedValue([{
        id: "locked-folder",
        folderKey: "private/folder/key",
        parentKey: null,
        sortKey: "0001",
        displayDbValue: "{not-json",
        archivedAt: null,
        createdAt: organizationDate(1_000),
        updatedAt: organizationDate(2_000),
    }]);
}

function expectedV2SessionVisibilityBranches() {
    return [
        { accountId: "u1" },
        {
            AND: [
                { shares: { some: { sharedWithUserId: "u1" } } },
                {
                    OR: [
                        { currentStorageState: "hosted" },
                        {
                            currentStorageState: "snapshot_complete",
                            materializationPublicationId: { not: "" },
                            materializedThroughSourceAt: {
                                gte: 0,
                                lte: BigInt(Number.MAX_SAFE_INTEGER),
                            },
                            publishedThroughServerSeq: { gte: 0 },
                        },
                    ],
                },
            ],
        },
    ];
}

async function rejectPrismaSkipDuplicates(args: unknown): Promise<void> {
    if (
        args &&
        typeof args === "object" &&
        Object.prototype.hasOwnProperty.call(args, "skipDuplicates")
    ) {
        throw new Error("Unknown argument `skipDuplicates`");
    }
}

function pagedSessionRow(id: string) {
    const createdAt = new Date(1_000);
    return {
        id,
        seq: 1,
        accountId: "u1",
        encryptionMode: "plain",
        createdAt,
        updatedAt: createdAt,
        meaningfulActivityAt: createdAt,
        archivedAt: null,
        metadata: "{}",
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 0,
        lastViewedSessionSeq: 0,
        pendingPermissionRequestCount: 0,
        pendingUserActionRequestCount: 0,
        pendingRequestObservedAt: null,
        latestReadyEventSeq: null,
        latestReadyEventAt: null,
        thinking: false,
        thinkingAt: null,
        latestTurnId: null,
        latestTurnStatus: null,
        lastRuntimeIssue: null,
        pendingCount: 0,
        pendingVersion: 0,
        dataEncryptionKey: null,
        active: false,
        lastActiveAt: createdAt,
        shares: [],
    };
}

describe("session organization routes", () => {
    beforeEach(() => {
        resetSessionRouteMocks();
        const account = createCurrentE2eeAccountFixture();
        accountFindUnique.mockResolvedValue(account);
        txAccountFindUnique.mockResolvedValue(account);
    });

    it("returns an account-scoped organization snapshot", async () => {
        sessionOrganizationCheckpointFindUnique.mockResolvedValue({ version: 12 });
        sessionPinFindMany.mockResolvedValue([
            { sessionId: "s1", sortKey: "a", pinnedAt: organizationDate(1_000) },
        ]);
        sessionOrganizationFolderFindMany.mockResolvedValue([
            {
                id: "parent-folder",
                folderKey: "parent:key",
                parentKey: null,
                sortKey: "parent-sort",
                displayDbValue: null,
                archivedAt: null,
                createdAt: organizationDate(1_500),
                updatedAt: organizationDate(1_600),
            },
            {
                id: "folder-1",
                folderKey: "folder:key",
                parentKey: "parent:key",
                sortKey: "folder-sort",
                displayDbValue: JSON.stringify(encryptedDisplay),
                archivedAt: null,
                createdAt: organizationDate(2_000),
                updatedAt: organizationDate(3_000),
            },
        ]);
        sessionFolderAssignmentFindMany.mockResolvedValue([{ sessionId: "s1", folderId: "folder-1" }]);
        sessionOrganizationTagFindMany.mockResolvedValue([]);
        sessionTagAssignmentFindMany.mockResolvedValue([]);
        sessionOrganizationOrderEntryFindMany.mockResolvedValue([
            { scopeKind: "workspace", scopeKey: "server-1", itemKind: "workspace", itemKey: "server-1:/repo", sortKey: "a" },
        ]);
        sessionOrganizationLabelFindMany.mockResolvedValue([]);

        const route = await createSessionRouteTestBuilder("GET", "/v2/session-organization");
        const { response } = await route.invoke({
            query: {
                includeAllFolderAssignments: "true",
                orderScopes: JSON.stringify([{ scopeKind: "workspace", scopeKey: "server-1" }]),
            },
        });

        expect(response).toEqual({
            snapshot: {
                schemaVersion: SESSION_ORGANIZATION_SNAPSHOT_VERSION,
                version: 12,
                pins: [{ sessionId: "s1", sortKey: "a", pinnedAt: 1_000 }],
                folders: [{
                    folderId: "parent-folder",
                    folderKey: "parent:key",
                    parentFolderId: null,
                    parentFolderKey: null,
                    sortKey: "parent-sort",
                    display: null,
                    archivedAt: null,
                    createdAt: 1_500,
                    updatedAt: 1_600,
                }, {
                    folderId: "folder-1",
                    folderKey: "folder:key",
                    parentFolderId: "parent-folder",
                    parentFolderKey: "parent:key",
                    sortKey: "folder-sort",
                    display: encryptedDisplay,
                    archivedAt: null,
                    createdAt: 2_000,
                    updatedAt: 3_000,
                }],
                folderAssignments: [{ sessionId: "s1", folderId: "folder-1" }],
                tags: [],
                tagAssignments: [],
                orderEntries: [{ scopeKind: "workspace", scopeKey: "server-1", itemKind: "workspace", itemKey: "server-1:/repo", sortKey: "a" }],
                labels: [],
            },
        });
        expect(sessionPinFindMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                accountId: "u1",
                session: expect.objectContaining({
                    archivedAt: null,
                    OR: expectedV2SessionVisibilityBranches(),
                }),
            }),
            orderBy: [{ sortKey: "asc" }, { pinnedAt: "asc" }],
        }));
        expect(accountFindUnique).toHaveBeenCalledWith({
            where: { id: "u1" },
            select: {
                publicKey: true,
                encryptionMode: true,
                contentPublicKey: true,
                contentPublicKeySig: true,
            },
        });
        expect(sessionFolderAssignmentFindMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                accountId: "u1",
                session: expect.objectContaining({
                    OR: expectedV2SessionVisibilityBranches(),
                }),
            }),
        }));
        expect(sessionOrganizationOrderEntryFindMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                accountId: "u1",
                OR: [{
                    scopeKind: "workspace",
                    scopeHash: hashSessionOrganizationKey("server-1"),
                    scopeKey: "server-1",
                }],
            }),
        }));
    });

    it("keeps a predecessor caller on 200 when the snapshot remains predecessor-compatible", async () => {
        const route = await createSessionRouteTestBuilder("GET", "/v2/session-organization");
        const { reply, response } = await route.invoke({
            accountStoredContentCompatibility: organizationCompatibilityForHeaders({
                [ACCOUNT_STORED_CONTENT_COMPATIBILITY_HTTP_HEADER]: "1",
            }),
        });

        expect(reply.statusCode).toBe(200);
        expect(response).toEqual({
            snapshot: expect.objectContaining({
                folders: [],
                tags: [],
                labels: [],
            }),
        });
    });

    it.each([
        ["missing", {}],
        ["v1", { [ACCOUNT_STORED_CONTENT_COMPATIBILITY_HTTP_HEADER]: "1" }],
        ["malformed", { [ACCOUNT_STORED_CONTENT_COMPATIBILITY_HTTP_HEADER]: "1,2" }],
    ])("returns the canonical typed 426 for a locked snapshot and a %s declaration", async (_label, headers) => {
        arrangeLockedOrganizationFolder();
        const route = await createSessionRouteTestBuilder("GET", "/v2/session-organization");
        const { reply, response } = await route.invoke({
            accountStoredContentCompatibility: organizationCompatibilityForHeaders(headers),
        });

        expect(response).toBeUndefined();
        expect(reply.statusCode).toBe(426);
        expect(reply.send).toHaveBeenCalledWith({
            error: "client-upgrade-required",
            requirement: {
                v: 1,
                kind: "account-stored-content",
                minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
            },
        });
    });

    it("returns the strict locked projection to a current V2 caller", async () => {
        arrangeLockedOrganizationFolder();
        const route = await createSessionRouteTestBuilder("GET", "/v2/session-organization");
        const { reply, response } = await route.invoke({
            accountStoredContentCompatibility: organizationCompatibilityForHeaders({
                [ACCOUNT_STORED_CONTENT_COMPATIBILITY_HTTP_HEADER]: String(
                    CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                ),
            }),
        });

        expect(reply.statusCode).toBe(200);
        expect(response).toEqual({
            snapshot: expect.objectContaining({
                folders: [expect.objectContaining({
                    folderId: "locked-folder",
                    display: null,
                    displayState: {
                        status: "unavailable",
                        reason: "invalid_stored_display",
                    },
                })],
            }),
        });
    });

    it("omits stale server-owned order entries from snapshots", async () => {
        sessionOrganizationOrderEntryFindMany.mockResolvedValue([
            { scopeKind: "pinned", scopeKey: "root", itemKind: "session", itemKey: "visible-session", sortKey: "legacy-pin" },
            { scopeKind: "folder", scopeKey: "folder-1", itemKind: "session", itemKey: "visible-session", sortKey: "a" },
            { scopeKind: "folder", scopeKey: "folder-1", itemKind: "session", itemKey: "hidden-session", sortKey: "b" },
            { scopeKind: "group", scopeKey: "root", itemKind: "folder", itemKey: "folder-1", sortKey: "c" },
            { scopeKind: "group", scopeKey: "root", itemKind: "folder", itemKey: "archived-folder", sortKey: "d" },
            { scopeKind: "group", scopeKey: "root", itemKind: "tag", itemKey: "tag-1", sortKey: "e" },
            { scopeKind: "group", scopeKey: "root", itemKind: "tag", itemKey: "archived-tag", sortKey: "f" },
            { scopeKind: "workspace", scopeKey: "server-1", itemKind: "workspace", itemKey: "server-1:/repo", sortKey: "g" },
        ]);
        sessionFindMany.mockResolvedValue([{ id: "visible-session" }]);
        sessionOrganizationFolderFindMany.mockResolvedValue([{ id: "folder-1" }]);
        sessionOrganizationTagFindMany.mockResolvedValue([{ id: "tag-1" }]);

        const route = await createSessionRouteTestBuilder("GET", "/v2/session-organization");
        const { response } = await route.invoke({
            query: {
                includeFolders: "false",
                includeTags: "false",
                orderScopes: JSON.stringify([
                    { scopeKind: "folder", scopeKey: "folder-1" },
                    { scopeKind: "group", scopeKey: "root" },
                    { scopeKind: "workspace", scopeKey: "server-1" },
                ]),
            },
        });

        expect(response).toEqual(expect.objectContaining({
            snapshot: expect.objectContaining({
                orderEntries: [
                    { scopeKind: "folder", scopeKey: "folder-1", itemKind: "session", itemKey: "visible-session", sortKey: "a" },
                    { scopeKind: "group", scopeKey: "root", itemKind: "folder", itemKey: "folder-1", sortKey: "c" },
                    { scopeKind: "group", scopeKey: "root", itemKind: "tag", itemKey: "tag-1", sortKey: "e" },
                    { scopeKind: "workspace", scopeKey: "server-1", itemKind: "workspace", itemKey: "server-1:/repo", sortKey: "g" },
                ],
            }),
        }));
        expect(sessionFindMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                id: { in: ["visible-session", "hidden-session"] },
                OR: expectedV2SessionVisibilityBranches(),
            }),
            select: { id: true },
        }));
        expect(sessionOrganizationFolderFindMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { accountId: "u1", id: { in: ["folder-1", "archived-folder"] }, archivedAt: null },
            select: { id: true },
        }));
        expect(sessionOrganizationTagFindMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { accountId: "u1", id: { in: ["tag-1", "archived-tag"] }, archivedAt: null },
            select: { id: true },
        }));
    });

    it("filters snapshot membership rows through current session visibility", async () => {
        sessionPinFindMany.mockResolvedValue([
            { sessionId: "visible-pin", sortKey: "pin-a", pinnedAt: organizationDate(1_000) },
        ]);
        sessionFolderAssignmentFindMany.mockResolvedValue([
            { sessionId: "visible-folder-session", folderId: "folder-1" },
        ]);
        sessionTagAssignmentFindMany.mockResolvedValue([
            { sessionId: "visible-tag-session", tagId: "tag-1" },
        ]);

        const route = await createSessionRouteTestBuilder("GET", "/v2/session-organization");
        const { response } = await route.invoke({
            query: {
                includeAllFolderAssignments: "true",
                includeAllTagAssignments: "true",
            },
        });

        expect(response).toEqual(expect.objectContaining({
            snapshot: expect.objectContaining({
                pins: [{ sessionId: "visible-pin", sortKey: "pin-a", pinnedAt: 1_000 }],
                folderAssignments: [{ sessionId: "visible-folder-session", folderId: "folder-1" }],
                tagAssignments: [{ sessionId: "visible-tag-session", tagIds: ["tag-1"] }],
            }),
        }));
        const visibilityWhere = expect.objectContaining({
            OR: expectedV2SessionVisibilityBranches(),
        });
        expect(sessionPinFindMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({ accountId: "u1", session: visibilityWhere }),
        }));
        expect(sessionFolderAssignmentFindMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({ accountId: "u1", session: visibilityWhere }),
        }));
        expect(sessionTagAssignmentFindMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({ accountId: "u1", session: visibilityWhere }),
        }));
    });

    it("fetches folder assignment snapshots from the union of requested session and folder scopes", async () => {
        sessionFolderAssignmentFindMany.mockResolvedValue([
            { sessionId: "s1", folderId: "folder-from-session" },
            { sessionId: "s2", folderId: "folder-a" },
        ]);

        const route = await createSessionRouteTestBuilder("GET", "/v2/session-organization");
        const { response } = await route.invoke({
            query: {
                assignmentSessionIds: "s1",
                folderIds: "folder-a",
            },
        });

        expect(response).toEqual(expect.objectContaining({
            snapshot: expect.objectContaining({
                folderAssignments: [
                    { sessionId: "s1", folderId: "folder-from-session" },
                    { sessionId: "s2", folderId: "folder-a" },
                ],
            }),
        }));
        expect(sessionFolderAssignmentFindMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                accountId: "u1",
                OR: [
                    { sessionId: { in: ["s1"] } },
                    { folderId: { in: ["folder-a"] } },
                ],
                session: expect.objectContaining({
                    OR: expectedV2SessionVisibilityBranches(),
                }),
            }),
        }));
    });

    it("fetches tag assignment snapshots by requested tag scope without a session scope", async () => {
        sessionTagAssignmentFindMany.mockResolvedValue([
            { sessionId: "s1", tagId: "tag-a" },
            { sessionId: "s2", tagId: "tag-a" },
        ]);

        const route = await createSessionRouteTestBuilder("GET", "/v2/session-organization");
        const { response } = await route.invoke({
            query: {
                tagIds: "tag-a",
            },
        });

        expect(response).toEqual(expect.objectContaining({
            snapshot: expect.objectContaining({
                tagAssignments: [
                    { sessionId: "s1", tagIds: ["tag-a"] },
                    { sessionId: "s2", tagIds: ["tag-a"] },
                ],
            }),
        }));
        expect(sessionTagAssignmentFindMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                accountId: "u1",
                OR: [{ tagId: { in: ["tag-a"] } }],
                session: expect.objectContaining({
                    OR: expectedV2SessionVisibilityBranches(),
                }),
            }),
        }));
    });

    it("fetches tag assignment snapshots from the union of requested session and tag scopes", async () => {
        sessionTagAssignmentFindMany.mockResolvedValue([
            { sessionId: "s1", tagId: "tag-from-session" },
            { sessionId: "s2", tagId: "tag-a" },
        ]);

        const route = await createSessionRouteTestBuilder("GET", "/v2/session-organization");
        const { response } = await route.invoke({
            query: {
                assignmentSessionIds: "s1",
                tagIds: "tag-a",
            },
        });

        expect(response).toEqual(expect.objectContaining({
            snapshot: expect.objectContaining({
                tagAssignments: [
                    { sessionId: "s1", tagIds: ["tag-from-session"] },
                    { sessionId: "s2", tagIds: ["tag-a"] },
                ],
            }),
        }));
        expect(sessionTagAssignmentFindMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                accountId: "u1",
                OR: [
                    { sessionId: { in: ["s1"] } },
                    { tagId: { in: ["tag-a"] } },
                ],
                session: expect.objectContaining({
                    OR: expectedV2SessionVisibilityBranches(),
                }),
            }),
        }));
    });

    it("pins a visible session idempotently and marks organization changed", async () => {
        sessionFindFirst.mockResolvedValue({ id: "s1" });
        txSessionFindFirst.mockResolvedValue({ id: "s1" });
        txSessionPinFindUnique.mockResolvedValue({ id: "existing-pin" });
        txSessionPinUpsert.mockResolvedValue({
            sessionId: "s1",
            sortKey: "rank-a",
            pinnedAt: organizationDate(4_000),
        });

        const route = await createSessionRouteTestBuilder("PUT", "/v2/session-organization/pins/:sessionId");
        const { response, reply } = await route.invoke({
            params: { sessionId: "s1" },
            body: { pinned: true, sortKey: "rank-a" },
        });

        expect(reply.code).not.toHaveBeenCalledWith(404);
        expect(response).toEqual({ pin: { sessionId: "s1", sortKey: "rank-a", pinnedAt: 4_000 } });
        expect(txSessionPinUpsert).toHaveBeenCalledWith(expect.objectContaining({
            where: { accountId_sessionId: { accountId: "u1", sessionId: "s1" } },
            create: expect.objectContaining({ accountId: "u1", sessionId: "s1", sortKey: "rank-a" }),
            update: { sortKey: "rank-a" },
        }));
        expect(txSessionOrganizationCheckpointUpsert).toHaveBeenCalledWith(expect.objectContaining({
            where: { accountId: "u1" },
            update: { version: { increment: 1 } },
        }));
        expect(markAccountChanged).toHaveBeenCalledWith(expect.anything(), {
            accountId: "u1",
            kind: "account",
            entityId: "session-organization",
            hint: { sessionOrganization: true, scope: "pins", sessionIds: ["s1"] },
        });
    });

    it("rejects pinning an invisible session", async () => {
        sessionFindFirst.mockResolvedValue(null);

        const route = await createSessionRouteTestBuilder("PUT", "/v2/session-organization/pins/:sessionId");
        const { response, reply } = await route.invoke({
            params: { sessionId: "hidden" },
            body: { pinned: true },
        });

        expect(reply.code).toHaveBeenCalledWith(404);
        expect(response).toEqual({ error: "Session not found" });
        expect(txSessionPinUpsert).not.toHaveBeenCalled();
        expect(markAccountChanged).not.toHaveBeenCalled();
    });

    it("rejects pinning an archived session before writing hidden pin state", async () => {
        sessionFindFirst.mockResolvedValue({ id: "archived" });
        txSessionFindFirst.mockResolvedValue(null);
        txSessionPinFindUnique.mockResolvedValue(null);
        txSessionPinCount.mockResolvedValue(0);
        txSessionPinUpsert.mockResolvedValue({
            sessionId: "archived",
            sortKey: null,
            pinnedAt: organizationDate(4_000),
        });

        const route = await createSessionRouteTestBuilder("PUT", "/v2/session-organization/pins/:sessionId");
        const { response, reply } = await route.invoke({
            params: { sessionId: "archived" },
            body: { pinned: true },
        });

        expect(reply.code).toHaveBeenCalledWith(404);
        expect(response).toEqual({ error: "Session not found" });
        expect(txSessionFindFirst).toHaveBeenCalledWith({
            where: expect.objectContaining({
                id: "archived",
                archivedAt: null,
                OR: expectedV2SessionVisibilityBranches(),
            }),
            select: { id: true },
        });
        expect(txSessionPinUpsert).not.toHaveBeenCalled();
        expect(markAccountChanged).not.toHaveBeenCalled();
    });

    it("enforces the product maximum when adding a new pin", async () => {
        sessionFindFirst.mockResolvedValue({ id: "s-overflow" });
        txSessionFindFirst.mockResolvedValue({ id: "s-overflow" });
        txSessionPinFindUnique.mockResolvedValue(null);
        txSessionPinCount.mockResolvedValue(SESSION_ORGANIZATION_MAX_PINNED_SESSIONS);

        const route = await createSessionRouteTestBuilder("PUT", "/v2/session-organization/pins/:sessionId");
        const { response, reply } = await route.invoke({
            params: { sessionId: "s-overflow" },
            body: { pinned: true },
        });

        expect(reply.code).toHaveBeenCalledWith(409);
        expect(response).toEqual({ error: "session-pin-limit-exceeded" });
        expect(txSessionPinCount).toHaveBeenCalledWith({
            where: {
                accountId: "u1",
                session: expect.objectContaining({
                    archivedAt: null,
                    OR: expectedV2SessionVisibilityBranches(),
                }),
            },
        });
        expect(txSessionPinUpsert).not.toHaveBeenCalled();
    });

    it("upserts folder definitions without parsing private display content", async () => {
        txSessionOrganizationFolderFindMany
            .mockResolvedValueOnce([{ id: "parent-folder", folderKey: "parent:key", archivedAt: null }])
            .mockResolvedValueOnce([{ id: "parent-folder", folderKey: "parent:key", parentKey: null }])
            .mockResolvedValueOnce([]);
        txSessionOrganizationFolderUpsert.mockResolvedValue({
            id: "folder-1",
            folderKey: "folder:key",
            parentKey: "parent:key",
            sortKey: "rank-a",
            displayDbValue: JSON.stringify(encryptedDisplay),
            archivedAt: null,
            createdAt: organizationDate(1_000),
            updatedAt: organizationDate(2_000),
        });

        const route = await createSessionRouteTestBuilder("POST", "/v2/session-organization/folders");
        const { response } = await route.invoke({
            body: {
                folderId: "folder-1",
                folderKey: "folder:key",
                parentFolderId: "parent-folder",
                parentFolderKey: "parent:key",
                sortKey: "rank-a",
                display: encryptedDisplay,
            },
        });

        expect(response).toEqual({
            folder: {
                folderId: "folder-1",
                folderKey: "folder:key",
                parentFolderId: "parent-folder",
                parentFolderKey: "parent:key",
                sortKey: "rank-a",
                display: encryptedDisplay,
                archivedAt: null,
                createdAt: 1_000,
                updatedAt: 2_000,
            },
        });
        expect(txSessionOrganizationFolderUpsert).toHaveBeenCalledWith(expect.objectContaining({
            create: expect.objectContaining({
                folderKey: "folder:key",
                parentKey: "parent:key",
                displayDbValue: JSON.stringify(encryptedDisplay),
            }),
            update: expect.objectContaining({
                parentKey: "parent:key",
                displayDbValue: JSON.stringify(encryptedDisplay),
                archivedAt: null,
            }),
        }));
    });

    it("rejects plaintext folder display for e2ee accounts", async () => {
        txSessionOrganizationFolderUpsert.mockResolvedValue({
            id: "folder-1",
            folderKey: "folder:key",
            parentKey: null,
            sortKey: "rank-a",
            displayDbValue: JSON.stringify(plainDisplay),
            archivedAt: null,
            createdAt: organizationDate(1_000),
            updatedAt: organizationDate(2_000),
        });

        const route = await createSessionRouteTestBuilder("POST", "/v2/session-organization/folders");
        const { response, reply } = await route.invoke({
            body: {
                folderId: "folder-1",
                folderKey: "folder:key",
                parentFolderId: null,
                parentFolderKey: null,
                sortKey: "rank-a",
                display: plainDisplay,
            },
        });

        expect(reply.code).toHaveBeenCalledWith(400);
        expect(response).toEqual({ error: "invalid-session-organization-folder" });
        expect(txSessionOrganizationFolderUpsert).not.toHaveBeenCalled();
    });

    it("enforces the product maximum when creating a new folder", async () => {
        txSessionOrganizationFolderFindMany.mockResolvedValue([]);
        txSessionOrganizationFolderCount.mockResolvedValue(SESSION_ORGANIZATION_MAX_FOLDERS);

        const route = await createSessionRouteTestBuilder("POST", "/v2/session-organization/folders");
        const { response, reply } = await route.invoke({
            body: {
                folderKey: "folder:overflow",
                parentFolderId: null,
                parentFolderKey: null,
                sortKey: null,
                display: encryptedDisplay,
            },
        });

        expect(reply.code).toHaveBeenCalledWith(409);
        expect(response).toEqual({ error: "session-organization-folder-limit-exceeded" });
        expect(txSessionOrganizationFolderUpsert).not.toHaveBeenCalled();
        expect(markAccountChanged).not.toHaveBeenCalled();
    });

    it("rejects folder upserts when parent id and key do not resolve to the same active account folder", async () => {
        txSessionOrganizationFolderFindMany.mockResolvedValue([
            { id: "parent-folder", folderKey: "parent:key", archivedAt: null },
        ]);

        const route = await createSessionRouteTestBuilder("POST", "/v2/session-organization/folders");
        const { response, reply } = await route.invoke({
            body: {
                folderId: "folder-1",
                folderKey: "folder:key",
                parentFolderId: "parent-folder",
                parentFolderKey: "other-parent:key",
                sortKey: "rank-a",
                display: encryptedDisplay,
            },
        });

        expect(reply.code).toHaveBeenCalledWith(400);
        expect(response).toEqual({ error: "invalid-session-organization-folder" });
        expect(txSessionOrganizationFolderUpsert).not.toHaveBeenCalled();
    });

    it("rejects folder upserts that parent a folder to itself", async () => {
        txSessionOrganizationFolderFindMany.mockResolvedValue([
            { id: "folder-1", folderKey: "folder:key", archivedAt: null },
        ]);
        txSessionOrganizationFolderUpsert.mockResolvedValue({
            id: "folder-1",
            folderKey: "folder:key",
            parentKey: "folder:key",
            sortKey: "rank-a",
            displayDbValue: JSON.stringify(encryptedDisplay),
            archivedAt: null,
            createdAt: organizationDate(1_000),
            updatedAt: organizationDate(2_000),
        });

        const route = await createSessionRouteTestBuilder("POST", "/v2/session-organization/folders");
        const { response, reply } = await route.invoke({
            body: {
                folderId: "folder-1",
                folderKey: "folder:key",
                parentFolderId: "folder-1",
                parentFolderKey: "folder:key",
                sortKey: "rank-a",
                display: encryptedDisplay,
            },
        });

        expect(reply.code).toHaveBeenCalledWith(400);
        expect(response).toEqual({ error: "invalid-session-organization-folder" });
        expect(txSessionOrganizationFolderUpsert).not.toHaveBeenCalled();
    });

    it("rejects folder upserts that parent a folder below its descendant", async () => {
        txSessionOrganizationFolderFindMany
            .mockResolvedValueOnce([{ id: "child-folder", folderKey: "child:key", archivedAt: null }])
            .mockResolvedValueOnce([
                { id: "folder-1", folderKey: "folder:key", parentKey: null },
                { id: "child-folder", folderKey: "child:key", parentKey: "folder:key" },
            ]);
        txSessionOrganizationFolderUpsert.mockResolvedValue({
            id: "folder-1",
            folderKey: "folder:key",
            parentKey: "child:key",
            sortKey: "rank-a",
            displayDbValue: JSON.stringify(encryptedDisplay),
            archivedAt: null,
            createdAt: organizationDate(1_000),
            updatedAt: organizationDate(2_000),
        });

        const route = await createSessionRouteTestBuilder("POST", "/v2/session-organization/folders");
        const { response, reply } = await route.invoke({
            body: {
                folderId: "folder-1",
                folderKey: "folder:key",
                parentFolderId: "child-folder",
                parentFolderKey: "child:key",
                sortKey: "rank-a",
                display: encryptedDisplay,
            },
        });

        expect(reply.code).toHaveBeenCalledWith(400);
        expect(response).toEqual({ error: "invalid-session-organization-folder" });
        expect(txSessionOrganizationFolderUpsert).not.toHaveBeenCalled();
    });

    it("rejects folder upserts that exceed the maximum hierarchy depth", async () => {
        txSessionOrganizationFolderFindMany
            .mockResolvedValueOnce([{ id: "folder-8", folderKey: "folder:8", archivedAt: null }])
            .mockResolvedValueOnce([
                { id: "folder-1", folderKey: "folder:1", parentKey: null },
                { id: "folder-2", folderKey: "folder:2", parentKey: "folder:1" },
                { id: "folder-3", folderKey: "folder:3", parentKey: "folder:2" },
                { id: "folder-4", folderKey: "folder:4", parentKey: "folder:3" },
                { id: "folder-5", folderKey: "folder:5", parentKey: "folder:4" },
                { id: "folder-6", folderKey: "folder:6", parentKey: "folder:5" },
                { id: "folder-7", folderKey: "folder:7", parentKey: "folder:6" },
                { id: "folder-8", folderKey: "folder:8", parentKey: "folder:7" },
            ]);
        txSessionOrganizationFolderUpsert.mockResolvedValue({
            id: "folder-9",
            folderKey: "folder:9",
            parentKey: "folder:8",
            sortKey: "rank-a",
            displayDbValue: JSON.stringify(encryptedDisplay),
            archivedAt: null,
            createdAt: organizationDate(1_000),
            updatedAt: organizationDate(2_000),
        });

        const route = await createSessionRouteTestBuilder("POST", "/v2/session-organization/folders");
        const { response, reply } = await route.invoke({
            body: {
                folderId: "folder-9",
                folderKey: "folder:9",
                parentFolderId: "folder-8",
                parentFolderKey: "folder:8",
                sortKey: "rank-a",
                display: encryptedDisplay,
            },
        });

        expect(reply.code).toHaveBeenCalledWith(400);
        expect(response).toEqual({ error: "invalid-session-organization-folder" });
        expect(txSessionOrganizationFolderUpsert).not.toHaveBeenCalled();
    });

    it("archives a deleted folder subtree and moves affected assignments to the deleted folder parent", async () => {
        txSessionOrganizationFolderFindMany.mockResolvedValue([
            { id: "parent-id", folderKey: "parent-key", parentKey: null },
            { id: "folder-a-id", folderKey: "folder-a-key", parentKey: "parent-key" },
            { id: "child-a-id", folderKey: "child-a-key", parentKey: "folder-a-key" },
        ]);
        txSessionOrganizationFolderUpdateMany.mockResolvedValue({ count: 2 });
        txSessionFolderAssignmentUpdateMany.mockResolvedValue({ count: 3 });

        const route = await createSessionRouteTestBuilder("DELETE", "/v2/session-organization/folders/:folderId");
        const { response } = await route.invoke({
            params: { folderId: "folder-a-id" },
            body: { folderId: "folder-a-id" },
        });

        expect(response).toEqual({
            deletedFolderIds: ["folder-a-id", "child-a-id"],
            assignmentTargetFolderId: "parent-id",
            affectedAssignmentCount: 3,
        });
        expect(txSessionOrganizationFolderUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { accountId: "u1", id: { in: ["folder-a-id", "child-a-id"] } },
            data: expect.objectContaining({ archivedAt: expect.any(Date) }),
        }));
        expect(txSessionFolderAssignmentUpdateMany).toHaveBeenCalledWith({
            where: { accountId: "u1", folderId: { in: ["folder-a-id", "child-a-id"] } },
            data: { folderId: "parent-id" },
        });
        expect(markAccountChanged).toHaveBeenCalledWith(expect.anything(), {
            accountId: "u1",
            kind: "account",
            entityId: "session-folder-assignments",
            hint: {
                sessionFolderAssignments: true,
                sessionOrganization: true,
                scope: "folderAssignments",
                folderIds: ["folder-a-id", "child-a-id"],
                toFolderId: "parent-id",
            },
        });
        expect(markAccountChanged).toHaveBeenCalledWith(expect.anything(), {
            accountId: "u1",
            kind: "account",
            entityId: "session-organization",
            hint: {
                sessionOrganization: true,
                scope: "folderAssignments",
                folderIds: ["folder-a-id", "child-a-id"],
                scopeKeys: ["parent-id"],
            },
        });
    });

    it("sets folder assignments only to active current-account folders and emits legacy plus organization hints", async () => {
        sessionFindFirst.mockResolvedValue({ id: "s1" });
        txSessionOrganizationFolderFindMany.mockResolvedValue([
            { id: "folder-1", folderKey: "folder:key", archivedAt: null },
        ]);
        txSessionFolderAssignmentUpsert.mockResolvedValue({});

        const route = await createSessionRouteTestBuilder("PUT", "/v2/session-organization/folder-assignments/:sessionId");
        const { response } = await route.invoke({
            params: { sessionId: "s1" },
            body: { folderId: "folder-1" },
        });

        expect(response).toEqual({ sessionId: "s1", folderId: "folder-1" });
        expect(txSessionOrganizationFolderFindMany).toHaveBeenCalledWith(expect.objectContaining({
            where: {
                accountId: "u1",
                id: { in: ["folder-1"] },
                archivedAt: null,
            },
        }));
        expect(markAccountChanged).toHaveBeenCalledWith(expect.anything(), {
            accountId: "u1",
            kind: "session",
            entityId: "s1",
            hint: {
                sessionFolderAssignment: true,
                sessionOrganization: true,
                scope: "folderAssignments",
                sessionIds: ["s1"],
                folderIds: ["folder-1"],
                folderId: "folder-1",
            },
        });
    });

    it("rejects folder assignments to missing or archived folders", async () => {
        sessionFindFirst.mockResolvedValue({ id: "s1" });
        txSessionOrganizationFolderFindMany.mockResolvedValue([]);

        const route = await createSessionRouteTestBuilder("PUT", "/v2/session-organization/folder-assignments/:sessionId");
        const { response, reply } = await route.invoke({
            params: { sessionId: "s1" },
            body: { folderId: "archived-folder" },
        });

        expect(reply.code).toHaveBeenCalledWith(400);
        expect(response).toEqual({ error: "invalid-session-folder-assignment" });
        expect(txSessionFolderAssignmentUpsert).not.toHaveBeenCalled();
    });

    it("rejects bulk folder assignment moves to missing or archived folders", async () => {
        txSessionOrganizationFolderFindMany.mockResolvedValue([]);

        const route = await createSessionRouteTestBuilder("POST", "/v2/session-organization/folder-assignments/move");
        const { response, reply } = await route.invoke({
            body: { fromFolderIds: ["folder-a"], toFolderId: "archived-folder" },
        });

        expect(reply.code).toHaveBeenCalledWith(400);
        expect(response).toEqual({ error: "invalid-session-folder-assignment-move" });
        expect(txSessionFolderAssignmentUpdateMany).not.toHaveBeenCalled();
        expect(txSessionFolderAssignmentDeleteMany).not.toHaveBeenCalled();
    });

    it("routes generic pinned order through canonical pin sort keys", async () => {
        txSessionFindMany.mockResolvedValue([{ id: "s1" }, { id: "s2" }]);
        txSessionPinUpsert
            .mockResolvedValueOnce({ sessionId: "s1", sortKey: "a", pinnedAt: organizationDate(1_000) })
            .mockResolvedValueOnce({ sessionId: "s2", sortKey: "b", pinnedAt: organizationDate(2_000) });

        const route = await createSessionRouteTestBuilder("PUT", "/v2/session-organization/order");
        const { response } = await route.invoke({
            body: {
                scopeKind: "pinned",
                scopeKey: "root",
                entries: [
                    { itemKind: "session", itemKey: "s1", sortKey: "a" },
                    { itemKind: "session", itemKey: "s2", sortKey: "b" },
                ],
            },
        });

        expect(response).toEqual({
            orderEntries: [
                { scopeKind: "pinned", scopeKey: "root", itemKind: "session", itemKey: "s1", sortKey: "a" },
                { scopeKind: "pinned", scopeKey: "root", itemKind: "session", itemKey: "s2", sortKey: "b" },
            ],
        });
        expect(txSessionPinUpsert).toHaveBeenCalledTimes(2);
        expect(txSessionOrganizationOrderEntryDeleteMany).not.toHaveBeenCalled();
        expect(txSessionOrganizationOrderEntryUpsert).not.toHaveBeenCalled();
        expect(markAccountChanged).toHaveBeenCalledWith(expect.anything(), {
            accountId: "u1",
            kind: "account",
            entityId: "session-organization",
            hint: { sessionOrganization: true, scope: "pins", sessionIds: ["s1", "s2"] },
        });
    });

    it("rejects generic pinned order entries that are not session items", async () => {
        const route = await createSessionRouteTestBuilder("PUT", "/v2/session-organization/order");
        const { response, reply } = await route.invoke({
            body: {
                scopeKind: "pinned",
                scopeKey: "root",
                entries: [
                    { itemKind: "folder", itemKey: "folder-1", sortKey: "a" },
                ],
            },
        });

        expect(reply.code).toHaveBeenCalledWith(400);
        expect(response).toEqual({ error: "invalid-session-organization-order" });
        expect(txSessionPinUpsert).not.toHaveBeenCalled();
        expect(txSessionOrganizationOrderEntryUpsert).not.toHaveBeenCalled();
    });

    it("rejects generic order entries for hidden sessions before writing order state", async () => {
        txSessionFindMany.mockResolvedValue([{ id: "visible-session" }]);
        txSessionOrganizationFolderFindMany.mockResolvedValue([{ id: "folder-1" }]);
        txSessionOrganizationOrderEntryFindMany.mockResolvedValue([]);

        const route = await createSessionRouteTestBuilder("PUT", "/v2/session-organization/order");
        const { response, reply } = await route.invoke({
            body: {
                scopeKind: "folder",
                scopeKey: "folder-1",
                entries: [
                    { itemKind: "session", itemKey: "visible-session", sortKey: "a" },
                    { itemKind: "session", itemKey: "hidden-session", sortKey: "b" },
                ],
            },
        });

        expect(reply.code).toHaveBeenCalledWith(400);
        expect(response).toEqual({ error: "invalid-session-organization-order" });
        expect(txSessionOrganizationOrderEntryDeleteMany).not.toHaveBeenCalled();
        expect(txSessionOrganizationOrderEntryUpsert).not.toHaveBeenCalled();
        expect(markAccountChanged).not.toHaveBeenCalled();
    });

    it("rejects generic order scope hash collisions before deleting or upserting order state", async () => {
        txSessionFindMany.mockResolvedValue([{ id: "visible-session" }]);
        txSessionOrganizationFolderFindMany.mockResolvedValue([{ id: "folder-1" }]);
        txSessionOrganizationOrderEntryFindMany.mockResolvedValue([{
            scopeKind: "folder",
            scopeKey: "colliding-folder",
            itemKind: "session",
            itemKey: "visible-session",
            sortKey: "a",
        }]);

        const route = await createSessionRouteTestBuilder("PUT", "/v2/session-organization/order");
        const { response, reply } = await route.invoke({
            body: {
                scopeKind: "folder",
                scopeKey: "folder-1",
                entries: [
                    { itemKind: "session", itemKey: "visible-session", sortKey: "a" },
                ],
            },
        });

        expect(reply.code).toHaveBeenCalledWith(400);
        expect(response).toEqual({ error: "invalid-session-organization-order" });
        expect(txSessionOrganizationOrderEntryDeleteMany).not.toHaveBeenCalled();
        expect(txSessionOrganizationOrderEntryUpsert).not.toHaveBeenCalled();
        expect(markAccountChanged).not.toHaveBeenCalled();
    });

    it("rejects generic order item hash collisions before deleting or upserting order state", async () => {
        txSessionFindMany.mockResolvedValue([{ id: "visible-session" }]);
        txSessionOrganizationFolderFindMany.mockResolvedValue([{ id: "folder-1" }]);
        txSessionOrganizationOrderEntryFindMany.mockResolvedValue([{
            scopeKind: "folder",
            scopeKey: "folder-1",
            itemKind: "session",
            itemKey: "colliding-session",
            itemHash: hashSessionOrganizationKey("visible-session"),
            sortKey: "a",
        }]);

        const route = await createSessionRouteTestBuilder("PUT", "/v2/session-organization/order");
        const { response, reply } = await route.invoke({
            body: {
                scopeKind: "folder",
                scopeKey: "folder-1",
                entries: [
                    { itemKind: "session", itemKey: "visible-session", sortKey: "a" },
                ],
            },
        });

        expect(reply.code).toHaveBeenCalledWith(400);
        expect(response).toEqual({ error: "invalid-session-organization-order" });
        expect(txSessionOrganizationOrderEntryDeleteMany).not.toHaveBeenCalled();
        expect(txSessionOrganizationOrderEntryUpsert).not.toHaveBeenCalled();
        expect(markAccountChanged).not.toHaveBeenCalled();
    });

    it("rejects generic order entries for missing folders and tags before writing order state", async () => {
        txSessionOrganizationFolderFindMany.mockResolvedValue([{ id: "folder-1" }]);
        txSessionOrganizationTagFindMany.mockResolvedValue([{
            id: "tag-1",
            tagKey: "legacy/tag/1",
            archivedAt: null,
        }]);
        txSessionOrganizationOrderEntryFindMany.mockResolvedValue([]);

        const route = await createSessionRouteTestBuilder("PUT", "/v2/session-organization/order");
        const { response, reply } = await route.invoke({
            body: {
                scopeKind: "group",
                scopeKey: "root",
                entries: [
                    { itemKind: "folder", itemKey: "folder-1", sortKey: "a" },
                    { itemKind: "folder", itemKey: "archived-folder", sortKey: "b" },
                    { itemKind: "tag", itemKey: "tag-1", sortKey: "c" },
                    { itemKind: "tag", itemKey: "archived-tag", sortKey: "d" },
                ],
            },
        });

        expect(reply.code).toHaveBeenCalledWith(400);
        expect(response).toEqual({ error: "invalid-session-organization-order" });
        expect(txSessionOrganizationFolderFindMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { accountId: "u1", id: { in: ["folder-1", "archived-folder"] }, archivedAt: null },
            select: { id: true },
        }));
        expect(txSessionOrganizationTagFindMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { accountId: "u1", id: { in: ["tag-1", "archived-tag"] }, archivedAt: null },
            select: { id: true },
        }));
        expect(txSessionOrganizationOrderEntryUpsert).not.toHaveBeenCalled();
        expect(markAccountChanged).not.toHaveBeenCalled();
    });

    it("reorders pins by updating the canonical pin sort keys consumed by v2 session bootstrap", async () => {
        txSessionFindMany.mockResolvedValue([{ id: "s1" }, { id: "s2" }]);
        txSessionPinUpsert
            .mockResolvedValueOnce({ sessionId: "s2", sortKey: "a", pinnedAt: organizationDate(2_000) })
            .mockResolvedValueOnce({ sessionId: "s1", sortKey: "b", pinnedAt: organizationDate(1_000) });

        const reorderRoute = await createSessionRouteTestBuilder("POST", "/v2/session-organization/pins/reorder");
        await reorderRoute.invoke({
            body: {
                scopeKind: "pinned",
                scopeKey: "root",
                entries: [
                    { itemKind: "session", itemKey: "s2", sortKey: "a" },
                    { itemKind: "session", itemKey: "s1", sortKey: "b" },
                ],
            },
        });

        expect(txSessionPinUpsert).toHaveBeenNthCalledWith(1, expect.objectContaining({
            where: { accountId_sessionId: { accountId: "u1", sessionId: "s2" } },
            create: expect.objectContaining({ accountId: "u1", sessionId: "s2", sortKey: "a" }),
            update: { sortKey: "a" },
        }));
        expect(txSessionPinUpsert).toHaveBeenNthCalledWith(2, expect.objectContaining({
            where: { accountId_sessionId: { accountId: "u1", sessionId: "s1" } },
            create: expect.objectContaining({ accountId: "u1", sessionId: "s1", sortKey: "b" }),
            update: { sortKey: "b" },
        }));
        expect(txSessionOrganizationOrderEntryUpsert).not.toHaveBeenCalled();

        sessionPinFindMany.mockResolvedValue([
            { sessionId: "s2", sortKey: "a", pinnedAt: organizationDate(2_000) },
            { sessionId: "s1", sortKey: "b", pinnedAt: organizationDate(1_000) },
        ]);
        sessionFindMany.mockResolvedValue([pagedSessionRow("s1"), pagedSessionRow("s2")]);

        const listRoute = await createSessionRouteTestBuilder("GET", "/v2/sessions");
        const { response } = await listRoute.invoke({ query: { limit: 10 } });

        expect((response as { sessions: Array<{ id: string }> }).sessions.map((session) => session.id)).toEqual(["s2", "s1"]);
        expect(sessionPinFindMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                accountId: "u1",
                session: expect.objectContaining({
                    OR: expectedV2SessionVisibilityBranches(),
                }),
            }),
            orderBy: [{ sortKey: "asc" }, { pinnedAt: "asc" }],
        }));
    });

    it("rejects reordering pins for an invisible session before writing pin state", async () => {
        txSessionFindMany.mockResolvedValue([{ id: "visible" }]);

        const route = await createSessionRouteTestBuilder("POST", "/v2/session-organization/pins/reorder");
        const { response, reply } = await route.invoke({
            body: {
                scopeKind: "pinned",
                scopeKey: "root",
                entries: [
                    { itemKind: "session", itemKey: "visible", sortKey: "a" },
                    { itemKind: "session", itemKey: "hidden", sortKey: "b" },
                ],
            },
        });

        expect(reply.code).toHaveBeenCalledWith(400);
        expect(response).toEqual({ error: "invalid-session-organization-order" });
        expect(txSessionFindMany).toHaveBeenCalledWith({
            where: expect.objectContaining({
                id: { in: ["visible", "hidden"] },
                archivedAt: null,
                OR: expectedV2SessionVisibilityBranches(),
            }),
            select: { id: true },
        });
        expect(txSessionPinUpsert).not.toHaveBeenCalled();
        expect(markAccountChanged).not.toHaveBeenCalled();
    });

    it("rejects pin reorder requests that would exceed the product maximum", async () => {
        txSessionFindMany.mockResolvedValue([{ id: "new-pin" }]);
        txSessionPinCount.mockResolvedValue(SESSION_ORGANIZATION_MAX_PINNED_SESSIONS);
        txSessionPinFindMany.mockResolvedValue([]);

        const route = await createSessionRouteTestBuilder("POST", "/v2/session-organization/pins/reorder");
        const { response, reply } = await route.invoke({
            body: {
                scopeKind: "pinned",
                scopeKey: "root",
                entries: [
                    { itemKind: "session", itemKey: "new-pin", sortKey: "a" },
                ],
            },
        });

        expect(reply.code).toHaveBeenCalledWith(409);
        expect(response).toEqual({ error: "session-pin-limit-exceeded" });
        expect(txSessionPinCount).toHaveBeenCalledWith({
            where: {
                accountId: "u1",
                session: expect.objectContaining({
                    archivedAt: null,
                    OR: expectedV2SessionVisibilityBranches(),
                }),
            },
        });
        expect(txSessionPinUpsert).not.toHaveBeenCalled();
        expect(markAccountChanged).not.toHaveBeenCalled();
    });

    it("upserts tag definitions without parsing private display content", async () => {
        txSessionOrganizationTagUpsert.mockResolvedValue({
            id: "tag-1",
            tagKey: "tag:key",
            sortKey: "tag-sort",
            displayDbValue: JSON.stringify(encryptedDisplay),
            archivedAt: null,
            createdAt: organizationDate(5_000),
            updatedAt: organizationDate(6_000),
        });

        const route = await createSessionRouteTestBuilder("POST", "/v2/session-organization/tags");
        const { response } = await route.invoke({
            body: {
                tagId: "tag-1",
                tagKey: "tag:key",
                sortKey: "tag-sort",
                display: encryptedDisplay,
            },
        });

        expect(response).toEqual({
            tag: {
                tagId: "tag-1",
                tagKey: "tag:key",
                sortKey: "tag-sort",
                display: encryptedDisplay,
                archivedAt: null,
                createdAt: 5_000,
                updatedAt: 6_000,
            },
        });
        expect(txSessionOrganizationTagUpsert).toHaveBeenCalledWith(expect.objectContaining({
            create: expect.objectContaining({
                tagKey: "tag:key",
                displayDbValue: JSON.stringify(encryptedDisplay),
            }),
            update: expect.objectContaining({
                displayDbValue: JSON.stringify(encryptedDisplay),
                archivedAt: null,
            }),
        }));
    });

    it("rejects plaintext tag display for e2ee accounts", async () => {
        txSessionOrganizationTagUpsert.mockResolvedValue({
            id: "tag-1",
            tagKey: "tag:key",
            sortKey: "tag-sort",
            displayDbValue: JSON.stringify(plainDisplay),
            archivedAt: null,
            createdAt: organizationDate(5_000),
            updatedAt: organizationDate(6_000),
        });

        const route = await createSessionRouteTestBuilder("POST", "/v2/session-organization/tags");
        const { response, reply } = await route.invoke({
            body: {
                tagId: "tag-1",
                tagKey: "tag:key",
                sortKey: "tag-sort",
                display: plainDisplay,
            },
        });

        expect(reply.code).toHaveBeenCalledWith(400);
        expect(response).toEqual({ error: "invalid-session-organization-tag" });
        expect(txSessionOrganizationTagUpsert).not.toHaveBeenCalled();
    });

    it("rejects an omitted plaintext tag display value before mutation", async () => {
        const plainAccount = {
            encryptionMode: "plain" as const,
            publicKey: null,
            contentPublicKey: null,
            contentPublicKeySig: null,
        };
        accountFindUnique.mockResolvedValue(plainAccount);
        txAccountFindUnique.mockResolvedValue(plainAccount);

        const route = await createSessionRouteTestBuilder("POST", "/v2/session-organization/tags");
        const { response, reply } = await route.invoke({
            body: {
                tagId: "tag-1",
                tagKey: "tag:key",
                sortKey: "tag-sort",
                display: { t: "plain" },
            },
        });

        expect(reply.code).toHaveBeenCalledWith(400);
        expect(response).toEqual({ error: "invalid-session-organization-tag" });
        expect(txSessionOrganizationTagUpsert).not.toHaveBeenCalled();
        expect(markAccountChanged).not.toHaveBeenCalled();
    });

    it("enforces the product maximum when creating a new tag", async () => {
        txSessionOrganizationTagFindMany.mockResolvedValue([]);
        txSessionOrganizationTagCount.mockResolvedValue(SESSION_ORGANIZATION_MAX_TAGS);

        const route = await createSessionRouteTestBuilder("POST", "/v2/session-organization/tags");
        const { response, reply } = await route.invoke({
            body: {
                tagKey: "tag:overflow",
                sortKey: null,
                display: encryptedDisplay,
            },
        });

        expect(reply.code).toHaveBeenCalledWith(409);
        expect(response).toEqual({ error: "session-organization-tag-limit-exceeded" });
        expect(txSessionOrganizationTagUpsert).not.toHaveBeenCalled();
        expect(markAccountChanged).not.toHaveBeenCalled();
    });

    it("archives a deleted tag and removes its assignments", async () => {
        txSessionOrganizationTagDeleteMany.mockResolvedValue({ count: 0 });
        txSessionOrganizationTagUpdateMany.mockResolvedValue({ count: 1 });
        txSessionTagAssignmentDeleteMany.mockResolvedValue({ count: 4 });

        const route = await createSessionRouteTestBuilder("DELETE", "/v2/session-organization/tags/:tagId");
        const { response } = await route.invoke({
            params: { tagId: "tag-1" },
            body: { tagId: "tag-1" },
        });

        expect(response).toEqual({ tagId: "tag-1", removedAssignmentCount: 4 });
        expect(txSessionTagAssignmentDeleteMany).toHaveBeenCalledWith({
            where: { accountId: "u1", tagId: "tag-1" },
        });
        expect(txSessionOrganizationTagUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { accountId: "u1", id: "tag-1" },
            data: expect.objectContaining({ archivedAt: expect.any(Date) }),
        }));
        expect(markAccountChanged).toHaveBeenCalledWith(expect.anything(), {
            accountId: "u1",
            kind: "account",
            entityId: "session-organization",
            hint: { sessionOrganization: true, scope: "tags", tagIds: ["tag-1"] },
        });
        expect(markAccountChanged).toHaveBeenCalledWith(expect.anything(), {
            accountId: "u1",
            kind: "account",
            entityId: "session-organization",
            hint: { sessionOrganization: true, scope: "tagAssignments", tagIds: ["tag-1"] },
        });
    });

    it("sets tag assignments for a visible session", async () => {
        sessionFindFirst.mockResolvedValue({ id: "s1" });
        txSessionOrganizationTagFindMany.mockResolvedValue([
            { id: "tag-1" },
            { id: "tag-2" },
        ]);
        txSessionTagAssignmentCreateMany.mockImplementation(rejectPrismaSkipDuplicates);
        txSessionTagAssignmentFindMany.mockResolvedValue([
            { sessionId: "s1", tagId: "tag-1" },
            { sessionId: "s1", tagId: "tag-2" },
        ]);

        const route = await createSessionRouteTestBuilder("PUT", "/v2/session-organization/tag-assignments/:sessionId");
        const { response } = await route.invoke({
            params: { sessionId: "s1" },
            body: { tagIds: ["tag-1", "tag-2"] },
        });

        expect(response).toEqual({ sessionId: "s1", tagIds: ["tag-1", "tag-2"] });
        expect(txSessionTagAssignmentDeleteMany).toHaveBeenCalledWith({
            where: { accountId: "u1", sessionId: "s1" },
        });
        expect(txSessionTagAssignmentCreateMany).toHaveBeenCalledWith({
            data: [
                { accountId: "u1", sessionId: "s1", tagId: "tag-1" },
                { accountId: "u1", sessionId: "s1", tagId: "tag-2" },
            ],
        });
        expect(markAccountChanged).toHaveBeenCalledWith(expect.anything(), {
            accountId: "u1",
            kind: "account",
            entityId: "session-organization",
            hint: { sessionOrganization: true, scope: "tagAssignments", sessionIds: ["s1"], tagIds: ["tag-1", "tag-2"] },
        });
    });

    it("upserts workspace labels without parsing private display content", async () => {
        txSessionOrganizationLabelUpsert.mockResolvedValue({
            labelKind: "workspace",
            scopeKey: "server_1:/private/project",
            displayDbValue: JSON.stringify(encryptedDisplay),
            archivedAt: null,
            createdAt: organizationDate(7_000),
            updatedAt: organizationDate(8_000),
        });

        const route = await createSessionRouteTestBuilder("POST", "/v2/session-organization/labels");
        const { response } = await route.invoke({
            body: {
                labelKind: "workspace",
                scopeKey: "server_1:/private/project",
                display: encryptedDisplay,
            },
        });

        expect(response).toEqual({
            label: {
                labelKind: "workspace",
                scopeKey: "server_1:/private/project",
                display: encryptedDisplay,
                archivedAt: null,
                createdAt: 7_000,
                updatedAt: 8_000,
            },
        });
        expect(txSessionOrganizationLabelUpsert).toHaveBeenCalledWith(expect.objectContaining({
            create: expect.objectContaining({
                accountId: "u1",
                labelKind: "workspace",
                scopeKey: "server_1:/private/project",
                displayDbValue: JSON.stringify(encryptedDisplay),
            }),
            update: expect.objectContaining({
                scopeKey: "server_1:/private/project",
                displayDbValue: JSON.stringify(encryptedDisplay),
                archivedAt: null,
            }),
        }));
        expect(markAccountChanged).toHaveBeenCalledWith(expect.anything(), {
            accountId: "u1",
            kind: "account",
            entityId: "session-organization",
            hint: { sessionOrganization: true, scope: "labels", scopeKeys: ["server_1:/private/project"] },
        });
    });

    it("rejects plaintext label display for e2ee accounts", async () => {
        txSessionOrganizationLabelUpsert.mockResolvedValue({
            labelKind: "workspace",
            scopeKey: "server_1:/private/project",
            displayDbValue: JSON.stringify(plainDisplay),
            archivedAt: null,
            createdAt: organizationDate(7_000),
            updatedAt: organizationDate(8_000),
        });

        const route = await createSessionRouteTestBuilder("POST", "/v2/session-organization/labels");
        const { response, reply } = await route.invoke({
            body: {
                labelKind: "workspace",
                scopeKey: "server_1:/private/project",
                display: plainDisplay,
            },
        });

        expect(reply.code).toHaveBeenCalledWith(400);
        expect(response).toEqual({ error: "invalid-session-organization-label" });
        expect(txSessionOrganizationLabelUpsert).not.toHaveBeenCalled();
    });

    it("enforces the product maximum when creating a new label", async () => {
        txSessionOrganizationLabelFindMany.mockResolvedValue([]);
        txSessionOrganizationLabelCount.mockResolvedValue(SESSION_ORGANIZATION_MAX_LABELS);

        const route = await createSessionRouteTestBuilder("POST", "/v2/session-organization/labels");
        const { response, reply } = await route.invoke({
            body: {
                labelKind: "workspace",
                scopeKey: "server_1:/private/overflow",
                display: encryptedDisplay,
            },
        });

        expect(reply.code).toHaveBeenCalledWith(409);
        expect(response).toEqual({ error: "session-organization-label-limit-exceeded" });
        expect(txSessionOrganizationLabelUpsert).not.toHaveBeenCalled();
        expect(markAccountChanged).not.toHaveBeenCalled();
    });

    it("rejects oversized label display envelopes", async () => {
        const route = await createSessionRouteTestBuilder("POST", "/v2/session-organization/labels");
        const { response, reply } = await route.invoke({
            body: {
                labelKind: "workspace",
                scopeKey: "server_1:/private/project",
                display: { t: "encrypted", c: "x".repeat(70 * 1024) },
            },
        });

        expect(reply.code).toHaveBeenCalledWith(400);
        expect(response).toEqual({ error: "invalid-session-organization-label" });
        expect(txSessionOrganizationLabelUpsert).not.toHaveBeenCalled();
    });

    it("archives labels idempotently and includes labels in the next snapshot", async () => {
        txSessionOrganizationLabelUpdateMany.mockResolvedValue({ count: 1 });
        sessionOrganizationCheckpointFindUnique.mockResolvedValue({ version: 5 });
        sessionOrganizationLabelFindMany.mockResolvedValue([
            {
                labelKind: "workspace",
                scopeKey: "server_1:/private/project",
                displayDbValue: JSON.stringify(encryptedDisplay),
                archivedAt: null,
                createdAt: organizationDate(7_000),
                updatedAt: organizationDate(8_000),
            },
        ]);

        const deleteRoute = await createSessionRouteTestBuilder("DELETE", "/v2/session-organization/labels");
        const deleteResult = await deleteRoute.invoke({
            body: {
                labelKind: "workspace",
                scopeKey: "server_1:/private/project",
            },
        });

        expect(deleteResult.response).toEqual({
            labelKind: "workspace",
            scopeKey: "server_1:/private/project",
            archived: true,
        });
        expect(txSessionOrganizationLabelUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: {
                accountId: "u1",
                labelKind: "workspace",
                scopeHash: expect.any(String),
                scopeKey: "server_1:/private/project",
                archivedAt: null,
            },
            data: expect.objectContaining({ archivedAt: expect.any(Date) }),
        }));

        const snapshotRoute = await createSessionRouteTestBuilder("GET", "/v2/session-organization");
        const snapshotResult = await snapshotRoute.invoke();
        const snapshotResponse = snapshotResult.response as {
            snapshot: {
                version: number;
                labels: unknown[];
            };
        };

        expect(snapshotResponse.snapshot.version).toBe(5);
        expect(snapshotResponse.snapshot.labels).toEqual([{
            labelKind: "workspace",
            scopeKey: "server_1:/private/project",
            display: encryptedDisplay,
            archivedAt: null,
            createdAt: 7_000,
            updatedAt: 8_000,
        }]);
    });

    it("imports legacy organization batches idempotently including workspace labels", async () => {
        txSessionFindFirst.mockResolvedValue({ id: "s1" });
        txSessionPinFindUnique.mockResolvedValue({ id: "pin-1" });
        txSessionPinUpsert.mockResolvedValue({
            sessionId: "s1",
            sortKey: "pin-a",
            pinnedAt: organizationDate(1_000),
        });
        txSessionOrganizationFolderUpsert.mockResolvedValue({
            id: "folder-1",
            folderKey: "legacy/folder/1",
            parentKey: null,
            sortKey: "folder-a",
            displayDbValue: JSON.stringify(encryptedDisplay),
            archivedAt: null,
            createdAt: organizationDate(2_000),
            updatedAt: organizationDate(3_000),
        });
        txSessionOrganizationTagUpsert.mockResolvedValue({
            id: "tag-1",
            tagKey: "legacy/tag/1",
            sortKey: "tag-a",
            displayDbValue: JSON.stringify(encryptedDisplay),
            archivedAt: null,
            createdAt: organizationDate(4_000),
            updatedAt: organizationDate(5_000),
        });
        txSessionOrganizationTagFindMany.mockResolvedValue([{
            id: "tag-1",
            tagKey: "legacy/tag/1",
            archivedAt: null,
        }]);
        txSessionTagAssignmentDeleteMany.mockResolvedValue({ count: 0 });
        txSessionTagAssignmentCreateMany.mockImplementation(async (args: unknown) => {
            await rejectPrismaSkipDuplicates(args);
            return { count: 1 };
        });
        txSessionTagAssignmentFindMany.mockResolvedValue([{ sessionId: "s1", tagId: "tag-1" }]);
        txSessionOrganizationOrderEntryFindMany.mockResolvedValue([
            { scopeKind: "workspace", scopeKey: "server_1", itemKind: "workspace", itemKey: "server_1:/private/project", sortKey: "workspace-a" },
        ]);
        txSessionOrganizationOrderEntryUpsert.mockResolvedValue({
            scopeKind: "workspace",
            scopeKey: "server_1",
            itemKind: "workspace",
            itemKey: "server_1:/private/project",
            sortKey: "workspace-a",
        });
        txSessionOrganizationLabelUpsert.mockResolvedValue({
            labelKind: "workspace",
            scopeKey: "server_1:/private/project",
            displayDbValue: JSON.stringify(encryptedDisplay),
            archivedAt: null,
            createdAt: organizationDate(7_000),
            updatedAt: organizationDate(8_000),
        });

        const route = await createSessionRouteTestBuilder("POST", "/v2/session-organization/import");
        const { response } = await route.invoke({
            body: {
                pins: [{ sessionId: "s1", sortKey: "pin-a" }],
                folders: [{
                    folderId: "folder-1",
                    folderKey: "legacy/folder/1",
                    parentFolderId: null,
                    parentFolderKey: null,
                    sortKey: "folder-a",
                    display: encryptedDisplay,
                }],
                tags: [{
                    tagId: "tag-1",
                    tagKey: "legacy/tag/1",
                    sortKey: "tag-a",
                    display: encryptedDisplay,
                }],
                tagAssignments: [{ sessionId: "s1", tagIds: ["tag-1"] }],
                orderEntries: [{
                    scopeKind: "workspace",
                    scopeKey: "server_1",
                    itemKind: "workspace",
                    itemKey: "server_1:/private/project",
                    sortKey: "workspace-a",
                }],
                labels: [{
                    labelKind: "workspace",
                    scopeKey: "server_1:/private/project",
                    display: encryptedDisplay,
                }],
            },
        });

        expect(response).toEqual({
            imported: {
                pins: 1,
                folders: 1,
                tags: 1,
                orderEntries: 1,
                labels: 1,
            },
        });
        expect(txSessionPinUpsert).toHaveBeenCalledTimes(1);
        expect(txSessionOrganizationFolderUpsert).toHaveBeenCalledTimes(1);
        expect(txSessionOrganizationTagUpsert).toHaveBeenCalledTimes(1);
        expect(txSessionTagAssignmentDeleteMany).toHaveBeenCalledWith({
            where: { accountId: "u1", sessionId: "s1" },
        });
        expect(txSessionTagAssignmentCreateMany).toHaveBeenCalledWith({
            data: [{ accountId: "u1", sessionId: "s1", tagId: "tag-1" }],
        });
        expect(txSessionOrganizationOrderEntryUpsert).toHaveBeenCalledTimes(1);
        expect(txSessionOrganizationLabelUpsert).toHaveBeenCalledTimes(1);
        expect(markAccountChanged).toHaveBeenCalledWith(expect.anything(), {
            accountId: "u1",
            kind: "account",
            entityId: "session-organization",
            hint: { sessionOrganization: true, scope: "tagAssignments", sessionIds: ["s1"], tagIds: ["tag-1"] },
        });
        expect(markAccountChanged).toHaveBeenCalledWith(expect.anything(), {
            accountId: "u1",
            kind: "account",
            entityId: "session-organization",
            hint: { sessionOrganization: true, scope: "labels", scopeKeys: ["server_1:/private/project"] },
        });
    });

    it("skips archived legacy pins without writing hidden pin state", async () => {
        txSessionFindFirst.mockResolvedValue(null);

        const route = await createSessionRouteTestBuilder("POST", "/v2/session-organization/import");
        const { response } = await route.invoke({
            body: {
                pins: [{ sessionId: "archived", sortKey: "pin-a" }],
                folders: [],
                tags: [],
                orderEntries: [],
                labels: [],
            },
        });

        expect(response).toEqual({
            imported: {
                pins: 0,
                folders: 0,
                tags: 0,
                orderEntries: 0,
                labels: 0,
            },
        });
        expect(txSessionFindFirst).toHaveBeenCalledWith({
            where: expect.objectContaining({
                id: "archived",
                archivedAt: null,
                OR: expectedV2SessionVisibilityBranches(),
            }),
            select: { id: true },
        });
        expect(txSessionPinUpsert).not.toHaveBeenCalled();
        expect(markAccountChanged).not.toHaveBeenCalled();
    });

    it("rejects plaintext display envelopes during e2ee legacy organization import before writing", async () => {
        txSessionFindFirst.mockResolvedValue({ id: "s1" });
        txSessionPinFindUnique.mockResolvedValue({ id: "pin-1" });
        txSessionPinUpsert.mockResolvedValue({
            sessionId: "s1",
            sortKey: "pin-a",
            pinnedAt: organizationDate(1_000),
        });
        txSessionOrganizationFolderUpsert.mockResolvedValue({
            id: "folder-1",
            folderKey: "legacy/folder/1",
            parentKey: null,
            sortKey: "folder-a",
            displayDbValue: JSON.stringify(plainDisplay),
            archivedAt: null,
            createdAt: organizationDate(2_000),
            updatedAt: organizationDate(3_000),
        });

        const route = await createSessionRouteTestBuilder("POST", "/v2/session-organization/import");
        const { response, reply } = await route.invoke({
            body: {
                pins: [{ sessionId: "s1", sortKey: "pin-a" }],
                folders: [{
                    folderId: "folder-1",
                    folderKey: "legacy/folder/1",
                    parentFolderId: null,
                    parentFolderKey: null,
                    sortKey: "folder-a",
                    display: plainDisplay,
                }],
                tags: [],
                orderEntries: [],
                labels: [],
            },
        });

        expect(reply.code).toHaveBeenCalledWith(400);
        expect(response).toEqual({ error: "invalid-session-organization-import" });
        expect(txSessionPinUpsert).not.toHaveBeenCalled();
        expect(txSessionOrganizationFolderUpsert).not.toHaveBeenCalled();
        expect(txSessionOrganizationTagUpsert).not.toHaveBeenCalled();
        expect(txSessionOrganizationLabelUpsert).not.toHaveBeenCalled();
    });

    it("rejects legacy organization import with a late invalid order entry before writing earlier groups", async () => {
        txSessionFindFirst.mockResolvedValue({ id: "s1" });
        txSessionPinFindUnique.mockResolvedValue({ id: "pin-1" });
        txSessionPinUpsert.mockResolvedValue({
            sessionId: "s1",
            sortKey: "pin-a",
            pinnedAt: organizationDate(1_000),
        });

        const route = await createSessionRouteTestBuilder("POST", "/v2/session-organization/import");
        const { response, reply } = await route.invoke({
            body: {
                pins: [{ sessionId: "s1", sortKey: "pin-a" }],
                folders: [],
                tags: [],
                orderEntries: [{
                    scopeKind: "pinned",
                    scopeKey: "root",
                    itemKind: "workspace",
                    itemKey: "server_1:/private/project",
                    sortKey: "pin-b",
                }],
                labels: [],
            },
        });

        expect(reply.code).toHaveBeenCalledWith(400);
        expect(response).toEqual({ error: "invalid-session-organization-import" });
        expect(txSessionPinUpsert).not.toHaveBeenCalled();
        expect(markAccountChanged).not.toHaveBeenCalled();
    });

    it("rejects legacy pinned order import when an entry is not currently visible", async () => {
        txSessionFindFirst.mockResolvedValue(null);

        const route = await createSessionRouteTestBuilder("POST", "/v2/session-organization/import");
        const { response, reply } = await route.invoke({
            body: {
                pins: [],
                folders: [],
                tags: [],
                orderEntries: [{
                    scopeKind: "pinned",
                    scopeKey: "root",
                    itemKind: "session",
                    itemKey: "hidden",
                    sortKey: "pin-a",
                }],
                labels: [],
            },
        });

        expect(reply.code).toHaveBeenCalledWith(400);
        expect(response).toEqual({ error: "invalid-session-organization-import" });
        expect(txSessionPinUpsert).not.toHaveBeenCalled();
        expect(markAccountChanged).not.toHaveBeenCalled();
    });
});
