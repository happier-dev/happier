import { randomUUID } from "node:crypto";
import {
    buildSessionAgentTransitionDividerLocalId,
    createPlainSessionOwnerMetadataEnvelopeV1,
    projectSessionSharedMetadataV1,
    SESSION_AGENT_TRANSITION_DIVIDER_MESSAGE,
} from "@happier-dev/protocol";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { eventRouter } from "@/app/events/eventRouter";
import { createSessionMessage } from "@/app/session/sessionWriteService";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createRouteTestBuilder } from "../../testkit/routeTestBuilder";
import { registerSessionAgentTransitionRoute } from "./registerSessionAgentTransitionRoute";

const CUTOVER_PATH = "/v2/sessions/:sessionId/agent-transition/cutover";
const OWNER_METADATA = createPlainSessionOwnerMetadataEnvelopeV1({ v: 1 });
const TARGET_SHARED_METADATA = JSON.stringify(projectSessionSharedMetadataV1({ metadata: { flavor: "codex" } }));
const TARGET_LEGACY_METADATA = JSON.stringify({ flavor: "codex" });

function dividerContent(fromAgentId = "claude") {
    return {
        t: "plain" as const,
        v: { role: "agent", content: { type: "event", id: "agent-transition-divider", data: {
            type: "message", message: SESSION_AGENT_TRANSITION_DIVIDER_MESSAGE,
            sessionAgentTransitionV1: { v: 1, fromAgentId, toAgentId: "codex", sourceCutoffSeqInclusive: 29_979 },
        } } },
    };
}

async function fixture(layout: 0 | 1 = 0, active = false, env: NodeJS.ProcessEnv = {}) {
    const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
    const viewer = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
    const session = await db.session.create({ data: {
        accountId: owner.id, tag: randomUUID(), encryptionMode: "plain", currentStorageState: "hosted", active,
        metadata: JSON.stringify(layout === 0 ? { flavor: "claude" } : projectSessionSharedMetadataV1({ metadata: {} })),
        metadataLayoutVersion: layout, ownerMetadata: layout === 0 ? null : JSON.stringify(OWNER_METADATA),
        metadataVersion: 4, agentState: "{}", agentStateVersion: 2,
    } });
    await db.sessionShare.create({ data: {
        sessionId: session.id, sharedByUserId: owner.id, sharedWithUserId: viewer.id,
        accessLevel: "edit", canApprovePermissions: false,
    } });
    const currentView = layout === 0 ? {
        kind: "legacy_v0", expectedMetadataVersion: 4, metadataCiphertext: TARGET_LEGACY_METADATA,
        expectedAgentStateVersion: 2, agentStateCiphertext: null,
    } : {
        kind: "envelope_tuple_v1", ownerPatch: {
            mode: "owner_inactive_model_intent", metadataLayoutVersion: 1,
            expectedOwnerMetadata: OWNER_METADATA,
            ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1({ v: 1, runtime: { permissionMode: "default" } }),
            sharedMetadata: { ciphertext: TARGET_SHARED_METADATA, expectedVersion: 4 },
            agentState: { ciphertext: null, expectedVersion: 2 },
            sessionExpectation: { kind: "inactive_model_intent" },
        },
    };
    const divider = { localId: buildSessionAgentTransitionDividerLocalId(randomUUID()), content: dividerContent() };
    const body = { v: 1, currentView, divider };
    const route = createRouteTestBuilder({
        method: "POST", path: CUTOVER_PATH,
        defaultRequest: { userId: owner.id, params: { sessionId: session.id }, body },
        registerRoutes(app) { registerSessionAgentTransitionRoute(app as never, env); },
    });
    return { owner, viewer, session, body, route };
}

