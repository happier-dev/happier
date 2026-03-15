import { describe, expect, it } from "vitest";

import { resolveServerSentryConfig } from "./sentry";

describe("app/monitoring/sentry", () => {
    it("returns null when DSN is unset", () => {
        expect(resolveServerSentryConfig({} as NodeJS.ProcessEnv)).toBeNull();
    });

    it("resolves config from env", () => {
        const resolved = resolveServerSentryConfig({
            SENTRY_DSN: "https://examplePublicKey@o0.ingest.sentry.io/0",
            SENTRY_SEND_DEFAULT_PII: "1",
            SENTRY_TRACES_SAMPLE_RATE: "0.2",
            SENTRY_ENVIRONMENT: "preview",
        } as NodeJS.ProcessEnv);

        expect(resolved).toEqual({
            dsn: "https://examplePublicKey@o0.ingest.sentry.io/0",
            sendDefaultPii: true,
            tracesSampleRate: 0.2,
            environment: "preview",
            release: undefined,
            enableLogs: false,
            logLevels: ["error", "fatal"],
            profileSessionSampleRate: 0,
            profileLifecycle: "manual",
        });
    });

    it("infers environment when explicit env is missing", () => {
        const resolved = resolveServerSentryConfig({
            SENTRY_DSN: "https://examplePublicKey@o0.ingest.sentry.io/0",
            NODE_ENV: "production",
            HAPPIER_SERVER_FLAVOR: "full",
        } as NodeJS.ProcessEnv);

        expect(resolved?.environment).toBe("production:full");
    });

    it("passes through release when set", () => {
        const resolved = resolveServerSentryConfig({
            SENTRY_DSN: "https://examplePublicKey@o0.ingest.sentry.io/0",
            SENTRY_RELEASE: "happier-server@1.2.3",
        } as NodeJS.ProcessEnv);

        expect(resolved?.release).toBe("happier-server@1.2.3");
    });

    it("resolves profiling settings when set", () => {
        const resolved = resolveServerSentryConfig({
            SENTRY_DSN: "https://examplePublicKey@o0.ingest.sentry.io/0",
            SENTRY_PROFILE_SESSION_SAMPLE_RATE: "0.25",
            SENTRY_PROFILE_LIFECYCLE: "trace",
        } as NodeJS.ProcessEnv);

        expect(resolved?.profileSessionSampleRate).toBe(0.25);
        expect(resolved?.profileLifecycle).toBe("trace");
    });

    it("enables logs and parses log levels", () => {
        const resolved = resolveServerSentryConfig({
            SENTRY_DSN: "https://examplePublicKey@o0.ingest.sentry.io/0",
            SENTRY_ENABLE_LOGS: "1",
            SENTRY_LOG_LEVELS: "warn,error,fatal",
        } as NodeJS.ProcessEnv);

        expect(resolved?.enableLogs).toBe(true);
        expect(resolved?.logLevels).toEqual(["warn", "error", "fatal"]);
    });

    it("uses central DSN when opted in and explicit DSN is missing", () => {
        const resolved = resolveServerSentryConfig({
            HAPPIER_SENTRY_USE_CENTRAL_DSN: "1",
            HAPPIER_SENTRY_CENTRAL_DSN: "https://central@o0.ingest.sentry.io/1",
        } as NodeJS.ProcessEnv);

        expect(resolved?.dsn).toBe("https://central@o0.ingest.sentry.io/1");
    });

    it("prefers explicit DSN over central DSN", () => {
        const resolved = resolveServerSentryConfig({
            SENTRY_DSN: "https://explicit@o0.ingest.sentry.io/0",
            HAPPIER_SENTRY_USE_CENTRAL_DSN: "1",
            HAPPIER_SENTRY_CENTRAL_DSN: "https://central@o0.ingest.sentry.io/1",
        } as NodeJS.ProcessEnv);

        expect(resolved?.dsn).toBe("https://explicit@o0.ingest.sentry.io/0");
    });

    it("returns null when opted into central DSN but central DSN is missing", () => {
        const resolved = resolveServerSentryConfig({
            HAPPIER_SENTRY_USE_CENTRAL_DSN: "1",
        } as NodeJS.ProcessEnv);

        expect(resolved).toBeNull();
    });
});
