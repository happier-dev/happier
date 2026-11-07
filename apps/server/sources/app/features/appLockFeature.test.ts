import { describe, expect, it } from "vitest";
import { resolveAppLockFeature } from "./appLockFeature";

describe("app-lock email recovery operator admission", () => {
    it("does not grant user-configured relay SMTP access by default", () => {
        expect(resolveAppLockFeature({}).features?.appLock?.emailRecovery?.enabled).toBe(false);
    });

    it("lets an operator explicitly admit self-hosted SMTP recovery", () => {
        expect(resolveAppLockFeature({ HAPPIER_FEATURE_APP_LOCK__EMAIL_RECOVERY__ENABLED: "1" })
            .features?.appLock?.emailRecovery?.enabled).toBe(true);
    });
});
