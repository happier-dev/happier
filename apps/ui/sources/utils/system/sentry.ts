import { MMKV } from 'react-native-mmkv';
import { Platform } from 'react-native';
import * as Sentry from '@sentry/react-native';
import type { ComponentType } from 'react';
import { parseOptionalBooleanEnv, type FeatureId } from '@happier-dev/protocol';
import { config } from '@/config';
import { getFeatureBuildPolicyDecision } from '@/sync/domains/features/featureBuildPolicy';
import { readStorageScopeFromEnv, scopedStorageId } from '@/utils/system/storageScope';

declare global {
    // eslint-disable-next-line no-var
    var __HAPPIER_SENTRY_INIT__: boolean | undefined;
    // eslint-disable-next-line no-var
    var __HAPPIER_CRASH_REPORTS_OPTOUT__: boolean | undefined;
}

const CRASH_REPORTS_FEATURE_ID = 'app.crashReports' as const satisfies FeatureId;
const IOS_REPLAY_DEFAULT_DISABLED_MAJOR_VERSION = 26;
let cachedReplayIntegration: any | null = null;
const isWebRuntime = typeof window !== 'undefined' && typeof document !== 'undefined';

function parseBooleanEnv(raw: string | undefined, defaultValue: boolean): boolean {
    const parsed = parseOptionalBooleanEnv(raw);
    return parsed === null ? defaultValue : parsed;
}

function parseRateEnv(raw: string | undefined, defaultValue: number): number {
    const parsed = Number.parseFloat(String(raw ?? '').trim());
    const value = Number.isFinite(parsed) ? parsed : defaultValue;
    return Math.max(0, Math.min(1, value));
}

// IMPORTANT: Expo only inlines EXPO_PUBLIC_* variables when accessed via dot notation.
const STATIC_SENTRY_DSN = process.env.EXPO_PUBLIC_SENTRY_DSN;
const STATIC_SENTRY_DSN_TAURI = process.env.EXPO_PUBLIC_SENTRY_DSN_TAURI;
const STATIC_SENTRY_SEND_DEFAULT_PII = process.env.EXPO_PUBLIC_SENTRY_SEND_DEFAULT_PII;
const STATIC_SENTRY_ENABLE_LOGS = process.env.EXPO_PUBLIC_SENTRY_ENABLE_LOGS;
const STATIC_SENTRY_ENABLE_REPLAY = process.env.EXPO_PUBLIC_SENTRY_ENABLE_REPLAY;
const STATIC_SENTRY_ALLOW_REPLAY_ON_IOS_26 = process.env.EXPO_PUBLIC_SENTRY_ALLOW_REPLAY_ON_IOS_26;
const STATIC_SENTRY_ENABLE_SPOTLIGHT = process.env.EXPO_PUBLIC_SENTRY_ENABLE_SPOTLIGHT;
const STATIC_SENTRY_REPLAYS_SESSION_SAMPLE_RATE = process.env.EXPO_PUBLIC_SENTRY_REPLAYS_SESSION_SAMPLE_RATE;
const STATIC_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE = process.env.EXPO_PUBLIC_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE;
const STATIC_SENTRY_ENVIRONMENT = process.env.EXPO_PUBLIC_SENTRY_ENVIRONMENT;
const STATIC_SENTRY_RELEASE = process.env.EXPO_PUBLIC_SENTRY_RELEASE;

function isTauriRuntime(): boolean {
    if (typeof window === 'undefined') return false;
    const w = window as unknown as Record<string, unknown>;
    return Boolean((w as any).__TAURI__ || (w as any).__TAURI_INTERNALS__);
}

function parseRuntimeMajorVersion(version: unknown): number | null {
    if (typeof version === 'number') {
        return Number.isFinite(version) ? Math.trunc(version) : null;
    }
    if (typeof version !== 'string') return null;
    const match = /^(\d+)/.exec(version.trim());
    if (!match) return null;
    const parsed = Number.parseInt(match[1] ?? '', 10);
    return Number.isFinite(parsed) ? parsed : null;
}

