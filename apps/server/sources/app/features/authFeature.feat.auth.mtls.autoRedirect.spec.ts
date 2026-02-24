import { describe, expect, it } from "vitest";

import { resolveAuthFeature } from "./authFeature";

describe("resolveAuthFeature (mTLS auto-redirect)", () => {
    it('allows auth.ui.autoRedirect.providerId="mtls" when mTLS login is viable', () => {
        const feature = resolveAuthFeature({
            AUTH_ANONYMOUS_SIGNUP_ENABLED: "0",
            HAPPIER_FEATURE_AUTH_UI__AUTO_REDIRECT_ENABLED: "1",
            HAPPIER_FEATURE_AUTH_UI__AUTO_REDIRECT_PROVIDER_ID: "mtls",
            HAPPIER_FEATURE_AUTH_MTLS__ENABLED: "1",
            HAPPIER_FEATURE_AUTH_MTLS__MODE: "forwarded",
            HAPPIER_FEATURE_AUTH_MTLS__TRUST_FORWARDED_HEADERS: "1",
            // mTLS login is a keyless method and is unavailable when the server storage policy requires E2EE.
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
        } as NodeJS.ProcessEnv);

        expect(feature.capabilities?.auth?.ui?.autoRedirect?.enabled).toBe(true);
        expect(feature.capabilities?.auth?.ui?.autoRedirect?.providerId).toBe("mtls");
    });

    it('refuses auth.ui.autoRedirect.providerId="mtls" when mTLS login is not viable', () => {
        const feature = resolveAuthFeature({
            AUTH_ANONYMOUS_SIGNUP_ENABLED: "0",
            HAPPIER_FEATURE_AUTH_UI__AUTO_REDIRECT_ENABLED: "1",
            HAPPIER_FEATURE_AUTH_UI__AUTO_REDIRECT_PROVIDER_ID: "mtls",
            HAPPIER_FEATURE_AUTH_MTLS__ENABLED: "1",
            HAPPIER_FEATURE_AUTH_MTLS__MODE: "forwarded",
            HAPPIER_FEATURE_AUTH_MTLS__TRUST_FORWARDED_HEADERS: "0",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
        } as NodeJS.ProcessEnv);

        expect(feature.capabilities?.auth?.ui?.autoRedirect?.enabled).toBe(true);
        expect(feature.capabilities?.auth?.ui?.autoRedirect?.providerId).toBe(null);
    });
});
