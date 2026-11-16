import { afterEach, describe, expect, it, vi } from "vitest";
import { API_TOKEN_FULL_GRANT_V1 } from "@happier-dev/protocol/auth/apiTokenGrant";

import { isApiTokenRequestOriginAllowed } from "./isApiTokenRequestOriginAllowed";

const homeEnv = (env: Record<string, string>) => async () => env;

describe("isApiTokenRequestOriginAllowed", () => {
    afterEach(() => vi.unstubAllEnvs());

    it("combines exact grant origins with the configured Happier origin", async () => {
        const env = homeEnv({ HAPPIER_WEBAPP_URL: "https://happier.test/app" });
        const grant = { ...API_TOKEN_FULL_GRANT_V1, origins: ["https://dashboard.test"] };
        await expect(isApiTokenRequestOriginAllowed(grant, "https://dashboard.test", env)).resolves.toBe(true);
        await expect(isApiTokenRequestOriginAllowed(API_TOKEN_FULL_GRANT_V1, "https://happier.test", env)).resolves.toBe(true);
        await expect(isApiTokenRequestOriginAllowed(grant, "https://denied.test", env)).resolves.toBe(false);
    });

    it("admits the web app the Home reports, including one set in Home settings rather than the process", async () => {
        // Reach, join links and Artifact links read the web app from the Home overlay; a Home-set
        // address never reaches process.env, and API-token origin admission must agree with them.
        vi.stubEnv("HAPPIER_WEBAPP_URL", "");
        const env = homeEnv({ HAPPIER_WEBAPP_URL: "https://home-set.test" });
        await expect(isApiTokenRequestOriginAllowed(API_TOKEN_FULL_GRANT_V1, "https://home-set.test", env)).resolves.toBe(true);
    });

    it.each([
        "null",
        "https://happier.test/app",
        "https://happier.test/",
        "https://user@happier.test",
        "https://happier.test.attacker.test",
        "https://dashboard.test/path",
    ])("does not reinterpret malformed or neighboring origins: %s", async (origin) => {
        const env = homeEnv({ HAPPIER_WEBAPP_URL: "https://happier.test/app" });
        const grant = { ...API_TOKEN_FULL_GRANT_V1, origins: ["https://dashboard.test"] };
        await expect(isApiTokenRequestOriginAllowed(grant, origin, env)).resolves.toBe(false);
    });
});
