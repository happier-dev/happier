import { describe, expect, it } from "vitest";

import { resolveFeaturesFromEnv } from "./registry";

describe("features/updatesFeature", () => {
    it("defaults OTA updates to enabled", () => {
        const result: any = resolveFeaturesFromEnv({} as any);
        expect(result.features?.updates?.ota?.enabled).toBe(true);
    });

    it("respects explicit env overrides", () => {
        const result: any = resolveFeaturesFromEnv({
            HAPPIER_FEATURE_UPDATES_OTA__ENABLED: "0",
        } as any);
        expect(result.features?.updates?.ota?.enabled).toBe(false);
    });
});

