import { describe, expect, it } from "vitest";

import { resolveKeylessAccountsAvailability, resolveKeylessAccountsEnabled } from "./resolveKeylessAccountsEnabled";

describe("resolveKeylessAccountsEnabled", () => {
    it("fails closed when keyless accounts env var is unset", () => {
        const env: NodeJS.ProcessEnv = {
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
        };

        expect(resolveKeylessAccountsAvailability(env)).toEqual({ ok: false, reason: "keyless-disabled" });
        expect(resolveKeylessAccountsEnabled(env)).toBe(false);
    });

    it("fails closed when storage policy requires E2EE", () => {
        const env: NodeJS.ProcessEnv = {
            HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "1",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "required_e2ee",
        };

        expect(resolveKeylessAccountsAvailability(env)).toEqual({ ok: false, reason: "e2ee-required" });
        expect(resolveKeylessAccountsEnabled(env)).toBe(false);
    });

    it("allows keyless accounts when explicitly enabled and plaintext storage is allowed", () => {
        const env: NodeJS.ProcessEnv = {
            HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "1",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
        };

        expect(resolveKeylessAccountsAvailability(env)).toEqual({ ok: true });
        expect(resolveKeylessAccountsEnabled(env)).toBe(true);
    });
});

