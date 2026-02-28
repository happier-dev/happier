import * as Sentry from "@sentry/node";
import { createRequire } from "node:module";
import type { Integration } from "@sentry/core";
import type { Log } from "@sentry/core";

import { parseOptionalBooleanEnv } from "@/config/env";
import { redactSentryLogAttributes } from "./sentryLogRedaction";

type ServerSentryConfig = {
    dsn: string;
    environment?: string;
    release?: string;
    tracesSampleRate: number;
    sendDefaultPii: boolean;
    enableLogs: boolean;
    logLevels: Array<Log["level"]>;
    profileSessionSampleRate: number;
    profileLifecycle: 'manual' | 'trace';
};

let cachedConfig: ServerSentryConfig | null = null;

function tryLoadNodeProfilingIntegration(): null | (() => Integration) {
    try {
        const req = createRequire(import.meta.url);
        const mod: any = req("@sentry/profiling-node");
        const fn = mod?.nodeProfilingIntegration;
        return typeof fn === "function" ? (fn as () => Integration) : null;
    } catch {
        return null;
    }
}

function parseRateEnv(raw: string | undefined, defaultValue: number): number {
    const parsed = Number.parseFloat(String(raw ?? "").trim());
    const value = Number.isFinite(parsed) ? parsed : defaultValue;
    return Math.max(0, Math.min(1, value));
}

function parseLogLevelsEnv(raw: string | undefined, defaultValue: Array<Log["level"]>): Array<Log["level"]> {
    const v = String(raw ?? "").trim();
    if (!v) return defaultValue;
    const allowed: Array<Log["level"]> = ["trace", "debug", "info", "warn", "error", "fatal"];
    const out: Array<Log["level"]> = [];
    for (const part of v.split(",")) {
        const candidate = part.trim().toLowerCase();
        if (!candidate) continue;
        if (allowed.includes(candidate as any)) {
            out.push(candidate as Log["level"]);
        }
    }
    return out.length > 0 ? out : defaultValue;
}

function resolveEnvironment(env: NodeJS.ProcessEnv): string | undefined {
    const explicit = (env.SENTRY_ENVIRONMENT ?? env.HAPPIER_SENTRY_ENVIRONMENT ?? "").trim();
    if (explicit) return explicit;
    const nodeEnv = (env.NODE_ENV ?? "").trim();
    const flavor = (env.HAPPIER_SERVER_FLAVOR ?? env.HAPPY_SERVER_FLAVOR ?? "").trim();
    const inferred = flavor ? `${nodeEnv || "production"}:${flavor}` : (nodeEnv || "production");
    return inferred || undefined;
}

function resolveRelease(env: NodeJS.ProcessEnv): string | undefined {
    const explicit = (env.SENTRY_RELEASE ?? env.HAPPIER_SENTRY_RELEASE ?? env.HAPPIER_RELEASE ?? "").trim();
    return explicit || undefined;
}

function resolveProfileLifecycle(env: NodeJS.ProcessEnv): 'manual' | 'trace' {
    const raw = (env.SENTRY_PROFILE_LIFECYCLE ?? env.HAPPIER_SENTRY_PROFILE_LIFECYCLE ?? "").trim().toLowerCase();
    return raw === 'trace' ? 'trace' : 'manual';
}

function resolveDsn(env: NodeJS.ProcessEnv): string | null {
    const explicit = (env.SENTRY_DSN ?? env.HAPPIER_SENTRY_DSN ?? "").trim();
    if (explicit) return explicit;

    const useCentral =
        parseOptionalBooleanEnv(env.HAPPIER_SENTRY_USE_CENTRAL_DSN ?? env.SENTRY_USE_CENTRAL_DSN) ?? false;
    if (!useCentral) return null;

    const central = (env.HAPPIER_SENTRY_CENTRAL_DSN ?? env.SENTRY_CENTRAL_DSN ?? "").trim();
    return central || null;
}

