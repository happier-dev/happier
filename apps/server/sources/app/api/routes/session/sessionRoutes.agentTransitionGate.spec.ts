import { describe, expect, it, vi } from "vitest";

import { createFakeRouteApp, createReplyStub, getRouteHandler } from "@/app/api/testkit/routeHarness";
import { createRouteRequest } from "@/app/api/testkit/requestFixtures";

const mocks = vi.hoisted(() => ({ applySessionAgentTransitionCutover: vi.fn() }));
vi.mock("@/app/session/agentTransition/applySessionAgentTransitionCutover", () => ({
    applySessionAgentTransitionCutover: mocks.applySessionAgentTransitionCutover,
}));

import { registerSessionAgentTransitionRoute } from "./registerSessionAgentTransitionRoute";

const { applySessionAgentTransitionCutover } = mocks;

const CUTOVER_PATH = "/v2/sessions/:sessionId/agent-transition/cutover";
const AGENT_SWITCHING_ENV_KEY = "HAPPIER_FEATURE_SESSIONS_AGENT_SWITCHING__ENABLED";

/**
 * The server-side Agent-switching gate.
 *
 * `sessions.agentSwitching` is server-represented and enabled by default; a
 * server owner who turns it off must actually REFUSE the lifecycle mutation, not
 * merely stop advertising the surface. Hiding the UI while the route still
 * commits the cutover means one direct call switches the Session on a server
 * that disabled the feature.
 */
describe("Agent-transition cutover feature gate", () => {
    async function invokeCutover(env: NodeJS.ProcessEnv) {
        applySessionAgentTransitionCutover.mockReset();
        applySessionAgentTransitionCutover.mockResolvedValue({
            ok: false,
            effect: "none",
            error: "session-not-found",
        });
        const app = createFakeRouteApp();
        registerSessionAgentTransitionRoute(app as never, env);
        const handler = getRouteHandler(app, "POST", CUTOVER_PATH);
        const reply = createReplyStub();
        await handler(
            createRouteRequest({
                userId: "u1",
                params: { sessionId: "s1" },
                body: {
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
                        content: { t: "plain", v: {} },
                    },
                },
            }),
            reply,
        );
        return reply;
    }

    it("refuses the cutover when the server owner disabled Agent switching", async () => {
        const reply = await invokeCutover({ [AGENT_SWITCHING_ENV_KEY]: "0" });

        expect(reply.statusCode).toBe(404);
        expect(reply.send).toHaveBeenCalledWith({ error: "not_found" });
        // The mutation must never run — hiding the surface is not a gate.
        expect(applySessionAgentTransitionCutover).not.toHaveBeenCalled();
    });

    it("admits the cutover on a server that never set the opt-out", async () => {
        const reply = await invokeCutover({});

        // The gate let the request through to the real handler; whatever the
        // service then answers is not the gate's business.
        expect(applySessionAgentTransitionCutover).toHaveBeenCalledTimes(1);
        expect(reply.send).not.toHaveBeenCalledWith({ error: "not_found" });
    });
});
