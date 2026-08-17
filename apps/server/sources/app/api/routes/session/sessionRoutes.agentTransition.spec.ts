import {
    SESSION_AGENT_TRANSITION_DIVIDER_MESSAGE,
    createPlainSessionOwnerMetadataEnvelopeV1,
} from "@happier-dev/protocol";
import { beforeEach, describe, expect, it } from "vitest";

import {
    applySessionAgentTransitionCutover,
    buildMessageUpdatedUpdate,
    buildNewMessageUpdate,
    buildSessionMetadataRecipientUpdate,
    buildUpdateSessionUpdate,
    createSessionRouteTestBuilder,
    emitUpdate,
    resetSessionRouteMocks,
} from "./sessionRoutes.testkit";

const CUTOVER_PATH = "/v2/sessions/:sessionId/agent-transition/cutover";
const STORED_PLAIN_OWNER_METADATA_ENVELOPE = JSON.stringify(
    createPlainSessionOwnerMetadataEnvelopeV1({ v: 1 }),
);

function dividerBody() {
    return {
        v: 1,
        currentView: {
            kind: "legacy_v0",
            expectedMetadataVersion: 1,
            metadataCiphertext: "target-view",
            expectedAgentStateVersion: 2,
            agentStateCiphertext: null,
        },
        divider: {
            localId: "agent-transition:submitted-1",
            content: {
                t: "plain",
                v: {
                    role: "agent",
                    content: {
                        type: "event",
                        id: "agent-transition-divider",
                        data: {
                            type: "message",
                            message: SESSION_AGENT_TRANSITION_DIVIDER_MESSAGE,
                            sessionAgentTransitionV1: {
                                v: 1,
                                fromAgentId: "claude",
                                toAgentId: "codex",
                            },
                        },
                    },
                },
            },
        },
    };
}

function dividerMessageRow() {
    return {
        id: "m-divider",
        seq: 42,
        localId: "agent-transition:submitted-1",
        content: { t: "plain", v: {} },
    };
}

/**
 * The cutover route's PUBLICATION contract.
 *
 * The service itself is mocked; everything the route does with its result —
 * including the real shared current-view publisher and the real recipient
 * projector — runs for real. These specs exist because the committed current
 * view previously reached no client at all: the divider was pushed while the
 * Session's new Agent identity waited for the next change-cursor catch-up.
 */
