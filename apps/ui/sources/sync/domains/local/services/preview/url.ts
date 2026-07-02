export type LocalServicePreviewPlatform = "web" | "ios" | "android";

export type LocalServicePreviewLoadUrlResult =
    | Readonly<{ ok: true; url: string }>
    | Readonly<{ ok: false; reasonCode: "invalid_url" | "native_loopback_not_allowed" | "unsupported_scheme" }>;

export type ResolveLocalServicePreviewLoadUrlInput = Readonly<{
    platform: LocalServicePreviewPlatform;
    url: string;
}>;

function parsePreviewUrl(rawUrl: string): URL | null {
    try {
        return new URL(rawUrl);
    } catch {
        return null;
    }
}

function isNativePlatform(platform: LocalServicePreviewPlatform): boolean {
    return platform === "ios" || platform === "android";
}

function isLoopbackHostname(hostname: string): boolean {
    const normalized = hostname.toLowerCase().replace(/^\[/u, "").replace(/\]$/u, "");
    return (
        normalized === "localhost" ||
        normalized === "0.0.0.0" ||
        normalized === "::1" ||
        /^127(?:\.|$)/u.test(normalized) ||
        /^::ffff:127\./u.test(normalized) ||
        /^::ffff:7f[0-9a-f]{2}:/u.test(normalized)
    );
}

export function resolveLocalServicePreviewLoadUrl(
    input: ResolveLocalServicePreviewLoadUrlInput,
): LocalServicePreviewLoadUrlResult {
    const parsed = parsePreviewUrl(input.url);
    if (!parsed) {
        return { ok: false, reasonCode: "invalid_url" };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return { ok: false, reasonCode: "unsupported_scheme" };
    }
    if (isNativePlatform(input.platform) && isLoopbackHostname(parsed.hostname)) {
        return { ok: false, reasonCode: "native_loopback_not_allowed" };
    }
    return { ok: true, url: parsed.toString() };
}
