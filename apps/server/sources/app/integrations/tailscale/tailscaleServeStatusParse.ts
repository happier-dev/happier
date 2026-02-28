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
    if (parsed.username || parsed.password) {
        parsed.username = "";
        parsed.password = "";
    }
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/+$/, "");
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

export function parseTailscaleServeHttpsBaseUrlForPort(statusText: string, port: number): string | null {
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
