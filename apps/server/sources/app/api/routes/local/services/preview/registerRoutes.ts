import {
    LocalServicePreviewResourceV1Schema,
    type LocalServicePreviewResourceV1,
} from "@happier-dev/protocol";

import type { Fastify } from "@/app/api/types";
import {
    proxyLocalServicePreviewHttpRequest,
    type LocalServicePreviewHttpRequest,
    type LocalServicePreviewHttpResponseSink,
    type OpenLocalServicePreviewTunnel,
    type ProxyLocalServicePreviewHttpRequestResult,
} from "@/app/local/services/preview/httpAdapter";
import {
    proxyLocalServicePreviewWebSocketUpgrade,
    type LocalServicePreviewWebSocketClient,
    type ProxyLocalServicePreviewWebSocketUpgradeInput,
    type ProxyLocalServicePreviewWebSocketUpgradeResult,
} from "@/app/local/services/preview/websocketAdapter";
import type {
    LocalServicePreviewRuntimeRegistrationInput,
    LocalServicePreviewRuntimeRegistrationResult,
} from "@/app/local/services/preview/runtime";

type PreviewAccessValidationResult =
    | Readonly<{ ok: true }>
    | Readonly<{ ok: false; reasonCode: string }>;

export type LocalServicePreviewSessionAccessPurpose = "register" | "proxy" | "unregister";

export type RegisterLocalServicePreviewRoutesOptions = Readonly<{
    resolvePreview: (previewId: string) => LocalServicePreviewResourceV1 | null | undefined;
    resolvePreviewByHost?: (hostname: string) => LocalServicePreviewResourceV1 | null | undefined;
    authorizeSessionAccess?: (input: Readonly<{
        userId: string;
        sessionId: string;
        purpose: LocalServicePreviewSessionAccessPurpose;
    }>) => boolean | Promise<boolean>;
    validateAccess: (input: Readonly<{
        previewId: string;
        rawToken: string | null;
        sessionId: string;
        machineId: string;
    }>) => PreviewAccessValidationResult;
    registerPreview?: (input: LocalServicePreviewRuntimeRegistrationInput) => LocalServicePreviewRuntimeRegistrationResult;
    unregisterPreview?: (previewId: string) => Readonly<{ ok: true } | { ok: false; reasonCode: string }>;
    openTunnel?: OpenLocalServicePreviewTunnel;
    featureEnabled?: () => boolean;
    proxyHttp?: (input: Parameters<typeof proxyLocalServicePreviewHttpRequest>[0]) => Promise<ProxyLocalServicePreviewHttpRequestResult>;
    proxyWebSocket?: (input: ProxyLocalServicePreviewWebSocketUpgradeInput) => Promise<ProxyLocalServicePreviewWebSocketUpgradeResult>;
}>;

type RouteRequest = Readonly<{
    method?: string;
    params?: Record<string, unknown>;
    query?: Record<string, unknown>;
    headers?: Record<string, unknown>;
    body?: unknown;
    userId?: string;
}>;

type RouteReply = {
    code?: (statusCode: number) => RouteReply;
    header?: (name: string, value: string) => RouteReply;
    send?: (payload?: unknown) => unknown;
    raw?: {
        writeHead?: (statusCode: number, statusMessage: string, headers: Record<string, string>) => void;
        write?: (chunk: Uint8Array) => void;
        end?: () => void;
        destroy?: (error?: unknown) => void;
    };
};

type UpgradeRequest = Readonly<{
    url?: string;
    headers?: Record<string, string | readonly string[] | undefined>;
    rawHeaders?: readonly string[];
}>;

type UpgradeSocket = {
    write?: (chunk: Uint8Array) => unknown;
    end?: () => unknown;
    destroy?: (error?: unknown) => unknown;
};

type PreviewTokenMaterial = Readonly<{
    rawToken: string | null;
    source: "query" | "cookie" | "missing";
}>;

