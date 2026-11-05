import { beforeEach, describe, expect, it } from "vitest";
import type { RouteOptions } from "fastify";
import type { Prisma } from "@prisma/client";
import { SessionMessagesPageV1Schema } from "@happier-dev/protocol";

import {
    catchupFetchesInc,
    catchupReturnedInc,
    createSessionAccessProjectionRelations,
    createSessionRouteTestBuilder,
    resetSessionRouteMocks,
    txSessionFindUnique as sessionFindUnique,
    txSessionMessageFindMany as sessionMessageFindMany,
    txSessionTurnFindFirst,
    txSessionTurnFindMany,
} from "./sessionRoutes.testkit";
import { createAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { registerSessionMessageRoutes } from "./registerSessionMessageRoutes";

describe("sessionRoutes v1 messages pagination", () => {
    beforeEach(async () => {
        resetSessionRouteMocks();
        sessionMessageFindMany.mockReset();
        txSessionTurnFindFirst.mockClear();
        txSessionTurnFindMany.mockClear();
        catchupFetchesInc.mockReset();
        catchupReturnedInc.mockReset();
    });

    it("acquires only the exact committed message from a long transcript through the existing page route", async () => {
        const rows = Array.from({ length: 200 }, (_, index) => ({
            id: `message-${index + 1}`, seq: index + 1, localId: null, sidechainId: null,
            messageRole: "agent", content: { t: "encrypted", c: `sealed-${index + 1}` },
            createdAt: new Date(index + 1), updatedAt: new Date(index + 1),
        }));
        let acquiredRows = 0;
        // Substitute only the persistent database boundary; admission and projection remain real.
        sessionMessageFindMany.mockImplementation(async ({ where, take }: Prisma.SessionMessageFindManyArgs) => {
            const messageId = typeof where?.id === "string" ? where.id : undefined;
            const selected = messageId === undefined ? rows : rows.filter(row => row.id === messageId);
            const acquired = selected.slice(0, take ?? selected.length);
            acquiredRows += acquired.length;
            return acquired;
        });
        const app = createAuthenticatedTestApp();
        registerSessionMessageRoutes(app);
        await app.ready();
        try {
            const response = await app.inject({ method: "GET",
                url: "/v1/sessions/s1/messages?messageId=message-7&scope=all&role=agent",
                headers: { "x-test-user-id": "u1" } });
            expect(response.statusCode).toBe(200);
            const page = SessionMessagesPageV1Schema.parse(response.json());
            expect(page.messages.map(message => message.id)).toEqual(["message-7"]);
            expect(page).toMatchObject({ hasMore: false, nextBeforeSeq: null, nextAfterSeq: null });
            expect(acquiredRows).toBe(1);
        } finally { await app.close(); }
    });

    it.each(["beforeSeq=10", "afterSeq=0", "limit=1", "projection=turns", "projection=externalShareableV1"])(
        "rejects exact selection combined with %s before acquiring messages", async extra => {
            sessionMessageFindMany.mockResolvedValue([]);
            const app = createAuthenticatedTestApp();
            registerSessionMessageRoutes(app);
            await app.ready();
            try {
                const response = await app.inject({ method: "GET",
                    url: `/v1/sessions/s1/messages?messageId=message-7&${extra}`,
                    headers: { "x-test-user-id": "u1" } });
                expect(response.statusCode).toBe(400);
                expect(sessionMessageFindMany).not.toHaveBeenCalled();
            } finally { await app.close(); }
        },
    );

    it.each([false, true])('retains admitted references on transcript HTTP pages (explicit publication: %s)', async explicitPublication => {
        const surfaceItemReference = { v: 1, references: [{ v: 1, itemId: 'visual', itemRevision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ',
            sourceAddress: { serverId: 'home', sessionId: 's1' } }] };
        sessionMessageFindMany.mockResolvedValue([
            { id: 'm1', seq: 1, localId: null, sidechainId: null, messageRole: 'agent',
                content: { t: 'encrypted', c: 'sealed' }, surfaceItemReference,
                createdAt: new Date(1), updatedAt: new Date(1) },
            { id: 'm2', seq: 2, localId: null, sidechainId: null, messageRole: 'agent',
                content: { t: 'encrypted', c: 'sealed2' }, surfaceItemReference: null,
                createdAt: new Date(2), updatedAt: new Date(2) },
        ]);
        const app = createAuthenticatedTestApp();
        registerSessionMessageRoutes(app);
        await app.ready();
        try {
            const response = await app.inject({ method: 'GET',
                url: `/v1/sessions/s1/messages?scope=main${explicitPublication ? '&projection=externalShareableV1' : ''}`,
                headers: { 'x-test-user-id': 'u1' } });
            expect(response.statusCode).toBe(200);
            const page = SessionMessagesPageV1Schema.parse(response.json());
            expect(page.messages).toEqual(expect.arrayContaining([
                expect.objectContaining({ id: 'm1', surfaceItemReference }),
                expect.objectContaining({ id: 'm2', ...(explicitPublication ? { surfaceItemReference: null } : {}) }),
            ]));
            if (!explicitPublication) expect(page.messages.find(row => row.id === 'm2')).not.toHaveProperty('surfaceItemReference');
            expect(sessionMessageFindMany).toHaveBeenCalledWith(expect.objectContaining({
                select: expect.objectContaining({ surfaceItemReference: true }),
            }));
        } finally { await app.close(); }
    });

    it("admits preview reads only for a proof-bound session.list effect", async () => {
        const app = createAuthenticatedTestApp();
        let routeConfig: RouteOptions["config"];
        app.addHook("onRoute", (route: RouteOptions) => {
            if (route.method === "GET" && route.url === "/v1/sessions/:sessionId/messages") {
                routeConfig = route.config;
            }
        });
        registerSessionMessageRoutes(app);
        try {
            expect(routeConfig).toMatchObject({
                restrictedCredentialBinding: { scope: "session", session: "params.sessionId" },
            });
            expect(routeConfig?.allowApiToken).toBeUndefined();
        } finally {
            await app.close();
        }
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

            expect(response.statusCode, response.body).toBe(400);
        } finally {
            await app.close();
        }
    });

    it("returns forward page in ascending order with nextAfterSeq when hasMore", async () => {

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
        expect(SessionMessagesPageV1Schema.parse(res)).toEqual(res);

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
                { id: "m3", seq: 3, content: { t: "encrypted", c: "c3" }, messageActionReference: { v: 1, sessionId: "s1", messageId: "m3", observedRevision: "message-updated-at:1" }, localId: null, messageRole: "user", deliveryResolution: { v: 1, kind: "manual_handled" }, createdAt: 1, updatedAt: 1, accountActor: null },
                { id: "m4", seq: 4, content: { t: "encrypted", c: "c4" }, messageActionReference: { v: 1, sessionId: "s1", messageId: "m4", observedRevision: "message-updated-at:1" }, localId: null, messageRole: "user", createdAt: 1, updatedAt: 1, accountActor: null },
            ],
            hasMore: true,
            nextBeforeSeq: null,
            nextAfterSeq: 4,
        });
    });

    it("fails the complete forward page when an authoritative stored-content row is malformed", async () => {

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
        sessionFindUnique.mockResolvedValue({ ...createSessionAccessProjectionRelations(), id: "s1", accountId: "u1",
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
        sessionFindUnique.mockResolvedValue({ ...createSessionAccessProjectionRelations(), id: "s1", accountId: "u1",
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
        sessionFindUnique.mockResolvedValue({ ...createSessionAccessProjectionRelations(), id: "s1", accountId: "u1",
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
        sessionFindUnique.mockResolvedValue({ ...createSessionAccessProjectionRelations(), id: "s1", accountId: "u1",
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
        sessionFindUnique.mockResolvedValue({ ...createSessionAccessProjectionRelations(), id: "s1", accountId: "u1",
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
        sessionFindUnique.mockResolvedValue({ ...createSessionAccessProjectionRelations(), id: "s1", accountId: "u1",
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
        sessionFindUnique.mockResolvedValue({ ...createSessionAccessProjectionRelations(), id: "s1", accountId: "u1",
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
        sessionFindUnique.mockResolvedValue({ ...createSessionAccessProjectionRelations(), id: "s1", accountId: "u1",
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
        sessionFindUnique.mockResolvedValue({ ...createSessionAccessProjectionRelations(), id: "s1", accountId: "u1",
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

    it("keeps an external cursor blocked when Session.seq is missing", async () => {
        // Deliberately omit Session.seq: an incomplete complete-snapshot
        // publication tuple must fail closed at sequence zero.
        sessionFindUnique.mockResolvedValue({ ...createSessionAccessProjectionRelations(), id: "s1", accountId: "u1",
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
            },
        });
    });

    it("returns exact out-of-page consumed inputs in the same transaction snapshot", async () => {
        sessionFindUnique.mockResolvedValue({ ...createSessionAccessProjectionRelations(), id: "s1", accountId: "u1", currentStorageState: "hosted" });
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
        sessionFindUnique.mockResolvedValue({ ...createSessionAccessProjectionRelations(), id: "s1", accountId: "u1", currentStorageState: "hosted" });
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
                        status: { in: ["in_progress", "waiting"] },
                    }),
                ]),
            }),
            take: 101,
        }));
    });

    it("keeps a final with an exact bounded out-of-page user witness publishable", async () => {
        sessionFindUnique.mockResolvedValue({ ...createSessionAccessProjectionRelations(), id: "s1", accountId: "u1", currentStorageState: "hosted" });
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
        sessionFindUnique.mockResolvedValue({ ...createSessionAccessProjectionRelations(), id: "s1", accountId: "u1", currentStorageState: "hosted" });
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
        sessionFindUnique.mockResolvedValue({ ...createSessionAccessProjectionRelations(), id: "s1", accountId: "u1", currentStorageState: "hosted" });
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
        sessionFindUnique.mockResolvedValue({ ...createSessionAccessProjectionRelations(), id: "s1", accountId: "u1", currentStorageState: "hosted" });
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

        const route = await createSessionRouteTestBuilder("GET", "/v1/sessions/:sessionId/messages");
        const { reply } = await route.invoke({
            params: { sessionId: "s1" },
            query: { role: "tool" },
        });

        expect(reply.code).toHaveBeenCalledWith(400);
        expect(sessionMessageFindMany).not.toHaveBeenCalled();
    });

    it("unions singular role and CSV roles filters", async () => {
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

        const route = await createSessionRouteTestBuilder("GET", "/v1/sessions/:sessionId/messages");
        const { reply } = await route.invoke({
            params: { sessionId: "s1" },
            query: { role: ["user", "agent"] },
        });

        expect(reply.code).toHaveBeenCalledWith(400);
        expect(sessionMessageFindMany).not.toHaveBeenCalled();
    });

    it("returns nextAfterSeq=null when forward page has no more", async () => {

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
                { id: "m3", seq: 3, content: { t: "encrypted", c: "c3" }, messageActionReference: { v: 1, sessionId: "s1", messageId: "m3", observedRevision: "message-updated-at:1" }, localId: null, createdAt: 1, updatedAt: 1, accountActor: null },
            ],
            hasMore: false,
            nextBeforeSeq: null,
            nextAfterSeq: null,
        });
    });

    it("keeps legacy default behavior (backward paging newest-first) when afterSeq is not provided", async () => {

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
                { id: "m5", seq: 5, content: { t: "encrypted", c: "c5" }, messageActionReference: { v: 1, sessionId: "s1", messageId: "m5", observedRevision: "message-updated-at:1" }, localId: null, createdAt: 1, updatedAt: 1, accountActor: null },
                { id: "m4", seq: 4, content: { t: "encrypted", c: "c4" }, messageActionReference: { v: 1, sessionId: "s1", messageId: "m4", observedRevision: "message-updated-at:1" }, localId: null, createdAt: 1, updatedAt: 1, accountActor: null },
            ],
            hasMore: true,
            nextBeforeSeq: 4,
            nextAfterSeq: null,
        });
    });

    it("keeps legacy beforeSeq behavior when afterSeq is not provided", async () => {

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
                { id: "m4", seq: 4, content: { t: "encrypted", c: "c4" }, messageActionReference: { v: 1, sessionId: "s1", messageId: "m4", observedRevision: "message-updated-at:1" }, localId: null, createdAt: 1, updatedAt: 1, accountActor: null },
                { id: "m3", seq: 3, content: { t: "encrypted", c: "c3" }, messageActionReference: { v: 1, sessionId: "s1", messageId: "m3", observedRevision: "message-updated-at:1" }, localId: null, createdAt: 1, updatedAt: 1, accountActor: null },
            ],
            hasMore: false,
            nextBeforeSeq: null,
            nextAfterSeq: null,
        });
    });

    it("can fetch all chains when scope=all", async () => {

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
                { id: "m2", seq: 2, content: { t: "encrypted", c: "c2" }, messageActionReference: { v: 1, sessionId: "s1", messageId: "m2", observedRevision: "message-updated-at:1" }, localId: null, sidechainId: "sc-1", createdAt: 1, updatedAt: 1, accountActor: null },
                { id: "m1", seq: 1, content: { t: "encrypted", c: "c1" }, messageActionReference: { v: 1, sessionId: "s1", messageId: "m1", observedRevision: "message-updated-at:1" }, localId: null, createdAt: 1, updatedAt: 1, accountActor: null },
            ],
            hasMore: false,
            nextBeforeSeq: null,
            nextAfterSeq: null,
        });
    });

    it("can fetch a single sidechain when scope=sidechain", async () => {

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
