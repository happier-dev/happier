import { beforeEach, describe, expect, it } from "vitest";

import { createEnvPatcher } from "@/testkit/env";

import {
    createSessionRouteTestBuilder,
    createSessionMessage,
    emitUpdate,
    markAccountChanged,
    resetSessionRouteMocks,
    txSessionFindUnique,
    txSessionSystemRecordCreate,
    txSessionSystemRecordFindFirst,
    txSessionSystemRecordFindMany,
    txSessionSystemRecordFindUnique,
    txSessionSystemRecordUpdate,
} from "./sessionRoutes.testkit";

function synopsisPayload(overrides: Record<string, unknown> = {}) {
    return {
        v: 1,
        seqTo: 2,
        updatedAtMs: 3,
        synopsis: "hello",
        ...overrides,
    };
}

function summaryPayload(overrides: Record<string, unknown> = {}) {
    return {
        v: 1,
        seqFrom: 1,
        seqTo: 2,
        createdAtFromMs: 10,
        createdAtToMs: 20,
        summary: "summary",
        keywords: ["memory"],
        entities: [],
        decisions: [],
        ...overrides,
    };
}

describe("sessionRoutes system records", () => {
    const storagePolicyEnv = createEnvPatcher(["HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY"]);

    beforeEach(() => {
        storagePolicyEnv.restore();
        storagePolicyEnv.set("HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY", "optional");
        resetSessionRouteMocks();
    });

    it("registers the v2 session system-record route surface", async () => {
        expect((await createSessionRouteTestBuilder("PUT", "/v2/sessions/:sessionId/system-records")).routeExists).toBe(true);
        expect((await createSessionRouteTestBuilder("GET", "/v2/sessions/:sessionId/system-records")).routeExists).toBe(true);
        expect((await createSessionRouteTestBuilder("GET", "/v2/sessions/:sessionId/system-records/record")).routeExists).toBe(true);
        expect((await createSessionRouteTestBuilder("GET", "/v2/sessions/:sessionId/system-records/latest")).routeExists).toBe(true);
    });

    it("upserts an accessible plain memory record without transcript side effects", async () => {
        const createdAt = new Date("2026-05-19T10:00:00.000Z");
        txSessionFindUnique.mockResolvedValue({ encryptionMode: "plain" });
        txSessionSystemRecordFindUnique.mockResolvedValue(null);
        txSessionSystemRecordCreate.mockResolvedValue({
            id: "rec-1",
            accountId: "u1",
            sessionId: "s1",
            namespace: "memory",
            kind: "synopsis.v1",
            localId: "memory:synopsis:v1:2",
            content: { t: "plain", v: synopsisPayload() },
            createdAt,
            updatedAt: createdAt,
        });

        const route = await createSessionRouteTestBuilder("PUT", "/v2/sessions/:sessionId/system-records");
        const { response: res } = await route.invoke({
            params: { sessionId: "s1" },
            body: {
                namespace: "memory",
                kind: "synopsis.v1",
                localId: "memory:synopsis:v1:2",
                content: { t: "plain", v: synopsisPayload() },
            },
        });

        expect(txSessionSystemRecordCreate).toHaveBeenCalledWith({
            data: {
                accountId: "u1",
                sessionId: "s1",
                namespace: "memory",
                kind: "synopsis.v1",
                localId: "memory:synopsis:v1:2",
                content: { t: "plain", v: synopsisPayload() },
            },
            select: expect.any(Object),
        });
        expect(createSessionMessage).not.toHaveBeenCalled();
        expect(emitUpdate).not.toHaveBeenCalled();
        expect(markAccountChanged).not.toHaveBeenCalled();
        expect(res).toEqual({
            didCreate: true,
            didUpdate: false,
            record: {
                id: "rec-1",
                sessionId: "s1",
                namespace: "memory",
                kind: "synopsis.v1",
                localId: "memory:synopsis:v1:2",
                content: { t: "plain", v: synopsisPayload() },
                createdAt: createdAt.toISOString(),
                updatedAt: createdAt.toISOString(),
            },
        });
    });

    it("rejects invalid plain payloads before writing", async () => {
        const route = await createSessionRouteTestBuilder("PUT", "/v2/sessions/:sessionId/system-records");
        const { reply, response: res } = await route.invoke({
            params: { sessionId: "s1" },
            body: {
                namespace: "memory",
                kind: "synopsis.v1",
                localId: "memory:synopsis:v1:2",
                content: { t: "plain", v: { wrong: true } },
            },
        });

        expect(reply.code).toHaveBeenCalledWith(400);
        expect(res).toEqual({ error: "Invalid parameters" });
        expect(txSessionSystemRecordCreate).not.toHaveBeenCalled();
    });

    it("rejects plain system-record content for e2ee sessions", async () => {
        txSessionFindUnique.mockResolvedValue({ encryptionMode: "e2ee" });

        const route = await createSessionRouteTestBuilder("PUT", "/v2/sessions/:sessionId/system-records");
        const { reply, response: res } = await route.invoke({
            params: { sessionId: "s1" },
            body: {
                namespace: "memory",
                kind: "synopsis.v1",
                localId: "memory:synopsis:v1:2",
                content: { t: "plain", v: synopsisPayload() },
            },
        });

        expect(reply.code).toHaveBeenCalledWith(400);
        expect(res).toEqual({ error: "Invalid parameters", code: "session_encryption_mode_mismatch" });
        expect(txSessionSystemRecordCreate).not.toHaveBeenCalled();
    });

    it("rejects reusing a localId for a different kind", async () => {
        txSessionFindUnique.mockResolvedValue({ encryptionMode: "plain" });
        txSessionSystemRecordFindUnique.mockResolvedValue({
            id: "rec-existing",
            accountId: "u1",
            sessionId: "s1",
            namespace: "memory",
            kind: "synopsis.v1",
            localId: "memory:shared",
            content: { t: "plain", v: synopsisPayload() },
            createdAt: new Date("2026-05-19T10:00:00.000Z"),
            updatedAt: new Date("2026-05-19T10:00:00.000Z"),
        });

        const route = await createSessionRouteTestBuilder("PUT", "/v2/sessions/:sessionId/system-records");
        const { reply, response: res } = await route.invoke({
            params: { sessionId: "s1" },
            body: {
                namespace: "memory",
                kind: "summary_shard.v1",
                localId: "memory:shared",
                content: { t: "plain", v: summaryPayload() },
            },
        });

        expect(reply.code).toHaveBeenCalledWith(409);
        expect(res).toEqual({ error: "Conflict", code: "system_record_kind_conflict" });
        expect(txSessionSystemRecordCreate).not.toHaveBeenCalled();
        expect(txSessionSystemRecordUpdate).not.toHaveBeenCalled();
    });

    it("lists records with namespace kind and localId filtering", async () => {
        const createdAt = new Date("2026-05-19T10:00:00.000Z");
        txSessionFindUnique.mockResolvedValue({ encryptionMode: "plain" });
        txSessionSystemRecordFindMany.mockResolvedValue([
            {
                id: "rec-1",
                accountId: "u1",
                sessionId: "s1",
                namespace: "memory",
                kind: "synopsis.v1",
                localId: "memory:synopsis:v1:2",
                content: { t: "plain", v: synopsisPayload() },
                createdAt,
                updatedAt: createdAt,
            },
        ]);

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions/:sessionId/system-records");
        const { response: res } = await route.invoke({
            params: { sessionId: "s1" },
            query: {
                namespace: "memory",
                kind: "synopsis.v1",
                localId: "memory:synopsis:v1:2",
                limit: "25",
            },
        });

        expect(txSessionSystemRecordFindMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                sessionId: "s1",
                OR: [
                    {
                        accountId: "u1",
                        namespace: "memory",
                        kind: { in: ["synopsis.v1"] },
                    },
                ],
                localId: "memory:synopsis:v1:2",
            }),
            take: 26,
        }));
        expect(res).toEqual({
            records: [
                {
                    id: "rec-1",
                    sessionId: "s1",
                    namespace: "memory",
                    kind: "synopsis.v1",
                    localId: "memory:synopsis:v1:2",
                    content: { t: "plain", v: synopsisPayload() },
                    createdAt: createdAt.toISOString(),
                    updatedAt: createdAt.toISOString(),
                },
            ],
            nextCursor: null,
            hasNext: false,
        });
    });

    it("looks up a record by namespace and localId", async () => {
        const createdAt = new Date("2026-05-19T10:00:00.000Z");
        txSessionFindUnique.mockResolvedValue({ encryptionMode: "plain" });
        txSessionSystemRecordFindUnique.mockResolvedValue({
            id: "rec-1",
            accountId: "u1",
            sessionId: "s1",
            namespace: "memory",
            kind: "synopsis.v1",
            localId: "memory:synopsis:v1:2",
            content: { t: "plain", v: synopsisPayload() },
            createdAt,
            updatedAt: createdAt,
        });

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions/:sessionId/system-records/record");
        const { response: res } = await route.invoke({
            params: { sessionId: "s1" },
            query: { namespace: "memory", localId: "memory:synopsis:v1:2" },
        });

        expect(txSessionSystemRecordFindUnique).toHaveBeenCalledWith(expect.objectContaining({
            where: {
                accountId_sessionId_namespace_localId: {
                    accountId: "u1",
                    sessionId: "s1",
                    namespace: "memory",
                    localId: "memory:synopsis:v1:2",
                },
            },
        }));
        expect(res).toEqual({
            record: expect.objectContaining({
                id: "rec-1",
                localId: "memory:synopsis:v1:2",
            }),
        });
    });

    it("fetches the latest record by namespace and kind", async () => {
        const createdAt = new Date("2026-05-19T10:00:00.000Z");
        txSessionFindUnique.mockResolvedValue({ encryptionMode: "plain" });
        txSessionSystemRecordFindFirst.mockResolvedValue({
            id: "rec-1",
            accountId: "u1",
            sessionId: "s1",
            namespace: "memory",
            kind: "synopsis.v1",
            localId: "memory:synopsis:v1:2",
            content: { t: "plain", v: synopsisPayload() },
            createdAt,
            updatedAt: createdAt,
        });

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions/:sessionId/system-records/latest");
        const { response: res } = await route.invoke({
            params: { sessionId: "s1" },
            query: { namespace: "memory", kind: "synopsis.v1" },
        });

        expect(txSessionSystemRecordFindFirst).toHaveBeenCalledWith(expect.objectContaining({
            where: {
                accountId: "u1",
                sessionId: "s1",
                namespace: "memory",
                kind: "synopsis.v1",
            },
            orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        }));
        expect(res).toEqual({
            record: expect.objectContaining({
                id: "rec-1",
                kind: "synopsis.v1",
            }),
        });
    });
});
