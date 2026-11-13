import { beforeEach, describe, expect, it } from "vitest";

import {
    createSessionRouteTestBuilder,
    createSessionAccessProjectionRelations,
    resetSessionRouteMocks,
    clearSessionRuntimeActivityProjectionInTx,
    buildUpdateSessionUpdate,
    emitUpdate,
    sessionFindUnique,
    txAccountFindMany,
    txSessionFindMany,
    txSessionShareFindMany,
    txSessionFindUnique,
    txSessionUpdate,
    accountChanges,
} from "./sessionRoutes.testkit";

// Module transformation belongs to collection, outside the archive operation budget.
await import("./sessionRoutes");

describe("sessionRoutes v2 archive", () => {
    beforeEach(() => {
        resetSessionRouteMocks();
        // Database census boundary: the real access owner resolves the owner
        // and this direct admin from the fixture's current readable audience.
        txAccountFindMany.mockResolvedValue([{ id: "owner" }, { id: "u1" }]);
        txSessionFindMany.mockResolvedValue([{
            ...createSessionAccessProjectionRelations(),
            id: "s1",
            accountId: "owner",
            account: { status: "active" },
            currentStorageState: "hosted",
        }]);
        txSessionShareFindMany.mockResolvedValue([{
            sessionId: "s1",
            accountId: "u1",
        }]);
    });

    it("archives an inactive session when actor is admin", async () => {
        const now = new Date(1234);
        sessionFindUnique.mockResolvedValue({ ...createSessionAccessProjectionRelations(), id: "s1", accountId: "owner", currentStorageState: "hosted", grants: [{ principalKind: 'account', teamId: null, teamGroupId: null, effectiveAt: null, requiredByTeamPolicy: false, account: { status: 'active' }, team: null, teamGroup: null,  id: "share-u1", accountId: "u1", accessLevel: "admin", canApprovePermissions: false  }],   });
        txSessionFindUnique.mockResolvedValue({ ...createSessionAccessProjectionRelations(), id: "s1", accountId: "owner", currentStorageState: "hosted", grants: [{ principalKind: 'account', teamId: null, teamGroupId: null, effectiveAt: null, requiredByTeamPolicy: false, account: { status: 'active' }, team: null, teamGroup: null,  id: "share-u1", accountId: "u1", accessLevel: "admin", canApprovePermissions: false  }],   active: false, archivedAt: null });
        txSessionUpdate.mockResolvedValue({ id: "s1", archivedAt: now });
        clearSessionRuntimeActivityProjectionInTx.mockResolvedValue({
            ok: true,
            didWrite: true,
            projection: {
                runtimeActivityState: "unknown",
                runtimeActivityActiveCount: 0,
                runtimeActivityObservedAt: null,
                runtimeActivityRevision: 9,
            },
            recipientCursors: [],
            badgeAttentionChanged: false,
        });
        sessionFindUnique.mockResolvedValue({
            ...createSessionAccessProjectionRelations(),
            id: "s1",
            accountId: "owner",
            grants: [{ principalKind: 'account', teamId: null, teamGroupId: null, effectiveAt: null, requiredByTeamPolicy: false, account: { status: 'active' }, team: null, teamGroup: null,  id: "share-u1", accountId: "u1", accessLevel: "admin", canApprovePermissions: false  }],
            
            
            currentStorageState: "snapshot_complete",
            acceptedThroughServerSeq: 4,
            materializationPublicationId: "archive-publication-v1",
            materializedThroughSourceAt: 42_000n,
            publishedThroughServerSeq: 4,
            seq: 9,
            lastViewedSessionSeq: 9,
            latestReadyEventSeq: null,
            latestReadyEventAt: null,
            createdAt: new Date(10_000),
            updatedAt: new Date(90_000),
            meaningfulActivityAt: new Date(90_000),
            lastActiveAt: new Date(90_000),
        });

        const route = await createSessionRouteTestBuilder("POST", "/v2/sessions/:sessionId/archive");
        const { reply, response: res } = await route.invoke({ params: { sessionId: "s1" } });

        expect(reply.code).not.toHaveBeenCalledWith(403);
        expect(res).toEqual({ success: true, archivedAt: now.getTime() });
        expect(clearSessionRuntimeActivityProjectionInTx).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: "s1",
        }));
        expect(accountChanges).toMatchObject([
            { accountId: "owner", kind: "session", entityId: "s1" },
            { accountId: "u1", kind: "session", entityId: "s1" },
        ]);
        expect(buildUpdateSessionUpdate).toHaveBeenCalledWith(
            "s1",
            expect.any(Number),
            expect.any(String),
            undefined,
            undefined,
            {
                archivedAt: now.getTime(),
                runtimeActivityState: "unknown",
                runtimeActivityActiveCount: 0,
                runtimeActivityObservedAt: null,
                runtimeActivityRevision: 9,
            },
        );
        expect(emitUpdate).toHaveBeenCalledTimes(3);
        expect(emitUpdate).toHaveBeenCalledWith(expect.objectContaining({
            recipientFilter: {
                type: "all-interested-in-session",
                sessionId: "s1",
            },
        }));
        expect(emitUpdate).toHaveBeenCalledWith(expect.objectContaining({
            recipientFilter: { type: "user-machine-scoped-only" },
        }));
    });

    it("returns 409 when attempting to archive an active session", async () => {
        sessionFindUnique.mockResolvedValue({ ...createSessionAccessProjectionRelations(), id: "s1", accountId: "owner", currentStorageState: "hosted", grants: [{ principalKind: 'account', teamId: null, teamGroupId: null, effectiveAt: null, requiredByTeamPolicy: false, account: { status: 'active' }, team: null, teamGroup: null,  id: "share-u1", accountId: "u1", accessLevel: "admin", canApprovePermissions: false  }],   });
        txSessionFindUnique.mockResolvedValue({ ...createSessionAccessProjectionRelations(), id: "s1", accountId: "owner", currentStorageState: "hosted", grants: [{ principalKind: 'account', teamId: null, teamGroupId: null, effectiveAt: null, requiredByTeamPolicy: false, account: { status: 'active' }, team: null, teamGroup: null,  id: "share-u1", accountId: "u1", accessLevel: "admin", canApprovePermissions: false  }],   active: true, archivedAt: null });

        const route = await createSessionRouteTestBuilder("POST", "/v2/sessions/:sessionId/archive");
        const { reply, response: res } = await route.invoke({ params: { sessionId: "s1" } });

        expect(reply.code).toHaveBeenCalledWith(409);
        expect(res).toEqual({ error: "session-active" });
        expect(txSessionUpdate).not.toHaveBeenCalled();
    });

    it("returns 403 when actor is not admin", async () => {
        sessionFindUnique.mockResolvedValue({ ...createSessionAccessProjectionRelations(), id: "s1", accountId: "owner", currentStorageState: "hosted", grants: [{ principalKind: 'account', teamId: null, teamGroupId: null, effectiveAt: null, requiredByTeamPolicy: false, account: { status: 'active' }, team: null, teamGroup: null,  id: "share-u1", accountId: "u1", accessLevel: "edit", canApprovePermissions: false  }],   });

        const route = await createSessionRouteTestBuilder("POST", "/v2/sessions/:sessionId/archive");
        const { reply, response: res } = await route.invoke({ params: { sessionId: "s1" } });

        expect(reply.code).toHaveBeenCalledWith(403);
        expect(res).toEqual({ error: "Forbidden" });
    });

    it("unarchives an archived session when actor is admin", async () => {
        sessionFindUnique.mockResolvedValue({ ...createSessionAccessProjectionRelations(), id: "s1", accountId: "owner", currentStorageState: "hosted", grants: [{ principalKind: 'account', teamId: null, teamGroupId: null, effectiveAt: null, requiredByTeamPolicy: false, account: { status: 'active' }, team: null, teamGroup: null,  id: "share-u1", accountId: "u1", accessLevel: "admin", canApprovePermissions: false  }],   });
        txSessionFindUnique.mockResolvedValue({ ...createSessionAccessProjectionRelations(), id: "s1", accountId: "owner", currentStorageState: "hosted", grants: [{ principalKind: 'account', teamId: null, teamGroupId: null, effectiveAt: null, requiredByTeamPolicy: false, account: { status: 'active' }, team: null, teamGroup: null,  id: "share-u1", accountId: "u1", accessLevel: "admin", canApprovePermissions: false  }],   active: false, archivedAt: new Date(1) });
        txSessionUpdate.mockResolvedValue({ id: "s1", archivedAt: null });

        const route = await createSessionRouteTestBuilder("POST", "/v2/sessions/:sessionId/unarchive");
        const { response: res } = await route.invoke({ params: { sessionId: "s1" } });

        expect(res).toEqual({ success: true, archivedAt: null });
        expect(accountChanges).toMatchObject([
            { accountId: "owner", kind: "session", entityId: "s1" },
            { accountId: "u1", kind: "session", entityId: "s1" },
        ]);
        expect(buildUpdateSessionUpdate).toHaveBeenCalledWith(
            "s1",
            expect.any(Number),
            expect.any(String),
            undefined,
            undefined,
            { archivedAt: null },
        );
        expect(emitUpdate).toHaveBeenCalledTimes(3);
        expect(emitUpdate).toHaveBeenCalledWith(expect.objectContaining({
            recipientFilter: {
                type: "all-interested-in-session",
                sessionId: "s1",
            },
        }));
        expect(emitUpdate).toHaveBeenCalledWith(expect.objectContaining({
            recipientFilter: { type: "user-machine-scoped-only" },
        }));
    });
});
