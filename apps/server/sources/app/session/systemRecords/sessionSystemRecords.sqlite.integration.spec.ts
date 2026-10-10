import { SESSION_WORKFLOW_RUN_SNAPSHOT_PROJECTION_VERSION } from "@happier-dev/protocol";
import { randomUUID } from "node:crypto";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import { sessionRoutes } from "@/app/api/routes/session/sessionRoutes";
import { registerSessionSystemRecordRoutes } from "@/app/api/routes/session/registerSessionSystemRecordRoutes";
import { setHomeSettings } from "@/app/home/settings/homeSettings";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createPresentUserSessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication.testkit";
import { deriveSessionSystemRecordAddressKeys } from "./sessionSystemRecordAddressKeys";
import { runSessionSystemRecordBackfillOperator } from "./sessionSystemRecordBackfillOperator";
import {
    initializeSessionSystemRecordsProtocolV1Activation,
    resetSessionSystemRecordsProtocolV1ActivationForTests,
} from "./sessionSystemRecordProtocolContract";
import {
    deleteSessionSystemRecordV1,
    getSessionSystemRecord,
    upsertSessionSystemRecord,
    upsertSessionSystemRecordV1,
} from "./sessionSystemRecordService";

const authentication = createPresentUserSessionAccessAuthentication();


async function createAccountAndSession(suffix: string) {
    const account = await db.account.create({
        data: { publicKey: `ssr-sqlite-${suffix}`, encryptionMode: "plain" },
        select: { id: true },
    });
    const session = await db.session.create({
        data: {
            accountId: account.id,
            tag: `ssr-sqlite-${suffix}`,
            encryptionMode: "plain",
            metadata: "{}",
        },
        select: { id: true },
    });
    return { account, session };
}

