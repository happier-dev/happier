import { describe, expect, it } from "vitest";

import { resolveAuthFeature } from "./authFeature";

function getMethod(feature: any, id: string): any | null {
    const methods = feature?.capabilities?.auth?.methods;
    if (!Array.isArray(methods)) return null;
    const normalized = id.toLowerCase();
    return methods.find((m) => String(m?.id ?? "").toLowerCase() === normalized) ?? null;
}

describe("resolveAuthFeature (auth.methods)", () => {
    it("exposes key_challenge + mtls as auth methods when enabled", () => {
        const feature = resolveAuthFeature({
            AUTH_ANONYMOUS_SIGNUP_ENABLED: "1",
            HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "1",
            HAPPIER_FEATURE_AUTH_MTLS__ENABLED: "1",
            HAPPIER_FEATURE_AUTH_MTLS__MODE: "forwarded",
            HAPPIER_FEATURE_AUTH_MTLS__TRUST_FORWARDED_HEADERS: "1",
            HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "1",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
        } as NodeJS.ProcessEnv);

        const keyChallenge = getMethod(feature, "key_challenge");
        expect(keyChallenge).toMatchObject({ id: "key_challenge" });
        expect(keyChallenge.actions).toEqual(
            expect.arrayContaining([
                { id: "login", enabled: true, mode: "keyed" },
                { id: "provision", enabled: true, mode: "keyed" },
            ]),
        );

        const mtls = getMethod(feature, "mtls");
        expect(mtls).toMatchObject({ id: "mtls" });
        expect(mtls.actions).toEqual(
            expect.arrayContaining([{ id: "login", enabled: true, mode: "keyless" }]),
        );
    });

    it("disables key_challenge provisioning when key-challenge login is disabled", () => {
        const feature = resolveAuthFeature({
            AUTH_ANONYMOUS_SIGNUP_ENABLED: "1",
            HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "0",
        } as NodeJS.ProcessEnv);

        const keyChallenge = getMethod(feature, "key_challenge");
        expect(keyChallenge).toMatchObject({ id: "key_challenge" });
        expect(keyChallenge.actions).toEqual(
            expect.arrayContaining([{ id: "provision", enabled: false, mode: "keyed" }]),
        );
        const signupMethods = feature?.capabilities?.auth?.signup?.methods ?? [];
        const anonymous = signupMethods.find((m: any) => String(m?.id ?? "").toLowerCase() === "anonymous") ?? null;
        expect(anonymous?.enabled).toBe(false);
    });

    it("disables mTLS provisioning when keyless auto-provision eligibility is not satisfied", () => {
        const feature = resolveAuthFeature({
            AUTH_ANONYMOUS_SIGNUP_ENABLED: "0",
            HAPPIER_FEATURE_AUTH_MTLS__ENABLED: "1",
            HAPPIER_FEATURE_AUTH_MTLS__MODE: "forwarded",
            HAPPIER_FEATURE_AUTH_MTLS__TRUST_FORWARDED_HEADERS: "1",
            HAPPIER_FEATURE_AUTH_MTLS__AUTO_PROVISION: "1",
            HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "1",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "required_e2ee",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "e2ee",
        } as NodeJS.ProcessEnv);

        const mtls = getMethod(feature, "mtls");
        expect(mtls).toMatchObject({ id: "mtls" });
        expect(mtls.actions).toEqual(
            expect.arrayContaining([{ id: "provision", enabled: false, mode: "keyless" }]),
        );
    });

    it("reports a misconfig when mTLS is enabled but keyless accounts are unavailable due to required_e2ee storage policy", () => {
        const feature = resolveAuthFeature({
            AUTH_ANONYMOUS_SIGNUP_ENABLED: "0",
            HAPPIER_FEATURE_AUTH_MTLS__ENABLED: "1",
            HAPPIER_FEATURE_AUTH_MTLS__MODE: "forwarded",
            HAPPIER_FEATURE_AUTH_MTLS__TRUST_FORWARDED_HEADERS: "1",
            HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "1",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "required_e2ee",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "e2ee",
        } as NodeJS.ProcessEnv);

        const misconfig = feature?.capabilities?.auth?.misconfig ?? [];
        expect(misconfig).toEqual(expect.arrayContaining([expect.objectContaining({ code: "auth_mtls_keyless_unavailable" })]));
    });

    it("disables keyless OAuth provisioning when keyless auto-provision eligibility is not satisfied", () => {
        const feature = resolveAuthFeature({
            AUTH_ANONYMOUS_SIGNUP_ENABLED: "0",
            AUTH_SIGNUP_PROVIDERS: "",
            HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "0",
            HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "1",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "e2ee",
            HAPPIER_FEATURE_AUTH_OAUTH__KEYLESS_ENABLED: "1",
            HAPPIER_FEATURE_AUTH_OAUTH__KEYLESS_PROVIDERS: "github",
            HAPPIER_FEATURE_AUTH_OAUTH__KEYLESS_AUTO_PROVISION: "1",
            GITHUB_CLIENT_ID: "id",
            GITHUB_CLIENT_SECRET: "secret",
            GITHUB_REDIRECT_URL: "https://example.test/v1/oauth/github/callback",
        } as NodeJS.ProcessEnv);

        const github = getMethod(feature, "github");
        expect(github).toMatchObject({ id: "github" });
        expect(github.actions).toEqual(
            expect.arrayContaining([{ id: "provision", enabled: false, mode: "keyless" }]),
        );
        expect(github.actions).toEqual(
            expect.arrayContaining([{ id: "login", enabled: true, mode: "keyless" }]),
        );
    });
});
