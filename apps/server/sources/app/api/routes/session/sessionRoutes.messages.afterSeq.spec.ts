import { beforeEach, describe, expect, it } from "vitest";

import {
    catchupFetchesInc,
    catchupReturnedInc,
    checkSessionAccess,
    createSessionRouteTestBuilder,
    resetSessionRouteMocks,
    txSessionFindUnique as sessionFindUnique,
    txSessionMessageFindMany as sessionMessageFindMany,
    txSessionTurnFindFirst,
    txSessionTurnFindMany,
} from "./sessionRoutes.testkit";
import { createAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { registerSessionMessageRoutes } from "./registerSessionMessageRoutes";
import {
    initializeSessionTurnTranscriptAnchorProjectionProtocolActivation,
    resetSessionTurnTranscriptAnchorProjectionProtocolActivationForTests,
    SESSION_TURN_TRANSCRIPT_ANCHOR_PROJECTION_CONTRACT_MIGRATION,
    SESSION_TURN_TRANSCRIPT_ANCHOR_PROJECTION_FINAL_CONTRACT_MARKER_VALUE,
} from "@/app/session/turns/sessionTurnTranscriptAnchorProjectionProtocolContract";

describe("sessionRoutes v1 messages pagination", () => {
    beforeEach(async () => {
        resetSessionRouteMocks();
        resetSessionTurnTranscriptAnchorProjectionProtocolActivationForTests();
        await initializeSessionTurnTranscriptAnchorProjectionProtocolActivation({
            $queryRawUnsafe: async () => [{
                migration_name: SESSION_TURN_TRANSCRIPT_ANCHOR_PROJECTION_CONTRACT_MIGRATION,
            }],
            simpleCache: {
                findUnique: async () => ({
                    value: SESSION_TURN_TRANSCRIPT_ANCHOR_PROJECTION_FINAL_CONTRACT_MARKER_VALUE,
                }),
            },
            sessionTurn: { count: async () => 0 },
        });
        checkSessionAccess.mockReset();
        sessionMessageFindMany.mockReset();
        txSessionTurnFindFirst.mockClear();
        txSessionTurnFindMany.mockClear();
        catchupFetchesInc.mockReset();
        catchupReturnedInc.mockReset();
    });

    it("returns a validation 400 for an external page above its cap", async () => {
        const app = createAuthenticatedTestApp();
        registerSessionMessageRoutes(app);
        await app.ready();
        try {
            const response = await app.inject({
                method: "GET",
                url: "/v1/sessions/s1/messages?projection=externalShareableV1&limit=101",
                headers: { "x-test-user-id": "u1" },
            });

            expect(response.statusCode).toBe(400);
        } finally {
            await app.close();
        }
    });

    it("returns forward page in ascending order with nextAfterSeq when hasMore", async () => {
        checkSessionAccess.mockResolvedValue({ level: "owner" });

        const t0 = new Date(1);
        sessionMessageFindMany.mockResolvedValue([
            { id: "m3", seq: 3, localId: null, sidechainId: null, messageRole: "user", content: { t: "encrypted", c: "c3" }, deliveryResolution: { v: 1, kind: "manual_handled" }, createdAt: t0, updatedAt: t0 },
            { id: "m4", seq: 4, localId: null, sidechainId: null, messageRole: "user", content: { t: "encrypted", c: "c4" }, createdAt: t0, updatedAt: t0 },
            { id: "m5", seq: 5, localId: null, sidechainId: null, messageRole: "user", content: { t: "encrypted", c: "c5" }, createdAt: t0, updatedAt: t0 },
        ]);

        const route = await createSessionRouteTestBuilder("GET", "/v1/sessions/:sessionId/messages");
        const { response: res } = await route.invoke({
            params: { sessionId: "s1" },
            query: { afterSeq: 2, limit: 2, role: "user" },
        });

        expect(catchupFetchesInc).toHaveBeenCalledWith({ type: "session-messages-afterSeq" });
        expect(catchupReturnedInc).toHaveBeenCalledWith({ type: "session-messages-afterSeq" }, 2);

        expect(sessionMessageFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    sessionId: "s1",
                    sidechainId: null,
                    OR: [{ messageRole: "user" }, { messageRole: null }],
                    seq: { gt: 2 },
                }),
                orderBy: { seq: "asc" },
                take: 3,
            }),
        );

        expect(res).toEqual({
            messages: [
                { id: "m3", seq: 3, content: { t: "encrypted", c: "c3" }, messageActionReference: { v: 1, sessionId: "s1", messageId: "m3", observedRevision: "message-updated-at:1" }, localId: null, messageRole: "user", deliveryResolution: { v: 1, kind: "manual_handled" }, createdAt: 1, updatedAt: 1 },
                { id: "m4", seq: 4, content: { t: "encrypted", c: "c4" }, messageActionReference: { v: 1, sessionId: "s1", messageId: "m4", observedRevision: "message-updated-at:1" }, localId: null, messageRole: "user", createdAt: 1, updatedAt: 1 },
            ],
            hasMore: true,
            nextBeforeSeq: null,
            nextAfterSeq: 4,
        });
    });

    it("fails the complete forward page when an authoritative stored-content row is malformed", async () => {
        checkSessionAccess.mockResolvedValue({ level: "owner" });

        const t0 = new Date(1);
        sessionMessageFindMany.mockResolvedValue([
            { id: "m3", seq: 3, localId: null, sidechainId: null, content: { t: "encrypted", c: "c3" }, createdAt: t0, updatedAt: t0 },
            { id: "m4", seq: 4, localId: null, sidechainId: null, content: { t: "future", value: "unreadable" }, createdAt: t0, updatedAt: t0 },
            { id: "m5", seq: 5, localId: null, sidechainId: null, content: { t: "encrypted", c: "c5" }, createdAt: t0, updatedAt: t0 },
        ]);

        const route = await createSessionRouteTestBuilder("GET", "/v1/sessions/:sessionId/messages");
        const { reply, response } = await route.invoke({
            params: { sessionId: "s1" },
            query: { afterSeq: 2, limit: 2 },
        });

        expect(reply.code).toHaveBeenCalledWith(503);
        expect(response).toEqual({ error: "session_transcript_stored_content_unavailable" });
        expect(catchupReturnedInc).not.toHaveBeenCalled();
    });

    it("intersects old-client pagination with the current operation's accepted sequence", async () => {
        sessionFindUnique.mockResolvedValue({
            currentStorageState: "server_partial",
            acceptedThroughServerSeq: 4,
            publishedThroughServerSeq: null,
        });
        sessionMessageFindMany.mockResolvedValue([]);

        const route = await createSessionRouteTestBuilder("GET", "/v1/sessions/:sessionId/messages");
        await route.invoke({
            params: { sessionId: "s1" },
            query: { afterSeq: 2, limit: 50 },
        });

        expect(sessionMessageFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    sessionId: "s1",
                    sidechainId: null,
                    seq: { gt: 2, lte: 4 },
                }),
            }),
        );
    });

    it("uses the canonical shareable publication fence and returns only the server-derived coarse admission actor", async () => {
        sessionFindUnique.mockResolvedValue({
            currentStorageState: "snapshot_complete",
            seq: 9,
            acceptedThroughServerSeq: 9,
            materializationPublicationId: "publication-1",
            materializedThroughSourceAt: 123n,
            publishedThroughServerSeq: 7,
        });
        const t0 = new Date(1);
        sessionMessageFindMany.mockResolvedValue([{
            id: "m7",
            seq: 7,
            localId: "local-7",
            sidechainId: null,
            messageRole: "user",
            content: { t: "plain", v: { role: "user", content: { type: "text", text: "hello" } } },
            inputAdmissionReceipt: { v: 1, issuer: "authenticatedMachine" },
            createdAt: t0,
            updatedAt: t0,
        }]);

        const route = await createSessionRouteTestBuilder("GET", "/v1/sessions/:sessionId/messages");
        const { response } = await route.invoke({
            params: { sessionId: "s1" },
            query: { afterSeq: 0, limit: 100, projection: "externalShareableV1" },
        });

        expect(sessionMessageFindMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                sessionId: "s1",
                sidechainId: null,
                seq: { gt: 0, lte: 7 },
                session: expect.objectContaining({
                    AND: expect.arrayContaining([
                        expect.objectContaining({ OR: expect.any(Array) }),
                    ]),
                }),
            }),
            select: expect.objectContaining({ inputAdmissionReceipt: true }),
        }));
        expect(response).toMatchObject({
            messages: [{
                id: "m7",
                externalShareableActor: "machine",
            }],
            publicationBlocked: true,
        });
        expect(response).not.toHaveProperty("messages.0.inputAdmissionReceipt");
    });

    it("defaults external-shareable pages to their bounded cap without changing the legacy default", async () => {
        sessionMessageFindMany.mockResolvedValue([]);

        const route = await createSessionRouteTestBuilder("GET", "/v1/sessions/:sessionId/messages");
        await route.invoke({
            params: { sessionId: "s1" },
            query: { afterSeq: 0, projection: "externalShareableV1" },
        });

        expect(sessionMessageFindMany).toHaveBeenLastCalledWith(expect.objectContaining({
            take: 101,
        }));

        await route.invoke({
            params: { sessionId: "s1" },
            query: { afterSeq: 0 },
        });

        expect(sessionMessageFindMany).toHaveBeenLastCalledWith(expect.objectContaining({
            take: 151,
        }));
    });

    it("returns the coarse machine actor only for history-observed user rows without exposing an input receipt", async () => {
        sessionFindUnique.mockResolvedValue({
            currentStorageState: "snapshot_complete",
            seq: 2,
            acceptedThroughServerSeq: null,
            materializationPublicationId: "publication-1",
            materializedThroughSourceAt: 123n,
            publishedThroughServerSeq: 2,
        });
        const t0 = new Date(1);
        sessionMessageFindMany.mockResolvedValue([
            {
                id: "history-user",
                seq: 1,
                localId: "history-user",
                sidechainId: null,
                messageRole: "user",
                content: { t: "encrypted", c: "historical-ciphertext" },
                transcriptObservationProvenance: { kind: "non_dependent", source: "history" },
                inputAdmissionReceipt: null,
                createdAt: t0,
                updatedAt: t0,
            },
            {
                id: "ordinary-user",
                seq: 2,
                localId: "ordinary-user",
                sidechainId: null,
                messageRole: "user",
                content: { t: "encrypted", c: "ordinary-ciphertext" },
                transcriptObservationProvenance: { kind: "non_dependent", source: "external" },
                inputAdmissionReceipt: null,
                createdAt: t0,
                updatedAt: t0,
            },
        ]);

        const route = await createSessionRouteTestBuilder("GET", "/v1/sessions/:sessionId/messages");
        const { response } = await route.invoke({
            params: { sessionId: "s1" },
            query: { afterSeq: 0, limit: 100, projection: "externalShareableV1" },
        });

        expect(response).toEqual(expect.objectContaining({
            messages: [
                expect.objectContaining({
                    id: "history-user",
                    externalShareableActor: "machine",
                    transcriptObservationProvenance: { kind: "non_dependent", source: "history" },
                }),
                expect.objectContaining({
                    id: "ordinary-user",
                    transcriptObservationProvenance: { kind: "non_dependent", source: "external" },
                }),
            ],
        }));
        expect(response).not.toHaveProperty("messages.0.inputAdmissionReceipt");
        expect(response).not.toHaveProperty("messages.1.externalShareableActor");
    });

    it("does not let an unpublished row produce an external cursor", async () => {
        sessionFindUnique.mockResolvedValue({
            currentStorageState: "server_partial",
            acceptedThroughServerSeq: 4,
            publishedThroughServerSeq: null,
        });
        sessionMessageFindMany.mockResolvedValue([]);

        const route = await createSessionRouteTestBuilder("GET", "/v1/sessions/:sessionId/messages");
        const { response } = await route.invoke({
            params: { sessionId: "s1" },
            query: { afterSeq: 0, limit: 100, projection: "externalShareableV1" },
        });

        expect(response).toEqual({
            messages: [],
            hasMore: true,
            nextBeforeSeq: null,
            nextAfterSeq: null,
            publicationBlocked: true,
            externalShareableSnapshot: { turns: [] },
        });
    });

    it("returns the same-transaction hidden-turn barrier before a later-publishable user row", async () => {
        sessionFindUnique.mockResolvedValue({
            currentStorageState: "snapshot_complete",
            seq: 9,
            acceptedThroughServerSeq: 9,
            materializationPublicationId: "publication-1",
            materializedThroughSourceAt: 123n,
            publishedThroughServerSeq: 7,
        });
        const t0 = new Date(1);
        sessionMessageFindMany.mockResolvedValue([{
            id: "m7",
            seq: 7,
            localId: "local-7",
            sidechainId: null,
            messageRole: "user",
            content: { t: "encrypted", c: "c7" },
            inputAdmissionReceipt: null,
            createdAt: t0,
            updatedAt: t0,
        }]);
        txSessionTurnFindMany.mockResolvedValue([{
            turnId: "turn-7",
            status: "completed",
            startedAt: 1n,
            updatedAt: 2n,
            terminalAt: 2n,
            lastRuntimeIssueJson: null,
            transcriptAnchorsJson: JSON.stringify({
                startUserMessageSeq: 7,
                userMessageSeqs: [7],
                startSeqInclusive: 7,
                endSeqInclusive: 9,
                finalAssistantMessageSeq: 9,
            }),
            transcriptAnchorProjectionVersion: 1,
            transcriptAnchorMinSeq: 7,
            transcriptAnchorMaxSeq: 9,
            rollbackState: null,
        }]);

        const route = await createSessionRouteTestBuilder("GET", "/v1/sessions/:sessionId/messages");
        const { response } = await route.invoke({
            params: { sessionId: "s1" },
            query: { afterSeq: 0, limit: 100, projection: "externalShareableV1" },
        });

        expect(response).toMatchObject({
            messages: [expect.objectContaining({ id: "m7", seq: 7 })],
            publicationBlocked: true,
            externalShareableSnapshot: {
                turns: [],
                publicationBlockedFromSeq: 7,
            },
        });
        expect(txSessionTurnFindFirst).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                sessionId: "s1",
                transcriptAnchorProjectionVersion: 0,
            }),
        }));
        expect(txSessionTurnFindMany).toHaveBeenCalledTimes(1);
        expect(txSessionTurnFindMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                sessionId: "s1",
                transcriptAnchorProjectionVersion: 1,
                OR: expect.arrayContaining([
                    expect.objectContaining({
                        transcriptAnchorMinSeq: { lte: 7 },
                        transcriptAnchorMaxSeq: { gte: 7 },
                    }),
                ]),
            }),
            take: 101,
        }));
    });

    it("holds the external cursor at a committed admitted input until its turn is durably witnessed", async () => {
        sessionFindUnique.mockResolvedValue({
            currentStorageState: "snapshot_complete",
            seq: 7,
            acceptedThroughServerSeq: 7,
            materializationPublicationId: "publication-1",
            materializedThroughSourceAt: 123n,
            publishedThroughServerSeq: 7,
        });
        const t0 = new Date(1);
        sessionMessageFindMany.mockResolvedValue([{
            id: "m7",
            seq: 7,
            localId: "local-7",
            sidechainId: null,
            messageRole: "user",
            content: { t: "encrypted", c: "c7" },
            inputAdmissionReceipt: { v: 1, issuer: "authenticatedMachine" },
            deliveryResolution: null,
            createdAt: t0,
            updatedAt: t0,
        }]);
        txSessionTurnFindMany.mockResolvedValue([]);

        const route = await createSessionRouteTestBuilder("GET", "/v1/sessions/:sessionId/messages");
        const { response } = await route.invoke({
            params: { sessionId: "s1" },
            query: { afterSeq: 0, limit: 100, projection: "externalShareableV1" },
        });

        expect(response).toMatchObject({
            messages: [expect.objectContaining({ id: "m7", seq: 7 })],
            hasMore: true,
            externalShareableSnapshot: {
                turns: [],
                turnSettlementBlockedFromSeq: 7,
            },
        });
    });

    it("holds the external cursor while the matching active turn has not persisted anchors", async () => {
        sessionFindUnique.mockResolvedValue({
            currentStorageState: "snapshot_complete",
            seq: 7,
            acceptedThroughServerSeq: 7,
            materializationPublicationId: "publication-1",
            materializedThroughSourceAt: 123n,
            publishedThroughServerSeq: 7,
        });
        const t0 = new Date(1);
        sessionMessageFindMany.mockResolvedValue([{
            id: "m7",
            seq: 7,
            localId: "local-7",
            sidechainId: null,
            messageRole: "user",
            content: { t: "encrypted", c: "c7" },
            inputAdmissionReceipt: { v: 1, issuer: "authenticatedMachine" },
            deliveryResolution: null,
            createdAt: t0,
            updatedAt: t0,
        }]);
        txSessionTurnFindMany.mockResolvedValue([{
            turnId: "turn-7",
            status: "in_progress",
            startedAt: 1n,
            updatedAt: 2n,
            terminalAt: null,
            lastRuntimeIssueJson: null,
            transcriptAnchorsJson: null,
            transcriptAnchorProjectionVersion: 1,
            transcriptAnchorMinSeq: null,
            transcriptAnchorMaxSeq: null,
            rollbackState: null,
        }]);

        const route = await createSessionRouteTestBuilder("GET", "/v1/sessions/:sessionId/messages");
        const { response } = await route.invoke({
            params: { sessionId: "s1" },
            query: { afterSeq: 0, limit: 100, projection: "externalShareableV1" },
        });

        expect(response).toMatchObject({
            messages: [expect.objectContaining({ id: "m7", seq: 7 })],
            hasMore: true,
            externalShareableSnapshot: {
                turns: [],
                turnSettlementBlockedFromSeq: 7,
            },
        });
    });

    it("re-blocks an otherwise active external cursor when a legacy v0 turn projection reappears", async () => {
        sessionFindUnique.mockResolvedValue({
            currentStorageState: "snapshot_complete",
            seq: 7,
            acceptedThroughServerSeq: 7,
            materializationPublicationId: "publication-1",
            materializedThroughSourceAt: 123n,
            publishedThroughServerSeq: 7,
        });
        const t0 = new Date(1);
        sessionMessageFindMany.mockResolvedValue([{
            id: "m7",
            seq: 7,
            localId: "local-7",
            sidechainId: null,
            messageRole: "user",
            content: { t: "encrypted", c: "c7" },
            inputAdmissionReceipt: { v: 1, issuer: "authenticatedMachine" },
            deliveryResolution: { v: 1, kind: "manual_handled" },
            createdAt: t0,
            updatedAt: t0,
        }]);
        txSessionTurnFindFirst.mockResolvedValue({
            id: "legacy-turn-row",
            transcriptAnchorProjectionVersion: 0,
        });
        txSessionTurnFindMany.mockResolvedValue([]);

        const route = await createSessionRouteTestBuilder("GET", "/v1/sessions/:sessionId/messages");
        const { response } = await route.invoke({
            params: { sessionId: "s1" },
            query: { afterSeq: 0, limit: 100, projection: "externalShareableV1" },
        });

        expect(response).toMatchObject({
            messages: [expect.objectContaining({ id: "m7", seq: 7 })],
            hasMore: true,
            externalShareableSnapshot: {
                turns: [],
                turnSettlementBlockedFromSeq: 7,
            },
        });
        expect(txSessionTurnFindFirst).toHaveBeenCalledTimes(1);
    });

    it("advances past a durably manual-handled input without a turn after the historical v0 rows are backfilled", async () => {
        sessionFindUnique.mockResolvedValue({
            currentStorageState: "snapshot_complete",
            seq: 7,
            acceptedThroughServerSeq: 7,
            materializationPublicationId: "publication-1",
            materializedThroughSourceAt: 123n,
            publishedThroughServerSeq: 7,
        });
        const t0 = new Date(1);
        sessionMessageFindMany.mockResolvedValue([{
            id: "m7",
            seq: 7,
            localId: "local-7",
            sidechainId: null,
            messageRole: "user",
            content: { t: "encrypted", c: "c7" },
            inputAdmissionReceipt: { v: 1, issuer: "authenticatedMachine" },
            deliveryResolution: { v: 1, kind: "manual_handled" },
            createdAt: t0,
            updatedAt: t0,
        }]);
        txSessionTurnFindMany.mockResolvedValue([]);

        const route = await createSessionRouteTestBuilder("GET", "/v1/sessions/:sessionId/messages");
        const { response } = await route.invoke({
            params: { sessionId: "s1" },
            query: { afterSeq: 0, limit: 100, projection: "externalShareableV1" },
        });

        expect(response).toMatchObject({
            messages: [expect.objectContaining({ id: "m7", seq: 7 })],
            hasMore: false,
            externalShareableSnapshot: { turns: [] },
        });
        expect(response).not.toHaveProperty("externalShareableSnapshot.publicationBlockedFromSeq");
    });

    it("keeps an external cursor blocked when Session.seq is missing until the SessionTurn projection contract is activated", async () => {
        resetSessionTurnTranscriptAnchorProjectionProtocolActivationForTests();
        // Deliberately omit Session.seq: an incomplete complete-snapshot
        // publication tuple must fail closed at sequence zero.
        sessionFindUnique.mockResolvedValue({
            currentStorageState: "snapshot_complete",
            acceptedThroughServerSeq: 7,
            materializationPublicationId: "publication-1",
            materializedThroughSourceAt: 123n,
            publishedThroughServerSeq: 7,
        });
        const t0 = new Date(1);
        sessionMessageFindMany.mockResolvedValue([{
            id: "m7",
            seq: 7,
            localId: "local-7",
            sidechainId: null,
            messageRole: "user",
            content: { t: "encrypted", c: "c7" },
            inputAdmissionReceipt: { v: 1, issuer: "authenticatedMachine" },
            deliveryResolution: { v: 1, kind: "manual_handled" },
            createdAt: t0,
            updatedAt: t0,
        }]);

        const route = await createSessionRouteTestBuilder("GET", "/v1/sessions/:sessionId/messages");
        const { response } = await route.invoke({
            params: { sessionId: "s1" },
            query: { afterSeq: 0, limit: 100, projection: "externalShareableV1" },
        });

        expect(response).toMatchObject({
            messages: [expect.objectContaining({ id: "m7", seq: 7 })],
            publicationBlocked: true,
            hasMore: true,
            externalShareableSnapshot: {
                turns: [],
                turnSettlementBlockedFromSeq: 7,
            },
        });
    });

    it("returns exact out-of-page consumed inputs in the same transaction snapshot", async () => {
        sessionFindUnique.mockResolvedValue({ currentStorageState: "hosted" });
        const t0 = new Date(1);
        const inputReceiptActorId = "account-private-actor-id";
        const input = {
            id: "m1",
            seq: 1,
            localId: "local-1",
            sidechainId: null,
            messageRole: "user",
            content: {
                t: "plain",
                v: {
                    role: "user",
                    content: { type: "text", text: "hello" },
                    meta: {
                        happierInputAuthorityV1: {
                            v: 1,
                            producer: "pluginSession",
                            caller: {
                                kind: "plugin",
                                pluginId: "com.example.channel",
                                contributionLocalId: "channel",
                            },
                            permission: { admittedPermissionCeiling: "read-only" },
                        },
                    },
                },
            },
            inputAdmissionReceipt: {
                v: 1,
                issuer: "authenticatedAccount",
                actorAccountId: inputReceiptActorId,
                sessionRelationship: "owner",
            },
            createdAt: t0,
            updatedAt: t0,
        };
        const final = {
            id: "m102",
            seq: 102,
            localId: "local-102",
            sidechainId: null,
            messageRole: "agent",
            content: { t: "plain", v: { role: "agent", content: { type: "text", text: "final" } } },
            inputAdmissionReceipt: null,
            createdAt: t0,
            updatedAt: t0,
        };
        sessionMessageFindMany
            .mockResolvedValueOnce([final])
            .mockResolvedValueOnce([input]);
        txSessionTurnFindMany.mockResolvedValue([{
            turnId: "turn-1",
            status: "completed",
            startedAt: 1n,
            updatedAt: 102n,
            terminalAt: 102n,
            lastRuntimeIssueJson: null,
            transcriptAnchorsJson: JSON.stringify({
                startUserMessageSeq: 1,
                userMessageSeqs: [1],
                startSeqInclusive: 1,
                endSeqInclusive: 102,
                finalAssistantMessageSeq: 102,
            }),
            transcriptAnchorProjectionVersion: 1,
            transcriptAnchorMinSeq: 1,
            transcriptAnchorMaxSeq: 102,
            rollbackState: null,
        }]);

        const route = await createSessionRouteTestBuilder("GET", "/v1/sessions/:sessionId/messages");
        const { response } = await route.invoke({
            params: { sessionId: "s1" },
            query: { afterSeq: 100, limit: 100, projection: "externalShareableV1" },
        });

        expect(response).toMatchObject({
            messages: [expect.objectContaining({ id: "m102", seq: 102 })],
            externalShareableSnapshot: {
                turns: [expect.objectContaining({ turnId: "turn-1" })],
                referencedUserRows: [expect.objectContaining({ id: "m1", seq: 1, localId: "local-1" })],
            },
        });
        expect(sessionMessageFindMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
            where: expect.objectContaining({ sessionId: "s1", seq: { in: [1] } }),
        }));
        expect(JSON.stringify(response)).not.toContain(inputReceiptActorId);
        expect(JSON.stringify(response)).not.toContain("authenticatedAccount");
    });

    it("uses one bounded v1 turn snapshot and holds the cursor when that witness is full", async () => {
        sessionFindUnique.mockResolvedValue({ currentStorageState: "hosted" });
        const t0 = new Date(1);
        sessionMessageFindMany.mockResolvedValue([{
            id: "m7",
            seq: 7,
            localId: "local-7",
            sidechainId: null,
            messageRole: "user",
            content: { t: "encrypted", c: "c7" },
            inputAdmissionReceipt: { v: 1, issuer: "authenticatedMachine" },
            createdAt: t0,
            updatedAt: t0,
        }]);
        txSessionTurnFindMany.mockResolvedValue(Array.from({ length: 101 }, (_, index) => ({
            turnId: `turn-${index}`,
            status: "in_progress",
            startedAt: 1n,
            updatedAt: 2n,
            terminalAt: null,
            lastRuntimeIssueJson: null,
            transcriptAnchorsJson: JSON.stringify({
                startUserMessageSeq: 7,
                userMessageSeqs: [7],
                startSeqInclusive: 7,
                endSeqInclusive: null,
            }),
            transcriptAnchorProjectionVersion: 1,
            transcriptAnchorMinSeq: 7,
            transcriptAnchorMaxSeq: 7,
            rollbackState: null,
        })));

        const route = await createSessionRouteTestBuilder("GET", "/v1/sessions/:sessionId/messages");
        const { response } = await route.invoke({
            params: { sessionId: "s1" },
            query: { afterSeq: 6, limit: 100, projection: "externalShareableV1" },
        });

        expect(response).toMatchObject({
            hasMore: true,
            externalShareableSnapshot: {
                turnSettlementBlockedFromSeq: 7,
            },
        });
        expect(txSessionTurnFindMany).toHaveBeenCalledTimes(1);
        expect(txSessionTurnFindMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                sessionId: "s1",
                transcriptAnchorProjectionVersion: 1,
                OR: expect.arrayContaining([
                    expect.objectContaining({
                        transcriptAnchorMinSeq: { lte: 7 },
                        transcriptAnchorMaxSeq: { gte: 7 },
                    }),
                    expect.objectContaining({
                        status: "in_progress",
                    }),
                ]),
            }),
            take: 101,
        }));
    });

    it("keeps a final with an exact bounded out-of-page user witness publishable", async () => {
        sessionFindUnique.mockResolvedValue({ currentStorageState: "hosted" });
        const t0 = new Date(1);
        const userMessageSeqs = Array.from({ length: 100 }, (_, index) => index + 1);
        const final = {
            id: "m202",
            seq: 202,
            localId: "local-202",
            sidechainId: null,
            messageRole: "agent",
            content: { t: "plain", v: { role: "agent", content: { type: "text", text: "final" } } },
            inputAdmissionReceipt: null,
            createdAt: t0,
            updatedAt: t0,
        };
        const referencedUsers = userMessageSeqs.map((seq) => ({
            id: `m${seq}`,
            seq,
            localId: `local-${seq}`,
            sidechainId: null,
            messageRole: "user",
            content: { t: "encrypted", c: `c${seq}` },
            inputAdmissionReceipt: { v: 1, issuer: "authenticatedMachine" },
            createdAt: t0,
            updatedAt: t0,
        }));
        sessionMessageFindMany
            .mockResolvedValueOnce([final])
            .mockResolvedValueOnce(referencedUsers);
        txSessionTurnFindMany.mockResolvedValue([{
            turnId: "turn-1",
            status: "completed",
            startedAt: 1n,
            updatedAt: 202n,
            terminalAt: 202n,
            lastRuntimeIssueJson: null,
            transcriptAnchorsJson: JSON.stringify({
                startUserMessageSeq: 1,
                userMessageSeqs,
                startSeqInclusive: 1,
                endSeqInclusive: 202,
                finalAssistantMessageSeq: 202,
            }),
            transcriptAnchorProjectionVersion: 1,
            transcriptAnchorMinSeq: 1,
            transcriptAnchorMaxSeq: 202,
            rollbackState: null,
        }]);

        const route = await createSessionRouteTestBuilder("GET", "/v1/sessions/:sessionId/messages");
        const { response } = await route.invoke({
            params: { sessionId: "s1" },
            query: { afterSeq: 200, limit: 100, projection: "externalShareableV1" },
        });

        expect(response).toMatchObject({
            hasMore: false,
            externalShareableSnapshot: {
                referencedUserRows: expect.arrayContaining([
                    expect.objectContaining({ seq: 1, localId: "local-1" }),
                    expect.objectContaining({ seq: 100, localId: "local-100" }),
                ]),
            },
        });
        expect(sessionMessageFindMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
            where: expect.objectContaining({ sessionId: "s1", seq: { in: userMessageSeqs } }),
            take: 100,
        }));
    });

    it("does not advance through a final whose exact out-of-page user witness exceeds the bounded snapshot", async () => {
        sessionFindUnique.mockResolvedValue({ currentStorageState: "hosted" });
        const t0 = new Date(1);
        const final = {
            id: "m102",
            seq: 102,
            localId: "local-102",
            sidechainId: null,
            messageRole: "agent",
            content: { t: "plain", v: { role: "agent", content: { type: "text", text: "final" } } },
            inputAdmissionReceipt: null,
            createdAt: t0,
            updatedAt: t0,
        };
        sessionMessageFindMany.mockResolvedValue([final]);
        txSessionTurnFindMany.mockResolvedValue([{
            turnId: "turn-1",
            status: "completed",
            startedAt: 1n,
            updatedAt: 102n,
            terminalAt: 102n,
            lastRuntimeIssueJson: null,
            transcriptAnchorsJson: JSON.stringify({
                startUserMessageSeq: 1,
                userMessageSeqs: Array.from({ length: 101 }, (_, index) => index + 1),
                startSeqInclusive: 1,
                endSeqInclusive: 102,
                finalAssistantMessageSeq: 102,
            }),
            transcriptAnchorProjectionVersion: 1,
            transcriptAnchorMinSeq: 1,
            transcriptAnchorMaxSeq: 102,
            rollbackState: null,
        }]);

        const route = await createSessionRouteTestBuilder("GET", "/v1/sessions/:sessionId/messages");
        const { response } = await route.invoke({
            params: { sessionId: "s1" },
            query: { afterSeq: 100, limit: 100, projection: "externalShareableV1" },
        });

        expect(response).toMatchObject({
            hasMore: true,
            externalShareableSnapshot: {
                turnSettlementBlockedFromSeq: 102,
            },
        });
        expect(sessionMessageFindMany).toHaveBeenCalledTimes(1);
    });

    it("does not advance through finals whose combined out-of-page user witnesses exceed the bounded snapshot", async () => {
        sessionFindUnique.mockResolvedValue({ currentStorageState: "hosted" });
        const t0 = new Date(1);
        const firstUserMessageSeqs = Array.from({ length: 60 }, (_, index) => index + 1);
        const secondUserMessageSeqs = Array.from({ length: 60 }, (_, index) => index + 61);
        sessionMessageFindMany.mockResolvedValue([
            {
                id: "m202",
                seq: 202,
                localId: "local-202",
                sidechainId: null,
                messageRole: "agent",
                content: { t: "plain", v: { role: "agent", content: { type: "text", text: "first final" } } },
                inputAdmissionReceipt: null,
                createdAt: t0,
                updatedAt: t0,
            },
            {
                id: "m203",
                seq: 203,
                localId: "local-203",
                sidechainId: null,
                messageRole: "agent",
                content: { t: "plain", v: { role: "agent", content: { type: "text", text: "second final" } } },
                inputAdmissionReceipt: null,
                createdAt: t0,
                updatedAt: t0,
            },
        ]);
        txSessionTurnFindMany.mockResolvedValue([
            {
                turnId: "turn-1",
                status: "completed",
                startedAt: 1n,
                updatedAt: 202n,
                terminalAt: 202n,
                lastRuntimeIssueJson: null,
                transcriptAnchorsJson: JSON.stringify({
                    startUserMessageSeq: 1,
                    userMessageSeqs: firstUserMessageSeqs,
                    startSeqInclusive: 1,
                    endSeqInclusive: 202,
                    finalAssistantMessageSeq: 202,
                }),
                transcriptAnchorProjectionVersion: 1,
                transcriptAnchorMinSeq: 1,
                transcriptAnchorMaxSeq: 202,
                rollbackState: null,
            },
            {
                turnId: "turn-2",
                status: "completed",
                startedAt: 61n,
                updatedAt: 203n,
                terminalAt: 203n,
                lastRuntimeIssueJson: null,
                transcriptAnchorsJson: JSON.stringify({
                    startUserMessageSeq: 61,
                    userMessageSeqs: secondUserMessageSeqs,
                    startSeqInclusive: 61,
                    endSeqInclusive: 203,
                    finalAssistantMessageSeq: 203,
                }),
                transcriptAnchorProjectionVersion: 1,
                transcriptAnchorMinSeq: 61,
                transcriptAnchorMaxSeq: 203,
                rollbackState: null,
            },
        ]);

        const route = await createSessionRouteTestBuilder("GET", "/v1/sessions/:sessionId/messages");
        const { response } = await route.invoke({
            params: { sessionId: "s1" },
            query: { afterSeq: 200, limit: 100, projection: "externalShareableV1" },
        });

        expect(response).toMatchObject({
            hasMore: true,
            externalShareableSnapshot: {
                turnSettlementBlockedFromSeq: 203,
            },
        });
        expect(sessionMessageFindMany).toHaveBeenCalledTimes(2);
        expect(sessionMessageFindMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
            where: expect.objectContaining({ sessionId: "s1", seq: { in: firstUserMessageSeqs } }),
            take: 100,
        }));
    });

    it("fails closed when a selected v1 row's private anchor projection disagrees with its stored anchors", async () => {
        sessionFindUnique.mockResolvedValue({ currentStorageState: "hosted" });
        const t0 = new Date(1);
        sessionMessageFindMany.mockResolvedValue([{
            id: "m102",
            seq: 102,
            localId: "local-102",
            sidechainId: null,
            messageRole: "agent",
            content: { t: "plain", v: { role: "agent", content: { type: "text", text: "final" } } },
            inputAdmissionReceipt: null,
            createdAt: t0,
            updatedAt: t0,
        }]);
        txSessionTurnFindMany.mockResolvedValue([{
            turnId: "turn-1",
            status: "completed",
            startedAt: 1n,
            updatedAt: 102n,
            terminalAt: 102n,
            lastRuntimeIssueJson: null,
            transcriptAnchorsJson: JSON.stringify({
                startUserMessageSeq: 1,
                userMessageSeqs: [1],
                startSeqInclusive: 1,
                endSeqInclusive: 102,
                finalAssistantMessageSeq: 102,
            }),
            transcriptAnchorProjectionVersion: 1,
            transcriptAnchorMinSeq: 2,
            transcriptAnchorMaxSeq: 102,
            rollbackState: null,
        }]);

        const route = await createSessionRouteTestBuilder("GET", "/v1/sessions/:sessionId/messages");
        const { response } = await route.invoke({
            params: { sessionId: "s1" },
            query: { afterSeq: 100, limit: 100, projection: "externalShareableV1" },
        });

        expect(response).toMatchObject({
            hasMore: true,
            externalShareableSnapshot: {
                turns: [],
                turnSettlementBlockedFromSeq: 102,
            },
        });
    });

    it("includes legacy null-role rows in user role filters for encrypted history recovery", async () => {
        checkSessionAccess.mockResolvedValue({ level: "owner" });
        sessionMessageFindMany.mockResolvedValue([]);

        const route = await createSessionRouteTestBuilder("GET", "/v1/sessions/:sessionId/messages");
        await route.invoke({
            params: { sessionId: "s1" },
            query: { role: "user", limit: 50 },
        });

        expect(sessionMessageFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    sessionId: "s1",
                    sidechainId: null,
                    OR: [{ messageRole: "user" }, { messageRole: null }],
                }),
            }),
        );
    });

    it("rejects unsupported role filters", async () => {
        checkSessionAccess.mockResolvedValue({ level: "owner" });

        const route = await createSessionRouteTestBuilder("GET", "/v1/sessions/:sessionId/messages");
        const { reply } = await route.invoke({
            params: { sessionId: "s1" },
            query: { role: "tool" },
        });

        expect(reply.code).toHaveBeenCalledWith(400);
        expect(sessionMessageFindMany).not.toHaveBeenCalled();
    });

    it("unions singular role and CSV roles filters", async () => {
        checkSessionAccess.mockResolvedValue({ level: "owner" });
        sessionMessageFindMany.mockResolvedValue([]);

        const route = await createSessionRouteTestBuilder("GET", "/v1/sessions/:sessionId/messages");
        await route.invoke({
            params: { sessionId: "s1" },
            query: { role: "user", roles: "agent,event,user", limit: 2 },
        });

        expect(sessionMessageFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    sessionId: "s1",
                    sidechainId: null,
                    OR: [{ messageRole: { in: ["user", "agent", "event"] } }, { messageRole: null }],
                }),
                take: 3,
            }),
        );
    });

    it("rejects repeated role query parameters instead of widening the query", async () => {
        checkSessionAccess.mockResolvedValue({ level: "owner" });

        const route = await createSessionRouteTestBuilder("GET", "/v1/sessions/:sessionId/messages");
        const { reply } = await route.invoke({
            params: { sessionId: "s1" },
            query: { role: ["user", "agent"] },
        });

        expect(reply.code).toHaveBeenCalledWith(400);
        expect(sessionMessageFindMany).not.toHaveBeenCalled();
    });

    it("returns nextAfterSeq=null when forward page has no more", async () => {
        checkSessionAccess.mockResolvedValue({ level: "owner" });

        const t0 = new Date(1);
        sessionMessageFindMany.mockResolvedValue([
            { id: "m3", seq: 3, localId: null, sidechainId: null, content: { t: "encrypted", c: "c3" }, createdAt: t0, updatedAt: t0 },
        ]);

        const route = await createSessionRouteTestBuilder("GET", "/v1/sessions/:sessionId/messages");
        const { response: res } = await route.invoke({
            params: { sessionId: "s1" },
            query: { afterSeq: 2, limit: 2 },
        });

        expect(catchupFetchesInc).toHaveBeenCalledWith({ type: "session-messages-afterSeq" });
        expect(catchupReturnedInc).toHaveBeenCalledWith({ type: "session-messages-afterSeq" }, 1);

        expect(res).toEqual({
            messages: [
                { id: "m3", seq: 3, content: { t: "encrypted", c: "c3" }, messageActionReference: { v: 1, sessionId: "s1", messageId: "m3", observedRevision: "message-updated-at:1" }, localId: null, createdAt: 1, updatedAt: 1 },
            ],
            hasMore: false,
            nextBeforeSeq: null,
            nextAfterSeq: null,
        });
    });

    it("keeps legacy default behavior (backward paging newest-first) when afterSeq is not provided", async () => {
        checkSessionAccess.mockResolvedValue({ level: "owner" });

        const t0 = new Date(1);
        sessionMessageFindMany.mockResolvedValue([
            { id: "m5", seq: 5, localId: null, sidechainId: null, content: { t: "encrypted", c: "c5" }, createdAt: t0, updatedAt: t0 },
            { id: "m4", seq: 4, localId: null, sidechainId: null, content: { t: "encrypted", c: "c4" }, createdAt: t0, updatedAt: t0 },
            { id: "m3", seq: 3, localId: null, sidechainId: null, content: { t: "encrypted", c: "c3" }, createdAt: t0, updatedAt: t0 },
        ]);

        const route = await createSessionRouteTestBuilder("GET", "/v1/sessions/:sessionId/messages");
        const { response: res } = await route.invoke({
            params: { sessionId: "s1" },
            query: { limit: 2 },
        });

        expect(catchupFetchesInc).not.toHaveBeenCalled();
        expect(catchupReturnedInc).not.toHaveBeenCalled();

        expect(sessionMessageFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ sessionId: "s1", sidechainId: null }),
                orderBy: { seq: "desc" },
                take: 3,
            }),
        );

        expect(res).toEqual({
            messages: [
                { id: "m5", seq: 5, content: { t: "encrypted", c: "c5" }, messageActionReference: { v: 1, sessionId: "s1", messageId: "m5", observedRevision: "message-updated-at:1" }, localId: null, createdAt: 1, updatedAt: 1 },
                { id: "m4", seq: 4, content: { t: "encrypted", c: "c4" }, messageActionReference: { v: 1, sessionId: "s1", messageId: "m4", observedRevision: "message-updated-at:1" }, localId: null, createdAt: 1, updatedAt: 1 },
            ],
            hasMore: true,
            nextBeforeSeq: 4,
            nextAfterSeq: null,
        });
    });

    it("keeps legacy beforeSeq behavior when afterSeq is not provided", async () => {
        checkSessionAccess.mockResolvedValue({ level: "owner" });

        const t0 = new Date(1);
        sessionMessageFindMany.mockResolvedValue([
            { id: "m4", seq: 4, localId: null, sidechainId: null, content: { t: "encrypted", c: "c4" }, createdAt: t0, updatedAt: t0 },
            { id: "m3", seq: 3, localId: null, sidechainId: null, content: { t: "encrypted", c: "c3" }, createdAt: t0, updatedAt: t0 },
        ]);

        const route = await createSessionRouteTestBuilder("GET", "/v1/sessions/:sessionId/messages");
        const { response: res } = await route.invoke({
            params: { sessionId: "s1" },
            query: { beforeSeq: 5, limit: 50 },
        });

        expect(catchupFetchesInc).not.toHaveBeenCalled();
        expect(catchupReturnedInc).not.toHaveBeenCalled();

        expect(sessionMessageFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ sessionId: "s1", sidechainId: null, seq: { lt: 5 } }),
                orderBy: { seq: "desc" },
                take: 51,
            }),
        );

        expect(res).toEqual({
            messages: [
                { id: "m4", seq: 4, content: { t: "encrypted", c: "c4" }, messageActionReference: { v: 1, sessionId: "s1", messageId: "m4", observedRevision: "message-updated-at:1" }, localId: null, createdAt: 1, updatedAt: 1 },
                { id: "m3", seq: 3, content: { t: "encrypted", c: "c3" }, messageActionReference: { v: 1, sessionId: "s1", messageId: "m3", observedRevision: "message-updated-at:1" }, localId: null, createdAt: 1, updatedAt: 1 },
            ],
            hasMore: false,
            nextBeforeSeq: null,
            nextAfterSeq: null,
        });
    });

    it("can fetch all chains when scope=all", async () => {
        checkSessionAccess.mockResolvedValue({ level: "owner" });

        const t0 = new Date(1);
        sessionMessageFindMany.mockResolvedValue([
            { id: "m2", seq: 2, localId: null, sidechainId: "sc-1", content: { t: "encrypted", c: "c2" }, createdAt: t0, updatedAt: t0 },
            { id: "m1", seq: 1, localId: null, sidechainId: null, content: { t: "encrypted", c: "c1" }, createdAt: t0, updatedAt: t0 },
        ]);

        const route = await createSessionRouteTestBuilder("GET", "/v1/sessions/:sessionId/messages");
        const { response: res } = await route.invoke({
            params: { sessionId: "s1" },
            query: { limit: 50, scope: "all" },
        });

        expect(sessionMessageFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ sessionId: "s1" }),
            }),
        );

        expect(res).toEqual({
            messages: [
                { id: "m2", seq: 2, content: { t: "encrypted", c: "c2" }, messageActionReference: { v: 1, sessionId: "s1", messageId: "m2", observedRevision: "message-updated-at:1" }, localId: null, sidechainId: "sc-1", createdAt: 1, updatedAt: 1 },
                { id: "m1", seq: 1, content: { t: "encrypted", c: "c1" }, messageActionReference: { v: 1, sessionId: "s1", messageId: "m1", observedRevision: "message-updated-at:1" }, localId: null, createdAt: 1, updatedAt: 1 },
            ],
            hasMore: false,
            nextBeforeSeq: null,
            nextAfterSeq: null,
        });
    });

    it("can fetch a single sidechain when scope=sidechain", async () => {
        checkSessionAccess.mockResolvedValue({ level: "owner" });

        const t0 = new Date(1);
        sessionMessageFindMany.mockResolvedValue([
            { id: "m2", seq: 2, localId: null, sidechainId: "sc-1", content: { t: "encrypted", c: "c2" }, createdAt: t0, updatedAt: t0 },
            { id: "m1", seq: 1, localId: null, sidechainId: "sc-1", content: { t: "encrypted", c: "c1" }, createdAt: t0, updatedAt: t0 },
        ]);

        const route = await createSessionRouteTestBuilder("GET", "/v1/sessions/:sessionId/messages");
        await route.invoke({
            params: { sessionId: "s1" },
            query: { limit: 50, scope: "sidechain", sidechainId: "sc-1" },
        });

        expect(sessionMessageFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ sessionId: "s1", sidechainId: "sc-1" }),
            }),
        );
    });
});
