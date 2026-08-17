import { beforeEach, describe, expect, it } from "vitest";

import { deriveSessionPermissionMediationRecordLocatorV1 } from "@happier-dev/protocol";
import { deriveSessionSystemRecordAddressKeys } from "@/app/session/systemRecords/sessionSystemRecordAddressKeys";
import {
    initializeSessionSystemRecordsProtocolV1Activation,
    resetSessionSystemRecordsProtocolV1ActivationForTests,
    SESSION_SYSTEM_RECORDS_CONTRACT_MIGRATION,
} from "@/app/session/systemRecords/sessionSystemRecordProtocolContract";
import { createEnvPatcher } from "@/testkit/env";

import {
    createSessionRouteTestBuilder,
    createSessionMessage,
    checkSessionAccess,
    createSessionRouteAccessFixture,
    emitUpdate,
    markAccountChanged,
    resetSessionRouteMocks,
    txSessionFindFirst,
    txSessionFindUnique,
    txSessionSystemRecordCreate,
    txSessionSystemRecordFindFirst,
    txSessionSystemRecordFindMany,
    txSessionSystemRecordUpdate,
} from "./sessionRoutes.testkit";

// Prisma is the system boundary; protocol-activation fixtures expose only its audited findMany operation.
type ProtocolActivationDatabase = Parameters<typeof initializeSessionSystemRecordsProtocolV1Activation>[0];

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

function persistedHostAddress(namespace: "memory" | "activity", localId: string) {
    return {
        ownerKind: "host" as const,
        pluginId: null,
        ...deriveSessionSystemRecordAddressKeys({
            ownerKind: "host",
            pluginId: null,
            namespace,
            localId,
        }),
        version: 1,
    };
}

