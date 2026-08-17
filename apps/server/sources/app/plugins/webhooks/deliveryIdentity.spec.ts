import { describe, expect, it } from "vitest";

import { createPluginWebhookDeliveryIdentityDigestV1 } from "./deliveryIdentity";

describe("createPluginWebhookDeliveryIdentityDigestV1", () => {
    it("returns one stable fixed-width lowercase SHA-256 identity", () => {
        const input = {
            verifierKind: "github_hmac_sha256_v1" as const,
            routeId: "route_abcd",
            providerDeliveryId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        };
        const first = createPluginWebhookDeliveryIdentityDigestV1(input);
        expect(first).toMatch(/^[0-9a-f]{64}$/u);
        expect(createPluginWebhookDeliveryIdentityDigestV1(input)).toBe(first);
    });

    it("length-prefixes every field so concatenation aliases cannot collide", () => {
        const left = createPluginWebhookDeliveryIdentityDigestV1({
            verifierKind: "github_hmac_sha256_v1",
            routeId: "a",
            providerDeliveryId: "bc",
        });
        const right = createPluginWebhookDeliveryIdentityDigestV1({
            verifierKind: "github_hmac_sha256_v1",
            routeId: "ab",
            providerDeliveryId: "c",
        });
        expect(left).not.toBe(right);
    });

    it("binds verifier, route, and provider delivery identity independently", () => {
        const base = {
            verifierKind: "github_hmac_sha256_v1" as const,
            routeId: "route_1",
            providerDeliveryId: "delivery_1",
        };
        const digest = createPluginWebhookDeliveryIdentityDigestV1(base);
        expect(createPluginWebhookDeliveryIdentityDigestV1({ ...base, routeId: "route_2" })).not.toBe(digest);
        expect(createPluginWebhookDeliveryIdentityDigestV1({ ...base, providerDeliveryId: "delivery_2" })).not.toBe(digest);
    });
});