/** Real cutover, tuple owner, message owner and projection; only socket delivery is replaced. */
describe("sessionRoutes Agent-transition cutover publication", () => {
    let harness: LightSqliteHarness;
    let emitUpdate: MockInstance<typeof eventRouter.emitUpdate>;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-transition-route-", initAuth: false,
            env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional" } });
    });
    beforeEach(() => {
        harness.restoreEnv();
        emitUpdate = vi.spyOn(eventRouter, "emitUpdate").mockImplementation(() => {});
    });
    afterEach(() => vi.restoreAllMocks());
    afterAll(async () => { if (harness) await harness.close(); });

    it("announces a layout-one current view to each participant before the divider", async () => {
        const f = await fixture(1);
        const result = await f.route.invoke();
        expect(result.reply.statusCode).toBe(200);
        const divider = await db.sessionMessage.findUniqueOrThrow({ where: { sessionId_localId: {
            sessionId: f.session.id, localId: f.body.divider.localId,
        } } });
        expect(result.response).toEqual({ success: true, dividerSeq: divider.seq });
        const events = emitUpdate.mock.calls.map(([event]) => event);
        for (const accountId of [f.owner.id, f.viewer.id]) {
            const viewIndex = events.findIndex(event => event.userId === accountId && event.payload.body.t === "update-session");
            const dividerIndex = events.findIndex(event => event.userId === accountId && event.payload.body.t === "new-message");
            expect(viewIndex).toBeGreaterThanOrEqual(0);
            expect(dividerIndex).toBeGreaterThan(viewIndex);
        }
        const shared = events.filter(event => event.userId === f.viewer.id && event.payload.body.t === "update-session");
        for (const event of shared) expect(event.payload.body).not.toHaveProperty("ownerMetadata");
        expect(events).toContainEqual(expect.objectContaining({ userId: f.owner.id,
            payload: expect.objectContaining({ body: expect.objectContaining({ t: "update-session", ownerMetadata: expect.any(Object) }) }) }));
    });

    it("announces layout-zero metadata only to its owner while both participants receive the divider", async () => {
        const f = await fixture();
        const result = await f.route.invoke();
        expect(result.reply.statusCode).toBe(200);
        const events = emitUpdate.mock.calls.map(([event]) => event);
        const views = events.filter(event => event.payload.body.t === "update-session");
        expect(views).toHaveLength(1);
        expect(views[0]).toMatchObject({ userId: f.owner.id, payload: { body: {
            metadata: { value: TARGET_LEGACY_METADATA, version: 5 }, agentState: { value: null, version: 3 },
        } } });
        for (const accountId of [f.owner.id, f.viewer.id]) {
            expect(events.some(event => event.userId === accountId && event.payload.body.t === "new-message")).toBe(true);
        }
    });

    it("publishes nothing and allocates no message on an exact retry", async () => {
        const f = await fixture();
        const first = await f.route.invoke();
        expect(first.reply.statusCode).toBe(200);
        const committed = await db.session.findUniqueOrThrow({ where: { id: f.session.id } });
        emitUpdate.mockClear();
        const retry = await f.route.invoke();
        expect(retry.response).toEqual(first.response);
        expect(emitUpdate).not.toHaveBeenCalled();
        expect(await db.sessionMessage.count({ where: { sessionId: f.session.id } })).toBe(1);
        expect(await db.session.findUniqueOrThrow({ where: { id: f.session.id } })).toEqual(committed);
    });

    it.each(["different-content", "missing-role"] as const)("publishes the committed view and preserves a reserved divider with %s", async seed => {
        const f = await fixture();
        const seeded = await createSessionMessage({ inputAdmission: "transcriptOnly", actorUserId: f.owner.id,
            sessionId: f.session.id, localId: f.body.divider.localId,
            content: seed === "different-content" ? dividerContent("gemini") : f.body.divider.content,
            messageRole: "event" });
        expect(seeded.ok).toBe(true);
        if (!seeded.ok) throw new Error("divider fixture failed");
        if (seed === "missing-role") await db.sessionMessage.update({ where: { id: seeded.message.id }, data: { messageRole: null } });
        const before = await db.sessionMessage.findUniqueOrThrow({ where: { id: seeded.message.id } });
        emitUpdate.mockClear();
        const result = await f.route.invoke();
        expect(result.reply.statusCode).toBe(409);
        expect(result.response).toEqual({ effect: "current_view_committed", error: "divider-conflict" });
        expect((await db.session.findUniqueOrThrow({ where: { id: f.session.id } })).metadata).toBe(TARGET_LEGACY_METADATA);
        expect(await db.sessionMessage.findUniqueOrThrow({ where: { id: seeded.message.id } })).toEqual(before);
        const bodies = emitUpdate.mock.calls.map(([event]) => event.payload.body);
        expect(bodies).toContainEqual(expect.objectContaining({ t: "update-session", metadata: { value: TARGET_LEGACY_METADATA, version: 5 } }));
        expect(bodies.some(body => body.t === "new-message" || body.t === "message-updated")).toBe(false);
    });

    it("publishes nothing when an active Session refuses the cutover", async () => {
        const f = await fixture(0, true);
        const result = await f.route.invoke();
        expect(result.reply.statusCode).toBe(409);
        expect(result.response).toEqual({ effect: "none", error: "session-active" });
        expect(await db.session.findUniqueOrThrow({ where: { id: f.session.id } })).toEqual(f.session);
        expect(await db.sessionMessage.count({ where: { sessionId: f.session.id } })).toBe(0);
        expect(emitUpdate).not.toHaveBeenCalled();
    });

    it("reports the committed effect and recovery cursor when current-view delivery fails", async () => {
        const f = await fixture();
        emitUpdate.mockImplementation(event => {
            if (event.payload.body.t === "update-session") throw new Error("socket delivery unavailable");
        });
        const result = await f.route.invoke();
        expect(result.reply.statusCode).toBe(500);
        expect(result.response).toEqual({ effect: "current_view_committed", error: "internal" });
        expect((await db.session.findUniqueOrThrow({ where: { id: f.session.id } })).metadata).toBe(TARGET_LEGACY_METADATA);
        expect(await db.sessionMessage.count({ where: { sessionId: f.session.id } })).toBe(1);
        expect(emitUpdate.mock.calls.map(([event]) => event.payload.body)).toContainEqual(expect.objectContaining({ t: "account-change" }));
    });

    it("refuses a disabled Agent-switching feature before any durable effect", async () => {
        const f = await fixture(0, false, { HAPPIER_FEATURE_SESSIONS_AGENT_SWITCHING__ENABLED: "0" });
        const result = await f.route.invoke();
        expect(result.reply.statusCode).toBe(404);
        expect(result.response).toEqual({ error: "not_found" });
        expect(await db.session.findUniqueOrThrow({ where: { id: f.session.id } })).toEqual(f.session);
        expect(await db.sessionMessage.count({ where: { sessionId: f.session.id } })).toBe(0);
        expect(emitUpdate).not.toHaveBeenCalled();
    });

    it("admits a server that never set the Agent-switching opt-out", async () => {
        const f = await fixture();
        const result = await f.route.invoke();
        expect(result.reply.statusCode).toBe(200);
        expect(await db.sessionMessage.count({ where: { sessionId: f.session.id } })).toBe(1);
    });
});
