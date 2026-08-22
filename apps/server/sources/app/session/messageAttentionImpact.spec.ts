import {
    SESSION_AGENT_TRANSITION_DIVIDER_MESSAGE,
    SESSION_MESSAGE_NO_USER_ATTENTION_IMPACT,
    SESSION_MESSAGE_USER_ATTENTION_IMPACT,
} from "@happier-dev/protocol";
import { describe, expect, it } from "vitest";

import { resolveMessageAttentionImpact } from "./messageAttentionImpact";

function storedAgentEvent(data: unknown): PrismaJson.SessionMessageContent {
    return {
        t: "plain",
        v: { role: "agent", content: { type: "event", id: "divider-1", data } },
    } as PrismaJson.SessionMessageContent;
}

function divider(sidecar: unknown = {
    v: 1,
    fromAgentId: "claude",
    toAgentId: "codex",
    sourceCutoffSeqInclusive: 29_979,
}) {
    return {
        type: "message",
        message: SESSION_AGENT_TRANSITION_DIVIDER_MESSAGE,
        sessionAgentTransitionV1: sidecar,
    };
}

/**
 * The server re-read resolver has no rule of its own for the transition divider:
 * it must INHERIT the decision from the shared `agentEventAttentionImpact` owner.
 * `attentionImpact` is not a persisted column, so a write-time constant would not
 * survive this path.
 */
describe("resolveMessageAttentionImpact — Agent-transition divider", () => {
    const DIVIDER_LOCAL_ID = "agent-transition:local_01";

    it("inherits no user attention for a stored transition divider", () => {
        expect(resolveMessageAttentionImpact({
            content: storedAgentEvent(divider()),
            localId: DIVIDER_LOCAL_ID,
        })).toEqual(SESSION_MESSAGE_NO_USER_ATTENTION_IMPACT);
    });

    it("keeps an ordinary passthrough agent message attention-bearing", () => {
        expect(resolveMessageAttentionImpact({
            content: storedAgentEvent({ type: "message", message: "Context was reset" }),
            localId: DIVIDER_LOCAL_ID,
        })).toEqual(SESSION_MESSAGE_USER_ATTENTION_IMPACT);
    });

    it("does not silence a divider sidecar carried by an ordinary row", () => {
        // The sidecar key is writable by anyone who can post an agent event, so
        // the exemption must also require the reserved localId that only the
        // owner-only cutover can produce.
        for (const localId of ["local_01", "agent-transition", null]) {
            expect(resolveMessageAttentionImpact({
                content: storedAgentEvent(divider()),
                localId,
            }), String(localId)).toEqual(SESSION_MESSAGE_USER_ATTENTION_IMPACT);
        }
    });

    it("does not silence a malformed or unknown-version sidecar", () => {
        expect(resolveMessageAttentionImpact({
            content: storedAgentEvent(divider({ v: 2, fromAgentId: "claude", toAgentId: "codex" })),
            localId: DIVIDER_LOCAL_ID,
        })).toEqual(SESSION_MESSAGE_USER_ATTENTION_IMPACT);
        expect(resolveMessageAttentionImpact({
            content: storedAgentEvent(divider({ v: 1 })),
            localId: DIVIDER_LOCAL_ID,
        })).toEqual(SESSION_MESSAGE_USER_ATTENTION_IMPACT);
    });

    // Expected, not a defect: the server never decrypts owner content. For an
    // E2EE Session the divider's no-attention property is carried at write time
    // by the transition service's trusted impact, and the CLIENT re-derives it
    // from decrypted content through the same shared owner.
    it("cannot re-derive attention for an opaque encrypted row and stays attention-bearing", () => {
        expect(resolveMessageAttentionImpact({
            content: { t: "encrypted", c: "opaque" } as PrismaJson.SessionMessageContent,
            localId: DIVIDER_LOCAL_ID,
        })).toEqual(SESSION_MESSAGE_USER_ATTENTION_IMPACT);
    });
});
