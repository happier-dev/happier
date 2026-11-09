import type { LocalServicePreviewResourceV1 } from "@happier-dev/protocol";
import type { LocalServicePreviewHttpHeaders } from "./httpAdapter.js";
import { isSafeLocalServiceHeaderField } from "./requestTarget.js";

export const DEFAULT_PREVIEW_MAX_PROXY_HOPS = 5;
const PREVIEW_HOP_HEADER = "x-happier-preview-hops";
export const PREVIEW_TRANSPORT_UNAVAILABLE_HEADER = "x-happier-preview-transport-unavailable";

function headerName(value: string): string {
    return value.trim().toLowerCase();
}

export function isPreviewControlledForwardingHeader(name: string): boolean {
    const normalized = headerName(name);
    return normalized === "forwarded"
        || normalized === "x-real-ip"
        || normalized === "via"
        || normalized.startsWith("x-forwarded-");
}

export function readPreviewHeader(headers: LocalServicePreviewHttpHeaders, name: string): string | undefined {
    const value = Object.entries(headers).find(([key]) => headerName(key) === name)?.[1];
    return typeof value === "string" ? value : value?.[0];
}

export function parseProxyHopCount(headers: LocalServicePreviewHttpHeaders): number {
    const value = Number.parseInt(readPreviewHeader(headers, PREVIEW_HOP_HEADER) ?? "0", 10);
    return Number.isFinite(value) && value > 0 ? value : 0;
}

/** Cookies the relay owns for a preview; they never reach, or are set by, the previewed application. */
export function isPreviewAuthorityCookie(name: string): boolean {
    // Retired development collector cookies can still be in a browser jar; never disclose them upstream.
    return name === "happier_preview_token" || name === "happier_public_token" || name === "happier_preview_collector";
}

export function previewTargetUrl(preview: LocalServicePreviewResourceV1): URL {
    const host = preview.target.host.includes(":") ? `[${preview.target.host}]` : preview.target.host;
    return new URL(`${preview.target.scheme}://${host}:${preview.target.port}`);
}

/** HTTP and upgrade requests share the same app credentials and external-origin policy. */
export function buildPreviewRequestHeaders(input: Readonly<{
    preview: LocalServicePreviewResourceV1;
    headers: LocalServicePreviewHttpHeaders;
    externalProtocol?: "http" | "https";
    upgrade?: boolean;
}>): Record<string, string | string[]> {
    const externalHost = readPreviewHeader(input.headers, "host");
    const target = previewTargetUrl(input.preview);
    const out: Record<string, string | string[]> = {};
    const connectionTokens = (readPreviewHeader(input.headers, "connection") ?? "").split(",").map(headerName);
    for (const [name, value] of Object.entries(input.headers)) {
        const normalized = headerName(name);
        if (!isSafeLocalServiceHeaderField(normalized) || isPreviewControlledForwardingHeader(normalized)
            || connectionTokens.includes(normalized)
            || ["authorization", "host", "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "accept-encoding", PREVIEW_HOP_HEADER].includes(normalized)) continue;
        let values = (typeof value === "string" ? [value] : value ?? []).filter(isSafeLocalServiceHeaderField);
        if (normalized === "cookie") {
            values = (input.preview.policy?.cookiePolicy ?? "rewrite") === "drop" ? [] : values.map((raw) => raw.split(";")
                .map((entry) => entry.trim()).filter((entry) => !isPreviewAuthorityCookie(entry.split("=", 1)[0]!)).join("; ")).filter(Boolean);
        }
        if (normalized === "origin" || normalized === "referer") {
            values = values.map((raw) => {
                try {
                    const parsed = new URL(raw);
                    if (!externalHost || parsed.host.toLowerCase() !== externalHost.toLowerCase()) return raw;
                    return normalized === "origin" ? target.origin : `${target.origin}${parsed.pathname}${parsed.search}${parsed.hash}`;
                } catch { return raw; }
            });
        }
        if (values.length) out[name] = values.length === 1 ? values[0]! : [...values];
    }
    out.Host = target.host;
    out.Connection = input.upgrade ? "Upgrade" : "close";
    if (input.upgrade) out.Upgrade = "websocket";
    else out["Accept-Encoding"] = "identity";
    out[PREVIEW_HOP_HEADER] = String(parseProxyHopCount(input.headers) + 1);
    if (externalHost && isSafeLocalServiceHeaderField(externalHost)) out["X-Forwarded-Host"] = externalHost;
    out["X-Forwarded-Proto"] = input.externalProtocol ?? "http";
    return out;
}
