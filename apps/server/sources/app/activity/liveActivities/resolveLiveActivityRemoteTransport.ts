import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";

import {
    buildLiveActivityRemoteUpdateCapabilityDiagnostics,
    resolveLiveActivityRemoteUpdateMode,
    type LiveActivityDirectApnsConfigurationDiagnostic,
    type LiveActivityRemoteUpdateCapabilityDiagnostics,
    type LiveActivityRemoteUpdateMode,
    type LiveActivityRemoteUpdateModeResolution,
} from "@happier-dev/protocol";

import { parseBooleanEnv } from "@/config/env";

export type LiveActivityDirectApnsEnvironment = "sandbox" | "production";

export type LiveActivityDirectApnsConfig = Readonly<{
    configured: boolean;
    diagnostics: readonly LiveActivityDirectApnsConfigurationDiagnostic[];
    environment: LiveActivityDirectApnsEnvironment;
    teamId: string | null;
    keyId: string | null;
    privateKeyPem: string | null;
    bundleIds: readonly string[];
    allowedActivityNames: readonly string[];
}>;

export type LiveActivityHostedRelayConfig = Readonly<{
    allowed: boolean;
    capabilityAvailable: boolean;
    baseUrl: string | null;
    accessKey: string | null;
    providerImplemented: boolean;
}>;

export type LiveActivityBackgroundWakeConfig = Readonly<{
    enabled: boolean;
}>;

export type LiveActivityRemoteTransportConfig = Readonly<{
    enabled: boolean;
    preferredMode: LiveActivityRemoteUpdateMode;
    modeResolution: LiveActivityRemoteUpdateModeResolution;
    capabilityDiagnostics: LiveActivityRemoteUpdateCapabilityDiagnostics;
    directApns: LiveActivityDirectApnsConfig;
    hostedRelay: LiveActivityHostedRelayConfig;
    backgroundWake: LiveActivityBackgroundWakeConfig;
}>;

function readTrimmed(env: NodeJS.ProcessEnv, key: string): string | null {
    const value = env[key]?.trim();
    return value ? value : null;
}

function readCsv(env: NodeJS.ProcessEnv, key: string): string[] {
    const value = env[key];
    if (typeof value !== "string") return [];
    return value
        .split(/[,\n]+/g)
        .map((entry) => entry.trim())
        .filter(Boolean);
}

function readDirectApnsEnvironment(env: NodeJS.ProcessEnv): LiveActivityDirectApnsEnvironment {
    return readTrimmed(env, "HAPPIER_LIVE_ACTIVITY_APNS_ENVIRONMENT") === "production"
        ? "production"
        : "sandbox";
}

function readPreferredModeFromEnv(env: NodeJS.ProcessEnv): LiveActivityRemoteUpdateMode {
    const value = readTrimmed(env, "HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATE_MODE");
    if (
        value === "hosted_happier_relay" ||
        value === "direct_apns" ||
        value === "background_wake_best_effort" ||
        value === "local_only" ||
        value === "disabled"
    ) {
        return value;
    }
    return "local_only";
}

function readPrivateKeyPem(env: NodeJS.ProcessEnv): string | null {
    const inline = readTrimmed(env, "HAPPIER_LIVE_ACTIVITY_APNS_PRIVATE_KEY");
    if (inline) return inline;

    const path = readTrimmed(env, "HAPPIER_LIVE_ACTIVITY_APNS_PRIVATE_KEY_FILE");
    if (!path) return null;
    try {
        const fromFile = readFileSync(path, "utf8").trim();
        return fromFile || null;
    } catch {
        return null;
    }
}

