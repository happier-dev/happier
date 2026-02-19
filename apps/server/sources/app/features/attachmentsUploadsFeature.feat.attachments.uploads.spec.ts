import { describe, expect, it } from "vitest";

import { resolveFeaturesFromEnv } from "./registry";

describe("features/attachmentsUploadsFeature", () => {
    it("defaults attachments uploads to enabled", () => {
        const result: any = resolveFeaturesFromEnv({} as any);
        expect(result.features?.attachments?.uploads?.enabled).toBe(true);
    });

    it("respects explicit env overrides", () => {
        const result: any = resolveFeaturesFromEnv({
            HAPPIER_FEATURE_ATTACHMENTS_UPLOADS__ENABLED: "1",
        } as any);
        expect(result.features?.attachments?.uploads?.enabled).toBe(true);
    });

    it("hard-disables attachments uploads when build policy denies the feature", () => {
        const result: any = resolveFeaturesFromEnv({
            HAPPIER_BUILD_FEATURES_DENY: "attachments.uploads",
            HAPPIER_FEATURE_ATTACHMENTS_UPLOADS__ENABLED: "1",
        } as any);
        expect(result.features?.attachments?.uploads?.enabled).toBe(false);
    });
});
