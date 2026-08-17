import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDbMocks, installDbModuleMock } from "../../testkit/dbMocks";
import { createEnvReset } from "../../testkit/env";
import { createRouteTestBuilder } from "../../testkit/routeTestBuilder";

const dbMocks = createDbMocks({
    voiceSessionLease: ["updateMany"],
} as const);

installDbModuleMock(() => ({ db: dbMocks.db }));

describe("voiceRoutes (session release)", () => {
    const resetVoiceEnv = createEnvReset();

    beforeEach(() => {
        vi.resetModules();
        dbMocks.reset();
        resetVoiceEnv({
            HAPPIER_FEATURE_VOICE__ENABLED: "1",
            ELEVENLABS_API_KEY: "el_key",
            ELEVENLABS_AGENT_ID: "agent_dev",
        });
        dbMocks.db.voiceSessionLease.updateMany.mockResolvedValue({ count: 1 });
    });

    afterEach(() => resetVoiceEnv());

    it("expires only the authenticated Account's exact lease and is existence-oblivious", async () => {
        const { voiceRoutes } = await import("./voiceRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v1/voice/session/release",
            registerRoutes(app) {
                voiceRoutes(app as any);
            },
        });

        const { response, reply } = await route.invoke({
            userId: "account-a",
            body: { leaseId: "lease-a" },
        });

        expect(reply.code).not.toHaveBeenCalled();
        expect(response).toEqual({ ok: true });
        expect(dbMocks.db.voiceSessionLease.updateMany).toHaveBeenCalledWith({
            where: { id: "lease-a", accountId: "account-a" },
            data: { expiresAt: expect.any(Date) },
        });
    });
});
