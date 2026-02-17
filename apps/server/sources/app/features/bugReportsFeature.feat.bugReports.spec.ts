import { describe, expect, it } from "vitest";

import { resolveBugReportsFeature } from "./bugReportsFeature";

describe("features/bugReportsFeature", () => {
    it("returns defaults when env vars are not set", () => {
        const result = resolveBugReportsFeature({} as any);
        expect(result.features?.bugReports?.enabled).toBe(true);
        expect(result.capabilities?.bugReports?.providerUrl).toBe("https://reports.happier.dev");
        expect(result.capabilities?.bugReports?.defaultIncludeDiagnostics).toBe(true);
        expect(result.capabilities?.bugReports?.maxArtifactBytes).toBe(10 * 1024 * 1024);
        expect(result.capabilities?.bugReports?.uploadTimeoutMs).toBe(120000);
        expect(result.capabilities?.bugReports?.contextWindowMs).toBe(30 * 60 * 1000);
    });

    it("respects explicit env overrides", () => {
        const result = resolveBugReportsFeature({
            HAPPIER_FEATURE_BUG_REPORTS__ENABLED: "0",
            HAPPIER_FEATURE_BUG_REPORTS__PROVIDER_URL: "https://reports.enterprise.local",
            HAPPIER_FEATURE_BUG_REPORTS__DEFAULT_INCLUDE_DIAGNOSTICS: "0",
            HAPPIER_FEATURE_BUG_REPORTS__MAX_ARTIFACT_BYTES: "4096",
            HAPPIER_FEATURE_BUG_REPORTS__UPLOAD_TIMEOUT_MS: "15000",
            HAPPIER_FEATURE_BUG_REPORTS__ACCEPTED_ARTIFACT_KINDS: "ui-mobile,daemon",
            HAPPIER_FEATURE_BUG_REPORTS__CONTEXT_WINDOW_MS: "45000",
        } as any);

        expect(result.features?.bugReports?.enabled).toBe(false);
        expect(result.capabilities?.bugReports?.providerUrl).toBe("https://reports.enterprise.local");
        expect(result.capabilities?.bugReports?.defaultIncludeDiagnostics).toBe(false);
        expect(result.capabilities?.bugReports?.maxArtifactBytes).toBe(4096);
        expect(result.capabilities?.bugReports?.uploadTimeoutMs).toBe(15000);
        expect(result.capabilities?.bugReports?.contextWindowMs).toBe(45000);
        expect(result.capabilities?.bugReports?.acceptedArtifactKinds).toEqual(["ui-mobile", "daemon"]);
    });

    it("does not fail open to default provider when provider url env is invalid", () => {
        const result = resolveBugReportsFeature({
            HAPPIER_FEATURE_BUG_REPORTS__PROVIDER_URL: "not a url",
        } as any);

        expect(result.features?.bugReports?.enabled).toBe(false);
        expect(result.capabilities?.bugReports?.providerUrl).toBeNull();
    });

    it("treats non-http provider urls as invalid", () => {
        const result = resolveBugReportsFeature({
            HAPPIER_FEATURE_BUG_REPORTS__PROVIDER_URL: "ftp://reports.enterprise.local",
        } as any);

        expect(result.features?.bugReports?.enabled).toBe(false);
        expect(result.capabilities?.bugReports?.providerUrl).toBeNull();
    });

    it("strips provider url query and hash while preserving path prefix", () => {
        const result = resolveBugReportsFeature({
            HAPPIER_FEATURE_BUG_REPORTS__PROVIDER_URL: "https://reports.enterprise.local/bugs/?token=abc#frag",
        } as any);

        expect(result.features?.bugReports?.enabled).toBe(true);
        expect(result.capabilities?.bugReports?.providerUrl).toBe("https://reports.enterprise.local/bugs");
    });

    it("normalizes accepted kinds to lowercase and deduplicates entries", () => {
        const result = resolveBugReportsFeature({
            HAPPIER_FEATURE_BUG_REPORTS__ACCEPTED_ARTIFACT_KINDS: " CLI,daemon,Daemon, server ,cli ",
        } as any);

        expect(result.capabilities?.bugReports?.acceptedArtifactKinds).toEqual(["cli", "daemon", "server"]);
    });

    it("falls back to default context window when env value is invalid", () => {
        const result = resolveBugReportsFeature({
            HAPPIER_FEATURE_BUG_REPORTS__CONTEXT_WINDOW_MS: "100",
        } as any);

        expect(result.capabilities?.bugReports?.contextWindowMs).toBe(30 * 60 * 1000);
    });
});