export function resolveServerSentryConfig(env: NodeJS.ProcessEnv): ServerSentryConfig | null {
    const dsn = resolveDsn(env);
    if (!dsn) return null;

    const sendDefaultPii = parseOptionalBooleanEnv(env.SENTRY_SEND_DEFAULT_PII ?? env.HAPPIER_SENTRY_SEND_DEFAULT_PII) ?? false;
    const tracesSampleRate = parseRateEnv(env.SENTRY_TRACES_SAMPLE_RATE ?? env.HAPPIER_SENTRY_TRACES_SAMPLE_RATE, 0);
    const environment = resolveEnvironment(env);
    const release = resolveRelease(env);
    const profileSessionSampleRate = parseRateEnv(
        env.SENTRY_PROFILE_SESSION_SAMPLE_RATE ?? env.HAPPIER_SENTRY_PROFILE_SESSION_SAMPLE_RATE,
        0,
    );
    const profileLifecycle = resolveProfileLifecycle(env);
    const enableLogs = parseOptionalBooleanEnv(env.SENTRY_ENABLE_LOGS ?? env.HAPPIER_SENTRY_ENABLE_LOGS) ?? false;
    const logLevels = parseLogLevelsEnv(env.SENTRY_LOG_LEVELS ?? env.HAPPIER_SENTRY_LOG_LEVELS, ["error", "fatal"]);

    return {
        dsn,
        sendDefaultPii,
        tracesSampleRate,
        environment,
        release,
        enableLogs,
        logLevels,
        profileSessionSampleRate,
        profileLifecycle,
    };
}

export function initializeServerSentry(env: NodeJS.ProcessEnv): void {
    // Avoid re-initializing Sentry (important when entrypoints initialize Sentry before importing the server runtime).
    if (Sentry.getClient()) return;

    const resolved = resolveServerSentryConfig(env);
    if (!resolved) return;

    cachedConfig = resolved;
    const shouldConfigureIntegrations = resolved.tracesSampleRate > 0 || resolved.profileSessionSampleRate > 0 || resolved.enableLogs;
    Sentry.init({
        dsn: resolved.dsn,
        ...(resolved.environment ? { environment: resolved.environment } : null),
        ...(resolved.release ? { release: resolved.release } : null),
        sendDefaultPii: resolved.sendDefaultPii,
        ...(resolved.enableLogs ? { enableLogs: true, beforeSendLog: (log) => ({ ...log, attributes: redactSentryLogAttributes(log.attributes) }) } : null),
        ...(resolved.tracesSampleRate > 0 ? { tracesSampleRate: resolved.tracesSampleRate } : null),
        ...(resolved.profileSessionSampleRate > 0
            ? { profileSessionSampleRate: resolved.profileSessionSampleRate, profileLifecycle: resolved.profileLifecycle }
            : null),
        ...(shouldConfigureIntegrations
            ? {
                  integrations: (integrations: Integration[]) => {
                      const next = [...integrations];

                      if (resolved.tracesSampleRate > 0) {
                          // We keep error capture in our Fastify error handler to preserve consistent 4xx/5xx policy and custom context.
                          // Set `shouldHandleError` to false to avoid double-capturing 5xx errors.
                          next.push(
                              Sentry.fastifyIntegration({
                                  shouldHandleError: () => false,
                              }),
                          );
                      }

                      if (resolved.profileSessionSampleRate > 0) {
                          const profiling = tryLoadNodeProfilingIntegration();
                          if (profiling) {
                              next.push(profiling());
                          }
                      }

                      if (resolved.enableLogs) {
                          try {
                              next.push(
                                  Sentry.pinoIntegration({
                                      autoInstrument: true,
                                      error: { levels: [], handled: true },
                                      log: { levels: resolved.logLevels },
                                  }),
                              );
                          } catch {
                              // ignore
                          }
                      }

                      return next;
                  },
              }
            : null),
    });
}

export function captureFastifyExceptionForSentry(error: unknown, request: {
    method?: unknown;
    url?: unknown;
    ip?: unknown;
    userId?: unknown;
    headers?: Record<string, unknown> | undefined;
}): void {
    // If Sentry isn't initialized, avoid any work.
    if (!Sentry.getClient()) return;

    const method = typeof request.method === "string" ? request.method : "unknown";
    const url = typeof request.url === "string" ? request.url : "";
    const path = url.includes("?") ? url.slice(0, url.indexOf("?")) : url;
    const ip = typeof request.ip === "string" ? request.ip : undefined;
    const userAgent = typeof request.headers?.["user-agent"] === "string" ? (request.headers["user-agent"] as string) : undefined;

    Sentry.withScope((scope) => {
        scope.setTag("runtime", "server");
        scope.setTag("http.method", method);
        if (path) scope.setTag("http.path", path);
        if (userAgent) scope.setExtra("http.userAgent", userAgent);
        if (ip) scope.setExtra("http.ip", ip);

        if (cachedConfig?.sendDefaultPii) {
            const userId = typeof request.userId === "string" ? request.userId : null;
            if (userId) {
                scope.setUser({ id: userId });
            }
        }

        Sentry.captureException(error);
    });
}