function privateKeyDiagnostics(
    privateKeyPem: string | null,
): LiveActivityDirectApnsConfigurationDiagnostic[] {
    if (!privateKeyPem) return ["apns_private_key_missing"];
    if (privateKeyPem.includes("-----BEGIN CERTIFICATE-----")) {
        return ["apns_private_key_must_be_p8_token_key"];
    }
    if (!privateKeyPem.includes("-----BEGIN PRIVATE KEY-----")) {
        return ["apns_private_key_must_be_p8_token_key"];
    }
    try {
        const privateKey = createPrivateKey(privateKeyPem);
        if (
            privateKey.asymmetricKeyType !== "ec" ||
            privateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1"
        ) {
            return ["apns_private_key_must_be_p8_token_key"];
        }
    } catch {
        return ["apns_private_key_must_be_p8_token_key"];
    }
    return [];
}

function resolveDirectApnsConfig(env: NodeJS.ProcessEnv): LiveActivityDirectApnsConfig {
    const teamId = readTrimmed(env, "HAPPIER_LIVE_ACTIVITY_APNS_TEAM_ID");
    const keyId = readTrimmed(env, "HAPPIER_LIVE_ACTIVITY_APNS_KEY_ID");
    const privateKeyPem = readPrivateKeyPem(env);
    const bundleIds = readCsv(env, "HAPPIER_LIVE_ACTIVITY_APNS_BUNDLE_IDS");
    const allowedActivityNames = readCsv(env, "HAPPIER_LIVE_ACTIVITY_APNS_ACTIVITY_NAMES");
    const diagnostics: LiveActivityDirectApnsConfigurationDiagnostic[] = [];

    if (!teamId) diagnostics.push("apns_team_id_missing");
    if (!keyId) diagnostics.push("apns_key_id_missing");
    diagnostics.push(...privateKeyDiagnostics(privateKeyPem));
    if (bundleIds.length === 0) diagnostics.push("apns_bundle_id_allowlist_missing");

    return {
        configured: diagnostics.length === 0,
        diagnostics,
        environment: readDirectApnsEnvironment(env),
        teamId,
        keyId,
        privateKeyPem,
        bundleIds,
        allowedActivityNames,
    };
}

function resolveHostedRelayConfig(env: NodeJS.ProcessEnv): LiveActivityHostedRelayConfig {
    const baseUrl = readTrimmed(env, "HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_BASE_URL");
    const accessKey = readTrimmed(env, "HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_ACCESS_KEY");
    const allowed = parseBooleanEnv(env.HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_ALLOWED, false);
    const providerImplemented = true;
    const capabilityAvailable = providerImplemented && allowed && Boolean(baseUrl) && Boolean(accessKey);

    return {
        allowed,
        capabilityAvailable,
        baseUrl,
        accessKey,
        providerImplemented,
    };
}

export function resolveLiveActivityRemoteTransportConfig(
    env: NodeJS.ProcessEnv = process.env,
): LiveActivityRemoteTransportConfig {
    const enabled = parseBooleanEnv(env.HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATES_ENABLED, false);
    const directApns = resolveDirectApnsConfig(env);
    const hostedRelay = resolveHostedRelayConfig(env);
    const backgroundWake = {
        enabled: parseBooleanEnv(env.HAPPIER_LIVE_ACTIVITY_BACKGROUND_WAKE_ENABLED, false),
    };
    const capabilityDiagnostics = buildLiveActivityRemoteUpdateCapabilityDiagnostics({
        expoWidgetsPushNotificationsEnabled: parseBooleanEnv(
            env.HAPPIER_LIVE_ACTIVITY_EXPO_WIDGETS_PUSH_NOTIFICATIONS_ENABLED,
            true,
        ),
        hostedRelay,
        directApns: {
            configured: directApns.configured,
            configurationDiagnostics: directApns.diagnostics,
        },
        backgroundWake,
    });
    const preferredMode = enabled ? readPreferredModeFromEnv(env) : "disabled";
    const modeResolution = resolveLiveActivityRemoteUpdateMode({
        preferredMode,
        diagnostics: capabilityDiagnostics,
        allowFallback: parseBooleanEnv(env.HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATE_ALLOW_FALLBACK, false),
    });

    return {
        enabled,
        preferredMode,
        modeResolution,
        capabilityDiagnostics,
        directApns,
        hostedRelay,
        backgroundWake,
    };
}
