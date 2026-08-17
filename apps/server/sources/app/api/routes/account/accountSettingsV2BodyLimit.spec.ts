import { describe, expect, it } from "vitest";

import { ACCOUNT_SETTINGS_MAX_ENCRYPTED_CIPHERTEXT_UTF8_BYTES } from "@happier-dev/protocol";
import { createFakeRouteApp, getRouteEntry } from "../../testkit/routeHarness";
import { createAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { registerAccountSettingsRoutes } from "./registerAccountSettingsRoutes";

describe("Account Settings V2 request body limit", () => {
    it("provisions enough raw-body capacity for a maximally sized canonical encrypted request", () => {
        const app = createFakeRouteApp();
        registerAccountSettingsRoutes(app as any);
        const maximumCanonicalRequestBytes = new TextEncoder().encode(JSON.stringify({
            content: {
                t: "encrypted",
                c: "x".repeat(ACCOUNT_SETTINGS_MAX_ENCRYPTED_CIPHERTEXT_UTF8_BYTES),
            },
            expectedVersion: Number.MAX_VALUE,
        })).byteLength;

        const route = getRouteEntry(app, "POST", "/v2/account/settings");
        expect(route.opts.bodyLimit).toBeGreaterThanOrEqual(maximumCanonicalRequestBytes);
        expect(route.opts.bodyLimit).toBeLessThan(100 * 1024 * 1024);
    });

    it("rejects a raw request body over the ceiling even when its parsed ciphertext is small", async () => {
        const app = createAuthenticatedTestApp();
        registerAccountSettingsRoutes(app as any);
        await app.ready();

        try {
            const response = await app.inject({
                method: "POST",
                url: "/v2/account/settings",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": "account-1",
                },
                // Whitespace is not part of the parsed ciphertext. Its byte
                // count must still be bounded before JSON/schema processing.
                payload: `{"content":{"t":"encrypted","c":"ciphertext"}${" ".repeat(
                    ACCOUNT_SETTINGS_MAX_ENCRYPTED_CIPHERTEXT_UTF8_BYTES + 1024,
                )},"expectedVersion":0.5}`,
            });

            expect(response.statusCode).toBe(413);
        } finally {
            await app.close();
        }
    });
});