describe("SessionSystemRecord CONTRACT on SQLite", () => {
    let harness: LightSqliteHarness | undefined;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-session-system-record-contract-",
            initAuth: false,
            env: {
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
                HAPPIER_FEATURE_SESSIONS_BOARD__ENABLED: "1",
            },
        });
        await expect(initializeSessionSystemRecordsProtocolV1Activation(db)).resolves.toBe(true);
    }, 300_000);

    afterAll(async () => {
        resetSessionSystemRecordsProtocolV1ActivationForTests();
        await harness?.close();
    });

    it("requires authentication before Board mutation handling", async () => {
        const app = Fastify().withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        app.decorate("authenticate", async (_request: FastifyRequest, reply: FastifyReply) => reply.code(401).send({ error: "Unauthorized" }));
        sessionRoutes(app);
        try {
            const response = await app.inject({ method: "PUT", url: "/v2/sessions/not-authorized/board", payload: {
                operation: "update_layout", expectedLayoutRevision: null,
                layoutContent: { t: "plain", v: { v: 1, tabs: [] } },
            } });
            expect(response.statusCode).toBe(401);
            expect(await db.sessionSystemRecord.count()).toBe(0);
        } finally {
            await app.close();
        }
    });

    it("creates, updates and removes transcript content without changing an unrelated Board layout", async () => {
        const { account, session } = await createAccountAndSession(`transcript-${randomUUID()}`);
        const app = Fastify().withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        app.decorate("authenticate", async (request: FastifyRequest) => { request.userId = account.id; request.authAuthority = "present_user"; });
        sessionRoutes(app);
        const url = `/v2/sessions/${session.id}/board`;
        const layoutContent = { t: "plain", v: { v: 1, tabs: [{ id: "overview", title: "Overview", items: [] }] } };
        const itemContent = { t: "plain", v: { v: 1, destination: "transcript", title: "Result", frame: "frameless",
            height: { mode: "auto", fallback: "regular" }, source: { kind: "declarative", document: { version: 1, root: { kind: "markdown", text: "Hello" } } } } };
        const previousBoardEnabled = process.env.HAPPIER_FEATURE_SESSIONS_BOARD__ENABLED;
        try {
            const layout = await app.inject({ method: "PUT", url, payload: { operation: "update_layout", layoutContent, expectedLayoutRevision: null } });
            expect(layout.statusCode).toBe(200);
            process.env.HAPPIER_FEATURE_SESSIONS_BOARD__ENABLED = "0";
            const created = await app.inject({ method: "PUT", url, payload: { operation: "upsert_item", destination: "transcript", itemId: "visual", itemContent, expectedItemRevision: null } });
            expect(created.statusCode, created.body).toBe(200);
            const updated = await app.inject({ method: "PUT", url, payload: { operation: "upsert_item", itemId: "visual", itemContent: { ...itemContent, v: { ...itemContent.v, title: "Changed" } }, expectedItemRevision: created.json().itemRevision } });
            expect(updated.statusCode, updated.body).toBe(200);
            const stale = await app.inject({ method: "PUT", url, payload: { operation: "upsert_item", itemId: "visual", itemContent, expectedItemRevision: created.json().itemRevision } });
            expect(stale.statusCode).toBe(409);
            const removed = await app.inject({ method: "PUT", url, payload: { operation: "remove_item", itemId: "visual", expectedItemRevision: updated.json().itemRevision } });
            expect(removed.statusCode, removed.body).toBe(200);
            const rows = await db.sessionSystemRecord.findMany({ where: { sessionId: session.id } });
            expect(rows).toHaveLength(1);
            expect(rows[0]?.content).toEqual(layoutContent);
        } finally {
            if (previousBoardEnabled === undefined) delete process.env.HAPPIER_FEATURE_SESSIONS_BOARD__ENABLED;
            else process.env.HAPPIER_FEATURE_SESSIONS_BOARD__ENABLED = previousBoardEnabled;
            await app.close();
        }
    });

    it("atomically creates Board item and placement, replays exact bytes and rolls back layout conflicts", async () => {
        const { account, session } = await createAccountAndSession(`board-${randomUUID()}`);
        const app = Fastify().withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        app.decorate("authenticate", async (request: FastifyRequest) => { request.userId = account.id; request.authAuthority = "present_user"; });
        sessionRoutes(app);
        const itemContent = { t: "plain", v: { v: 1, destination: "both", title: "Note", frame: "card", height: { mode: "auto", fallback: "regular" }, source: { kind: "declarative", document: { version: 1, root: { kind: "markdown", text: "Hello" } } } } };
        const layoutContent = { t: "plain", v: { v: 1, tabs: [{ id: "overview", title: "Overview", items: [{ itemId: "note", width: "medium" }] }] } };
        const payload = { operation: "upsert_item", destination: "both", itemId: "note", itemContent, expectedItemRevision: null, placement: { layoutContent, expectedLayoutRevision: null } };
        try {
            const created = await app.inject({ method: "PUT", url: `/v2/sessions/${session.id}/board`, payload });
            expect(created.statusCode, created.body).toBe(200);
            expect(created.json()).toMatchObject({ operation: "upsert_item", outcome: "created", itemId: "note" });
            const replay = await app.inject({ method: "PUT", url: `/v2/sessions/${session.id}/board`, payload });
            expect(replay.statusCode).toBe(200);
            expect(replay.json().itemRevision).toBe(created.json().itemRevision);
            const conflict = await app.inject({ method: "PUT", url: `/v2/sessions/${session.id}/board`, payload: {
                ...payload, itemContent: { ...itemContent, v: { ...itemContent.v, title: "Changed" } }, expectedItemRevision: created.json().itemRevision,
                placement: { ...payload.placement, layoutContent: { t: "plain", v: { v: 1, tabs: [] } } },
            } });
            expect(conflict.statusCode).toBe(409);
            const rows = await db.sessionSystemRecord.findMany({ where: { sessionId: session.id } });
            expect(rows).toHaveLength(2);
            expect(rows.find(row => row.localId === "note")?.content).toEqual(itemContent);
            const removal = { operation: "remove_item", itemId: "note", expectedItemRevision: created.json().itemRevision,
                layoutContent: { t: "plain", v: { v: 1, tabs: [] } }, expectedLayoutRevision: created.json().layoutRevision };
            const removed = await app.inject({ method: "PUT", url: `/v2/sessions/${session.id}/board`, payload: removal });
            expect(removed.statusCode).toBe(200);
            const removeReplay = await app.inject({ method: "PUT", url: `/v2/sessions/${session.id}/board`, payload: removal });
            expect(removeReplay.json()).toEqual(removed.json());
            const changedLayout = await app.inject({ method: "PUT", url: `/v2/sessions/${session.id}/board`, payload: {
                operation: "update_layout", layoutContent: { t: "plain", v: { v: 1, tabs: [{ id: "other", title: "Other", items: [] }] } },
                expectedLayoutRevision: removed.json().layoutRevision,
            } });
            expect(changedLayout.statusCode).toBe(200);
            const staleRemove = await app.inject({ method: "PUT", url: `/v2/sessions/${session.id}/board`, payload: removal });
            expect(staleRemove.statusCode).toBe(409);

            const recreated = await app.inject({ method: "PUT", url: `/v2/sessions/${session.id}/board`, payload: {
                ...payload,
                placement: { layoutContent, expectedLayoutRevision: changedLayout.json().layoutRevision },
            } });
            expect(recreated.statusCode).toBe(200);
            expect(recreated.json().itemRevision).not.toBe(created.json().itemRevision);
            const removeRecreated = await app.inject({ method: "PUT", url: `/v2/sessions/${session.id}/board`, payload: {
                ...removal, expectedLayoutRevision: recreated.json().layoutRevision,
            } });
            expect(removeRecreated.statusCode).toBe(409);
            expect(await db.sessionSystemRecord.count({ where: { sessionId: session.id, localId: "note" } })).toBe(1);

        } finally { await app.close(); }
    });

    it("atomically validates an item.place participant and never commits a dangling placement", async () => {
        const { account, session } = await createAccountAndSession(`board-place-${randomUUID()}`);
        const app = Fastify().withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        app.decorate("authenticate", async (request: FastifyRequest) => { request.userId = account.id; request.authAuthority = "present_user"; });
        sessionRoutes(app);
        const url = `/v2/sessions/${session.id}/board`;
        const itemContent = { t: "plain", v: { v: 1, title: "Note", frame: "card", height: { mode: "auto", fallback: "regular" },
            source: { kind: "declarative", document: { version: 1, root: { kind: "markdown", text: "Hello" } } } } };
        const initialLayout = { t: "plain", v: { v: 1, tabs: [
            { id: "overview", title: "Overview", items: [{ itemId: "note", width: "medium" }] },
            { id: "details", title: "Details", items: [] },
        ] } };
        try {
            const created = await app.inject({ method: "PUT", url, payload: {
                operation: "upsert_item", itemId: "note", expectedItemRevision: null, itemContent,
                placement: { expectedLayoutRevision: null, layoutContent: initialLayout },
            } });
            expect(created.statusCode, created.body).toBe(200);

            const danglingLayout = { t: "plain", v: { ...initialLayout.v, tabs: initialLayout.v.tabs.map(tab => tab.id === "details"
                ? { ...tab, items: [{ itemId: "missing", width: "wide" }] }
                : tab) } };
            const missing = await app.inject({ method: "PUT", url, payload: {
                operation: "update_layout", expectedLayoutRevision: created.json().layoutRevision,
                layoutContent: danglingLayout,
                itemPlacementParticipant: { itemId: "missing", expectedItemRevision: created.json().itemRevision },
            } });
            expect(missing.statusCode, missing.body).toBe(404);
            expect(missing.json()).toEqual({ error: "session_board_item_not_found" });
            expect((await db.sessionSystemRecord.findFirst({ where: { sessionId: session.id, localId: "layout" } }))?.content).toEqual(initialLayout);

            const placedLayout = { t: "plain", v: { ...initialLayout.v, tabs: initialLayout.v.tabs.map(tab => tab.id === "details"
                ? { ...tab, items: [{ itemId: "note", width: "wide" }] }
                : tab) } };
            const concurrentlyUpdated = await app.inject({ method: "PUT", url, payload: {
                operation: "upsert_item", itemId: "note", expectedItemRevision: created.json().itemRevision,
                itemContent: { ...itemContent, v: { ...itemContent.v, title: "Updated elsewhere" } },
            } });
            expect(concurrentlyUpdated.statusCode, concurrentlyUpdated.body).toBe(200);
            expect(concurrentlyUpdated.json().itemRevision).not.toBe(created.json().itemRevision);
            const staleParticipant = await app.inject({ method: "PUT", url, payload: {
                operation: "update_layout", expectedLayoutRevision: created.json().layoutRevision,
                layoutContent: placedLayout,
                itemPlacementParticipant: { itemId: "note", expectedItemRevision: created.json().itemRevision },
            } });
            expect(staleParticipant.statusCode, staleParticipant.body).toBe(409);
            expect(staleParticipant.json()).toMatchObject({ error: "session_board_revision_conflict" });
            expect((await db.sessionSystemRecord.findFirst({ where: { sessionId: session.id, localId: "layout" } }))?.content).toEqual(initialLayout);

            const removedLayout = { t: "plain", v: { ...initialLayout.v, tabs: initialLayout.v.tabs.map(tab => ({ ...tab, items: [] })) } };
            const [place, remove] = await Promise.all([
                app.inject({ method: "PUT", url, payload: {
                    operation: "update_layout", expectedLayoutRevision: created.json().layoutRevision,
                    layoutContent: placedLayout,
                    itemPlacementParticipant: { itemId: "note", expectedItemRevision: concurrentlyUpdated.json().itemRevision },
                } }),
                app.inject({ method: "PUT", url, payload: {
                    operation: "remove_item", itemId: "note", expectedItemRevision: concurrentlyUpdated.json().itemRevision,
                    expectedLayoutRevision: created.json().layoutRevision, layoutContent: removedLayout,
                } }),
            ]);
            expect([place.statusCode, remove.statusCode].filter(status => status === 200)).toHaveLength(1);
            expect([place.statusCode, remove.statusCode].filter(status => status !== 200).every(status => status === 404 || status === 409)).toBe(true);

            const rows = await db.sessionSystemRecord.findMany({ where: { sessionId: session.id }, select: { localId: true, content: true } });
            const itemExists = rows.some(row => row.localId === "note");
            const layout = rows.find(row => row.localId === "layout")?.content as typeof initialLayout | undefined;
            const isPlaced = layout?.v.tabs.some(tab => tab.items.some(entry => entry.itemId === "note")) === true;
            expect(isPlaced).toBe(itemExists);
        } finally {
            await app.close();
        }
    });

    it("keeps Plain item source authority immutable and removes every layout placement atomically", async () => {
        const { account, session } = await createAccountAndSession(`board-source-${randomUUID()}`);
        const app = Fastify().withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        app.decorate("authenticate", async (request: FastifyRequest) => { request.userId = account.id; request.authAuthority = "present_user"; });
        sessionRoutes(app);
        const url = `/v2/sessions/${session.id}/board`;
        const itemContent = { t: "plain", v: { v: 1, title: "Note", frame: "card", height: { mode: "auto", fallback: "regular" },
            source: { kind: "declarative", document: { version: 1, root: { kind: "markdown", text: "Hello" } } } } };
        const layoutContent = { t: "plain", v: { v: 1, tabs: [
            { id: "overview", title: "Overview", items: [{ itemId: "note", width: "medium" }] },
            { id: "details", title: "Details", items: [{ itemId: "note", width: "wide" }] },
        ] } };
        try {
            const created = await app.inject({ method: "PUT", url, payload: { operation: "upsert_item", itemId: "note",
                itemContent, expectedItemRevision: null, placement: { layoutContent, expectedLayoutRevision: null } } });
            expect(created.statusCode).toBe(200);
            const converted = await app.inject({ method: "PUT", url, payload: { operation: "upsert_item", itemId: "note",
                itemContent: { ...itemContent, v: { ...itemContent.v,
                    source: { kind: "widget", instance: { v: 1, id: "note",
                        definition: { kind: "installed", surface: { pluginId: "com.acme.test", localId: "dashboard" } },
                        bindings: {} } } } },
                expectedItemRevision: created.json().itemRevision } });
            expect(converted.statusCode).toBe(409);
            expect(converted.json().error).toBe("session_board_source_conflict");

            const removedLayout = { t: "plain", v: { v: 1, tabs: layoutContent.v.tabs.map(tab => ({ ...tab, items: [] })) } };
            const removed = await app.inject({ method: "PUT", url, payload: { operation: "remove_item", itemId: "note",
                expectedItemRevision: created.json().itemRevision, layoutContent: removedLayout,
                expectedLayoutRevision: created.json().layoutRevision } });
            expect(removed.statusCode).toBe(200);
            const rows = await db.sessionSystemRecord.findMany({ where: { sessionId: session.id }, select: { localId: true, content: true } });
            expect(rows).toEqual([{ localId: "layout", content: removedLayout }]);
        } finally {
            await app.close();
        }
    });

    it("recognizes typed-only surface records and refuses generic writes", async () => {
        const { account, session } = await createAccountAndSession(`surface-${randomUUID()}`);
        const result = await upsertSessionSystemRecordV1({ authentication,
            actorUserId: account.id, sessionId: session.id,
            address: { owner: "host", namespace: "surface", kind: "layout.v1", localId: "layout" },
            content: { t: "plain", v: { v: 1, tabs: [] } }, expectedRevision: null,
        });
        expect(result).toEqual({ ok: false, code: "plugin_session_record_forbidden" });
        await expect(deleteSessionSystemRecordV1({ authentication,
            actorUserId: account.id, sessionId: session.id,
            address: { owner: "host", namespace: "surface", kind: "layout.v1", localId: "layout" },
        })).resolves.toEqual({ ok: false, code: "plugin_session_record_forbidden" });
    });

    it("shares the owner's Board tuple, commits one concurrent CAS winner, and revokes editor writes", async () => {
        const { account, session } = await createAccountAndSession(`board-shared-${randomUUID()}`);
        const editor = await db.account.create({ data: { publicKey: `board-editor-${randomUUID()}`, encryptionMode: "plain" } });
        const share = await db.sessionShare.create({ data: { sessionId: session.id, sharedByUserId: account.id, sharedWithUserId: editor.id, accessLevel: "edit" } });
        let actorUserId = editor.id;
        const app = Fastify().withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        app.decorate("authenticate", async (request: FastifyRequest) => { request.userId = actorUserId; request.authAuthority = "present_user"; });
        sessionRoutes(app);
        const url = `/v2/sessions/${session.id}/board`;
        try {
            const created = await app.inject({ method: "PUT", url, payload: { operation: "update_layout", expectedLayoutRevision: null,
                layoutContent: { t: "plain", v: { v: 1, tabs: [] } } } });
            expect(created.statusCode).toBe(200);
            expect(await db.sessionSystemRecord.findMany({ where: { sessionId: session.id }, select: { accountId: true } })).toEqual([{ accountId: account.id }]);
            const changes = await db.accountChange.findMany({ where: { entityId: session.id, kind: "session" }, select: { accountId: true, hint: true } });
            expect(changes).toEqual(expect.arrayContaining([
                { accountId: account.id, hint: { v: 1, sessionSurfaces: true } },
                { accountId: editor.id, hint: { v: 1, sessionSurfaces: true } },
            ]));
            const attempts = await Promise.all(["first", "second"].map(id => app.inject({ method: "PUT", url, payload: {
                operation: "update_layout", expectedLayoutRevision: created.json().layoutRevision,
                layoutContent: { t: "plain", v: { v: 1, tabs: [{ id, title: id, items: [] }] } },
            } })));
            expect(attempts.map(response => response.statusCode).sort()).toEqual([200, 409]);
            const winner = attempts.find(response => response.statusCode === 200)!;
            await db.sessionShare.delete({ where: { id: share.id } });
            const revoked = await app.inject({ method: "PUT", url, payload: { operation: "update_layout", expectedLayoutRevision: winner.json().layoutRevision,
                layoutContent: { t: "plain", v: { v: 1, tabs: [] } } } });
            expect(revoked.statusCode).toBe(403);
            actorUserId = account.id;
            const owner = await app.inject({ method: "GET", url: `/v2/sessions/${session.id}/system-records/record`,
                headers: { "x-happier-session-system-records-protocol": "1" }, query: { owner: "host", namespace: "surface", kind: "layout.v1", localId: "layout" } });
            expect(owner.statusCode).toBe(200);
            expect(owner.json().record.revision).toBe(winner.json().layoutRevision);
            const legacy = await app.inject({ method: "GET", url: `/v2/sessions/${session.id}/system-records` });
            expect(legacy.statusCode).toBe(200);
            expect(legacy.json().records).toEqual([]);
            const legacyLookup = await app.inject({ method: "GET", url: `/v2/sessions/${session.id}/system-records/record`,
                query: { namespace: "surface", localId: "layout" } });
            expect(legacyLookup.statusCode, legacyLookup.body).toBe(400);
            expect(legacyLookup.json()).toEqual({ error: "Invalid parameters" });
            const legacyLatest = await app.inject({ method: "GET", url: `/v2/sessions/${session.id}/system-records/latest`,
                headers: { "x-happier-session-system-records-protocol": "1" },
                query: { namespace: "surface", kind: "layout.v1" } });
            expect(legacyLatest.statusCode, legacyLatest.body).toBe(400);
            expect(legacyLatest.json()).toEqual({ error: "Invalid parameters" });
            const malformedStrictLookup = await app.inject({ method: "GET", url: `/v2/sessions/${session.id}/system-records/record`,
                headers: { "x-happier-session-system-records-protocol": "1" },
                query: { owner: "host", namespace: "surface", kind: "layout.v1" } });
            expect(malformedStrictLookup.statusCode, malformedStrictLookup.body).toBe(400);
            expect(malformedStrictLookup.json()).toMatchObject({ code: "plugin_session_record_invalid_query" });
        } finally { await app.close(); }
    });

    it("keeps Board envelopes opaque, conflicts on different ciphertext, and rejects unauthorized or mismatched writes", async () => {
        const { account, session } = await createAccountAndSession(`board-encrypted-${randomUUID()}`);
        await db.session.update({ where: { id: session.id }, data: { encryptionMode: "e2ee" } });
        const outsider = await db.account.create({ data: { publicKey: `board-outsider-${randomUUID()}`, encryptionMode: "plain" } });
        let actorUserId = account.id;
        const app = Fastify().withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        // Authentication is the boundary; capability resolution and storage are real.
        app.decorate("authenticate", async (request: FastifyRequest) => { request.userId = actorUserId; request.authAuthority = "present_user"; });
        sessionRoutes(app);
        const url = `/v2/sessions/${session.id}/board`;
        const payload = { operation: "upsert_item", itemId: "encrypted-note", expectedItemRevision: null,
            itemContent: { t: "encrypted", c: "sealed-item" },
            placement: { layoutContent: { t: "encrypted", c: "sealed-layout" }, expectedLayoutRevision: null } };
        try {
            const created = await app.inject({ method: "PUT", url, payload });
            expect(created.statusCode).toBe(200);
            const replay = await app.inject({ method: "PUT", url, payload });
            expect(replay.statusCode).toBe(200);
            expect(replay.json().itemRevision).toBe(created.json().itemRevision);
            const resealed = await app.inject({ method: "PUT", url, payload: { ...payload, itemContent: { t: "encrypted", c: "different-seal" } } });
            expect(resealed.statusCode).toBe(409);
            expect(resealed.json().error).toBe("session_board_revision_conflict");
            const mismatch = await app.inject({ method: "PUT", url, payload: { operation: "update_layout",
                expectedLayoutRevision: created.json().layoutRevision, layoutContent: { t: "plain", v: { v: 1, tabs: [] } } } });
            expect(mismatch.statusCode).toBe(409);
            expect(mismatch.json().error).toBe("session_board_storage_mode_mismatch");
            // A retained row inconsistent with the persisted mode is not permission
            // to replace it with a new envelope, even when the incoming mode matches.
            await db.session.update({ where: { id: session.id }, data: { encryptionMode: "plain" } });
            const retainedMismatch = await app.inject({ method: "PUT", url, payload: { operation: "update_layout",
                expectedLayoutRevision: created.json().layoutRevision, layoutContent: { t: "plain", v: { v: 1, tabs: [] } } } });
            expect(retainedMismatch.statusCode).toBe(409);
            expect(retainedMismatch.json().error).toBe("session_board_storage_mode_mismatch");
            expect((await db.sessionSystemRecord.findFirst({ where: { sessionId: session.id, localId: "layout" } }))?.content).toEqual(payload.placement.layoutContent);
            await db.session.update({ where: { id: session.id }, data: { encryptionMode: "e2ee" } });
            actorUserId = outsider.id;
            const forbidden = await app.inject({ method: "PUT", url, payload });
            expect(forbidden.statusCode).toBe(403);
            expect(forbidden.json()).toEqual({ error: "session_board_forbidden" });
            expect(await db.sessionSystemRecord.count({ where: { sessionId: session.id } })).toBe(2);
        } finally { await app.close(); }
    });

    it("keeps a Board feature disabled after route admission distinct from denied edit capability", async () => {
        const { account, session } = await createAccountAndSession(`board-gate-race-${randomUUID()}`);
        await db.account.update({ where: { id: account.id }, data: { homeRole: "owner", status: "active" } });
        const outsider = await db.account.create({ data: { publicKey: `board-gate-outsider-${randomUUID()}`, encryptionMode: "plain" } });
        let actorUserId = account.id;
        let disableAfterAdmission = true;
        const app = Fastify().withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        app.decorate("authenticate", async (request: FastifyRequest) => { request.userId = actorUserId; request.authAuthority = "present_user"; });
        app.addHook("onRoute", (route) => {
            if (route.url !== "/v2/sessions/:sessionId/board") return;
            const preHandlers = Array.isArray(route.preHandler) ? route.preHandler : route.preHandler ? [route.preHandler] : [];
            route.preHandler = [...preHandlers, async () => {
                if (!disableAfterAdmission) return;
                disableAfterAdmission = false;
                // Schedule a real Home-owner write after the real feature prehandler
                // admits the request, but before Board opens its transaction.
                expect((await setHomeSettings({ actorAccountId: account.id, write: {
                    expectedRevision: 0, values: { HAPPIER_FEATURE_SESSIONS_BOARD__ENABLED: false },
                } })).status).toBe("applied");
            }];
        });
        sessionRoutes(app);
        const previous = process.env.HAPPIER_FEATURE_SESSIONS_BOARD__ENABLED;
        const request = { method: "PUT" as const, url: `/v2/sessions/${session.id}/board`, payload: {
            operation: "update_layout", expectedLayoutRevision: null, layoutContent: { t: "plain", v: { v: 1, tabs: [] } },
        } };
        try {
            // Leave the deployment switch unset so persisted Home settings decide.
            delete process.env.HAPPIER_FEATURE_SESSIONS_BOARD__ENABLED;
            const disabled = await app.inject(request);
            expect(disabled.statusCode).toBe(404);
            expect(disabled.json()).toEqual({ error: "not_found" });
            expect(await db.sessionSystemRecord.count({ where: { sessionId: session.id } })).toBe(0);

            expect((await setHomeSettings({ actorAccountId: account.id, write: {
                expectedRevision: 1, values: { HAPPIER_FEATURE_SESSIONS_BOARD__ENABLED: true },
            } })).status).toBe("applied");
            actorUserId = outsider.id;
            const denied = await app.inject(request);
            expect(denied.statusCode).toBe(403);
            expect(denied.json()).toEqual({ error: "session_board_forbidden" });
            expect(await db.sessionSystemRecord.count({ where: { sessionId: session.id } })).toBe(0);

            actorUserId = account.id;
            expect((await app.inject(request)).statusCode).toBe(200);
            expect(await db.sessionSystemRecord.count({ where: { sessionId: session.id } })).toBe(1);
        } finally {
            if (previous === undefined) delete process.env.HAPPIER_FEATURE_SESSIONS_BOARD__ENABLED;
            else process.env.HAPPIER_FEATURE_SESSIONS_BOARD__ENABLED = previous;
            await db.homeSettings.deleteMany({ where: { id: "home" } });
            await app.close();
        }
    });

    it("disables exact surface reads and namespace lists without disabling workflow or deleting stored records", async () => {
        const { account, session } = await createAccountAndSession(`board-gate-${randomUUID()}`);
        const app = Fastify().withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        app.decorate("authenticate", async (request: FastifyRequest) => { request.userId = account.id; request.authAuthority = "present_user"; });
        sessionRoutes(app);
        const headers = { "x-happier-session-system-records-protocol": "1" };
        const base = `/v2/sessions/${session.id}`;
        const previous = process.env.HAPPIER_FEATURE_SESSIONS_BOARD__ENABLED;
        try {
            const created = await app.inject({ method: "PUT", url: `${base}/board`, payload: {
                operation: "update_layout", expectedLayoutRevision: null, layoutContent: { t: "plain", v: { v: 1, tabs: [] } },
            } });
            expect(created.statusCode).toBe(200);
            process.env.HAPPIER_FEATURE_SESSIONS_BOARD__ENABLED = "0";
            const mutation = await app.inject({ method: "PUT", url: `${base}/board`, payload: {
                operation: "update_layout", expectedLayoutRevision: created.json().layoutRevision,
                layoutContent: { t: "plain", v: { v: 1, tabs: [{ id: "hidden", title: "Hidden", items: [] }] } },
            } });
            expect(mutation.statusCode).toBe(404);
            expect(mutation.json()).toEqual({ error: "not_found" });
            const list = await app.inject({ method: "GET", url: `${base}/system-records`, headers, query: { owner: "host", namespace: "surface" } });
            expect(list.statusCode).toBe(404);
            expect(list.json()).toEqual({
                error: "Plugin Session system record operation failed",
                code: "plugin_session_record_feature_disabled",
            });
            const read = await app.inject({ method: "GET", url: `${base}/system-records/record`, headers,
                query: { owner: "host", namespace: "surface", kind: "layout.v1", localId: "layout" } });
            expect(read.statusCode).toBe(404);
            expect(read.json()).toEqual({
                error: "Plugin Session system record operation failed",
                code: "plugin_session_record_feature_disabled",
            });
            const workflow = await app.inject({ method: "GET", url: `${base}/system-records`, headers, query: { owner: "host", namespace: "activity" } });
            expect(workflow.statusCode).toBe(200);
            expect(await db.sessionSystemRecord.count({ where: { sessionId: session.id } })).toBe(1);
        } finally {
            if (previous === undefined) delete process.env.HAPPIER_FEATURE_SESSIONS_BOARD__ENABLED;
            else process.env.HAPPIER_FEATURE_SESSIONS_BOARD__ENABLED = previous;
            await app.close();
        }
    });

    it("serves strict host CRUD without plugin identity while rejecting unattested plugin CRUD", async () => {
        const { account, session } = await createAccountAndSession(`http-${randomUUID()}`);
        const app = Fastify().withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        // Authentication is the external boundary; all record policy and persistence remain real.
        app.decorate("authenticate", async (request: FastifyRequest) => { request.userId = account.id; request.authAuthority = "present_user"; });
        registerSessionSystemRecordRoutes(app);
        const headers = { "x-happier-session-system-records-protocol": "1" };
        const base = `/v2/sessions/${session.id}/system-records`;
        const address = { owner: "host", namespace: "memory", kind: "synopsis.v1", localId: "synopsis" };
        const content = { t: "plain", v: { v: 1, seqTo: 1, updatedAtMs: 1, synopsis: "host" } };
        try {
            const created = await app.inject({ method: "PUT", url: base, headers, payload: { address, content, expectedRevision: null } });
            expect(created.statusCode).toBe(200);
            const revision = created.json().record.revision;
            const read = await app.inject({ method: "GET", url: `${base}/record`, headers, query: address });
            expect(read.statusCode).toBe(200);
            expect(read.json().record).toMatchObject({ address, content, revision });
            const list = await app.inject({ method: "GET", url: base, headers, query: { owner: "host", namespace: "memory" } });
            expect(list.statusCode).toBe(200);
            expect(list.json().records).toHaveLength(1);
            for (const request of [
                { method: "GET" as const, url: base, query: { owner: "plugin", namespace: "notes" } },
                { method: "GET" as const, url: `${base}/record`, query: { ...address, owner: "plugin" } },
                { method: "PUT" as const, url: base, payload: { address: { ...address, owner: "plugin" }, content, expectedRevision: null } },
                { method: "DELETE" as const, url: `${base}/record`, payload: { address: { ...address, owner: "plugin" }, expectedRevision: revision } },
            ]) {
                const rejected = await app.inject({ ...request, headers });
                expect(rejected.statusCode).toBe(400);
                expect(rejected.json().code).toBe("plugin_session_record_invalid_query");
            }
            const deleted = await app.inject({ method: "DELETE", url: `${base}/record`, headers, payload: { address, expectedRevision: revision } });
            expect(deleted.statusCode).toBe(200);
            expect(await db.sessionSystemRecord.count({ where: { sessionId: session.id } })).toBe(0);
        } finally {
            await app.close();
            await db.session.delete({ where: { id: session.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    }, 120_000);

    it("fails strict reads and lists closed when retained content disagrees with the Session encryption mode", async () => {
        for (const testCase of [
            { storedContent: { t: "plain" as const, v: { v: 1, seqTo: 1, updatedAtMs: 1, synopsis: "must-not-leak" } }, mismatchedMode: "e2ee" as const, matchingMode: "plain" as const },
            { storedContent: { t: "encrypted" as const, c: "sealed-must-not-leak" }, mismatchedMode: "plain" as const, matchingMode: "e2ee" as const },
        ]) {
            const { account, session } = await createAccountAndSession(`mode-read-${randomUUID()}`);
            const app = Fastify().withTypeProvider<ZodTypeProvider>();
            app.setValidatorCompiler(validatorCompiler);
            app.setSerializerCompiler(serializerCompiler);
            app.decorate("authenticate", async (request: FastifyRequest) => { request.userId = account.id; request.authAuthority = "present_user"; });
            registerSessionSystemRecordRoutes(app);
            const headers = { "x-happier-session-system-records-protocol": "1" };
            const base = `/v2/sessions/${session.id}/system-records`;
            const address = { owner: "host" as const, namespace: "memory" as const, kind: "synopsis.v1" as const, localId: "synopsis" };
            const keys = deriveSessionSystemRecordAddressKeys({ ownerKind: "host", pluginId: null, namespace: address.namespace, localId: address.localId });
            try {
                await db.session.update({ where: { id: session.id }, data: { encryptionMode: testCase.mismatchedMode } });
                await db.sessionSystemRecord.create({ data: {
                    accountId: account.id, sessionId: session.id,
                    ownerKind: "host", pluginId: null, namespace: address.namespace, kind: address.kind, localId: address.localId,
                    content: testCase.storedContent,
                    namespaceAddressKey: keys.namespaceAddressKey, recordAddressKey: keys.recordAddressKey, version: 1,
                } });
                const mismatchedRead = await app.inject({ method: "GET", url: `${base}/record`, headers, query: address });
                expect(mismatchedRead.statusCode).toBe(409);
                expect(mismatchedRead.json()).toEqual({
                    error: "Plugin Session system record operation failed",
                    code: "plugin_session_record_storage_mode_mismatch",
                });
                expect(mismatchedRead.body).not.toContain("must-not-leak");
                const mismatchedList = await app.inject({ method: "GET", url: base, headers, query: { owner: "host", namespace: "memory" } });
                expect(mismatchedList.statusCode).toBe(409);
                expect(mismatchedList.json().code).toBe("plugin_session_record_storage_mode_mismatch");
                expect(mismatchedList.body).not.toContain("must-not-leak");

                await db.session.update({ where: { id: session.id }, data: { encryptionMode: testCase.matchingMode } });
                const matchingRead = await app.inject({ method: "GET", url: `${base}/record`, headers, query: address });
                expect(matchingRead.statusCode).toBe(200);
                expect(matchingRead.json().record.content).toEqual(testCase.storedContent);
                const matchingList = await app.inject({ method: "GET", url: base, headers, query: { owner: "host", namespace: "memory" } });
                expect(matchingList.statusCode).toBe(200);
                expect(matchingList.json().records).toHaveLength(1);
            } finally {
                await app.close();
                await db.session.delete({ where: { id: session.id } });
                await db.account.delete({ where: { id: account.id } });
            }
        }
    }, 120_000);


    it("rejects activity mutations when a real editor share is downgraded after access preflight", async () => {
        const suffix = randomUUID();
        const { account, session } = await createAccountAndSession(`downgrade-${suffix}`);
        const editor = await db.account.create({ data: { publicKey: `ssr-editor-${suffix}`, encryptionMode: "plain" } });
        const share = await db.sessionShare.create({ data: {
            sessionId: session.id, sharedByUserId: account.id, sharedWithUserId: editor.id, accessLevel: "edit",
        } });
        const address = { owner: "host" as const, namespace: "activity" as const, kind: "workflow_run.v1" as const, localId: "activity:workflow_run:v1:downgrade" };
        const content = { t: "plain" as const, v: {
            v: 1, projectionVersion: SESSION_WORKFLOW_RUN_SNAPSHOT_PROJECTION_VERSION, runId: "downgrade", backendId: "claude", title: "Original", status: "active",
            recordRevision: "1", updatedAt: 1000, totalAgents: 0, completedAgents: 0, phases: [], agents: [],
        } };
        try {
            const created = await upsertSessionSystemRecordV1({ authentication,  actorUserId: account.id, sessionId: session.id, address, content });
            expect(created.ok).toBe(true);
            if (!created.ok) throw new Error("Expected initial activity record");
            const persistedBefore = await db.sessionSystemRecord.findUniqueOrThrow({ where: { id: created.record.id } });
            const operations = [
                () => upsertSessionSystemRecordV1({ authentication,  actorUserId: editor.id, sessionId: session.id, address, content: { ...content, v: { ...content.v, title: "Changed" } } }),
                () => upsertSessionSystemRecordV1({ authentication,  actorUserId: editor.id, sessionId: session.id, address, content }),
                () => upsertSessionSystemRecord({ authentication,  actorUserId: editor.id, sessionId: session.id, namespace: address.namespace, kind: address.kind, localId: address.localId, content }),
                () => deleteSessionSystemRecordV1({ authentication,  actorUserId: editor.id, sessionId: session.id, address }),
            ];
            const findUnique = db.session.findUnique.bind(db.session);
            for (const operation of operations) {
                await db.sessionShare.update({ where: { id: share.id }, data: { accessLevel: "edit" } });
                let downgraded = false;
                // Intercept only the database boundary; execute the real read before changing the persisted share.
                const read = vi.spyOn(db.session, "findUnique").mockImplementation((args) => {
                    const query = findUnique(args);
                    // Preserve Prisma's fluent client/PrismaPromise contract while
                    // intercepting fulfillment at this genuine database boundary.
                    return new Proxy(query, {
                        get(target, property, receiver) {
                            if (property !== "then") return Reflect.get(target, property, receiver);
                            return (...callbacks: Parameters<typeof query.then>) => query.then(async row => {
                                if (!downgraded && args.select?.shares) {
                                    downgraded = true;
                                    await db.sessionShare.update({ where: { id: share.id }, data: { accessLevel: "view" } });
                                }
                                return row;
                            }).then(...callbacks);
                        },
                    });
                });
                try {
                    const result = await operation();
                    expect(downgraded).toBe(true);
                    expect(result).toEqual("error" in result
                        ? { ok: false, error: "forbidden" }
                        : { ok: false, code: "plugin_session_record_forbidden" });
                    expect(await db.sessionSystemRecord.findUniqueOrThrow({ where: { id: created.record.id } })).toEqual(persistedBefore);
                } finally {
                    read.mockRestore();
                    // Prisma delegates compute methods through a proxy; restore the callable explicitly.
                    db.session.findUnique = findUnique;
                }
            }
        } finally {
            await db.session.delete({ where: { id: session.id } });
            await db.account.deleteMany({ where: { id: { in: [account.id, editor.id] } } });
        }
    }, 120_000);

    it("materializes final required address columns and canonical indexes", async () => {
        const columns = await db.$queryRawUnsafe<Array<{ name: string; notnull: bigint | number }>>(
            'PRAGMA table_info("SessionSystemRecord")',
        );
        const byName = new Map(columns.map((column) => [column.name, Number(column.notnull)]));
        expect(byName.get("ownerKind")).toBe(1);
        expect(byName.get("pluginId")).toBe(0);
        expect(byName.get("namespaceAddressKey")).toBe(1);
        expect(byName.get("recordAddressKey")).toBe(1);
        expect(byName.get("version")).toBe(1);

        const indexes = await db.$queryRawUnsafe<Array<{ name: string }>>(
            'PRAGMA index_list("SessionSystemRecord")',
        );
        const names = indexes.map((index) => index.name);
        expect(names).toContain("SessionSystemRecord_account_session_record_key");
        expect(names).toContain("SessionSystemRecord_account_namespace_kind_updated_idx");
        expect(names).not.toContain("SessionSystemRecord_accountId_sessionId_namespace_localId_key");
        expect(names).not.toContain("SessionSystemRecord_account_kind_updated_idx");
    });

    it("reads a canonical stored host row whose local id predates the author-v1 bound", async () => {
        const suffix = randomUUID();
        const longLocalId = `legacy:${"x".repeat(300)}`;
        const { account, session } = await createAccountAndSession(`long-${suffix}`);
        try {
            const keys = deriveSessionSystemRecordAddressKeys({
                ownerKind: "host",
                pluginId: null,
                namespace: "memory",
                localId: longLocalId,
            });
            await db.sessionSystemRecord.create({
                data: {
                    accountId: account.id,
                    sessionId: session.id,
                    namespace: "memory",
                    kind: "synopsis.v1",
                    localId: longLocalId,
                    content: {
                        t: "plain",
                        v: { v: 1, seqTo: 1, updatedAtMs: 1, synopsis: "legacy long id" },
                    },
                    ownerKind: "host",
                    pluginId: null,
                    namespaceAddressKey: keys.namespaceAddressKey,
                    recordAddressKey: keys.recordAddressKey,
                    version: 1,
                },
            });

            await expect(getSessionSystemRecord({ authentication,
                actorUserId: account.id,
                sessionId: session.id,
                namespace: "memory",
                localId: longLocalId,
            })).resolves.toMatchObject({
                ok: true,
                record: { localId: longLocalId },
            });
        } finally {
            await db.session.delete({ where: { id: session.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    }, 120_000);

    it("audits canonical writes and fails closed on a derived-key mismatch", async () => {
        const suffix = randomUUID();
        const { account, session } = await createAccountAndSession(`audit-${suffix}`);
        const localId = `memory:synopsis:v1:${suffix}`;
        try {
            const created = await upsertSessionSystemRecord({ authentication,
                actorUserId: account.id,
                sessionId: session.id,
                namespace: "memory",
                kind: "synopsis.v1",
                localId,
                content: { t: "plain", v: { v: 1, seqTo: 1, updatedAtMs: 1, synopsis: "one" } },
            });
            expect(created).toMatchObject({ ok: true, didCreate: true });
            if (!created.ok) throw new Error("Expected canonical host record write to succeed");

            await expect(runSessionSystemRecordBackfillOperator({
                pageSize: 100,
                timeBudgetMs: 10_000,
            })).resolves.toMatchObject({
                outcome: "drained",
                processed: 0,
                updated: 0,
                audit: { nullRows: 0, mismatchedRows: 0 },
            });

            await db.sessionSystemRecord.update({
                where: { id: created.record.id },
                data: { recordAddressKey: Buffer.alloc(32, 0xa5) },
            });
            await expect(runSessionSystemRecordBackfillOperator({
                pageSize: 100,
                timeBudgetMs: 10_000,
            })).resolves.toMatchObject({
                outcome: "verification_failed",
                audit: { nullRows: 0, mismatchedRows: 1 },
            });
        } finally {
            await db.session.delete({ where: { id: session.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    }, 120_000);

    it("enforces plugin-qualified revision CAS and idempotent conditional delete", async () => {
        const suffix = randomUUID();
        const { account, session } = await createAccountAndSession(`plugin-${suffix}`);
        const address = {
            owner: "plugin" as const,
            namespace: "notes",
            kind: "entry.v1",
            localId: `note:${suffix}`,
        };
        try {
            const first = await upsertSessionSystemRecordV1({ authentication,
                actorUserId: account.id,
                sessionId: session.id,
                pluginId: "acme.notes",
                address,
                content: { t: "plain", v: { title: "One" } },
                expectedRevision: null,
            });
            expect(first).toMatchObject({ ok: true });
            if (!first.ok) throw new Error("Expected plugin record write to succeed");

            const updated = await upsertSessionSystemRecordV1({ authentication,
                actorUserId: account.id,
                sessionId: session.id,
                pluginId: "acme.notes",
                address,
                content: { t: "plain", v: { title: "Two" } },
                expectedRevision: first.record.revision,
            });
            expect(updated).toMatchObject({ ok: true });
            if (!updated.ok) throw new Error("Expected conditional plugin record update to succeed");

            await expect(deleteSessionSystemRecordV1({ authentication,
                actorUserId: account.id,
                sessionId: session.id,
                pluginId: "acme.notes",
                address,
                expectedRevision: first.record.revision,
            })).resolves.toMatchObject({ ok: false, code: "plugin_session_record_revision_conflict" });
            await expect(deleteSessionSystemRecordV1({ authentication,
                actorUserId: account.id,
                sessionId: session.id,
                pluginId: "acme.notes",
                address,
                expectedRevision: updated.record.revision,
            })).resolves.toEqual({ ok: true });
        } finally {
            await db.session.delete({ where: { id: session.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    }, 120_000);

    it("distinguishes omitted settlement from create-only and caller-CAS revisions", async () => {
        const suffix = randomUUID();
        const { account, session } = await createAccountAndSession(`settlement-${suffix}`);
        const address = {
            owner: "plugin" as const,
            namespace: "notes",
            kind: "entry.v1",
            localId: `note:${suffix}`,
        };
        try {
            const created = await upsertSessionSystemRecordV1({ authentication,
                actorUserId: account.id,
                sessionId: session.id,
                pluginId: "acme.notes",
                address,
                content: { t: "plain", v: { title: "Created" } },
                expectedRevision: null,
            });
            if (!created.ok) throw new Error("Expected create-only plugin record write to succeed");

            const settled = await upsertSessionSystemRecordV1({ authentication,
                actorUserId: account.id,
                sessionId: session.id,
                pluginId: "acme.notes",
                address,
                content: { t: "plain", v: { title: "Settled" } },
            });
            expect(settled).toMatchObject({
                ok: true,
                record: { content: { t: "plain", v: { title: "Settled" } } },
            });
            if (!settled.ok) throw new Error("Expected omitted revision to settle the current plugin record");
            expect(settled.record.revision).not.toBe(created.record.revision);

            await expect(upsertSessionSystemRecordV1({ authentication,
                actorUserId: account.id,
                sessionId: session.id,
                pluginId: "acme.notes",
                address,
                content: { t: "plain", v: { title: "Create only" } },
                expectedRevision: null,
            })).resolves.toEqual({
                ok: false,
                code: "plugin_session_record_revision_conflict",
                currentRevision: settled.record.revision,
            });
            await expect(upsertSessionSystemRecordV1({ authentication,
                actorUserId: account.id,
                sessionId: session.id,
                pluginId: "acme.notes",
                address,
                content: { t: "plain", v: { title: "Stale CAS" } },
                expectedRevision: created.record.revision,
            })).resolves.toEqual({
                ok: false,
                code: "plugin_session_record_revision_conflict",
                currentRevision: settled.record.revision,
            });

            await expect(deleteSessionSystemRecordV1({ authentication,
                actorUserId: account.id,
                sessionId: session.id,
                pluginId: "acme.notes",
                address,
            })).resolves.toEqual({ ok: true });
            const recreated = await upsertSessionSystemRecordV1({ authentication,
                actorUserId: account.id,
                sessionId: session.id,
                pluginId: "acme.notes",
                address,
                content: { t: "plain", v: { title: "Recreated" } },
                expectedRevision: null,
            });
            expect(recreated).toMatchObject({ ok: true });
            await expect(deleteSessionSystemRecordV1({ authentication,
                actorUserId: account.id,
                sessionId: session.id,
                pluginId: "acme.notes",
                address,
            })).resolves.toEqual({ ok: true });
        } finally {
            await db.session.delete({ where: { id: session.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    }, 120_000);
});
