import { beforeEach, describe, expect, it } from "vitest";
import { SessionMetadataTuplePatchV1Schema } from "@happier-dev/protocol";

import {
    buildSessionMetadataRecipientUpdate,
    buildUpdateSessionUpdate,
    emitUpdate,
    patchSession,
    updateSessionMetadataEnvelopeTuple,
    createSessionRouteTestBuilder,
    resetSessionRouteMocks,
} from "./sessionRoutes.testkit";

const OWNER_METADATA_CIPHERTEXT =
    "oQoBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQGDb9gtt8Xqs3gDuzJU/wWRuslcRY3OZA==";

describe("sessionRoutes v2 patch", () => {
    beforeEach(() => {
        resetSessionRouteMocks();
    });

    it("emits update-session using returned per-recipient cursors", async () => {
        patchSession.mockResolvedValue({
            ok: true,
            participantCursors: [
                { accountId: "u1", cursor: 10 },
                { accountId: "u2", cursor: 11 },
            ],
            metadata: { version: 2, value: "mNew" },
            agentState: { version: 3, value: null },
        });

        const route = await createSessionRouteTestBuilder("PATCH", "/v2/sessions/:sessionId");
        const { response: res } = await route.invoke({
            params: { sessionId: "s1" },
            body: {
                metadata: { ciphertext: "mNew", expectedVersion: 1 },
                agentState: { ciphertext: null, expectedVersion: 2 },
            },
        });

        expect(patchSession).toHaveBeenCalledWith({
            actorUserId: "u1",
            sessionId: "s1",
            metadata: { ciphertext: "mNew", expectedVersion: 1 },
            agentState: { ciphertext: null, expectedVersion: 2 },
        });

        expect(buildUpdateSessionUpdate).toHaveBeenCalledWith(
            "s1",
            10,
            expect.any(String),
            { value: "mNew", version: 2 },
            { value: null, version: 3 },
        );
        expect(buildUpdateSessionUpdate).toHaveBeenCalledWith(
            "s1",
            11,
            expect.any(String),
            { value: "mNew", version: 2 },
            { value: null, version: 3 },
        );
        expect(emitUpdate).toHaveBeenCalledTimes(2);

        expect(res).toEqual({
            success: true,
            metadata: { version: 2 },
            agentState: { version: 3 },
        });
    });

    it("forwards an inactive-model-intent expectation and publishes nothing on active conflict", async () => {
        patchSession.mockResolvedValue({
            ok: false,
            error: "session_active",
        });

        const route = await createSessionRouteTestBuilder(
            "PATCH",
            "/v2/sessions/:sessionId",
        );
        const { reply, response } = await route.invoke({
            params: { sessionId: "s1" },
            body: {
                inactiveModelIntent: {
                    metadata: {
                        ciphertext: "inactive-model-intent",
                        expectedVersion: 1,
                    },
                    sessionExpectation: {
                        kind: "inactive_model_intent",
                    },
                },
            },
        });

        expect(patchSession).toHaveBeenCalledWith({
            actorUserId: "u1",
            sessionId: "s1",
            metadata: {
                ciphertext: "inactive-model-intent",
                expectedVersion: 1,
            },
            agentState: undefined,
            sessionExpectation: {
                kind: "inactive_model_intent",
            },
        });
        expect(reply.code).toHaveBeenCalledWith(409);
        expect(response).toEqual({
            code: "session_active",
        });
        expect(buildUpdateSessionUpdate).not.toHaveBeenCalled();
        expect(emitUpdate).not.toHaveBeenCalled();
    });

    it("returns the strict inactive-model-intent success shape", async () => {
        patchSession.mockResolvedValue({
            ok: true,
            participantCursors: [],
            metadata: {
                version: 2,
                value: "inactive-model-intent",
                privateOwnerField: "must-not-reach-wire",
            },
        });

        const route = await createSessionRouteTestBuilder(
            "PATCH",
            "/v2/sessions/:sessionId",
        );
        const { response } = await route.invoke({
            params: { sessionId: "s1" },
            body: {
                inactiveModelIntent: {
                    metadata: {
                        ciphertext: "inactive-model-intent",
                        expectedVersion: 1,
                    },
                    sessionExpectation: {
                        kind: "inactive_model_intent",
                    },
                },
            },
        });

        expect(response).toEqual({
            success: true,
            metadata: { version: 2 },
        });
    });

    it("rejects private extras in an inactive-model-intent version conflict", async () => {
        patchSession.mockResolvedValue({
            ok: false,
            error: "version-mismatch",
            current: {
                metadata: {
                    version: 9,
                    value: "m9",
                    privateOwnerField: "must-not-reach-wire",
                },
            },
        });

        const route = await createSessionRouteTestBuilder(
            "PATCH",
            "/v2/sessions/:sessionId",
        );

        await expect(route.invoke({
            params: { sessionId: "s1" },
            body: {
                inactiveModelIntent: {
                    metadata: {
                        ciphertext: "inactive-model-intent",
                        expectedVersion: 1,
                    },
                    sessionExpectation: {
                        kind: "inactive_model_intent",
                    },
                },
            },
        })).rejects.toThrow();
        expect(emitUpdate).not.toHaveBeenCalled();
    });

    it("passes through version-mismatch current values", async () => {
        patchSession.mockResolvedValue({
            ok: false,
            error: "version-mismatch",
            current: { metadata: { version: 9, value: "m9" } },
        });

        const route = await createSessionRouteTestBuilder("PATCH", "/v2/sessions/:sessionId");
        const { response: res } = await route.invoke({
            params: { sessionId: "s1" },
            body: {
                metadata: { ciphertext: "mNew", expectedVersion: 1 },
            },
        });

        expect(res).toEqual({
            success: false,
            error: "version-mismatch",
            metadata: { version: 9, value: "m9" },
        });
        expect(emitUpdate).not.toHaveBeenCalled();
    });

    it("returns 500 on version-mismatch when current state is missing", async () => {
        patchSession.mockResolvedValue({
            ok: false,
            error: "version-mismatch",
            current: null,
        });

        const route = await createSessionRouteTestBuilder("PATCH", "/v2/sessions/:sessionId");
        const { reply, response: res } = await route.invoke({
            params: { sessionId: "s1" },
            body: {
                metadata: { ciphertext: "mNew", expectedVersion: 1 },
            },
        });

        expect(reply.code).toHaveBeenCalledWith(500);
        expect(res).toEqual({ error: "Failed to update session" });
        expect(emitUpdate).not.toHaveBeenCalled();
    });

    it("returns the typed privacy-upgrade error for fenced legacy writes", async () => {
        patchSession.mockResolvedValue({
            ok: false,
            error: "metadata_privacy_upgrade_required",
        });

        const route = await createSessionRouteTestBuilder("PATCH", "/v2/sessions/:sessionId");
        const { reply, response: res } = await route.invoke({
            params: { sessionId: "s1" },
            body: {
                metadata: { ciphertext: "legacy-whole-bag", expectedVersion: 1 },
            },
        });

        expect(reply.code).toHaveBeenCalledWith(409);
        expect(res).toEqual({
            error: "Session metadata privacy upgrade required",
            code: "metadata_privacy_upgrade_required",
        });
        expect(emitUpdate).not.toHaveBeenCalled();
    });

    it("delegates a strict owner migration to the canonical tuple owner and publishes nothing when refused", async () => {
        updateSessionMetadataEnvelopeTuple.mockResolvedValue({
            ok: false,
            error: "metadata_privacy_upgrade_required",
        });

        const body = SessionMetadataTuplePatchV1Schema.parse({
            mode: "owner_migration",
            expectedAccountEncryptionMode: "plain",
            expectedAccountContentPublicKeyFingerprint:
                "content-public-key-sha256:"
                + "a".repeat(64),
            source: {
                metadataLayoutVersion: 0,
                metadata: {
                    version: 4,
                    ciphertext: "legacy-whole-bag",
                },
                ownerMetadata: null,
                agentState: {
                    version: 7,
                    ciphertext: null,
                },
            },
            target: {
                metadataLayoutVersion: 1,
                sharedMetadata: {
                    ciphertext: "shared-safe",
                },
                ownerMetadata: {
                    ciphertext: OWNER_METADATA_CIPHERTEXT,
                },
                agentState: {
                    ciphertext: null,
                },
            },
        });
        const route = await createSessionRouteTestBuilder(
            "PATCH",
            "/v2/sessions/:sessionId",
        );
        const { reply, response } = await route.invoke({
            params: { sessionId: "s1" },
            body,
        });

        expect(updateSessionMetadataEnvelopeTuple).toHaveBeenCalledTimes(1);
        expect(updateSessionMetadataEnvelopeTuple).toHaveBeenCalledWith({
            ...body,
            actorUserId: "u1",
            sessionId: "s1",
        });
        expect(reply.code).toHaveBeenCalledWith(409);
        expect(response).toEqual({
            error: "Session metadata privacy upgrade required",
            code: "metadata_privacy_upgrade_required",
        });
        expect(buildSessionMetadataRecipientUpdate).not.toHaveBeenCalled();
        expect(buildUpdateSessionUpdate).not.toHaveBeenCalled();
        expect(emitUpdate).not.toHaveBeenCalled();
    });

    it("commits an owner tuple once and returns its complete version vector", async () => {
        updateSessionMetadataEnvelopeTuple.mockResolvedValue({
            ok: true,
            participantCursors: [
                { accountId: "u1", cursor: 10 },
                { accountId: "u2", cursor: 11 },
            ],
            metadataLayoutVersion: 1,
            sharedMetadata: { version: 5, value: "shared-safe" },
            ownerMetadata: { value: OWNER_METADATA_CIPHERTEXT },
            agentState: { version: 9, value: "owner-state" },
        });

        const route = await createSessionRouteTestBuilder("PATCH", "/v2/sessions/:sessionId");
        const { response } = await route.invoke({
            params: { sessionId: "s1" },
            body: {
                mode: "owner",
                metadataLayoutVersion: 1,
                expectedOwnerMetadataCiphertext:
                    OWNER_METADATA_CIPHERTEXT,
                sharedMetadata: {
                    ciphertext: "shared-safe",
                    expectedVersion: 4,
                },
                ownerMetadata: {
                    ciphertext: OWNER_METADATA_CIPHERTEXT,
                },
                agentState: {
                    ciphertext: "owner-state",
                    expectedVersion: 8,
                },
            },
        });

        expect(updateSessionMetadataEnvelopeTuple).toHaveBeenCalledTimes(1);
        expect(updateSessionMetadataEnvelopeTuple).toHaveBeenCalledWith({
            mode: "owner",
            actorUserId: "u1",
            sessionId: "s1",
            metadataLayoutVersion: 1,
            expectedOwnerMetadataCiphertext:
                OWNER_METADATA_CIPHERTEXT,
            sharedMetadata: {
                ciphertext: "shared-safe",
                expectedVersion: 4,
            },
            ownerMetadata: {
                ciphertext: OWNER_METADATA_CIPHERTEXT,
            },
            agentState: {
                ciphertext: "owner-state",
                expectedVersion: 8,
            },
        });
        expect(response).toEqual({
            success: true,
            metadataLayoutVersion: 1,
            sharedMetadata: { version: 5 },
            agentState: { version: 9 },
        });
        expect(buildSessionMetadataRecipientUpdate).toHaveBeenNthCalledWith(
            1,
            "s1",
            10,
            expect.any(String),
            {
                metadata: "shared-safe",
                metadataVersion: 5,
                metadataLayoutVersion: 1,
                ownerMetadata: OWNER_METADATA_CIPHERTEXT,
                agentState: "owner-state",
                agentStateVersion: 9,
            },
        );
        expect(buildSessionMetadataRecipientUpdate).toHaveBeenNthCalledWith(
            2,
            "s1",
            11,
            expect.any(String),
            {
                metadata: "shared-safe",
                metadataVersion: 5,
                metadataLayoutVersion: 1,
                agentState: null,
                agentStateVersion: 9,
            },
        );
        expect(buildUpdateSessionUpdate).not.toHaveBeenCalled();
    });

    it("returns the typed active conflict for a conditioned owner tuple without publishing", async () => {
        updateSessionMetadataEnvelopeTuple.mockResolvedValue({
            ok: false,
            error: "session_active",
        });

        const route = await createSessionRouteTestBuilder(
            "PATCH",
            "/v2/sessions/:sessionId",
        );
        const { reply, response } = await route.invoke({
            params: { sessionId: "s1" },
            body: {
                mode: "owner_inactive_model_intent",
                metadataLayoutVersion: 1,
                sessionExpectation: {
                    kind: "inactive_model_intent",
                },
                expectedOwnerMetadataCiphertext:
                    OWNER_METADATA_CIPHERTEXT,
                sharedMetadata: {
                    ciphertext: "shared-safe",
                    expectedVersion: 4,
                },
                ownerMetadata: {
                    ciphertext: OWNER_METADATA_CIPHERTEXT,
                },
                agentState: {
                    ciphertext: "owner-state",
                    expectedVersion: 8,
                },
            },
        });

        expect(updateSessionMetadataEnvelopeTuple).toHaveBeenCalledWith({
            mode: "owner_inactive_model_intent",
            actorUserId: "u1",
            sessionId: "s1",
            metadataLayoutVersion: 1,
            sessionExpectation: {
                kind: "inactive_model_intent",
            },
            expectedOwnerMetadataCiphertext:
                OWNER_METADATA_CIPHERTEXT,
            sharedMetadata: {
                ciphertext: "shared-safe",
                expectedVersion: 4,
            },
            ownerMetadata: {
                ciphertext: OWNER_METADATA_CIPHERTEXT,
            },
            agentState: {
                ciphertext: "owner-state",
                expectedVersion: 8,
            },
        });
        expect(reply.code).toHaveBeenCalledWith(409);
        expect(response).toEqual({
            code: "session_active",
        });
        expect(buildSessionMetadataRecipientUpdate).not.toHaveBeenCalled();
        expect(buildUpdateSessionUpdate).not.toHaveBeenCalled();
        expect(emitUpdate).not.toHaveBeenCalled();
    });

    it("publishes a shared-editor tuple to every participant without owner-only fields", async () => {
        updateSessionMetadataEnvelopeTuple.mockResolvedValue({
            ok: true,
            participantCursors: [
                { accountId: "u1", cursor: 10 },
                { accountId: "u2", cursor: 11 },
            ],
            metadataLayoutVersion: 1,
            sharedMetadata: { version: 6, value: "shared-editor-safe" },
            agentStateVersion: 9,
        });

        const route = await createSessionRouteTestBuilder(
            "PATCH",
            "/v2/sessions/:sessionId",
        );
        const { response } = await route.invoke({
            params: { sessionId: "s1" },
            body: {
                mode: "shared_editor",
                metadataLayoutVersion: 1,
                sharedMetadata: {
                    ciphertext: "shared-editor-safe",
                    expectedVersion: 5,
                },
            },
        });

        expect(response).toEqual({
            success: true,
            metadataLayoutVersion: 1,
            sharedMetadata: { version: 6 },
        });
        for (const call of buildSessionMetadataRecipientUpdate.mock.calls) {
            expect(call[3]).toEqual({
                metadata: "shared-editor-safe",
                metadataVersion: 6,
                metadataLayoutVersion: 1,
                agentState: null,
                agentStateVersion: 9,
            });
        }
        expect(buildSessionMetadataRecipientUpdate).toHaveBeenCalledTimes(2);
        expect(buildUpdateSessionUpdate).not.toHaveBeenCalled();
    });

    it("returns a typed 409 version vector without private ciphertext on tuple CAS loss", async () => {
        updateSessionMetadataEnvelopeTuple.mockResolvedValue({
            ok: false,
            error: "version-mismatch",
            current: {
                metadataLayoutVersion: 1,
                sharedMetadata: { version: 6, value: "shared-newer" },
                ownerMetadata: { value: "owner-private" },
                agentState: { version: 10, value: "agent-private" },
            },
        });

        const route = await createSessionRouteTestBuilder("PATCH", "/v2/sessions/:sessionId");
        const { reply, response } = await route.invoke({
            params: { sessionId: "s1" },
            body: {
                mode: "owner",
                metadataLayoutVersion: 1,
                expectedOwnerMetadataCiphertext:
                    OWNER_METADATA_CIPHERTEXT,
                sharedMetadata: {
                    ciphertext: "shared-stale",
                    expectedVersion: 5,
                },
                ownerMetadata: {
                    ciphertext: OWNER_METADATA_CIPHERTEXT,
                },
                agentState: {
                    ciphertext: "agent-stale",
                    expectedVersion: 9,
                },
            },
        });

        expect(reply.code).toHaveBeenCalledWith(409);
        expect(response).toEqual({
            code: "session_metadata_version_conflict",
            metadataLayoutVersion: 1,
            sharedMetadata: { version: 6 },
            agentState: { version: 10 },
        });
        expect(JSON.stringify(response)).not.toMatch(
            /shared-newer|owner-private|agent-private/,
        );
        expect(emitUpdate).not.toHaveBeenCalled();
    });

    it("fails closed before publication when tuple success carries a future layout", async () => {
        updateSessionMetadataEnvelopeTuple.mockResolvedValue({
            ok: true,
            participantCursors: [
                { accountId: "u1", cursor: 10 },
                { accountId: "u2", cursor: 11 },
            ],
            metadataLayoutVersion: 2,
            sharedMetadata: { version: 6, value: "shared-future" },
        });

        const route = await createSessionRouteTestBuilder(
            "PATCH",
            "/v2/sessions/:sessionId",
        );
        const { reply, response } = await route.invoke({
            params: { sessionId: "s1" },
            body: {
                mode: "shared_editor",
                metadataLayoutVersion: 1,
                sharedMetadata: {
                    ciphertext: "shared-editor-safe",
                    expectedVersion: 5,
                },
            },
        });

        expect(reply.code).toHaveBeenCalledWith(500);
        expect(response).toEqual({ error: "Failed to update session" });
        expect(buildSessionMetadataRecipientUpdate).not.toHaveBeenCalled();
        expect(emitUpdate).not.toHaveBeenCalled();
    });

    it("fails closed on a future layout in a tuple conflict response", async () => {
        updateSessionMetadataEnvelopeTuple.mockResolvedValue({
            ok: false,
            error: "version-mismatch",
            current: {
                metadataLayoutVersion: 2,
                sharedMetadata: { version: 6, value: "shared-future" },
                ownerMetadata: { value: "owner-private" },
                agentState: { version: 10, value: "agent-private" },
            },
        });

        const route = await createSessionRouteTestBuilder(
            "PATCH",
            "/v2/sessions/:sessionId",
        );
        const { reply, response } = await route.invoke({
            params: { sessionId: "s1" },
            body: {
                mode: "owner",
                metadataLayoutVersion: 1,
                expectedOwnerMetadataCiphertext:
                    OWNER_METADATA_CIPHERTEXT,
                sharedMetadata: {
                    ciphertext: "shared-stale",
                    expectedVersion: 5,
                },
                ownerMetadata: {
                    ciphertext: OWNER_METADATA_CIPHERTEXT,
                },
                agentState: {
                    ciphertext: "agent-stale",
                    expectedVersion: 9,
                },
            },
        });

        expect(reply.code).toHaveBeenCalledWith(409);
        expect(response).toEqual({
            error: "Session metadata privacy upgrade required",
            code: "metadata_privacy_upgrade_required",
        });
        expect(JSON.stringify(response)).not.toMatch(
            /shared-future|owner-private|agent-private/,
        );
        expect(buildSessionMetadataRecipientUpdate).not.toHaveBeenCalled();
        expect(emitUpdate).not.toHaveBeenCalled();
    });

    it("rejects tuple-branch extras instead of stripping them into another mutation mode", async () => {
        const route = await createSessionRouteTestBuilder("PATCH", "/v2/sessions/:sessionId");
        const entry = route.app.routes.get("PATCH /v2/sessions/:sessionId");
        const schema = entry?.opts.schema;
        if (!schema || typeof schema !== "object" || !("body" in schema)) {
            throw new Error("Expected PATCH body schema");
        }
        const bodySchema = schema.body;
        if (!bodySchema || typeof bodySchema !== "object" || !("safeParse" in bodySchema)) {
            throw new Error("Expected a Zod PATCH body schema");
        }
        const parsed = (
            bodySchema as Readonly<{
                safeParse(value: unknown): Readonly<{ success: boolean }>;
            }>
        ).safeParse({
                mode: "shared_editor",
                metadataLayoutVersion: 1,
                sharedMetadata: {
                    ciphertext: "shared",
                    expectedVersion: 1,
                },
                ownerMetadata: { ciphertext: "must-not-be-stripped" },
        });

        expect(parsed.success).toBe(false);
        expect(updateSessionMetadataEnvelopeTuple).not.toHaveBeenCalled();
        expect(patchSession).not.toHaveBeenCalled();
    });

    it("rejects an inactive-model-intent expectation on an Agent-state-only legacy patch", async () => {
        const route = await createSessionRouteTestBuilder(
            "PATCH",
            "/v2/sessions/:sessionId",
        );
        const entry = route.app.routes.get(
            "PATCH /v2/sessions/:sessionId",
        );
        const schema = entry?.opts.schema;
        if (!schema || typeof schema !== "object" || !("body" in schema)) {
            throw new Error("Expected PATCH body schema");
        }
        const bodySchema = schema.body;
        if (
            !bodySchema
            || typeof bodySchema !== "object"
            || !("safeParse" in bodySchema)
        ) {
            throw new Error("Expected a Zod PATCH body schema");
        }

        const parsed = (
            bodySchema as Readonly<{
                safeParse(value: unknown): Readonly<{ success: boolean }>;
            }>
        ).safeParse({
            agentState: {
                ciphertext: "agent-state-only",
                expectedVersion: 1,
            },
            sessionExpectation: {
                kind: "inactive_model_intent",
            },
        });

        expect(parsed.success).toBe(false);
        expect(updateSessionMetadataEnvelopeTuple).not.toHaveBeenCalled();
        expect(patchSession).not.toHaveBeenCalled();
    });
});