const PREVIEW_ROUTE_PATH = "/v1/local-services/preview/:previewId/*";
const PREVIEW_HOST_ROUTE_PATH = "/*";
const PREVIEW_REGISTRATION_ROUTE_PATH = "/v1/local-services/preview";
const PREVIEW_RESOURCE_ROUTE_PATH = "/v1/local-services/preview/:previewId";
const PREVIEW_HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;
const PREVIEW_UPGRADE_ROUTE_PREFIX = "/v1/local-services/preview/";
const textEncoder = new TextEncoder();

function readString(value: unknown): string | null {
    return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readPreviewId(request: RouteRequest): string | null {
    return readString(request.params?.previewId);
}

function readWildcardPath(request: RouteRequest): string {
    const raw = readString(request.params?.["*"]) ?? "";
    return `/${raw.replace(/^\/+/u, "")}`;
}

function serializeQuery(query: Record<string, unknown> | undefined): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query ?? {})) {
        if (key === "previewToken") continue;
        if (Array.isArray(value)) {
            for (const item of value) {
                if (typeof item !== "undefined" && item !== null) params.append(key, String(item));
            }
            continue;
        }
        if (typeof value !== "undefined" && value !== null) params.set(key, String(value));
    }
    const serialized = params.toString();
    return serialized ? `?${serialized}` : "";
}

function readCookieToken(headers: Record<string, unknown> | undefined): string | null {
    const cookieHeader = headers?.cookie;
    if (typeof cookieHeader !== "string") return null;
    for (const entry of cookieHeader.split(";")) {
        const [rawName, ...rawValue] = entry.trim().split("=");
        if (rawName === "happier_preview_token") {
            const value = rawValue.join("=").trim();
            if (value.length === 0) return null;
            try {
                return decodeURIComponent(value);
            } catch {
                return null;
            }
        }
    }
    return null;
}

function readPreviewTokenMaterial(request: RouteRequest): PreviewTokenMaterial {
    const queryToken = readString(request.query?.previewToken);
    if (queryToken) {
        return { rawToken: queryToken, source: "query" };
    }
    const cookieToken = readCookieToken(request.headers);
    if (cookieToken) {
        return { rawToken: cookieToken, source: "cookie" };
    }
    return { rawToken: null, source: "missing" };
}

function readPreviewTokenFromUrl(url: URL): string | null {
    return readString(url.searchParams.get("previewToken"));
}

function scopedPreviewTokenCookie(input: Readonly<{
    path: string;
    rawToken: string;
    secure: boolean;
}>): string {
    return [
        `happier_preview_token=${encodeURIComponent(input.rawToken)}`,
        `Path=${input.path}`,
        "HttpOnly",
        "SameSite=Lax",
        input.secure ? "Secure" : null,
    ].filter((part): part is string => Boolean(part)).join("; ");
}

function normalizeHostname(value: string): string | null {
    try {
        return new URL(`http://${value.trim()}`).hostname.toLowerCase().replace(/\.$/u, "") || null;
    } catch {
        return null;
    }
}

function readHostHeader(headers: Record<string, unknown> | undefined): string | null {
    const rawHost = headers?.host;
    const host = Array.isArray(rawHost) ? rawHost[0] : rawHost;
    return typeof host === "string" ? normalizeHostname(host) : null;
}

type PreviewHttpRouteTarget = Readonly<{
    previewId: string;
    preview: LocalServicePreviewResourceV1;
    path: string;
    search: string;
    tokenMaterial: PreviewTokenMaterial;
    exchangeCookiePath: string;
    exchangeCookieSecure: boolean;
    exchangeRedirectLocation: string;
}>;

function pathModePreviewCookiePath(previewId: string): string {
    return `/v1/local-services/preview/${encodeURIComponent(previewId)}/`;
}

