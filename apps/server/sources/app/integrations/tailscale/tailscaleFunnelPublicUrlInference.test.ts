import { describe, expect, it } from "vitest";

import { inferAndApplyTailscaleFunnelPublicServerUrl } from "./tailscaleFunnelPublicUrlInference";

describe("inferAndApplyTailscaleFunnelPublicServerUrl", () => {
    it("sets HAPPIER_PUBLIC_SERVER_URL when inferred and not already set", async () => {
        const env: Record<string, string | undefined> = {
            PORT: "3005",
            HAPPIER_PUBLIC_SERVER_URL: "",
            HAPPIER_TAILSCALE_INFER_PUBLIC_URL: "1",
        };

        const applied = await inferAndApplyTailscaleFunnelPublicServerUrl(env, {
            runTailscaleFunnelStatus: async () =>
                [
                    "https://my-machine.tailnet.ts.net",
                    "|-- / proxy http://127.0.0.1:3005",
                    "",
                ].join("\n"),
        });

        expect(applied).toBe("https://my-machine.tailnet.ts.net");
        expect(env.HAPPIER_PUBLIC_SERVER_URL).toBe("https://my-machine.tailnet.ts.net");
    });

    it("fails closed when tailscale funnel status throws", async () => {
        const env: Record<string, string | undefined> = {
            PORT: "3005",
            HAPPIER_PUBLIC_SERVER_URL: "",
            HAPPIER_TAILSCALE_INFER_PUBLIC_URL: "1",
        };

        const applied = await inferAndApplyTailscaleFunnelPublicServerUrl(env, {
            runTailscaleFunnelStatus: async () => {
                throw new Error("tailscale unavailable");
            },
        });

        expect(applied).toBeNull();
        expect(env.HAPPIER_PUBLIC_SERVER_URL).toBe("");
    });

    it("does not override HAPPIER_PUBLIC_SERVER_URL when already set", async () => {
        const env: Record<string, string | undefined> = {
            PORT: "3005",
            HAPPIER_PUBLIC_SERVER_URL: "https://explicit.example.test",
            HAPPIER_TAILSCALE_INFER_PUBLIC_URL: "1",
        };

        const applied = await inferAndApplyTailscaleFunnelPublicServerUrl(env, {
            runTailscaleFunnelStatus: async () => {
                throw new Error("should not be called");
            },
        });

        expect(applied).toBeNull();
        expect(env.HAPPIER_PUBLIC_SERVER_URL).toBe("https://explicit.example.test");
    });
});