describe("sessionRoutes system records", () => {
    const storagePolicyEnv = createEnvPatcher(["HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY"]);

    beforeEach(async () => {
        storagePolicyEnv.restore();
        storagePolicyEnv.set("HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY", "optional");
        resetSessionRouteMocks();
        txSessionFindFirst.mockResolvedValue({ id: "s1" });
        resetSessionSystemRecordsProtocolV1ActivationForTests();
        await initializeSessionSystemRecordsProtocolV1Activation({
            $queryRawUnsafe: async () => [{
                migration_name: SESSION_SYSTEM_RECORDS_CONTRACT_MIGRATION,
            }],
            sessionSystemRecord: {
                findMany: async () => [],
            },
        } as unknown as ProtocolActivationDatabase);
    });

    it("registers the v2 session system-record route surface", async () => {
        expect((await createSessionRouteTestBuilder("PUT", "/v2/sessions/:sessionId/system-records")).routeExists).toBe(true);
        expect((await createSessionRouteTestBuilder("GET", "/v2/sessions/:sessionId/system-records")).routeExists).toBe(true);
        expect((await createSessionRouteTestBuilder("GET", "/v2/sessions/:sessionId/system-records/record")).routeExists).toBe(true);
        expect((await createSessionRouteTestBuilder("GET", "/v2/sessions/:sessionId/system-records/latest")).routeExists).toBe(true);
        expect((await createSessionRouteTestBuilder("DELETE", "/v2/sessions/:sessionId/system-records/record")).routeExists).toBe(true);
        expect((await createSessionRouteTestBuilder("GET", "/v2/sessions/:sessionId/permission-mediation-records")).routeExists).toBe(true);
        expect((await createSessionRouteTestBuilder("GET", "/v2/sessions/:sessionId/permission-mediation-records/:turnId/:requestId")).routeExists).toBe(true);
        expect((await createSessionRouteTestBuilder("PUT", "/v2/sessions/:sessionId/permission-mediation-records/:turnId/:requestId")).routeExists).toBe(true);
        expect((await createSessionRouteTestBuilder("DELETE", "/v2/sessions/:sessionId/permission-mediation-records/:turnId/:requestId")).routeExists).toBe(true);
    }, 60_000);

    it("lists host-stamped plugin records after the current-version contract is active", async () => {
        const headers = {
            "x-happier-session-system-records-protocol": "1",
            "x-happier-plugin-id": "acme.notes",
        };
        checkSessionAccess.mockResolvedValue(createSessionRouteAccessFixture("view"));
        txSessionFindUnique.mockResolvedValue({ encryptionMode: "plain", accountId: "session-owner" });
        txSessionSystemRecordFindMany.mockResolvedValue([]);
        const { reply, response } = await (
            await createSessionRouteTestBuilder("GET", "/v2/sessions/:sessionId/system-records")
        ).invoke({
            params: { sessionId: "s1" },
            headers,
            query: { owner: "plugin", namespace: "notes" },
        });

        expect(reply.code).not.toHaveBeenCalled();
        expect(response).toEqual({
            records: [],
            nextCursor: null,
            hasNext: false,
        });
        expect(txSessionFindUnique).toHaveBeenCalledWith({
            where: { id: "s1" },
            select: { encryptionMode: true, accountId: true },
        });
        expect(txSessionSystemRecordFindMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({ accountId: "u1", sessionId: "s1" }),
            take: 101,
        }));
    });

    it("writes a permission mediation record through its fixed host-owned address without a plugin header", async () => {
        const createdAt = new Date("2026-08-10T10:00:00.000Z");
        const requestId = "permission-request-1";
        const turnId = "permission-turn-1";
        const locator = deriveSessionPermissionMediationRecordLocatorV1({ sessionId: "s1", turnId, requestId });
        checkSessionAccess.mockResolvedValue(createSessionRouteAccessFixture("owner"));
        txSessionFindUnique.mockResolvedValue({ encryptionMode: "plain", accountId: "u1" });
        txSessionSystemRecordCreate.mockResolvedValue({
            id: "permission-record-1",
            accountId: "u1",
            sessionId: "s1",
            ownerKind: "host",
            pluginId: null,
            namespace: "permission",
            kind: "remote_settlement.v1",
            localId: locator,
            permissionTurnId: turnId,
            permissionRequestId: requestId,
            content: { t: "plain", v: { opaque: "mediation-state" } },
            ...deriveSessionSystemRecordAddressKeys({
                ownerKind: "host",
                pluginId: null,
                namespace: "permission",
                localId: locator,
            }),
            version: 1,
            createdAt,
            updatedAt: createdAt,
        });

        const { reply, response } = await (
            await createSessionRouteTestBuilder(
                "PUT",
                "/v2/sessions/:sessionId/permission-mediation-records/:turnId/:requestId",
            )
        ).invoke({
            params: { sessionId: "s1", turnId, requestId },
            headers: { "x-happier-plugin-id": "attacker.selected.namespace" },
            body: {
                kind: "remote_settlement.v1",
                content: { t: "plain", v: { opaque: "mediation-state" } },
                expectedRevision: null,
            },
        });

        expect(reply.code).not.toHaveBeenCalled();
        expect(response).toMatchObject({
            record: {
                sessionId: "s1",
                turnId,
                requestId,
                kind: "remote_settlement.v1",
                revision: expect.stringMatching(/^ssr1\./),
            },
        });
        expect(txSessionSystemRecordCreate).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                ownerKind: "host",
                pluginId: null,
                namespace: "permission",
                kind: "remote_settlement.v1",
                localId: locator,
                permissionTurnId: turnId,
                permissionRequestId: requestId,
            }),
        }));
    });

    it("rejects every v1 request before parsing or mutating while the database remains expanded-only", async () => {
        await initializeSessionSystemRecordsProtocolV1Activation({
            $queryRawUnsafe: async () => [],
            sessionSystemRecord: {
                findMany: async () => [],
            },
        } as unknown as ProtocolActivationDatabase);
        const headers = {
            "x-happier-session-system-records-protocol": "1",
            "x-happier-plugin-id": "acme.notes",
        };
        const routes = [
            {
                method: "GET" as const,
                path: "/v2/sessions/:sessionId/system-records",
                request: { query: { owner: "plugin", namespace: "notes" } },
            },
            {
                method: "GET" as const,
                path: "/v2/sessions/:sessionId/system-records/record",
                request: {
                    query: {
                        owner: "plugin",
                        namespace: "notes",
                        kind: "entry.v1",
                        localId: "note:one",
                    },
                },
            },
            {
                method: "PUT" as const,
                path: "/v2/sessions/:sessionId/system-records",
                request: {
                    body: {
                        address: {
                            owner: "plugin",
                            namespace: "notes",
                            kind: "entry.v1",
                            localId: "note:one",
                        },
                        content: { t: "plain", v: { title: "One" } },
                        expectedRevision: null,
                    },
                },
            },
            {
                method: "DELETE" as const,
                path: "/v2/sessions/:sessionId/system-records/record",
                request: {
                    body: {
                        address: {
                            owner: "plugin",
                            namespace: "notes",
                            kind: "entry.v1",
                            localId: "note:one",
                        },
                    },
                },
            },
        ];

        for (const routeCase of routes) {
            const route = await createSessionRouteTestBuilder(routeCase.method, routeCase.path);
            const { reply, response } = await route.invoke({
                params: { sessionId: "s1" },
                headers,
                ...routeCase.request,
            });
            expect(reply.code).toHaveBeenCalledWith(503);
            expect(response).toEqual({
                error: "Plugin Session system record operation failed",
                code: "plugin_session_records_unavailable",
            });
        }
        expect(txSessionFindUnique).not.toHaveBeenCalled();
        expect(txSessionSystemRecordFindMany).not.toHaveBeenCalled();
        expect(txSessionSystemRecordFindFirst).not.toHaveBeenCalled();
        expect(txSessionSystemRecordCreate).not.toHaveBeenCalled();
    });

    it("rejects unmistakable v1 GET intent when the protocol header is absent or unsupported", async () => {
        const cases = [
            {
                path: "/v2/sessions/:sessionId/system-records",
                query: { owner: "host", namespace: "activity", limit: 1 },
            },
            {
                path: "/v2/sessions/:sessionId/system-records/record",
                query: {
                    owner: "host",
                    namespace: "activity",
                    kind: "workflow_run.v1",
                    localId: "workflow:run:wf-1",
                },
            },
        ] as const;

        for (const testCase of cases) {
            for (const headers of [{}, { "x-happier-session-system-records-protocol": "2" }]) {
                const route = await createSessionRouteTestBuilder("GET", testCase.path);
                const { reply, response } = await route.invoke({
                    params: { sessionId: "s1" },
                    headers,
                    query: testCase.query,
                });
                expect(reply.code).toHaveBeenCalledWith(400);
                expect(response).toEqual({ error: "Invalid parameters" });
            }
        }
        expect(txSessionFindUnique).not.toHaveBeenCalled();
        expect(txSessionSystemRecordFindMany).not.toHaveBeenCalled();
        expect(txSessionSystemRecordFindFirst).not.toHaveBeenCalled();
    });

    it("continues accepting genuine released legacy GET list and read shapes without a protocol header", async () => {
        txSessionFindUnique.mockResolvedValue({ encryptionMode: "plain", accountId: "u1" });
        txSessionSystemRecordFindMany.mockResolvedValue([]);
        txSessionSystemRecordFindFirst.mockResolvedValue(null);

        const listRoute = await createSessionRouteTestBuilder("GET", "/v2/sessions/:sessionId/system-records");
        const listed = await listRoute.invoke({
            params: { sessionId: "s1" },
            query: { namespace: "memory", limit: 1 },
        });
        expect(listed.reply.code).not.toHaveBeenCalledWith(400);
        expect(listed.response).toEqual({ records: [], nextCursor: null, hasNext: false });

        const readRoute = await createSessionRouteTestBuilder("GET", "/v2/sessions/:sessionId/system-records/record");
        const read = await readRoute.invoke({
            params: { sessionId: "s1" },
            query: { namespace: "memory", localId: "memory:synopsis:v1:missing" },
        });
        expect(read.reply.code).not.toHaveBeenCalledWith(400);
        expect(read.response).toEqual({ record: null });
    });

    it("rejects every v1 route before persistence when the host-stamped plugin id is absent", async () => {
        const headers = { "x-happier-session-system-records-protocol": "1" };
        const address = {
            owner: "host" as const,
            namespace: "activity" as const,
            kind: "workflow_run.v1" as const,
            localId: "workflow:run:wf-1",
        };
        const invocations = [
            await (await createSessionRouteTestBuilder(
                "GET",
                "/v2/sessions/:sessionId/system-records",
            )).invoke({
                params: { sessionId: "s1" },
                headers,
                query: { owner: "host", namespace: "activity" },
            }),
            await (await createSessionRouteTestBuilder(
                "GET",
                "/v2/sessions/:sessionId/system-records/record",
            )).invoke({ params: { sessionId: "s1" }, headers, query: address }),
            await (await createSessionRouteTestBuilder(
                "PUT",
                "/v2/sessions/:sessionId/system-records",
            )).invoke({
                params: { sessionId: "s1" },
                headers,
                body: {
                    address,
                    content: { t: "plain", v: summaryPayload() },
                    expectedRevision: null,
                },
            }),
            await (await createSessionRouteTestBuilder(
                "DELETE",
                "/v2/sessions/:sessionId/system-records/record",
            )).invoke({ params: { sessionId: "s1" }, headers, body: { address } }),
        ];

        for (const { reply, response } of invocations) {
            expect(reply.code).toHaveBeenCalledWith(400);
            expect(response).toEqual({
                error: "Plugin Session system record operation failed",
                code: "plugin_session_record_invalid_query",
            });
        }
        expect(txSessionFindUnique).not.toHaveBeenCalled();
        expect(txSessionSystemRecordFindMany).not.toHaveBeenCalled();
        expect(txSessionSystemRecordFindFirst).not.toHaveBeenCalled();
        expect(txSessionSystemRecordCreate).not.toHaveBeenCalled();
    });

    it("writes a plugin-owned record under the host-stamped plugin identity", async () => {
        const createdAt = new Date("2026-08-04T10:00:00.000Z");
        const address = {
            owner: "plugin" as const,
            namespace: "notes",
            kind: "entry.v1",
            localId: "note:one",
        };
        const content = { t: "plain" as const, v: { title: "One" } };
        const keys = deriveSessionSystemRecordAddressKeys({
            ownerKind: "plugin",
            pluginId: "acme.notes",
            namespace: address.namespace,
            localId: address.localId,
        });
        txSessionFindUnique.mockResolvedValue({ encryptionMode: "plain", accountId: "session-owner" });
        txSessionSystemRecordFindFirst.mockResolvedValue(null);
        txSessionSystemRecordCreate.mockResolvedValue({
            id: "plugin-record-1",
            accountId: "u1",
            sessionId: "s1",
            ownerKind: "plugin",
            pluginId: "acme.notes",
            namespace: address.namespace,
            kind: address.kind,
            localId: address.localId,
            content,
            ...keys,
            version: 1,
            createdAt,
            updatedAt: createdAt,
        });
        const route = await createSessionRouteTestBuilder(
            "PUT",
            "/v2/sessions/:sessionId/system-records",
        );
        const { reply, response } = await route.invoke({
            params: { sessionId: "s1" },
            headers: {
                "x-happier-session-system-records-protocol": "1",
                "x-happier-plugin-id": "acme.notes",
            },
            body: {
                address,
                content,
                expectedRevision: null,
            },
        });

        expect(reply.code).not.toHaveBeenCalled();
        expect(response).toEqual(expect.objectContaining({
            record: expect.objectContaining({
                id: "plugin-record-1",
                address,
                content,
                revision: expect.stringMatching(/^ssr1\./),
            }),
        }));
        expect(txSessionSystemRecordCreate).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                accountId: "u1",
                ownerKind: "plugin",
                pluginId: "acme.notes",
                namespace: "notes",
                kind: "entry.v1",
                localId: "note:one",
            }),
        }));
    });

    it("upserts an accessible plain memory record without transcript side effects", async () => {
        const createdAt = new Date("2026-05-19T10:00:00.000Z");
        txSessionFindUnique.mockResolvedValue({ encryptionMode: "plain" });
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
                ownerKind: "host",
                pluginId: null,
                namespaceAddressKey: Uint8Array.from(Buffer.from(
                    "94f924d4d5cfbf803c112a9b5276f3f803072a910317f49242f1fb141c018f4b",
                    "hex",
                )),
                recordAddressKey: Uint8Array.from(Buffer.from(
                    "e392cc5a0cfa42d49f1111df9ef44ee9fbdc37369c50824d5342abe3276c114a",
                    "hex",
                )),
                version: 1,
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

    it("preserves predecessor trimming semantics for padded local ids", async () => {
        const createdAt = new Date("2026-05-19T10:00:00.000Z");
        const paddedLocalId = "  memory:synopsis:v1:padded  ";
        const trimmedLocalId = paddedLocalId.trim();
        txSessionFindUnique.mockResolvedValue({ encryptionMode: "plain", accountId: "u1" });
        txSessionSystemRecordCreate.mockResolvedValue({
            id: "rec-padded",
            accountId: "u1",
            sessionId: "s1",
            namespace: "memory",
            kind: "synopsis.v1",
            localId: trimmedLocalId,
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
                localId: paddedLocalId,
                content: { t: "plain", v: synopsisPayload() },
            },
        });

        expect(txSessionSystemRecordCreate).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ localId: trimmedLocalId }),
        }));
        expect(res).toEqual(expect.objectContaining({
            record: expect.objectContaining({ localId: trimmedLocalId }),
        }));
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
        txSessionSystemRecordFindFirst.mockResolvedValue({
            id: "rec-existing",
            accountId: "u1",
            sessionId: "s1",
            namespace: "memory",
            kind: "synopsis.v1",
            localId: "memory:shared",
            content: { t: "plain", v: synopsisPayload() },
            ...persistedHostAddress("memory", "memory:shared"),
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
                ...persistedHostAddress("memory", "memory:synopsis:v1:2"),
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
                OR: [{
                    accountId: "u1",
                    recordAddressKey: persistedHostAddress(
                        "memory",
                        "memory:synopsis:v1:2",
                    ).recordAddressKey,
                    kind: { in: ["synopsis.v1"] },
                }],
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
        txSessionSystemRecordFindFirst.mockResolvedValue({
            id: "rec-1",
            accountId: "u1",
            sessionId: "s1",
            namespace: "memory",
            kind: "synopsis.v1",
            localId: "memory:synopsis:v1:2",
            content: { t: "plain", v: synopsisPayload() },
            ...persistedHostAddress("memory", "memory:synopsis:v1:2"),
            createdAt,
            updatedAt: createdAt,
        });

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions/:sessionId/system-records/record");
        const { response: res } = await route.invoke({
            params: { sessionId: "s1" },
            query: { namespace: "memory", localId: "memory:synopsis:v1:2" },
        });

        expect(txSessionSystemRecordFindFirst).toHaveBeenCalledWith(expect.objectContaining({
            where: {
                accountId: "u1",
                sessionId: "s1",
                recordAddressKey: persistedHostAddress("memory", "memory:synopsis:v1:2").recordAddressKey,
                session: { is: expect.objectContaining({ id: "s1" }) },
            },
        }));
        expect(res).toEqual({
            record: expect.objectContaining({
                id: "rec-1",
                localId: "memory:synopsis:v1:2",
            }),
        });
    });

    it("decodes a canonical stored row whose local id predates the author-v1 bound", async () => {
        const createdAt = new Date("2026-05-19T10:00:00.000Z");
        const longLocalId = `legacy:${"x".repeat(300)}`;
        txSessionFindUnique.mockResolvedValue({ encryptionMode: "plain", accountId: "u1" });
        txSessionSystemRecordFindFirst.mockResolvedValueOnce({
            id: "rec-long",
            accountId: "u1",
            sessionId: "s1",
            namespace: "memory",
            kind: "synopsis.v1",
            localId: longLocalId,
            content: { t: "plain", v: synopsisPayload() },
            ...persistedHostAddress("memory", longLocalId),
            createdAt,
            updatedAt: createdAt,
        });

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions/:sessionId/system-records/record");
        const { response: res } = await route.invoke({
            params: { sessionId: "s1" },
            query: { namespace: "memory", localId: longLocalId },
        });

        expect(txSessionSystemRecordFindFirst).toHaveBeenCalledTimes(1);
        expect(txSessionSystemRecordFindFirst).toHaveBeenCalledWith(expect.objectContaining({
            where: {
                accountId: "u1",
                sessionId: "s1",
                recordAddressKey: persistedHostAddress("memory", longLocalId).recordAddressKey,
                session: { is: expect.objectContaining({ id: "s1" }) },
            },
        }));
        expect(res).toEqual({
            record: expect.objectContaining({
                id: "rec-long",
                localId: longLocalId,
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
            ...persistedHostAddress("memory", "memory:synopsis:v1:2"),
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
                kind: "synopsis.v1",
                namespaceAddressKey: persistedHostAddress(
                    "memory",
                    "memory:synopsis:v1:2",
                ).namespaceAddressKey,
                session: { is: expect.objectContaining({ id: "s1" }) },
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