function resolvePreviewHttpRouteTarget(
    request: RouteRequest,
    options: RegisterLocalServicePreviewRoutesOptions,
): PreviewHttpRouteTarget | Readonly<{ errorStatusCode: number; error: string; reasonCode: string }> {
    const path = readWildcardPath(request);
    const search = serializeQuery(request.query);
    const tokenMaterial = readPreviewTokenMaterial(request);
    const previewId = readPreviewId(request);
    if (previewId) {
        const preview = options.resolvePreview(previewId);
        if (!preview) {
            return { errorStatusCode: 404, error: "preview_not_found", reasonCode: "preview_not_found" };
        }
        return {
            previewId,
            preview,
            path,
            search,
            tokenMaterial,
            exchangeCookiePath: pathModePreviewCookiePath(previewId),
            exchangeCookieSecure: false,
            exchangeRedirectLocation: `${pathModePreviewCookiePath(previewId)}${path.replace(/^\/$/u, "")}${search}`,
        };
    }

    const hostname = readHostHeader(request.headers);
    const hostPreview = hostname ? options.resolvePreviewByHost?.(hostname) : null;
    if (!hostPreview) {
        return { errorStatusCode: 404, error: "preview_not_found", reasonCode: "preview_not_found" };
    }
    return {
        previewId: hostPreview.previewId,
        preview: hostPreview,
        path,
        search,
        tokenMaterial,
        exchangeCookiePath: "/",
        exchangeCookieSecure: true,
        exchangeRedirectLocation: `${path}${search}`,
    };
}

function isPreviewHttpRouteError(
    target: PreviewHttpRouteTarget | Readonly<{ errorStatusCode: number; error: string; reasonCode: string }>,
): target is Readonly<{ errorStatusCode: number; error: string; reasonCode: string }> {
    return "errorStatusCode" in target;
}

function redirectPreviewTokenExchange(reply: RouteReply, target: PreviewHttpRouteTarget, rawToken: string): void {
    reply
        .code?.(303)
        .header?.("Set-Cookie", scopedPreviewTokenCookie({
            path: target.exchangeCookiePath,
            rawToken,
            secure: target.exchangeCookieSecure,
        }))
        .header?.("Location", target.exchangeRedirectLocation)
        .send?.();
}

type PreviewUpgradeRoute = Readonly<{
    previewId: string;
    path: string;
    search: string;
    rawToken: string | null;
}>;

function serializeUrlSearchWithoutPreviewToken(url: URL): string {
    url.searchParams.delete("previewToken");
    const search = url.searchParams.toString();
    return search ? `?${search}` : "";
}

function requestHeadersToRecord(headers: Record<string, string | readonly string[] | undefined> | undefined): Record<string, unknown> {
    return Object.fromEntries(
        Object.entries(headers ?? {}).flatMap(([key, value]) => (
            typeof value === "string" || Array.isArray(value)
                ? [[key, value]]
                : typeof value === "undefined"
                    ? []
                    : [[key, String(value)]]
        )),
    );
}

function parseHostPreviewUpgradeRoute(
    request: UpgradeRequest,
    options: RegisterLocalServicePreviewRoutesOptions,
): PreviewUpgradeRoute | null {
    const url = upgradeUrl(request);
    const hostname = readHostHeader(requestHeadersToRecord(request.headers));
    const preview = hostname ? options.resolvePreviewByHost?.(hostname) : null;
    if (!url || !preview) return null;
    const rawToken = readPreviewTokenFromUrl(url) ?? readCookieToken(requestHeadersToRecord(request.headers));
    return {
        previewId: preview.previewId,
        path: url.pathname || "/",
        search: serializeUrlSearchWithoutPreviewToken(url),
        rawToken,
    };
}

async function* bodyChunks(body: unknown): AsyncIterable<Uint8Array> {
    if (typeof body === "undefined" || body === null) return;
    if (typeof body === "string") {
        yield textEncoder.encode(body);
        return;
    }
    if (body instanceof Uint8Array) {
        yield body;
        return;
    }
    if (Symbol.asyncIterator in Object(body)) {
        for await (const chunk of body as AsyncIterable<Uint8Array>) {
            yield chunk;
        }
        return;
    }
    yield textEncoder.encode(JSON.stringify(body));
}

