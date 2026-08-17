import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { withAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { sessionRoutes } from "./sessionRoutes";

describe("session historical transcript import route (SQLite integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-session-historical-import-route-",
            initAuth: false,
        });
    }, 120_000);

    afterAll(async () => {
        if (harness) await harness.close();
    });

    beforeEach(() => {
        vi.resetModules();
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
        });
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.sessionTurnMutationReceipt.deleteMany(),
            () => db.sessionTurn.deleteMany(),
            () => db.sessionPendingMessage.deleteMany(),
            () => db.sessionMessage.deleteMany(),
            () => db.sessionShare.deleteMany(),
            () => db.accountChange.deleteMany(),
            () => db.session.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    async function createFixture(params?: Readonly<{
        currentStorageState?: string;
    }>) {
        const account = await db.account.create({
            data: {
                publicKey: `historical-import-route-${crypto.randomUUID()}`,
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                accountId: account.id,
                tag: `historical-import-route-${crypto.randomUUID()}`,
                encryptionMode: "plain",
                metadata: JSON.stringify({}),
                currentStorageState: params?.currentStorageState ?? "hosted",
            },
            select: { id: true },
        });
        return { account, session };
    }

    it("writes an action import through the historical batch with closed history provenance and no input, Pending, turn, attention, badge, or participant effects", async () => {
        const { account, session } = await createFixture();

        await withAuthenticatedTestApp(
            (app) => sessionRoutes(app),
            async (app) => {
                const response = await app.inject({
                    method: "POST",
                    url: `/v2/sessions/${session.id}/transcript/import`,
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": account.id,
                    },
                    payload: {
                        items: [
                            {
                                localId: "history:user",
                                content: {
                                    t: "plain",
                                    v: { role: "user", content: { type: "text", text: "source fact" } },
                                },
                            },
                            {
                                localId: "history:agent",
                                content: {
                                    t: "plain",
                                    v: { role: "agent", content: { type: "text", text: "history reply" } },
                                },
                            },
                        ],
                    },
                });

                expect(response.statusCode).toBe(200);
                expect(response.json()).toEqual({ imported: 2, cursor: 2 });
            },
        );

        await expect(db.sessionMessage.findMany({
            where: { sessionId: session.id },
            orderBy: { seq: "asc" },
            select: {
                localId: true,
                seq: true,
                messageRole: true,
                inputAdmissionReceipt: true,
                requestEqualityEvidenceV1: true,
                transcriptObservationProvenance: true,
            },
        })).resolves.toEqual([
            {
                localId: "history:user",
                seq: 1,
                messageRole: "user",
                inputAdmissionReceipt: null,
                requestEqualityEvidenceV1: null,
                transcriptObservationProvenance: { kind: "non_dependent", source: "history" },
            },
            {
                localId: "history:agent",
                seq: 2,
                messageRole: "agent",
                inputAdmissionReceipt: null,
                requestEqualityEvidenceV1: null,
                transcriptObservationProvenance: { kind: "non_dependent", source: "history" },
            },
        ]);
        await expect(db.sessionPendingMessage.count({ where: { sessionId: session.id } })).resolves.toBe(0);
        await expect(db.sessionTurn.count({ where: { sessionId: session.id } })).resolves.toBe(0);
        await expect(db.accountChange.count({ where: { accountId: account.id } })).resolves.toBe(0);
        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: {
                seq: true,
                pendingCount: true,
                pendingBlockedCount: true,
                pendingQueueSeq: true,
                latestTurnId: true,
                latestReadyEventSeq: true,
                lastViewedSessionSeq: true,
            },
        })).resolves.toEqual({
            seq: 2,
            pendingCount: 0,
            pendingBlockedCount: 0,
            pendingQueueSeq: 0,
            latestTurnId: null,
            latestReadyEventSeq: null,
            lastViewedSessionSeq: null,
        });
    });

    it.each([
        "machine_only",
        "server_partial",
        "snapshot_complete",
        "legacy_external_unknown",
    ])("rejects direct adapter writes while External Sessions storage is %s", async (currentStorageState) => {
        const { account, session } = await createFixture({ currentStorageState });

        await withAuthenticatedTestApp(
            (app) => sessionRoutes(app),
            async (app) => {
                const response = await app.inject({
                    method: "POST",
                    url: `/v2/sessions/${session.id}/transcript/import`,
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": account.id,
                    },
                    payload: {
                        items: [{
                            localId: `history:${currentStorageState}`,
                            content: {
                                t: "plain",
                                v: { role: "agent", content: { type: "text", text: "must remain operation-owned" } },
                            },
                        }],
                    },
                });

                expect(response.statusCode).toBe(400);
                expect(response.json()).toMatchObject({
                    error: "Invalid parameters",
                    code: "external_session_operation_required",
                });
            },
        );

        await expect(db.sessionMessage.count({ where: { sessionId: session.id } })).resolves.toBe(0);
        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { seq: true, currentStorageState: true },
        })).resolves.toEqual({ seq: 0, currentStorageState });
    });

    /**
     * The reserved Agent-transition divider namespace, attacked from the weakest
     * authority this route accepts.
     *
     * `/transcript/import` authorizes ordinary edit/admin collaborators, not just
     * the Session owner, and takes any non-empty `localId`. A collaborator who
     * could plant `agent-transition:<inputLocalId>` would permanently conflict
     * with the owner-only transition on that Session — a durable denial of the
     * feature caused by a non-owner. Both storage modes are exercised because the
     * server can decrypt neither an E2EE divider nor an E2EE forgery: the guard
     * must be a localId decision, never a content decision.
     */
    async function createSharedEditorFixture(params?: Readonly<{ encryptionMode?: string }>) {
        const owner = await db.account.create({
            data: {
                publicKey: `historical-import-owner-${crypto.randomUUID()}`,
                encryptionMode: params?.encryptionMode ?? "plain",
            },
            select: { id: true },
        });
        const collaborator = await db.account.create({
            data: {
                publicKey: `historical-import-editor-${crypto.randomUUID()}`,
                encryptionMode: params?.encryptionMode ?? "plain",
            },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: `historical-import-shared-${crypto.randomUUID()}`,
                encryptionMode: params?.encryptionMode ?? "plain",
                metadata: JSON.stringify({}),
                currentStorageState: "hosted",
            },
            select: { id: true },
        });
        await db.sessionShare.create({
            data: {
                sessionId: session.id,
                sharedByUserId: owner.id,
                sharedWithUserId: collaborator.id,
                accessLevel: "edit",
            },
        });
        return { owner, collaborator, session };
    }

    it("refuses a shared editor's reserved divider localId on a plaintext Session", async () => {
        const { owner, collaborator, session } = await createSharedEditorFixture();

        await withAuthenticatedTestApp(
            (app) => sessionRoutes(app),
            async (app) => {
                // Control: the same collaborator CAN import ordinary history, so
                // the refusal below is the namespace, not the authorization.
                const allowed = await app.inject({
                    method: "POST",
                    url: `/v2/sessions/${session.id}/transcript/import`,
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": collaborator.id,
                    },
                    payload: {
                        items: [{
                            localId: "history:collaborator",
                            content: {
                                t: "plain",
                                v: { role: "user", content: { type: "text", text: "ordinary" } },
                            },
                        }],
                    },
                });
                expect(allowed.statusCode).toBe(200);

                const attack = await app.inject({
                    method: "POST",
                    url: `/v2/sessions/${session.id}/transcript/import`,
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": collaborator.id,
                    },
                    payload: {
                        items: [{
                            localId: "agent-transition:victim-local-id",
                            content: {
                                t: "plain",
                                v: { role: "agent", content: { type: "text", text: "forged divider" } },
                            },
                        }],
                    },
                });

                expect(attack.statusCode).toBe(400);
                expect(attack.json()).toEqual({
                    error: "Invalid parameters",
                    code: "session_message_reserved_local_id",
                });
            },
        );

        await expect(db.sessionMessage.findMany({
            where: { sessionId: session.id },
            select: { localId: true },
        })).resolves.toEqual([{ localId: "history:collaborator" }]);
        await expect(db.accountChange.count({ where: { accountId: owner.id } })).resolves.toBe(0);
    });

    it("refuses a shared editor's reserved divider localId on an E2EE Session", async () => {
        const { session, collaborator } = await createSharedEditorFixture({ encryptionMode: "e2ee" });

        await withAuthenticatedTestApp(
            (app) => sessionRoutes(app),
            async (app) => {
                const attack = await app.inject({
                    method: "POST",
                    url: `/v2/sessions/${session.id}/transcript/import`,
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": collaborator.id,
                    },
                    payload: {
                        items: [{
                            localId: "agent-transition:victim-local-id",
                            content: { t: "encrypted", c: "b3BhcXVlLWZvcmdlZC1kaXZpZGVy" },
                        }],
                    },
                });

                expect(attack.statusCode).toBe(400);
                expect(attack.json()).toEqual({
                    error: "Invalid parameters",
                    code: "session_message_reserved_local_id",
                });
            },
        );

        await expect(db.sessionMessage.count({ where: { sessionId: session.id } })).resolves.toBe(0);
    });

    it("atomically rejects a two-item import when a later historical identity conflicts", async () => {
        const { account, session } = await createFixture();
        await db.sessionMessage.create({
            data: {
                sessionId: session.id,
                localId: "history:existing",
                seq: 1,
                messageRole: "agent",
                content: { t: "plain", v: { role: "agent", content: { type: "text", text: "original" } } },
            },
        });
        await db.session.update({
            where: { id: session.id },
            data: { seq: 1 },
        });

        await withAuthenticatedTestApp(
            (app) => sessionRoutes(app),
            async (app) => {
                const response = await app.inject({
                    method: "POST",
                    url: `/v2/sessions/${session.id}/transcript/import`,
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": account.id,
                    },
                    payload: {
                        items: [
                            {
                                localId: "history:new",
                                content: {
                                    t: "plain",
                                    v: { role: "user", content: { type: "text", text: "must not persist" } },
                                },
                            },
                            {
                                localId: "history:existing",
                                content: {
                                    t: "plain",
                                    v: { role: "agent", content: { type: "text", text: "conflict" } },
                                },
                            },
                        ],
                    },
                });

                expect(response.statusCode).toBe(400);
                expect(response.json()).toMatchObject({
                    error: "Invalid parameters",
                    code: "stable-item-conflict",
                });
            },
        );

        await expect(db.sessionMessage.findMany({
            where: { sessionId: session.id },
            orderBy: { seq: "asc" },
            select: { localId: true, seq: true },
        })).resolves.toEqual([{ localId: "history:existing", seq: 1 }]);
        await expect(db.sessionPendingMessage.count({ where: { sessionId: session.id } })).resolves.toBe(0);
        await expect(db.sessionTurn.count({ where: { sessionId: session.id } })).resolves.toBe(0);
        await expect(db.accountChange.count({ where: { accountId: account.id } })).resolves.toBe(0);
        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: {
                seq: true,
                pendingCount: true,
                pendingBlockedCount: true,
                pendingQueueSeq: true,
                latestTurnId: true,
                latestReadyEventSeq: true,
                lastViewedSessionSeq: true,
            },
        })).resolves.toEqual({
            seq: 1,
            pendingCount: 0,
            pendingBlockedCount: 0,
            pendingQueueSeq: 0,
            latestTurnId: null,
            latestReadyEventSeq: null,
            lastViewedSessionSeq: null,
        });
    });
});
