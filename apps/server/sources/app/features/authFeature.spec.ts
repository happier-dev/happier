import { describe, expect, it } from "vitest";

import { resolveAuthFeature } from "./authFeature";

describe("resolveAuthFeature", () => {
    it("defaults recovery key reminder to enabled", () => {
        const feature = resolveAuthFeature({} as NodeJS.ProcessEnv);
        expect(feature.auth.ui.recoveryKeyReminder.enabled).toBe(true);
    });

    it("hard-disables recovery key reminder when build policy denies the feature", () => {
        const feature = resolveAuthFeature({
            HAPPIER_BUILD_FEATURES_DENY: "auth.ui.recoveryKeyReminder",
            HAPPIER_FEATURE_AUTH_UI__RECOVERY_KEY_REMINDER_ENABLED: "1",
        } as NodeJS.ProcessEnv);

        expect(feature.auth.ui.recoveryKeyReminder.enabled).toBe(false);
    });
});