function createResponseSink(reply: RouteReply, setCookie?: string): LocalServicePreviewHttpResponseSink {
    return {
        writeHead(statusCode, statusMessage, headers) {
            const responseHeaders = setCookie ? { ...headers, "Set-Cookie": setCookie } : { ...headers };
            if (reply.raw?.writeHead) {
                reply.raw.writeHead(statusCode, statusMessage, responseHeaders);
                return;
            }
            reply.code?.(statusCode);
            for (const [name, value] of Object.entries(responseHeaders)) {
                reply.header?.(name, value);
            }
        },
        write(chunk) {
            reply.raw?.write?.(chunk);
        },
        end() {
            if (reply.raw?.end) {
                reply.raw.end();
                return;
            }
            reply.send?.();
        },
        destroy(error) {
            reply.raw?.destroy?.(error);
        },
    };
}

function createPreviewHttpRequest(request: RouteRequest, target: PreviewHttpRouteTarget): LocalServicePreviewHttpRequest {
    return {
        method: request.method ?? "GET",
        path: target.path,
        search: target.search,
        headers: Object.fromEntries(
            Object.entries(request.headers ?? {}).flatMap(([key, value]) => (
                typeof value === "string" || Array.isArray(value)
                    ? [[key, value]]
                    : typeof value === "undefined"
                        ? []
                        : [[key, String(value)]]
            )),
        ),
        body: bodyChunks(request.body),
    };
}

function sendUpgradeError(socket: UpgradeSocket, statusCode: number, statusMessage: string): void {
    socket.write?.(textEncoder.encode([
        `HTTP/1.1 ${statusCode} ${statusMessage}`,
        "Connection: close",
        "Content-Length: 0",
        "",
        "",
    ].join("\r\n")));
    socket.destroy?.();
}

function upgradeUrl(request: UpgradeRequest): URL | null {
    try {
        const host = readString(request.headers?.host) ?? "localhost";
        return new URL(request.url ?? "", `http://${host}`);
    } catch {
        return null;
    }
}

function parsePreviewUpgradeRoute(request: UpgradeRequest): PreviewUpgradeRoute | null {
    const url = upgradeUrl(request);
    if (!url || !url.pathname.startsWith(PREVIEW_UPGRADE_ROUTE_PREFIX)) {
        return null;
    }
    const rest = url.pathname.slice(PREVIEW_UPGRADE_ROUTE_PREFIX.length);
    const [encodedPreviewId, ...pathParts] = rest.split("/");
    let decodedPreviewId: string | null = null;
    try {
        decodedPreviewId = encodedPreviewId ? decodeURIComponent(encodedPreviewId) : null;
    } catch {
        return null;
    }
    const previewId = readString(decodedPreviewId);
    if (!previewId) return null;

    const rawToken = readPreviewTokenFromUrl(url) ?? readCookieToken(request.headers);
    return {
        previewId,
        path: `/${pathParts.join("/")}`,
        search: serializeUrlSearchWithoutPreviewToken(url),
        rawToken,
    };
}

async function* socketChunks(socket: UpgradeSocket): AsyncIterable<Uint8Array> {
    const iterable = socket as UpgradeSocket & AsyncIterable<Uint8Array>;
    if (typeof iterable[Symbol.asyncIterator] === "function") {
        for await (const chunk of iterable) {
            yield chunk instanceof Uint8Array ? chunk : textEncoder.encode(String(chunk));
        }
    }
}

function createUpgradeClient(socket: UpgradeSocket): LocalServicePreviewWebSocketClient {
    return {
        read: () => socketChunks(socket),
        write(chunk) {
            socket.write?.(chunk);
        },
        end() {
            socket.end?.();
        },
        destroy(error) {
            socket.destroy?.(error);
        },
    };
}

function sendError(reply: RouteReply, statusCode: number, error: string, reasonCode: string): void {
    reply.code?.(statusCode).send?.({ error, reasonCode });
}

