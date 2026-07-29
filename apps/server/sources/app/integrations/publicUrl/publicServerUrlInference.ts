import { resolveRelayAccessConfiguredCanonicalPublicServerUrl } from "@happier-dev/cli-common/relayAccess";
import { resolveHappyHomeDirFromEnvironment } from "@happier-dev/cli-common/agents";
import { inferAndApplyTailscaleServePublicServerUrl } from "@/app/integrations/tailscale/tailscaleServePublicUrlInference";
import { inferAndApplyTailscaleFunnelPublicServerUrl } from "@/app/integrations/tailscale/tailscaleFunnelPublicUrlInference";
import { parseBooleanEnv, parseIntEnv } from "@/config/env";
import { stat } from "node:fs/promises";
import { join } from "node:path";

type InferenceCacheState = {
    value: string | null;
    resolved: boolean;
    expiresAtMs: number;
    relayAccessMtimeMs: number | null;
    inflight: Promise<string | null> | null;
};

const cache: InferenceCacheState = {
    value: null,
    resolved: false,
    expiresAtMs: 0,
    relayAccessMtimeMs: null,
    inflight: null,
};

const INFERRED_ENV_FLAG = "HAPPIER_PUBLIC_SERVER_URL_INFERRED";

function normalizeHttpUrl(raw: unknown): string | null {
    const value = String(raw ?? "").trim();
    if (!value) return null;
    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        return null;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (parsed.username || parsed.password) {
        parsed.username = "";
        parsed.password = "";
    }
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/+$/, "");
}

function resolveCacheTtlMs(env: NodeJS.ProcessEnv): number {
    const raw = String(env.HAPPIER_PUBLIC_SERVER_URL_INFER_TTL_MS ?? "").trim();
    return parseIntEnv(raw, 60_000, { min: 1_000, max: 3_600_000 });
}

function resolveInternalServerUrl(env: NodeJS.ProcessEnv): string {
    const rawPort = String(env.PORT ?? "").trim();
    const port = parseIntEnv(rawPort, 3005, { min: 1, max: 65_535 });
    return `http://127.0.0.1:${port}`;
}

function isEnvPublicServerUrlInferred(env: NodeJS.ProcessEnv): boolean {
    return String(env[INFERRED_ENV_FLAG] ?? "").trim() === "1";
}

function shouldInferFromRelayAccessConfig(env: NodeJS.ProcessEnv): boolean {
    return parseBooleanEnv(env.HAPPIER_RELAY_ACCESS_INFER_PUBLIC_URL, true);
}

async function readRelayAccessConfigMtimeMs(env: NodeJS.ProcessEnv): Promise<number | null> {
    if (!shouldInferFromRelayAccessConfig(env)) return null;
    const happyHomeDir = resolveHappyHomeDirFromEnvironment(env);
    const path = join(happyHomeDir, "relay", "access", "local.json");
    const st = await stat(path).catch(() => null);
    if (!st) return null;
    return typeof st.mtimeMs === "number" ? st.mtimeMs : null;
}

function readSingleHeaderValue(headers: Record<string, unknown>, name: string): string {
    const raw = (headers as any)[name] ?? (headers as any)[name.toLowerCase()] ?? (headers as any)[name.toUpperCase()];
    if (Array.isArray(raw)) return typeof raw[0] === "string" ? raw[0] : "";
    return typeof raw === "string" ? raw : "";
}

function readForwardedListHeader(headers: Record<string, unknown>, name: string): string {
    const raw = readSingleHeaderValue(headers, name).trim();
    if (!raw) return "";
    const first = raw.split(",")[0] ?? "";
    return first.trim();
}

function resolveRequestProtocol(request: Readonly<{ protocol?: unknown; headers: Record<string, unknown> }>): string {
    const fromRequest = typeof request.protocol === "string" ? request.protocol.trim() : "";
    if (fromRequest) return fromRequest;
    const forwarded = readForwardedListHeader(request.headers, "x-forwarded-proto");
    return forwarded || "http";
}

