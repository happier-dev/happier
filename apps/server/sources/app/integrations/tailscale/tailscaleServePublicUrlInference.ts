import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { parseBooleanEnv, parseIntEnv } from "@/config/env";

type TailscaleServeStatusRunner = (params: Readonly<{
    timeoutMs: number;
    env: NodeJS.ProcessEnv;
    tailscaleBin?: string;
}>) => Promise<string>;

const execFileAsync = promisify(execFile);

function stripTrailingSlash(url: string): string {
    return url.replace(/\/+$/, "");
}

function normalizeHttpsUrl(raw: string): string | null {
    const value = String(raw ?? "").trim();
    if (!value) return null;

    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        return null;
    }

    if (parsed.protocol !== "https:") return null;
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return stripTrailingSlash(parsed.toString());
}

function tryParseProxyTargetFromLine(line: string): URL | null {
    const trimmed = String(line ?? "").trim();
    const match = trimmed.match(/\bproxy\s+(\S+)/i);
    const raw = match?.[1] ? String(match[1]).trim() : "";
    if (!raw) return null;

    try {
        return new URL(raw);
    } catch {
        return null;
    }
}

function extractTailscaleServeHttpsUrl(serveStatusText: string): string | null {
    const line = String(serveStatusText ?? "")
        .split(/\r?\n/)
        .map((value) => value.trim())
        .find((value) => value.toLowerCase().includes("https://"));
    if (!line) return null;

    const match = line.match(/https:\/\/\S+/i);
    if (!match) return null;
    return normalizeHttpsUrl(match[0]);
}

function parseTailscaleServeHttpsBaseUrlForPort(statusText: string, port: number): string | null {
    const wantedPort = Number.isFinite(port) && port > 0 ? String(Math.trunc(port)) : "";
    if (!wantedPort) return null;

    let currentBase: string | null = null;
    const lines = String(statusText ?? "").split(/\r?\n/);
    for (const rawLine of lines) {
        const line = String(rawLine ?? "").trim();
        if (!line) continue;

        const maybeHttps = line.match(/^(https:\/\/\S+)/i)?.[1];
        if (maybeHttps && !line.toLowerCase().includes("proxy")) {
            currentBase = normalizeHttpsUrl(maybeHttps);
            continue;
        }

        if (!currentBase) continue;
        const proxyTarget = tryParseProxyTargetFromLine(line);
        if (!proxyTarget) continue;
        if (proxyTarget.port === wantedPort) {
            return currentBase;
        }
    }

    return null;
}

async function runLocalTailscaleServeStatus(params: Readonly<{
    timeoutMs: number;
    env: NodeJS.ProcessEnv;
    tailscaleBin?: string;
}>): Promise<string> {
    const command = String(params.tailscaleBin ?? params.env.HAPPIER_TAILSCALE_BIN ?? "tailscale").trim() || "tailscale";
    const timeoutMs = Math.max(1, Math.min(10_000, Math.trunc(params.timeoutMs)));
    const mergedEnv = { ...process.env, ...params.env };
    const result = await execFileAsync(command, ["serve", "status"], {
        env: mergedEnv,
        timeout: timeoutMs,
        maxBuffer: 2 * 1024 * 1024,
    });
    return String(result.stdout ?? "");
}

function resolveTailscaleServeStatusTimeoutMs(env: NodeJS.ProcessEnv): number {
    const raw = String(env.HAPPIER_TAILSCALE_SERVE_STATUS_TIMEOUT_MS ?? "").trim();
    return parseIntEnv(raw, 750, { min: 1, max: 10_000 });
}

function resolveApiPort(env: NodeJS.ProcessEnv): number {
    const raw = String(env.PORT ?? "").trim();
    return parseIntEnv(raw, 3005, { min: 1, max: 65_535 });
}

function shouldInferFromEnv(env: NodeJS.ProcessEnv): boolean {
    return parseBooleanEnv(env.HAPPIER_TAILSCALE_INFER_PUBLIC_URL, true);
}

export async function inferAndApplyTailscaleServePublicServerUrl(
    env: NodeJS.ProcessEnv,
    deps?: Readonly<{ runTailscaleServeStatus?: TailscaleServeStatusRunner }>,
): Promise<string | null> {
    if (String(env.HAPPIER_PUBLIC_SERVER_URL ?? "").trim()) return null;
    if (!shouldInferFromEnv(env)) return null;

    const port = resolveApiPort(env);
    const statusTimeoutMs = resolveTailscaleServeStatusTimeoutMs(env);

    try {
        const status = await (deps?.runTailscaleServeStatus ?? runLocalTailscaleServeStatus)({
            timeoutMs: statusTimeoutMs,
            env,
        });
        const inferred = parseTailscaleServeHttpsBaseUrlForPort(status, port) ?? extractTailscaleServeHttpsUrl(status);
        if (!inferred) return null;
        if (String(env.HAPPIER_PUBLIC_SERVER_URL ?? "").trim()) return null;
        env.HAPPIER_PUBLIC_SERVER_URL = inferred;
        return inferred;
    } catch {
        return null;
    }
}