async function isSessionAuthorized(
    request: RouteRequest,
    options: RegisterLocalServicePreviewRoutesOptions,
    input: Readonly<{ sessionId: string; purpose: LocalServicePreviewSessionAccessPurpose }>,
): Promise<boolean> {
    const userId = readString(request.userId);
    if (!userId || !options.authorizeSessionAccess) {
        return false;
    }
    return await options.authorizeSessionAccess({
        userId,
        sessionId: input.sessionId,
        purpose: input.purpose,
    });
}

async function handlePreviewHttpRequest(
    request: RouteRequest,
    reply: RouteReply,
    options: RegisterLocalServicePreviewRoutesOptions,
): Promise<unknown> {
    const target = resolvePreviewHttpRouteTarget(request, options);
    if (isPreviewHttpRouteError(target)) {
        sendError(reply, target.errorStatusCode, target.error, target.reasonCode);
        return undefined;
    }

    const access = options.validateAccess({
        previewId: target.previewId,
        rawToken: target.tokenMaterial.rawToken,
        sessionId: target.preview.sessionId,
        machineId: target.preview.machineId,
    });
    if (!access.ok) {
        sendError(reply, 401, "preview_access_denied", access.reasonCode);
        return undefined;
    }

    if (target.tokenMaterial.source === "query" && target.tokenMaterial.rawToken) {
        redirectPreviewTokenExchange(reply, target, target.tokenMaterial.rawToken);
        return undefined;
    }

    const proxyHttp = options.proxyHttp ?? proxyLocalServicePreviewHttpRequest;
    if (!options.openTunnel && !options.proxyHttp) {
        sendError(reply, 503, "preview_transport_unavailable", "pms_tunnel_unavailable");
        return undefined;
    }

    return await proxyHttp({
        preview: target.preview,
        request: createPreviewHttpRequest(request, target),
        response: createResponseSink(reply),
        openTunnel: options.openTunnel as OpenLocalServicePreviewTunnel,
    });
}

async function handlePreviewWebSocketUpgrade(
    request: UpgradeRequest,
    socket: UpgradeSocket,
    head: Uint8Array,
    options: RegisterLocalServicePreviewRoutesOptions,
): Promise<void> {
    const url = upgradeUrl(request);
    if (!url) return;
    const pathModeCandidate = url.pathname.startsWith(PREVIEW_UPGRADE_ROUTE_PREFIX);
    if (!pathModeCandidate && !parseHostPreviewUpgradeRoute(request, options)) return;

    if (options.featureEnabled && !options.featureEnabled()) {
        sendUpgradeError(socket, 404, "Not Found");
        return;
    }

    const parsedRoute = parsePreviewUpgradeRoute(request) ?? parseHostPreviewUpgradeRoute(request, options);
    if (!parsedRoute) {
        sendUpgradeError(socket, 400, "Bad Request");
        return;
    }

    const preview = options.resolvePreview(parsedRoute.previewId);
    if (!preview) {
        sendUpgradeError(socket, 404, "Not Found");
        return;
    }

    const access = options.validateAccess({
        previewId: parsedRoute.previewId,
        rawToken: parsedRoute.rawToken,
        sessionId: preview.sessionId,
        machineId: preview.machineId,
    });
    if (!access.ok) {
        sendUpgradeError(socket, 401, "Unauthorized");
        return;
    }

    const proxyWebSocket = options.proxyWebSocket ?? proxyLocalServicePreviewWebSocketUpgrade;
    if (!options.openTunnel && !options.proxyWebSocket) {
        sendUpgradeError(socket, 503, "Service Unavailable");
        return;
    }

    try {
        await proxyWebSocket({
            preview,
            request: {
                path: parsedRoute.path,
                search: parsedRoute.search,
                headers: Object.fromEntries(
                    Object.entries(request.headers ?? {}).flatMap(([key, value]) => (
                        typeof value === "string" || Array.isArray(value)
                            ? [[key, value]]
                            : typeof value === "undefined"
                                ? []
                                : [[key, String(value)]]
                    )),
                ),
                rawHeaders: request.rawHeaders ?? [],
                head,
                client: createUpgradeClient(socket),
            },
            openTunnel: options.openTunnel as OpenLocalServicePreviewTunnel,
        });
    } catch {
        sendUpgradeError(socket, 502, "Bad Gateway");
    }
}

