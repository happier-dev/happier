import { describe, expect, it } from "vitest";

import {
    collectLegacyConnectedServiceVendorKeys,
    collectLegacyConnectedServiceVendorKeysFromRows,
} from "./legacyConnectedServiceVendors";

describe("legacyConnectedServiceVendors", () => {
    it("derives legacy vendor keys from canonical cloud-connect metadata", () => {
        const vendorKeys = collectLegacyConnectedServiceVendorKeys({
            alpha: { cloudConnect: { vendorKey: "openai" } },
            beta: { cloudConnect: { vendorKey: "gemini" } },
            gamma: { cloudConnect: { vendorKey: "openai" } },
            delta: { cloudConnect: null },
            epsilon: {},
        });

        expect(vendorKeys).toEqual(["openai", "gemini"]);
    });

    it("derives legacy vendor keys from service-account token rows while ignoring non-default profiles", () => {
        const vendorKeys = collectLegacyConnectedServiceVendorKeysFromRows([
            { vendor: "openai", profileId: "default" },
            { vendor: "gemini", profileId: "default" },
            { vendor: "openai", profileId: "work" },
            { vendor: "anthropic", profileId: "default" },
            { vendor: "not-a-vendor", profileId: "default" },
            { vendor: "gemini", profileId: "default" },
        ]);

        expect(vendorKeys).toEqual(["openai", "gemini", "anthropic"]);
    });
});