function isIosReplayDefaultDisabledRuntime(): boolean {
    if (Platform.OS !== 'ios') return false;
    const majorVersion = parseRuntimeMajorVersion(Platform.Version);
    return majorVersion !== null && majorVersion >= IOS_REPLAY_DEFAULT_DISABLED_MAJOR_VERSION;
}

function resolveReplayEnabled(): boolean {
    if (!parseBooleanEnv(STATIC_SENTRY_ENABLE_REPLAY, false)) return false;
    if (!isIosReplayDefaultDisabledRuntime()) return true;
    return parseBooleanEnv(STATIC_SENTRY_ALLOW_REPLAY_ON_IOS_26, false);
}

function readPersistedCrashReportsOptOut(): boolean {
    try {
        const storageScope = isWebRuntime ? null : readStorageScopeFromEnv();
        const storage = storageScope ? new MMKV({ id: scopedStorageId('default', storageScope) }) : new MMKV();
        const rawSettings = storage.getString('settings');
        if (!rawSettings) return false;

        const parsed = JSON.parse(rawSettings) as {
            settings?: {
                crashReportsOptOut?: unknown;
            };
        };
        return parsed.settings?.crashReportsOptOut === true;
    } catch {
        return false;
    }
}

function resolveCrashReportsOptOut(): boolean {
    if (typeof globalThis.__HAPPIER_CRASH_REPORTS_OPTOUT__ === 'boolean') {
        return globalThis.__HAPPIER_CRASH_REPORTS_OPTOUT__;
    }
    const optOut = readPersistedCrashReportsOptOut();
    globalThis.__HAPPIER_CRASH_REPORTS_OPTOUT__ = optOut;
    return optOut;
}

function resolveSentryEnv() {
    const baseDsn = (STATIC_SENTRY_DSN ?? '').trim();
    const tauriDsn = (STATIC_SENTRY_DSN_TAURI ?? '').trim();
    const dsn = isTauriRuntime() && tauriDsn ? tauriDsn : baseDsn;
    if (!dsn) return null;

    const variant = typeof config.variant === 'string' ? config.variant.trim() : '';
    const inferredEnvironment = variant || undefined;

    const sendDefaultPii = parseBooleanEnv(STATIC_SENTRY_SEND_DEFAULT_PII, false);
    const enableLogs = parseBooleanEnv(STATIC_SENTRY_ENABLE_LOGS, false);
    const enableReplay = resolveReplayEnabled();
    const spotlight = parseBooleanEnv(STATIC_SENTRY_ENABLE_SPOTLIGHT, false);

    const replaysSessionSampleRate = parseRateEnv(STATIC_SENTRY_REPLAYS_SESSION_SAMPLE_RATE, 0.1);
    const replaysOnErrorSampleRate = parseRateEnv(STATIC_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE, 1);

    const environment = (STATIC_SENTRY_ENVIRONMENT ?? '').trim() || inferredEnvironment;
    const release = (STATIC_SENTRY_RELEASE ?? '').trim() || undefined;

    return {
        dsn,
        sendDefaultPii,
        enableLogs,
        enableReplay,
        spotlight,
        replaysSessionSampleRate,
        replaysOnErrorSampleRate,
        environment,
        release,
    };
}