async function handleRegisterPreviewRequest(
    request: RouteRequest,
    reply: RouteReply,
    options: RegisterLocalServicePreviewRoutesOptions,
): Promise<void> {
    if (!options.registerPreview) {
        sendError(reply, 503, "preview_runtime_unavailable", "preview_runtime_unavailable");
        return;
    }

    const parsedResource = LocalServicePreviewResourceV1Schema.safeParse(request.body);
    if (!parsedResource.success) {
        sendError(reply, 400, "invalid_preview_registration", "invalid_preview_resource");
        return;
    }
    if (!await isSessionAuthorized(request, options, { sessionId: parsedResource.data.sessionId, purpose: "register" })) {
        sendError(reply, 403, "preview_access_denied", "session_not_authorized");
        return;
    }

    const userId = readString(request.userId);
    if (!userId) {
        sendError(reply, 403, "preview_access_denied", "session_not_authorized");
        return;
    }

    const result = options.registerPreview({
        resource: parsedResource.data,
        accountId: userId,
    });
    if (!result.ok) {
        sendError(reply, 400, "invalid_preview_registration", result.reasonCode);
        return;
    }

    reply.code?.(201).send?.({
        resource: result.resource,
        accessUrl: result.accessUrl,
        expiresAt: result.expiresAt,
    });
}

async function handleUnregisterPreviewRequest(
    request: RouteRequest,
    reply: RouteReply,
    options: RegisterLocalServicePreviewRoutesOptions,
): Promise<void> {
    const previewId = readPreviewId(request);
    if (!previewId) {
        sendError(reply, 400, "invalid_preview_request", "missing_preview_id");
        return;
    }
    if (!options.unregisterPreview) {
        sendError(reply, 503, "preview_runtime_unavailable", "preview_runtime_unavailable");
        return;
    }

    const preview = options.resolvePreview(previewId);
    if (!preview) {
        sendError(reply, 404, "preview_not_found", "preview_not_found");
        return;
    }
    if (!await isSessionAuthorized(request, options, { sessionId: preview.sessionId, purpose: "unregister" })) {
        sendError(reply, 403, "preview_access_denied", "session_not_authorized");
        return;
    }

    const result = options.unregisterPreview(previewId);
    if (!result.ok) {
        sendError(reply, 404, "preview_not_found", result.reasonCode);
        return;
    }
    reply.send?.({ ok: true });
}

export function registerLocalServicePreviewRoutes(
    app: Fastify,
    options: RegisterLocalServicePreviewRoutesOptions,
): void {
    app.server?.on?.("upgrade", (request, socket, head) => {
        void handlePreviewWebSocketUpgrade(request as UpgradeRequest, socket as UpgradeSocket, head, options);
    });

    app.post(PREVIEW_REGISTRATION_ROUTE_PATH, {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        await handleRegisterPreviewRequest(request as RouteRequest, reply as RouteReply, options);
    });

    app.delete(PREVIEW_RESOURCE_ROUTE_PATH, {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        await handleUnregisterPreviewRequest(request as RouteRequest, reply as RouteReply, options);
    });

    for (const method of PREVIEW_HTTP_METHODS) {
        const handler = async (request: unknown, reply: unknown) => {
            await handlePreviewHttpRequest(request as RouteRequest, reply as RouteReply, options);
        };
        if (method === "GET") {
            app.get(PREVIEW_ROUTE_PATH, { exposeHeadRoute: false }, handler);
            app.get(PREVIEW_HOST_ROUTE_PATH, { exposeHeadRoute: false }, handler);
            continue;
        }
        app[method.toLowerCase() as Lowercase<typeof method>](PREVIEW_ROUTE_PATH, handler);
        if (method === "OPTIONS") {
            continue;
        }
        app[method.toLowerCase() as Lowercase<typeof method>](PREVIEW_HOST_ROUTE_PATH, handler);
    }
}