function resolveRequestHost(request: Readonly<{ hostname?: unknown; headers: Record<string, unknown> }>): string {
    const fromRequest = typeof request.hostname === "string" ? request.hostname.trim() : "";
    if (fromRequest) return fromRequest;
    const forwarded = readForwardedListHeader(request.headers, "x-forwarded-host");
    if (forwarded) return forwarded;
    return readForwardedListHeader(request.headers, "host");
}

function normalizeHostForComparison(raw: string): Readonly<{ hostname: string; port: string | null }> | null {
    const value = raw.trim();
    if (!value) return null;
    try {
        const url = new URL(value.includes("://") ? value : `http://${value}`);
        const hostname = url.hostname.trim().toLowerCase();
        if (!hostname) return null;
        const port = url.port ? url.port.trim() : null;
        return { hostname, port: port || null };
    } catch {
        return null;
    }
}

export async function resolveCachedCanonicalPublicServerUrl(
    env: NodeJS.ProcessEnv,
): Promise<string | null> {
    const explicit = readCanonicalPublicServerUrlFromEnv(env);
    if (explicit && !isEnvPublicServerUrlInferred(env)) return explicit;

    const now = Date.now();
    const ttlMs = resolveCacheTtlMs(env);
    const inferRelayAccess = shouldInferFromRelayAccessConfig(env);
    const relayAccessMtimeMs = inferRelayAccess ? await readRelayAccessConfigMtimeMs(env) : null;
    const relayAccessChanged = (relayAccessMtimeMs ?? null) !== (cache.relayAccessMtimeMs ?? null);

    if (cache.resolved && !relayAccessChanged && now < cache.expiresAtMs) {
        return cache.value;
    }
    if (cache.inflight) return await cache.inflight;

    cache.inflight = (async () => {
        try {
            const relayAccessCandidate = inferRelayAccess
                ? await resolveRelayAccessConfiguredCanonicalPublicServerUrl(env, {
                    upstreamUrl: resolveInternalServerUrl(env),
                })
                : null;
            if (relayAccessCandidate) {
                env.HAPPIER_PUBLIC_SERVER_URL = relayAccessCandidate;
                env[INFERRED_ENV_FLAG] = "1";
                return relayAccessCandidate;
            }
            const inferred =
                (await inferAndApplyTailscaleServePublicServerUrl(env))
                ?? (await inferAndApplyTailscaleFunnelPublicServerUrl(env));
            if (inferred) {
                env[INFERRED_ENV_FLAG] = "1";
            }
        } finally {
            // Whether inference succeeded or failed, normalize the current env value for caching.
            const resolved = normalizeHttpUrl(env.HAPPIER_PUBLIC_SERVER_URL);
            cache.value = resolved;
            cache.resolved = true;
            cache.expiresAtMs = Date.now() + ttlMs;
            cache.relayAccessMtimeMs = relayAccessMtimeMs;
        }
        return cache.value;
    })();

    try {
        return await cache.inflight;
    } finally {
        cache.inflight = null;
    }
}

export function readCanonicalPublicServerUrlFromEnv(env: NodeJS.ProcessEnv): string | null {
    return normalizeHttpUrl(env.HAPPIER_PUBLIC_SERVER_URL);
}

export function resetPublicServerUrlInferenceCacheForTests(): void {
    cache.value = null;
    cache.resolved = false;
    cache.expiresAtMs = 0;
    cache.relayAccessMtimeMs = null;
    cache.inflight = null;
}

export function isRequestOnCanonicalPublicServerUrl(params: Readonly<{
    request: Readonly<{ headers: Record<string, unknown>; hostname?: unknown; protocol?: unknown }>;
    canonicalPublicServerUrl: string | null;
}>): boolean {
    if (!params.canonicalPublicServerUrl) return false;
    const canonical = normalizeHostForComparison(params.canonicalPublicServerUrl);
    if (!canonical) return false;

    const proto = resolveRequestProtocol(params.request).toLowerCase();
    if (proto !== "http" && proto !== "https") return false;

    const host = resolveRequestHost(params.request);
    const requestHost = normalizeHostForComparison(host);
    if (!requestHost) return false;

    if (canonical.hostname !== requestHost.hostname) return false;
    // Only enforce a port match when one side declares it. (Most public URLs will omit default ports.)
    if (canonical.port && requestHost.port && canonical.port !== requestHost.port) return false;
    return true;
}
