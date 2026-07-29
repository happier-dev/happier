import type { LocalServicePreviewResourceV1 } from "@happier-dev/protocol";

type ResponseHeaderValue = string | readonly string[];
type ResponseHeaders = Readonly<Record<string, ResponseHeaderValue>>;

type PreviewRewriteRequest = Readonly<{
    path: string;
    search: string;
}>;

function headerName(value: string): string {
    return value.trim().toLowerCase();
}

function headerValues(value: ResponseHeaderValue): readonly string[] {
    return typeof value === "string" ? [value] : value;
}

function previewPathRoot(preview: LocalServicePreviewResourceV1): string {
    return `/v1/local-services/preview/${encodeURIComponent(preview.previewId)}/`;
}

function normalizedPath(value: string | null): string {
    if (!value || value.trim().length === 0) return "/";
    return value.startsWith("/") ? value : `/${value}`;
}

function joinCookiePath(root: string, path: string): string {
    const normalized = normalizedPath(path);
    if (normalized === "/") return root;
    return `${root.replace(/\/$/u, "")}${normalized}`;
}

function previewCookiePath(input: Readonly<{
    preview: LocalServicePreviewResourceV1;
    policy: "isolate" | "rewrite";
    upstreamPath: string | null;
}>): string {
    if (input.preview.originMode === "host") {
        return input.policy === "rewrite" ? normalizedPath(input.upstreamPath) : "/";
    }
    const root = previewPathRoot(input.preview);
    return input.policy === "rewrite" ? joinCookiePath(root, input.upstreamPath ?? "/") : root;
}

function rewriteSetCookieHeader(input: Readonly<{
    rawValue: string;
    preview: LocalServicePreviewResourceV1;
    policy: "isolate" | "rewrite";
}>): string | null {
    const parts = input.rawValue.split(";").map((part) => part.trim()).filter(Boolean);
    const nameValue = parts.shift();
    if (!nameValue || !nameValue.includes("=")) return null;

    let upstreamPath: string | null = null;
    const retainedAttributes: string[] = [];
    for (const attribute of parts) {
        const separator = attribute.indexOf("=");
        const name = headerName(separator >= 0 ? attribute.slice(0, separator) : attribute);
        if (name === "domain") continue;
        if (name === "path") {
            upstreamPath = separator >= 0 ? attribute.slice(separator + 1).trim() : null;
            continue;
        }
        if (name === "samesite") continue;
        retainedAttributes.push(attribute);
    }

    return [
        nameValue,
        `Path=${previewCookiePath({
            preview: input.preview,
            policy: input.policy,
            upstreamPath,
        })}`,
        "SameSite=Lax",
        ...retainedAttributes,
    ].join("; ");
}

function isLoopbackHostname(value: string): boolean {
    const normalized = value.toLowerCase().replace(/^\[|\]$/gu, "");
    return normalized === "localhost"
        || normalized === "127.0.0.1"
        || normalized === "::1";
}

function hostnamesMatch(left: string, right: string): boolean {
    const normalizedLeft = left.toLowerCase().replace(/\.$/u, "");
    const normalizedRight = right.toLowerCase().replace(/\.$/u, "");
    if (normalizedLeft === normalizedRight) return true;
    return isLoopbackHostname(normalizedLeft) && isLoopbackHostname(normalizedRight);
}

function targetPort(preview: LocalServicePreviewResourceV1): string {
    return String(preview.target.port);
}

function locationPathForPreviewTarget(input: Readonly<{
    rawValue: string;
    preview: LocalServicePreviewResourceV1;
    request: PreviewRewriteRequest;
}>): string | null {
    const base = `${input.preview.target.scheme}://${input.preview.target.host}:${input.preview.target.port}${normalizedPath(input.request.path)}${input.request.search}`;
    try {
        const parsed = new URL(input.rawValue, base);
        const protocol = parsed.protocol.replace(/:$/u, "");
        const port = parsed.port || (protocol === "https" ? "443" : "80");
        if (
            protocol !== input.preview.target.scheme
            || port !== targetPort(input.preview)
            || !hostnamesMatch(parsed.hostname, input.preview.target.host)
        ) {
            return null;
        }
        return `${parsed.pathname || "/"}${parsed.search}${parsed.hash}`;
    } catch {
        return null;
    }
}

function rewriteLocationHeader(input: Readonly<{
    rawValue: string;
    preview: LocalServicePreviewResourceV1;
    request: PreviewRewriteRequest;
}>): string {
    if ((input.preview.policy?.redirectPolicy ?? "preserve_host_origin") !== "rewrite_path_mode") {
        return input.rawValue;
    }
    const targetPath = locationPathForPreviewTarget(input);
    if (!targetPath) return input.rawValue;
    if (input.preview.originMode === "host") return targetPath;
    return `${previewPathRoot(input.preview).replace(/\/$/u, "")}${targetPath}`;
}

export function rewritePreviewResponseHeaders(input: Readonly<{
    preview: LocalServicePreviewResourceV1;
    request: PreviewRewriteRequest;
    headers: ResponseHeaders;
}>): ResponseHeaders {
    const cookiePolicy = input.preview.policy?.cookiePolicy ?? "drop";
    const out: Record<string, ResponseHeaderValue> = {};

    for (const [name, value] of Object.entries(input.headers)) {
        const normalized = headerName(name);
        if (normalized === "connection" || normalized === "transfer-encoding") continue;
        if (normalized === "set-cookie") {
            if (cookiePolicy === "drop") continue;
            const rewritten = headerValues(value).flatMap((rawValue) => {
                const cookie = rewriteSetCookieHeader({
                    rawValue,
                    preview: input.preview,
                    policy: cookiePolicy,
                });
                return cookie ? [cookie] : [];
            });
            if (rewritten.length === 1) out[normalized] = rewritten[0]!;
            if (rewritten.length > 1) out[normalized] = rewritten;
            continue;
        }
        if (normalized === "location") {
            out[normalized] = rewriteLocationHeader({
                rawValue: headerValues(value)[0] ?? "",
                preview: input.preview,
                request: input.request,
            });
            continue;
        }
        out[normalized] = value;
    }

    return out;
}
