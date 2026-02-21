import { describe, expect, it } from "vitest";

import { resolveAuthFeature } from "./authFeature";

function getMethod(feature: any, id: string): any | null {
    const methods = feature?.capabilities?.auth?.methods;
    if (!Array.isArray(methods)) return null;
    const normalized = id.toLowerCase();
    return methods.find((m) => String(m?.id ?? "").toLowerCase() === normalized) ?? null;
}

describe("resolveAuthFeature (auth.methods connect action)", () => {
    it("enables connect when the OAuth provider is configured", () => {
        const feature = resolveAuthFeature({
            GITHUB_CLIENT_ID: "id",
            GITHUB_CLIENT_SECRET: "secret",
            GITHUB_REDIRECT_URL: "https://example.test/v1/oauth/github/callback",
        } as NodeJS.ProcessEnv);

        const github = getMethod(feature, "github");
        expect(github?.actions).toEqual(
            expect.arrayContaining([{ id: "connect", enabled: true, mode: "either" }]),
        );
    });

    it("disables connect when the OAuth provider is not configured", () => {
        const feature = resolveAuthFeature({
            GITHUB_CLIENT_ID: "id",
            GITHUB_CLIENT_SECRET: "",
            GITHUB_REDIRECT_URL: "",
        } as NodeJS.ProcessEnv);

        const github = getMethod(feature, "github");
        expect(github?.actions).toEqual(
            expect.arrayContaining([{ id: "connect", enabled: false, mode: "either" }]),
        );
    });
});