describe("sessionRoutes Agent-transition cutover publication", () => {
    beforeEach(() => {
        resetSessionRouteMocks();
    });

    it("announces a layout-one current view to every participant, then the divider", async () => {
        applySessionAgentTransitionCutover.mockResolvedValue({
            ok: true,
            dividerSeq: 42,
            currentView: {
                currentView: {
                    kind: "envelope_tuple_v1",
                    sharedMetadataVersion: 5,
                    agentStateVersion: 3,
                },
                participantCursors: [
                    { accountId: "u1", cursor: 101 },
                    { accountId: "u2", cursor: 55 },
                ],
                publication: {
                    kind: "envelope_tuple_v1",
                    sessionOwnerId: "u1",
                    ownerAccountMode: "plain",
                    sharedMetadata: { version: 5, value: JSON.stringify({ v: 1 }) },
                    ownerMetadata: { value: STORED_PLAIN_OWNER_METADATA_ENVELOPE },
                    agentState: { version: 3, value: null },
                },
            },
            dividerWrite: {
                ok: true,
                didWrite: true,
                didUpdate: false,
                badgeAttentionChanged: false,
                attentionImpact: { affectsUnread: false, affectsMeaningfulActivity: false },
                message: dividerMessageRow(),
                participantCursors: [{ accountId: "u1", cursor: 102 }],
            },
        });

        const route = await createSessionRouteTestBuilder("POST", CUTOVER_PATH);
        const { response } = await route.invoke({
            params: { sessionId: "s1" },
            body: dividerBody(),
        });

        expect(response).toEqual({ success: true, dividerSeq: 42 });
        // Owner and shared participant each get their own projected envelope.
        expect(buildSessionMetadataRecipientUpdate).toHaveBeenCalledTimes(2);
        expect(buildSessionMetadataRecipientUpdate).toHaveBeenCalledWith(
            "s1",
            101,
            expect.any(String),
            expect.objectContaining({ metadataVersion: 5 }),
        );
        expect(buildSessionMetadataRecipientUpdate).toHaveBeenCalledWith(
            "s1",
            55,
            expect.any(String),
            expect.objectContaining({ metadataVersion: 5 }),
        );
        // The divider still publishes, and it is not the only thing published.
        expect(buildNewMessageUpdate).toHaveBeenCalledTimes(1);
        expect(emitUpdate).toHaveBeenCalledTimes(3);
    });

    it("announces a layout-zero current view to the owner only", async () => {
        applySessionAgentTransitionCutover.mockResolvedValue({
            ok: true,
            dividerSeq: 42,
            currentView: {
                currentView: { kind: "legacy_v0", metadataVersion: 2, agentStateVersion: 3 },
                participantCursors: [
                    { accountId: "u1", cursor: 101 },
                    { accountId: "u2", cursor: 55 },
                ],
                publication: {
                    kind: "legacy_v0",
                    sessionOwnerId: "u1",
                    session: {
                        accountId: "u1",
                        metadata: "target-view",
                        metadataVersion: 2,
                        metadataLayoutVersion: 0,
                        ownerMetadata: null,
                        agentState: null,
                        agentStateVersion: 3,
                    },
                },
            },
            dividerWrite: null,
        });

        const route = await createSessionRouteTestBuilder("POST", CUTOVER_PATH);
        const { response } = await route.invoke({
            params: { sessionId: "s1" },
            body: dividerBody(),
        });

        expect(response).toEqual({ success: true, dividerSeq: 42 });
        // Layout zero has no per-recipient envelope: a shared participant must
        // NOT receive the owner's metadata, so only the owner is published to.
        expect(buildUpdateSessionUpdate).toHaveBeenCalledTimes(1);
        expect(buildUpdateSessionUpdate).toHaveBeenCalledWith(
            "s1",
            101,
            expect.any(String),
            { value: "target-view", version: 2 },
            { value: null, version: 3 },
        );
        expect(buildSessionMetadataRecipientUpdate).not.toHaveBeenCalled();
        // No divider write on this call, so nothing else is emitted.
        expect(buildNewMessageUpdate).not.toHaveBeenCalled();
        expect(emitUpdate).toHaveBeenCalledTimes(1);
    });

    it("publishes nothing for an exact retry that committed nothing", async () => {
        applySessionAgentTransitionCutover.mockResolvedValue({
            ok: true,
            dividerSeq: 42,
            currentView: {
                currentView: { kind: "legacy_v0", metadataVersion: 2, agentStateVersion: 3 },
                participantCursors: [],
                publication: null,
            },
            dividerWrite: null,
        });

        const route = await createSessionRouteTestBuilder("POST", CUTOVER_PATH);
        const { response } = await route.invoke({
            params: { sessionId: "s1" },
            body: dividerBody(),
        });

        expect(response).toEqual({ success: true, dividerSeq: 42 });
        expect(emitUpdate).not.toHaveBeenCalled();
        expect(buildUpdateSessionUpdate).not.toHaveBeenCalled();
        expect(buildSessionMetadataRecipientUpdate).not.toHaveBeenCalled();
    });

    it("publishes a reconciled divider row instead of dropping it", async () => {
        applySessionAgentTransitionCutover.mockResolvedValue({
            ok: true,
            dividerSeq: 42,
            currentView: {
                currentView: { kind: "legacy_v0", metadataVersion: 2, agentStateVersion: 3 },
                participantCursors: [],
                publication: null,
            },
            // A concurrent writer won the reserved localId, so the message owner
            // reconciled the existing row rather than inserting one.
            dividerWrite: {
                ok: true,
                didWrite: false,
                didUpdate: true,
                badgeAttentionChanged: false,
                attentionImpact: { affectsUnread: false, affectsMeaningfulActivity: false },
                message: dividerMessageRow(),
                participantCursors: [{ accountId: "u1", cursor: 102 }],
            },
        });

        const route = await createSessionRouteTestBuilder("POST", CUTOVER_PATH);
        const { response } = await route.invoke({
            params: { sessionId: "s1" },
            body: dividerBody(),
        });

        expect(response).toEqual({ success: true, dividerSeq: 42 });
        expect(buildMessageUpdatedUpdate).toHaveBeenCalledTimes(1);
        expect(buildMessageUpdatedUpdate).toHaveBeenCalledWith(
            expect.anything(),
            "s1",
            102,
            expect.any(String),
        );
        expect(buildNewMessageUpdate).not.toHaveBeenCalled();
        expect(emitUpdate).toHaveBeenCalledTimes(1);
    });

    it("reports a committed current view honestly when its projection cannot be built", async () => {
        applySessionAgentTransitionCutover.mockResolvedValue({
            ok: true,
            dividerSeq: 42,
            currentView: {
                currentView: { kind: "legacy_v0", metadataVersion: 2, agentStateVersion: 3 },
                participantCursors: [{ accountId: "u1", cursor: 101 }],
                publication: {
                    kind: "legacy_v0",
                    sessionOwnerId: "u1",
                    session: {
                        accountId: "u1",
                        metadata: "target-view",
                        metadataVersion: 2,
                        // Layout zero with an owner envelope present is exactly the
                        // state the projector refuses, rather than disclosing it.
                        metadataLayoutVersion: 0,
                        ownerMetadata: STORED_PLAIN_OWNER_METADATA_ENVELOPE,
                        agentState: null,
                        agentStateVersion: 3,
                    },
                },
            },
            dividerWrite: null,
        });

        const route = await createSessionRouteTestBuilder("POST", CUTOVER_PATH);
        const { response, reply } = await route.invoke({
            params: { sessionId: "s1" },
            body: dividerBody(),
        });

        // The cutover DID commit. It must never be reported as an untouched
        // Session, so the failure keeps the committed-effect discriminator.
        expect(reply.statusCode).toBe(500);
        expect(response).toEqual({
            effect: "current_view_committed",
            error: "internal",
        });
        expect(emitUpdate).not.toHaveBeenCalled();
    });
});
