import { describe, expect, it } from "vitest";

import { resolveKeylessAutoProvisionEligibility } from "./resolveKeylessAutoProvisionEligibility";

describe("resolveKeylessAutoProvisionEligibility", () => {
    it("fails closed when keyless accounts are disabled", () => {
        const env: NodeJS.ProcessEnv = {
            HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "0",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
        };
        expect(resolveKeylessAutoProvisionEligibility(env)).toEqual({ ok: false, error: "e2ee-required" });
    });

    it("fails closed when storagePolicy=required_e2ee", () => {
        const env: NodeJS.ProcessEnv = {
            HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "1",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "required_e2ee",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "e2ee",
        };
        expect(resolveKeylessAutoProvisionEligibility(env)).toEqual({ ok: false, error: "e2ee-required" });
    });

    it("allows plaintext auto-provisioning on optional servers even when defaultAccountMode=e2ee", () => {
        const env: NodeJS.ProcessEnv = {
            HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "1",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "e2ee",
        };
        expect(resolveKeylessAutoProvisionEligibility(env)).toEqual({ ok: true, encryptionMode: "plain" });
    });
});

