import type { LocalServicePreviewInitialPathV1, LocalServicePreviewOriginModeV1 } from '@happier-dev/protocol/local/services/preview/v1';

export function readLocalServiceRequestHostname(headers: Record<string, unknown> | undefined): string | null {
    const raw = headers?.host;
    const host = Array.isArray(raw) ? raw[0] : raw;
    if (typeof host !== 'string') return null;
    try {
        return new URL(`http://${host.trim()}`).hostname.toLowerCase().replace(/\.$/u, '') || null;
    } catch {
        return null;
    }
}

export type ResolveLocalServicePreviewUrlInput = Readonly<{
    originMode: LocalServicePreviewOriginModeV1;
    publicBaseUrl: string;
    hostOriginBaseDomain: string | null;
    previewId: string;
    initialPath: LocalServicePreviewInitialPathV1;
    token: string;
}>;

export type ResolveLocalServicePreviewUrlResult =
    | Readonly<{ ok: true; url: string; origin: string }>
    | Readonly<{ ok: false; reasonCode: LocalServiceHostOriginFailureReason }>;

export type LocalServiceHostOriginFailureReason =
    | "host_origin_unavailable"
    | "https_required"
    | "invalid_public_base_url";

export type ResolveLocalServiceHostOriginResult =
    | Readonly<{ ok: true; origin: string }>
    | Readonly<{ ok: false; reasonCode: LocalServiceHostOriginFailureReason }>;

function parseUrl(rawUrl: string): URL | null {
    try {
        return new URL(rawUrl);
    } catch {
        return null;
    }
}

export function resolveLocalServicePreviewHostLabel(previewId: string): string {
    const label = previewId.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "preview";
    return label.slice(0, 63).replace(/-+$/u, "") || "preview";
}

function isDnsLabel(label: string): boolean {
    return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label);
}

export function isLocalServicePreviewLocalhostHostname(hostname: string): boolean {
    const normalized = hostname.toLowerCase().replace(/\.$/u, "");
    return normalized === "localhost" || normalized.endsWith(".localhost");
}

function isSecurePreviewUrl(url: URL): boolean {
    return url.protocol === "https:" || (url.protocol === "http:"
        && isLocalServicePreviewLocalhostHostname(url.hostname));
}

export function normalizeLocalServiceHostOriginBaseDomain(rawDomain: string): string | null {
    const trimmed = rawDomain.trim().toLowerCase().replace(/\.$/u, "");
    if (
        trimmed.length === 0 ||
        trimmed.length > 253 ||
        trimmed.includes("://") ||
        /[/?#@:\s]/u.test(trimmed)
    ) {
        return null;
    }
    const labels = trimmed.split(".");
    if ((labels.length < 2 && trimmed !== "localhost") || !labels.every(isDnsLabel)) {
        return null;
    }
    return trimmed;
}

function appendInitialPath(url: URL, initialPath: LocalServicePreviewInitialPathV1): URL {
    url.pathname = `${url.pathname.replace(/\/+$/u, "")}${initialPath.pathname}`;
    if (initialPath.search.length > 0) {
        url.search = initialPath.search;
    }
    return url;
}

function appendPreviewToken(url: URL, token: string): URL {
    url.searchParams.set("previewToken", token);
    return url;
}

/** Configuration readiness does not invent a resource id that could collide with the API host. */
export function resolveLocalServiceHostOriginConfiguration(input: Readonly<{
    publicBaseUrl: string;
    hostOriginBaseDomain: string | null | undefined;
}>): Readonly<{ ok: true; previewBase: URL; publicOrigin: string }>
    | Readonly<{ ok: false; reasonCode: LocalServiceHostOriginFailureReason }> {
    const publicBase = parseUrl(input.publicBaseUrl);
    if (!publicBase || (publicBase.protocol !== "http:" && publicBase.protocol !== "https:")) {
        return { ok: false, reasonCode: "invalid_public_base_url" };
    }
    const baseDomain = input.hostOriginBaseDomain ? normalizeLocalServiceHostOriginBaseDomain(input.hostOriginBaseDomain) : null;
    if (!baseDomain) {
        return { ok: false, reasonCode: "host_origin_unavailable" };
    }
    if (!isSecurePreviewUrl(publicBase)) {
        return { ok: false, reasonCode: "https_required" };
    }
    const previewBase = new URL(publicBase.origin);
    previewBase.hostname = baseDomain;
    if (!isSecurePreviewUrl(previewBase)) {
        return { ok: false, reasonCode: "https_required" };
    }
    return { ok: true, previewBase, publicOrigin: publicBase.origin };
}

/**
 * Canonical owner of the per-resource isolated origin used by BOTH the private preview
 * `originMode:'host'` branch and public exposures (S-3). An exposed local service serves
 * untrusted content, so it must never share the API origin — or another resource's origin —
 * where same-origin credentialed `fetch` and cross-preview scripting become possible. Callers
 * that cannot obtain an origin must refuse rather than fall back to the API origin.
 */
export function resolveLocalServiceHostOrigin(input: Readonly<{
    publicBaseUrl: string;
    hostOriginBaseDomain: string | null | undefined;
    resourceId: string;
}>): ResolveLocalServiceHostOriginResult {
    const configuration = resolveLocalServiceHostOriginConfiguration(input);
    if (!configuration.ok) return configuration;
    const preview = configuration.previewBase;
    preview.hostname = `${resolveLocalServicePreviewHostLabel(input.resourceId)}.${preview.hostname}`;
    if (preview.origin === configuration.publicOrigin) {
        return { ok: false, reasonCode: "host_origin_unavailable" };
    }
    return { ok: true, origin: preview.origin };
}

export function resolveLocalServicePreviewUrl(input: ResolveLocalServicePreviewUrlInput): ResolveLocalServicePreviewUrlResult {
    const publicBase = parseUrl(input.publicBaseUrl);
    if (!publicBase) {
        return { ok: false, reasonCode: "invalid_public_base_url" };
    }
    if (publicBase.protocol !== "http:" && publicBase.protocol !== "https:") {
        return { ok: false, reasonCode: "invalid_public_base_url" };
    }

    if (input.originMode === "host") {
        const hostOrigin = resolveLocalServiceHostOrigin({
            publicBaseUrl: input.publicBaseUrl,
            hostOriginBaseDomain: input.hostOriginBaseDomain,
            resourceId: input.previewId,
        });
        if (!hostOrigin.ok) {
            return hostOrigin;
        }

        const origin = hostOrigin.origin;
        const url = appendPreviewToken(appendInitialPath(new URL(origin), input.initialPath), input.token);
        return { ok: true, url: url.toString(), origin };
    }

    // Direct browsers and native embeds provide no isolated-origin guarantee for API paths.
    return { ok: false, reasonCode: "host_origin_unavailable" };
}

/**
 * The scheme the viewer's browser used to reach this server, as the upstream service must see it in
 * `X-Forwarded-Proto`: a secure request, or the configured https public base when a TLS terminator in
 * front of the server hides it. One owner for the HTTP and WebSocket data planes of previews and
 * public exposures.
 */
export function resolveLocalServiceExternalProtocol(input: Readonly<{
    requestIsSecure: boolean;
    configured?: "http" | "https";
}>): "http" | "https" {
    return input.requestIsSecure || input.configured === "https" ? "https" : "http";
}
