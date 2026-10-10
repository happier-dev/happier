import {
    LocalServicePreviewResourceV1Schema,
    localServicePreviewDirectBindingV1,
    type LocalServicePreviewResourceV1,
    type LocalServicePreviewDirectBindingV1,
} from "@happier-dev/protocol/local/services/preview/v1";
import { isDeepStrictEqual } from 'node:util';
import { readLocalServicePreviewAdmission, observeLocalServicePreviewRetirement } from '@/app/local/services/preview/admission';
import { readSessionAccessAuthenticationFromRequest, type SessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication";
import { readMachineAvailabilityState } from '@/app/machines/machineStateGuards';
import { LocalServicePreviewAccessRequestV1Schema, LocalServicePreviewServerAccessV1Schema, LocalServicePreviewNativeRegistrationRequestV1Schema, type LocalServicePreviewNativeDirectAccessRequestV1, type LocalServicePreviewNativeDirectAccessV1 } from '@happier-dev/protocol/local/services/preview/nativeDirect';
import type { MachineIrohEndpointAuthorityV1 } from '@happier-dev/protocol';

import type { Fastify } from "@/app/api/types";
import {
    proxyLocalServicePreviewHttpRequest,
    type LocalServicePreviewHttpRequest,
    type LocalServicePreviewHttpResponseSink,
    type OpenLocalServicePreviewTunnel,
    type ProxyLocalServicePreviewHttpRequestResult,
} from "@/app/local/services/preview/httpAdapter";
import type { PeerMediationObservabilityEmitter } from "@/app/api/socket/peer/mediation/observability/events";
import {
    proxyLocalServicePreviewWebSocketUpgrade,
    type ProxyLocalServicePreviewWebSocketUpgradeInput,
    type ProxyLocalServicePreviewWebSocketUpgradeResult,
} from "@/app/local/services/preview/websocketAdapter";
import {
    createLocalServicePreviewUpgradeClient,
    type LocalServicePreviewUpgradeSocket,
    writeLocalServicePreviewUpgradeError,
} from "@/app/local/services/preview/upgradeClient";
import { writeLocalServicePreviewDownstream } from "@/app/local/services/preview/downstream";
import { encodeLocalServiceRequestPath } from "@/app/local/services/preview/requestTarget";
import type {
    LocalServicePreviewRuntimeRegistrationInput,
    LocalServicePreviewRuntimeRegistrationResult,
} from "@/app/local/services/preview/runtime";

type PreviewAccessValidationResult =
    | Readonly<{ ok: true }>
    | Readonly<{ ok: false; reasonCode: string }>;

type PreviewAccessExchangeResult =
    | Readonly<{ ok: true; rawToken: string; expiresAt: number | null }>
    | Readonly<{ ok: false; reasonCode: string }>;

export type LocalServicePreviewSessionAccessPurpose = "register" | "proxy" | "unregister";

export type RegisterLocalServicePreviewRoutesOptions = Readonly<{
    resolvePreview: (previewId: string) => LocalServicePreviewResourceV1 | null | undefined;
    resolvePreviewByHost?: (hostname: string) => LocalServicePreviewResourceV1 | null | undefined;
    hostOriginBaseDomain?: string | null;
    externalProtocol?: "http" | "https";
    authorizeSessionAccess?: (input: Readonly<{
        userId: string;
        sessionId: string;
        purpose: LocalServicePreviewSessionAccessPurpose;
        authentication: SessionAccessAuthentication;
    }>) => boolean | Promise<boolean>;
    validateAccess: (input: Readonly<{
        previewId: string;
        rawToken: string | null;
        sessionId: string | undefined;
        machineId: string;
    }>) => PreviewAccessValidationResult;
    exchangeAccessToken?: (input: Readonly<{
        previewId: string;
        rawToken: string | null;
        sessionId: string | undefined;
        machineId: string;
    }>) => PreviewAccessExchangeResult;
    registerPreview?: (input: LocalServicePreviewRuntimeRegistrationInput) => LocalServicePreviewRuntimeRegistrationResult;
    resolveNativeDirectTarget?: (input: Readonly<{ accountId: string; machineId: string }>) => Promise<MachineIrohEndpointAuthorityV1 | null>;
    mintNativeDirectAccess?: (input: Readonly<{ previewId: string; actorAccountId?: string; request: LocalServicePreviewNativeDirectAccessRequestV1; target: MachineIrohEndpointAuthorityV1 }>) => Readonly<{ ok: true; access: LocalServicePreviewNativeDirectAccessV1 } | { ok: false; reasonCode: string }>;
    nativeDirectEnabled?: (request: object) => boolean | Promise<boolean>;
    openNativeRegistration?: (binding: LocalServicePreviewDirectBindingV1, grantId: string) => Readonly<{ ok: true; signal: AbortSignal; close: () => void } | { ok: false; reasonCode: string }>;
    unregisterPreview?: (previewId: string) => Readonly<{ ok: true } | { ok: false; reasonCode: string }>;
    retainConnection?: (previewId: string, close: () => void, rawToken?: string | null) => () => void;
    openTunnel?: OpenLocalServicePreviewTunnel;
    observability?: PeerMediationObservabilityEmitter;
    resolvePreviewAccountId?: (previewId: string) => string | null | undefined;
    /** The upgrade request being served, so the decision reads that request's Home configuration. */
    featureEnabled?: (request: object) => boolean | Promise<boolean>;
    proxyHttp?: (input: Parameters<typeof proxyLocalServicePreviewHttpRequest>[0]) => Promise<ProxyLocalServicePreviewHttpRequestResult>;
    proxyWebSocket?: (input: ProxyLocalServicePreviewWebSocketUpgradeInput) => Promise<ProxyLocalServicePreviewWebSocketUpgradeResult>;
}>;

type RouteRequest = Readonly<{
    raw?: import('node:http').IncomingMessage;
    method?: string;
    protocol?: string;
    params?: Record<string, unknown>;
    query?: Record<string, unknown>;
    headers?: Record<string, unknown>;
    body?: unknown;
    userId?: string;
    authAuthority?: "present_user" | "account_automation";
    authTokenAuthenticationEvidence?: readonly import("@happier-dev/protocol").AuthTokenAuthenticationEvidenceV1[];
}>;

type RouteReply = {
    hijack?: () => RouteReply;
    code?: (statusCode: number) => RouteReply;
    header?: (name: string, value: string | readonly string[]) => RouteReply;
    send?: (payload?: unknown) => unknown;
    raw?: {
        writeHead?: (statusCode: number, statusMessage: string, headers: Record<string, string | readonly string[]>) => void;
        write?: (chunk: Uint8Array) => unknown;
        end?: () => void;
        destroy?: (error?: unknown) => void;
        once?: (event: "close" | "drain" | "error", listener: () => void) => unknown;
        on?: (event: "close" | "drain" | "error", listener: () => void) => unknown;
        off?: (event: "close" | "drain" | "error", listener: () => void) => unknown;
        removeListener?: (event: "close" | "drain" | "error", listener: () => void) => unknown;
        destroyed?: boolean;
        writableEnded?: boolean;
    };
};

type UpgradeRequest = Readonly<{
    url?: string;
    headers?: Record<string, string | readonly string[] | undefined>;
    rawHeaders?: readonly string[];
    socket?: { encrypted?: boolean };
}>;

type UpgradeSocket = LocalServicePreviewUpgradeSocket;

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

type AbortableRouteReplyRaw = NonNullable<RouteReply["raw"]> & {
    on: NonNullable<NonNullable<RouteReply["raw"]>["on"]>;
};

function isAbortableRouteReplyRaw(raw: RouteReply["raw"]): raw is AbortableRouteReplyRaw {
    return typeof raw?.on === "function";
}

function readString(value: unknown): string | null {
    return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readPreviewId(request: RouteRequest): string | null {
    return readString(request.params?.previewId);
}

function readWildcardPath(request: RouteRequest): string {
    // S-1: Fastify percent-decodes the wildcard, so this value can carry a real CRLF. Re-encode
    // it once here, at the entry boundary, so both downstream sinks (the raw upstream request
    // line and the `Location` redirect header) receive a canonical request path.
    return encodeLocalServiceRequestPath(readString(request.params?.["*"]) ?? "");
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

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hostOriginConstraint(hostOriginBaseDomain: string | null | undefined): RegExp | null {
    if (!hostOriginBaseDomain) return null;
    const normalized = normalizeHostname(hostOriginBaseDomain);
    if (!normalized || normalized.includes("..")) return null;
    const labels = normalized.split(".");
    if (labels.length < 2 || labels.some((label) => label.length === 0)) return null;
    return new RegExp(`^[^.]+\\.${escapeRegExp(normalized)}(?::\\d+)?$`, "iu");
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

function resolvePreviewHttpRouteTarget(
    request: RouteRequest,
    options: RegisterLocalServicePreviewRoutesOptions,
): PreviewHttpRouteTarget | Readonly<{ errorStatusCode: number; error: string; reasonCode: string }> {
    const path = readWildcardPath(request);
    const search = serializeQuery(request.query);
    const tokenMaterial = readPreviewTokenMaterial(request);
    const previewId = readPreviewId(request);
    if (previewId) {
        return { errorStatusCode: 404, error: "preview_not_found", reasonCode: "host_origin_unavailable" };
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
    preview?: LocalServicePreviewResourceV1;
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
        preview,
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
            return writeLocalServicePreviewDownstream(reply.raw, chunk);
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

function createDownstreamAbortSignal(reply: RouteReply): AbortSignal | undefined {
    const raw = reply.raw;
    if (!isAbortableRouteReplyRaw(raw)) return undefined;
    const abortableRaw: AbortableRouteReplyRaw = raw;

    const controller = new AbortController();
    if (abortableRaw.destroyed && !abortableRaw.writableEnded) {
        controller.abort();
        return controller.signal;
    }

    let cleaned = false;
    function cleanup(): void {
        if (cleaned) return;
        cleaned = true;
        abortableRaw.off?.("close", abort);
        abortableRaw.off?.("error", abort);
        abortableRaw.removeListener?.("close", abort);
        abortableRaw.removeListener?.("error", abort);
    }
    function abort(): void {
        cleanup();
        if (!controller.signal.aborted) controller.abort();
    }

    abortableRaw.on("close", abort);
    abortableRaw.on("error", abort);
    return controller.signal;
}

function createPreviewHttpRequest(
    request: RouteRequest,
    target: PreviewHttpRouteTarget,
    signal?: AbortSignal,
): LocalServicePreviewHttpRequest {
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
        body: request.body === undefined ? undefined : bodyChunks(request.body),
        signal,
        externalProtocol: request.protocol === "https" ? "https" : "http",
    };
}

function resolveObservabilityAccountId(
    options: RegisterLocalServicePreviewRoutesOptions,
    previewId: string,
): string | undefined {
    const accountId = options.resolvePreviewAccountId?.(previewId);
    return typeof accountId === "string" && accountId.trim().length > 0 ? accountId.trim() : undefined;
}

async function sendUpgradeError(socket: UpgradeSocket, statusCode: number, statusMessage: string): Promise<void> {
    await writeLocalServicePreviewUpgradeError(socket, statusCode, statusMessage);
}

function upgradeUrl(request: UpgradeRequest): URL | null {
    try {
        const host = readString(request.headers?.host) ?? "localhost";
        return new URL(request.url ?? "", `http://${host}`);
    } catch {
        return null;
    }
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
        authentication: readSessionAccessAuthenticationFromRequest(request),
    });
}

async function isPreviewLifecycleAuthorized(
    request: RouteRequest,
    options: RegisterLocalServicePreviewRoutesOptions,
    preview: LocalServicePreviewResourceV1,
    purpose: LocalServicePreviewSessionAccessPurpose,
): Promise<boolean> {
    const userId = readString(request.userId);
    if (!userId) return false;
    if (preview.serviceTarget) return Boolean(await readLocalServicePreviewAdmission({ accountId: userId, resource: preview }));
    if (preview.owner.kind === 'user' && preview.owner.id !== userId) return false;
    if (preview.owner.kind === 'session' && preview.owner.id !== preview.sessionId) return false;
    if (purpose === 'proxy' && preview.sessionId !== undefined) {
        return isSessionAuthorized(request, options, { sessionId: preview.sessionId, purpose });
    }
    const registeredAccountId = options.resolvePreviewAccountId?.(preview.previewId);
    if (registeredAccountId && registeredAccountId !== userId) return false;
    if (await readMachineAvailabilityState({ machineId: preview.machineId, accountId: userId }) !== 'available') return false;
    return preview.sessionId === undefined || await isSessionAuthorized(request, options, {
        sessionId: preview.sessionId, purpose,
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

    if (target.tokenMaterial.source === "query" && target.tokenMaterial.rawToken) {
        const exchanged = options.exchangeAccessToken?.({
            previewId: target.previewId,
            rawToken: target.tokenMaterial.rawToken,
            sessionId: target.preview.sessionId,
            machineId: target.preview.machineId,
        }) ?? { ok: false as const, reasonCode: "preview_token_exchange_unavailable" };
        if (!exchanged.ok) {
            // A reload can still carry the already-consumed admission URL. A valid cookie for
            // this exact registration may remove it without reissuing the cookie.
            const cookieToken = readCookieToken(request.headers);
            if (cookieToken && options.validateAccess({
                previewId: target.previewId, rawToken: cookieToken,
                sessionId: target.preview.sessionId, machineId: target.preview.machineId,
            }).ok) {
                reply.code?.(303).header?.('Location', target.exchangeRedirectLocation).send?.();
                return undefined;
            }
            sendError(reply, 401, "preview_access_denied", exchanged.reasonCode);
            return undefined;
        }
        redirectPreviewTokenExchange(reply, target, exchanged.rawToken);
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

    const proxyHttp = options.proxyHttp ?? proxyLocalServicePreviewHttpRequest;
    if (!options.openTunnel && !options.proxyHttp) {
        sendError(reply, 503, "preview_transport_unavailable", "pms_tunnel_unavailable");
        return undefined;
    }

    const registration = new AbortController();
    const releaseConnection = options.retainConnection?.(target.previewId, () => {
        registration.abort();
        reply.raw?.destroy?.();
    }, target.tokenMaterial.rawToken);
    if (registration.signal.aborted) { releaseConnection?.(); return undefined; }
    const downstream = createDownstreamAbortSignal(reply);
    const signal = downstream ? AbortSignal.any([registration.signal, downstream]) : registration.signal;
    try {
        return await proxyHttp({
            preview: target.preview,
            request: createPreviewHttpRequest(request, target, signal),
            response: createResponseSink(reply),
            openTunnel: options.openTunnel as OpenLocalServicePreviewTunnel,
            observability: options.observability,
            observabilityAccountId: resolveObservabilityAccountId(options, target.previewId),
        });
    } finally {
        releaseConnection?.();
    }
}

async function handlePreviewWebSocketUpgrade(
    request: UpgradeRequest,
    socket: UpgradeSocket,
    head: Uint8Array,
    options: RegisterLocalServicePreviewRoutesOptions,
): Promise<void> {
    const url = upgradeUrl(request);
    if (!url) return;
    const hostRouteCandidate = parseHostPreviewUpgradeRoute(request, options);
    if (!hostRouteCandidate) {
        if (url.pathname.startsWith(PREVIEW_UPGRADE_ROUTE_PREFIX)) await sendUpgradeError(socket, 404, 'Not Found');
        return;
    }

    if (options.featureEnabled && !await options.featureEnabled(request)) {
        await sendUpgradeError(socket, 404, "Not Found");
        return;
    }

    const parsedRoute = hostRouteCandidate;
    if (!parsedRoute) {
        await sendUpgradeError(socket, 400, "Bad Request");
        return;
    }

    const preview = parsedRoute.preview ?? options.resolvePreview(parsedRoute.previewId);
    if (!preview) {
        await sendUpgradeError(socket, 404, "Not Found");
        return;
    }

    const access = options.validateAccess({
        previewId: parsedRoute.previewId,
        rawToken: parsedRoute.rawToken,
        sessionId: preview.sessionId,
        machineId: preview.machineId,
    });
    if (!access.ok) {
        await sendUpgradeError(socket, 401, "Unauthorized");
        return;
    }

    const proxyWebSocket = options.proxyWebSocket ?? proxyLocalServicePreviewWebSocketUpgrade;
    if (!options.openTunnel && !options.proxyWebSocket) {
        await sendUpgradeError(socket, 503, "Service Unavailable");
        return;
    }

    const registration = new AbortController();
    const releaseConnection = options.retainConnection?.(parsedRoute.previewId, () => {
        registration.abort();
        socket.destroy?.();
    }, parsedRoute.rawToken);
    if (registration.signal.aborted || socket.destroyed) { releaseConnection?.(); return; }
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
                externalProtocol: request.socket?.encrypted ? "https" : options.externalProtocol ?? "http",
                head,
                signal: registration.signal,
                client: createLocalServicePreviewUpgradeClient(socket),
            },
            openTunnel: options.openTunnel as OpenLocalServicePreviewTunnel,
            observability: options.observability,
            observabilityAccountId: resolveObservabilityAccountId(options, parsedRoute.previewId),
        });
    } catch {
        await sendUpgradeError(socket, 502, "Bad Gateway");
    } finally {
        releaseConnection?.();
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
    const userId = readString(request.userId);
    const serviceAdmission = parsedResource.data.serviceTarget && userId
        ? await readLocalServicePreviewAdmission({ accountId: userId, resource: parsedResource.data }) : null;
    if (parsedResource.data.serviceTarget
        ? !serviceAdmission || !options.retainConnection || !options.unregisterPreview
        : !await isPreviewLifecycleAuthorized(request, options, parsedResource.data, 'register')) {
        sendError(reply, 403, "preview_access_denied", "session_not_authorized");
        return;
    }

    if (!userId) {
        sendError(reply, 403, "preview_access_denied", "session_not_authorized");
        return;
    }

    const previous = options.resolvePreview(parsedResource.data.previewId);
    const accountId = serviceAdmission && parsedResource.data.owner.kind === 'user' ? parsedResource.data.owner.id : userId;
    const result = options.registerPreview({
        resource: parsedResource.data,
        accountId,
        ...(serviceAdmission ? { viewerAccountId: userId } : {}),
        nativeDirectSupported: options.resolveNativeDirectTarget
            ? Boolean(await options.resolveNativeDirectTarget({ accountId: serviceAdmission?.custodianAccountId ?? userId, machineId: parsedResource.data.machineId })) : false,
    });
    if (!result.ok) {
        sendError(reply, 400, "invalid_preview_registration", result.reasonCode);
        return;
    }

    if (serviceAdmission && (!previous || !isDeepStrictEqual(localServicePreviewDirectBindingV1(previous), localServicePreviewDirectBindingV1(result.resource)))) {
        const lifetime = new AbortController();
        const binding = localServicePreviewDirectBindingV1(result.resource);
        const release = options.retainConnection?.(result.resource.previewId, () => lifetime.abort());
        const retire = () => {
            const current = options.resolvePreview(result.resource.previewId);
            if (!lifetime.signal.aborted && current && isDeepStrictEqual(localServicePreviewDirectBindingV1(current), binding)) {
                options.unregisterPreview?.(current.previewId);
            }
        };
        void observeLocalServicePreviewRetirement({ admission: serviceAdmission, resource: result.resource, signal: lifetime.signal })
            .then(retire, retire).finally(() => release?.());
    }

    reply.code?.(201).send?.({
        resource: result.resource,
        accessUrl: result.accessUrl,
        expiresAt: result.expiresAt,
        ...(result.nativeDirect ? { nativeDirect: result.nativeDirect } : {}),
        ...(result.accessUnavailableReasonCode ? { accessUnavailableReasonCode: result.accessUnavailableReasonCode } : {}),
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
    if (!await isPreviewLifecycleAuthorized(request, options, preview, 'unregister')) {
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
    app.server?.on?.("upgrade", (request, socket, head) => (
        handlePreviewWebSocketUpgrade(request as UpgradeRequest, socket as UpgradeSocket, head, options)
    ));

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

    app.post(`${PREVIEW_RESOURCE_ROUTE_PATH}/access`, { preHandler: app.authenticate }, async (rawRequest, rawReply) => {
        const request = rawRequest as RouteRequest;
        const reply = rawReply as RouteReply;
        const previewId = readPreviewId(request);
        const parsed = LocalServicePreviewAccessRequestV1Schema.safeParse(request.body);
        if (!previewId || !parsed.success) return sendError(reply, 400, 'invalid_preview_request', 'invalid_native_access_request');
        const resource = options.resolvePreview(previewId);
        if (!resource) return sendError(reply, 404, 'preview_not_found', 'preview_not_found');
        const actorAccountId = readString(request.userId);
        const serviceAdmission = resource.serviceTarget && actorAccountId
            ? await readLocalServicePreviewAdmission({ accountId: actorAccountId, resource }) : null;
        if (resource.serviceTarget ? !serviceAdmission : !await isPreviewLifecycleAuthorized(request, options, resource, 'proxy')) {
            return sendError(reply, 403, 'preview_access_denied', 'session_not_authorized');
        }
        if (options.resolvePreview(previewId) !== resource) return sendError(reply, 404, 'preview_not_found', 'preview_not_found');
        const accountId = options.resolvePreviewAccountId?.(previewId);
        if ('kind' in parsed.data) {
            if (!accountId || !options.registerPreview) return sendError(reply, 503, 'preview_transport_unavailable', 'server_preview_unavailable');
            const admission = options.registerPreview({ resource, accountId,
                ...(serviceAdmission && actorAccountId ? { viewerAccountId: actorAccountId } : {}) });
            if (!admission.ok) return sendError(reply, 503, 'preview_transport_unavailable', admission.reasonCode);
            if (!admission.accessUrl || admission.expiresAt === null) return sendError(reply, 503, 'preview_transport_unavailable', 'preview_private_route_unavailable');
            return reply.send?.(LocalServicePreviewServerAccessV1Schema.parse({
                v: 1, kind: 'server_preview', previewId, machineId: resource.machineId,
                accessUrl: admission.accessUrl, expiresAt: admission.expiresAt,
            }));
        }
        if (!accountId || !options.resolveNativeDirectTarget || !options.mintNativeDirectAccess
            || options.nativeDirectEnabled && !await options.nativeDirectEnabled(request)) return sendError(reply, 503, 'preview_transport_unavailable', 'native_preview_unavailable');
        const target = await options.resolveNativeDirectTarget({ accountId: serviceAdmission?.custodianAccountId ?? accountId, machineId: resource.machineId });
        if (!target) return sendError(reply, 503, 'preview_transport_unavailable', 'machine_iroh_endpoint_unavailable');
        // Revoke/replacement during the asynchronous target read cannot mint old authority.
        if (options.resolvePreview(previewId) !== resource) return sendError(reply, 404, 'preview_not_found', 'preview_not_found');
        if (serviceAdmission && actorAccountId && !await readLocalServicePreviewAdmission({ accountId: actorAccountId, resource })) {
            return sendError(reply, 403, 'preview_access_denied', 'session_not_authorized');
        }
        if (options.resolvePreview(previewId) !== resource) return sendError(reply, 404, 'preview_not_found', 'preview_not_found');
        const result = options.mintNativeDirectAccess({ previewId, request: parsed.data, target,
            ...(serviceAdmission && actorAccountId ? { actorAccountId } : {}) });
        if (!result.ok) return sendError(reply, 503, 'preview_transport_unavailable', result.reasonCode);
        reply.send?.(result.access);
    });

    app.post(`${PREVIEW_RESOURCE_ROUTE_PATH}/native-registration`, { preHandler: app.authenticate }, async (rawRequest, rawReply) => {
        const request = rawRequest as RouteRequest;
        const reply = rawReply as RouteReply;
        const parsed = LocalServicePreviewNativeRegistrationRequestV1Schema.safeParse(request.body);
        const previewId = readPreviewId(request);
        if (!previewId || !parsed.success || parsed.data.previewId !== previewId) return sendError(reply, 400, 'invalid_preview_request', 'preview_registration_mismatch');
        const resource = options.resolvePreview(previewId);
        if (!resource) return sendError(reply, 404, 'preview_not_found', 'preview_not_found');
        if (!await isPreviewLifecycleAuthorized(request, options, resource, 'register')) return sendError(reply, 403, 'preview_access_denied', 'session_not_authorized');
        const { grantId, ...binding } = parsed.data;
        const lease = options.openNativeRegistration?.(binding, grantId);
        if (!lease?.ok) return sendError(reply, 404, 'preview_not_found', lease?.reasonCode ?? 'preview_registration_unavailable');
        const raw = reply.raw;
        if (!raw?.writeHead || !raw.write || !raw.end) { lease.close(); return sendError(reply, 503, 'preview_transport_unavailable', 'preview_registration_unavailable'); }
        let finished = false;
        const finish = () => {
            if (finished) return;
            finished = true;
            request.raw?.off('aborted', finish);
            lease.signal.removeEventListener('abort', finish);
            lease.close();
            raw.end?.();
        };
        raw.once?.('close', finish);
        request.raw?.once('aborted', finish);
        lease.signal.addEventListener('abort', finish, { once: true });
        reply.hijack?.();
        raw.writeHead(200, 'OK', { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
        raw.write(textEncoder.encode(`${JSON.stringify({ v: 1, kind: 'preview_registration_admitted', previewId })}\n`));
        if (lease.signal.aborted || request.raw?.aborted) finish();
    });

    const hostRouteConstraint = hostOriginConstraint(options.hostOriginBaseDomain);

    app.register(async (dataPlane) => {
        // Data-plane bytes are owned by the upstream application. Control routes above retain
        // their normal JSON parser and API body contract through Fastify encapsulation.
        dataPlane.removeContentTypeParser(["application/json", "text/plain", "*"]);
        dataPlane.addContentTypeParser("*", (_request, payload, done) => done(null, payload));
        for (const method of PREVIEW_HTTP_METHODS) {
            const handler = async (request: unknown, reply: unknown) => {
                await handlePreviewHttpRequest(request as RouteRequest, reply as RouteReply, options);
            };
            if (method === "GET") {
                dataPlane.get(PREVIEW_ROUTE_PATH, { exposeHeadRoute: false }, handler);
                if (hostRouteConstraint) {
                    // An unconstrained static UI root wins over a constrained wildcard.
                    // Match that path explicitly while keeping the same preview policy.
                    for (const path of ["/", PREVIEW_HOST_ROUTE_PATH]) {
                        dataPlane.get(path, {
                            exposeHeadRoute: false,
                            constraints: { host: hostRouteConstraint },
                        }, handler);
                    }
                }
                continue;
            }
            dataPlane[method.toLowerCase() as Lowercase<typeof method>](PREVIEW_ROUTE_PATH, handler);
            if (method === "OPTIONS" || !hostRouteConstraint) {
                continue;
            }
            const hostPaths = method === "HEAD" ? ["/", PREVIEW_HOST_ROUTE_PATH] : [PREVIEW_HOST_ROUTE_PATH];
            for (const path of hostPaths) {
                dataPlane[method.toLowerCase() as Lowercase<typeof method>](path, {
                    constraints: { host: hostRouteConstraint },
                }, handler);
            }
        }
    });
}
