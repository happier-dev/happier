import { beforeEach, describe, expect, it } from "vitest";

import {
    createSessionRouteTestBuilder,
    accountFindUnique,
    createSessionAccessProjectionRelations,
    flattenSessionWhereConjuncts,
    resetSessionRouteMocks,
    sessionFindMany,
} from "./sessionRoutes.testkit";

describe("sessionRoutes v2 archived sessions listing", () => {
    beforeEach(() => {
        resetSessionRouteMocks();
        sessionFindMany.mockReset();
    });

    it("filters to archived sessions and includes archivedAt", async () => {
        const now = new Date(1000);
        sessionFindMany
            .mockResolvedValueOnce([
                {
                    ...createSessionAccessProjectionRelations(),
                    id: "s2",
                    seq: 2,
                    accountId: "u1",
                    currentStorageState: "hosted",
                    acceptedThroughServerSeq: null,
                    materializationPublicationId: null,
                    materializedThroughSourceAt: null,
                    publishedThroughServerSeq: null,
                    encryptionMode: "e2ee",
                    createdAt: now,
                    updatedAt: now,
                    meaningfulActivityAt: now,
                    archivedAt: now,
                    metadata: "m2",
                    metadataVersion: 1,
                    agentState: null,
                    agentStateVersion: 0,
                    responsibleAccountId: null,
                    accountReadStates: [{ accountId: "u1", lastViewedSessionSeq: 2, unreadSince: null }],
                    accountFollows: [],
                    sessionPins: [],
                    sessionAttentionStandings: [],
                    dataKeyEnvelopes: [],
                    pendingCount: 0,
                    pendingBlockedCount: 0,
                    pendingVersion: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    latestTurnId: null,
                    latestTurnStatus: null,
                    latestTurnStatusObservedAt: null,
                    lastRuntimeIssue: null,
                    latestReadyEventSeq: null,
                    turns: [],
                    active: false,
                    lastActiveAt: now,
                    grants: [],
                    
                    
                },
            ])
            .mockResolvedValue([]);

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions/archived");
        const { response: res } = await route.invoke({ query: { limit: 50 } });

        expect(flattenSessionWhereConjuncts(sessionFindMany.mock.calls[0]?.[0]?.where)).toContainEqual({
            archivedAt: { not: null },
        });

        expect(res).toEqual({
            sessions: [
                expect.objectContaining({
                    id: "s2",
                    encryptionMode: "e2ee",
                    archivedAt: now.getTime(),
                }),
            ],
            nextCursor: null,
            hasNext: false,
        });
        expect(accountFindUnique).not.toHaveBeenCalled();
    });

    it("omits the unmigrated layout-zero shared archived row instead of refusing the page", async () => {
        const now = new Date(1_000);
        const row = {
            ...createSessionAccessProjectionRelations(),
            id: "legacy-shared-archived",
            seq: 1,
            currentStorageState: "hosted",
            accountId: "owner",
            encryptionMode: "plain",
            createdAt: now,
            updatedAt: now,
            meaningfulActivityAt: now,
            archivedAt: now,
            metadata: "legacy-whole-bag",
            metadataVersion: 1,
            ownerMetadata: null,
            metadataLayoutVersion: 0,
            agentState: "legacy-owner-state",
            agentStateVersion: 3,
            lastViewedSessionSeq: 0,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            pendingCount: 0,
            pendingBlockedCount: 0,
            pendingVersion: 0,
            responsibleAccountId: null,
            accountReadStates: [],
            accountFollows: [],
            sessionPins: [],
            sessionAttentionStandings: [],
            dataKeyEnvelopes: [],
            latestTurnId: null,
            latestTurnStatus: null,
            latestTurnStatusObservedAt: null,
            lastRuntimeIssue: null,
            latestReadyEventSeq: null,
            turns: [],
            active: false,
            lastActiveAt: now,
            grants: [{ principalKind: 'account', teamId: null, teamGroupId: null, effectiveAt: null, requiredByTeamPolicy: false, account: { status: 'active' }, team: null, teamGroup: null, 
                id: "legacy-shared-archived-direct",
                accountId: "u1",
                accessLevel: "view",
                canApprovePermissions: false,
             }],
            
            
        };
        sessionFindMany
            .mockResolvedValueOnce([row])
            .mockResolvedValue([]);

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions/archived");
        const { reply, response } = await route.invoke({ query: { limit: 1 } });

        // Per-row degradation: the unreadable historical share is dropped and the
        // refusal stays visible through the count, never a request-wide 409.
        expect(reply.statusCode).toBe(200);
        const payload = response as {
            sessions: ReadonlyArray<{ id: string }>;
            metadataUpgradeRequiredCount?: number;
        };
        expect(payload.sessions).toEqual([]);
        expect(payload.metadataUpgradeRequiredCount).toBe(1);
        expect(flattenSessionWhereConjuncts(sessionFindMany.mock.calls[0]?.[0]?.where)).toEqual(expect.arrayContaining([
            { archivedAt: { not: null } },
            { currentStorageState: "hosted", meaningfulActivityAt: { not: null } },
        ]));
    });
});