export function initializeSentryOnce(): void {
    if (globalThis.__HAPPIER_SENTRY_INIT__) return;
    if (getFeatureBuildPolicyDecision(CRASH_REPORTS_FEATURE_ID) === 'deny') return;
    if (resolveCrashReportsOptOut()) return;

    const resolved = resolveSentryEnv();
    if (!resolved) return;

    globalThis.__HAPPIER_SENTRY_INIT__ = true;

    cachedReplayIntegration = null;
    const replayIntegration =
        resolved.enableReplay
            ? (() => {
                  try {
                      const integration = Sentry.mobileReplayIntegration();
                      cachedReplayIntegration = integration;
                      return integration;
                  } catch {
                      cachedReplayIntegration = null;
                      return null;
                  }
              })()
            : null;

    Sentry.init({
        dsn: resolved.dsn,
        ...(resolved.environment ? { environment: resolved.environment } : null),
        ...(resolved.release ? { release: resolved.release } : null),
        sendDefaultPii: resolved.sendDefaultPii,
        enableLogs: resolved.enableLogs,
        ...(resolved.enableReplay
            ? {
                  replaysSessionSampleRate: resolved.replaysSessionSampleRate,
                  replaysOnErrorSampleRate: resolved.replaysOnErrorSampleRate,
                  integrations: replayIntegration ? [replayIntegration] : [],
              }
            : null),
        spotlight: __DEV__ && resolved.spotlight,
    });

    if (cachedReplayIntegration && typeof cachedReplayIntegration.startBuffering === 'function') {
        // Prefer privacy-preserving buffered mode when sessions aren't sampled.
        if (resolved.replaysSessionSampleRate <= 0 && resolved.replaysOnErrorSampleRate > 0) {
            try {
                cachedReplayIntegration.startBuffering();
            } catch {
                // ignore
            }
        }
    }
}

export function applyCrashReportsOptOut(optOut: boolean): void {
    globalThis.__HAPPIER_CRASH_REPORTS_OPTOUT__ = Boolean(optOut);

    if (optOut) {
        if (globalThis.__HAPPIER_SENTRY_INIT__) {
            void Sentry.close().catch(() => {});
            cachedReplayIntegration = null;
            // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
            delete globalThis.__HAPPIER_SENTRY_INIT__;
        }
        return;
    }

    initializeSentryOnce();
}

export function wrapWithSentryIfEnabled<T extends ComponentType<any>>(Component: T): T {
    if (getFeatureBuildPolicyDecision(CRASH_REPORTS_FEATURE_ID) === 'deny') return Component;
    if (resolveCrashReportsOptOut()) return Component;
    if (!resolveSentryEnv()) return Component;

    // Ensure init happens before wrap to avoid Sentry "App Start Span" warnings.
    initializeSentryOnce();
    return Sentry.wrap(Component) as unknown as T;
}

export type BugReportSentryEventInfo = {
    eventId: string;
    dsn: string;
    environment?: string;
    release?: string;
    replayId?: string;
};

export async function captureBugReportSentryEvent(): Promise<BugReportSentryEventInfo | null> {
    if (getFeatureBuildPolicyDecision(CRASH_REPORTS_FEATURE_ID) === 'deny') return null;
    if (resolveCrashReportsOptOut()) return null;
    const resolved = resolveSentryEnv();
    if (!resolved) return null;

    try {
        const eventId = Sentry.captureMessage('Bug report submitted', {
            level: "info",
        });
        if (cachedReplayIntegration && typeof cachedReplayIntegration.flush === 'function') {
            try {
                await cachedReplayIntegration.flush();
            } catch {
                // ignore
            }
        }
        const replayId =
            cachedReplayIntegration && typeof cachedReplayIntegration.getReplayId === 'function'
                ? cachedReplayIntegration.getReplayId()
                : undefined;
        return { eventId, dsn: resolved.dsn, environment: resolved.environment, release: resolved.release, replayId };
    } catch {
        return null;
    }
}

export function captureExceptionIfEnabled(
    error: unknown,
    context?: Readonly<{
        tags?: Record<string, string>;
        extra?: Record<string, unknown>;
    }>,
): void {
    if (getFeatureBuildPolicyDecision(CRASH_REPORTS_FEATURE_ID) === 'deny') return;
    if (resolveCrashReportsOptOut()) return;
    if (!resolveSentryEnv()) return;

    initializeSentryOnce();

    try {
        Sentry.captureException(error, context);
    } catch {
        // ignore reporting failures
    }
}
