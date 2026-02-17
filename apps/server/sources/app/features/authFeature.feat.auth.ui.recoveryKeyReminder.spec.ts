import { describe, expect, it } from "vitest";

import { resolveAuthFeature } from "./authFeature";

describe("resolveAuthFeature", () => {
    it("defaults recovery key reminder to enabled", () => {
        const feature = resolveAuthFeature({} as NodeJS.ProcessEnv);
        expect(feature.features?.auth?.ui?.recoveryKeyReminder?.enabled).toBe(true);
    });

    it("respects explicit env overrides for recovery key reminder enablement", () => {
        const feature = resolveAuthFeature({
            HAPPIER_FEATURE_AUTH_UI__RECOVERY_KEY_REMINDER_ENABLED: "0",
        } as NodeJS.ProcessEnv);

        expect(feature.features?.auth?.ui?.recoveryKeyReminder?.enabled).toBe(false);
    });
});
