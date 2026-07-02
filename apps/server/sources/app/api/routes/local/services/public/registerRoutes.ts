import type {
    LocalServicePreviewResourceV1,
    LocalServicePublicExposureModeV1,
    LocalServicePublicExposureV1,
} from "@happier-dev/protocol";

import { auth } from "@/app/auth/auth";
import type { Fastify } from "@/app/api/types";
import {
    proxyLocalServicePreviewHttpRequest,
    type LocalServicePreviewHttpRequest,
    type LocalServicePreviewHttpResponseSink,
    type OpenLocalServicePreviewTunnel,
    type ProxyLocalServicePreviewHttpRequestResult,
} from "@/app/local/services/preview/httpAdapter";
import type {
    LocalServicePublicRuntimeAccessResult,
    LocalServicePublicRuntimeCreateResult,
} from "@/app/local/services/public/runtime";

export type RegisterLocalServicePublicRoutesOptions = Readonly<{
    resolvePreview: (previewId: string) => LocalServicePreviewResourceV1 | null | undefined;
    resolveExposure?: (exposureId: string) => LocalServicePublicExposureV1 | null | undefined;
    authorizeSessionAccess?: (input: Readonly<{
        userId: string;
        sessionId: string;
        purpose: "public_exposure" | "public_revoke";
    }>) => boolean | Promise<boolean>;
    createExposure: (input: Readonly<{
        preview: LocalServicePreviewResourceV1;
        requestedMode: LocalServicePublicExposureModeV1;
        requestedTtlMs: number;
        actorId: string;
        sessionAuthorized: boolean;
        dnsTlsValid: boolean;
        rateLimitProfileId: string;
    }>) => LocalServicePublicRuntimeCreateResult;
    revokeExposure: (exposureId: string, input: Readonly<{ actorId: string }>) => Readonly<{
        ok: true;
    } | {
        ok: false;
        reasonCode: string;
    }>;
    validateAccess: (input: Readonly<{
        exposureId: string;
        rawToken: string | null;
        authenticated: boolean;
    }>) => LocalServicePublicRuntimeAccessResult;
    dnsTlsValid?: boolean;
    readOptionalUserId?: (request: unknown) => Promise<string | null>;
    openTunnel?: OpenLocalServicePreviewTunnel;
    proxyHttp?: (input: Parameters<typeof proxyLocalServicePreviewHttpRequest>[0]) => Promise<ProxyLocalServicePreviewHttpRequestResult>;
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

const PUBLIC_CONTROL_ROUTE_PATH = "/v1/local-services/public";
const PUBLIC_RESOURCE_ROUTE_PATH = "/v1/local-services/public/:exposureId";
const PUBLIC_PROXY_ROUTE_PATH = "/v1/local-services/public/:exposureId/*";
const PUBLIC_PROXY_HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;
const textEncoder = new TextEncoder();

function readString(value: unknown): string | null {
    return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readNumber(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim().length > 0) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

function readBodyObject(body: unknown): Record<string, unknown> {
    return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
}

function readExposureId(request: RouteRequest): string | null {
    return readString(request.params?.exposureId);
}

function readWildcardPath(request: RouteRequest): string {
    const raw = readString(request.params?.["*"]) ?? "";
    return `/${raw.replace(/^\/+/u, "")}`;
}

function serializeQuery(query: Record<string, unknown> | undefined): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query ?? {})) {
        if (key === "publicToken") continue;
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

function createResponseSink(reply: RouteReply): LocalServicePreviewHttpResponseSink {
    return {
        writeHead(statusCode, statusMessage, headers) {
            if (reply.raw?.writeHead) {
                reply.raw.writeHead(statusCode, statusMessage, { ...headers });
                return;
            }
            reply.code?.(statusCode);
            for (const [name, value] of Object.entries(headers)) {
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

function createPublicHttpRequest(request: RouteRequest): LocalServicePreviewHttpRequest {
    return {
        method: request.method ?? "GET",
        path: readWildcardPath(request),
        search: serializeQuery(request.query),
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

function sendError(reply: RouteReply, statusCode: number, error: string, reasonCode: string): void {
    reply.code?.(statusCode).send?.({ error, reasonCode });
}

async function isSessionAuthorized(
    request: RouteRequest,
    options: RegisterLocalServicePublicRoutesOptions,
    input: Readonly<{ sessionId: string; purpose: "public_exposure" | "public_revoke" }>,
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

async function readOptionalBearerUserId(request: RouteRequest): Promise<string | null> {
    const authorization = request.headers?.authorization;
    if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
        return null;
    }
    try {
        const verified = await auth.verifyToken(authorization.slice("Bearer ".length));
        return verified?.userId ?? null;
    } catch {
        return null;
    }
}

async function handleCreateExposure(
    request: RouteRequest,
    reply: RouteReply,
    options: RegisterLocalServicePublicRoutesOptions,
): Promise<void> {
    const body = readBodyObject(request.body);
    const previewId = readString(body.previewId);
    const requestedMode = readString(body.mode) as LocalServicePublicExposureModeV1 | null;
    const requestedTtlMs = readNumber(body.ttlMs);
    if (!previewId || !requestedMode || requestedTtlMs === null) {
        sendError(reply, 400, "invalid_public_preview_request", "invalid_request");
        return;
    }

    const preview = options.resolvePreview(previewId);
    if (!preview) {
        sendError(reply, 404, "preview_not_found", "preview_not_found");
        return;
    }
    if (!await isSessionAuthorized(request, options, { sessionId: preview.sessionId, purpose: "public_exposure" })) {
        sendError(reply, 403, "public_preview_denied", "session_not_authorized");
        return;
    }

    const result = options.createExposure({
        preview,
        requestedMode,
        requestedTtlMs,
        actorId: readString(request.userId) ?? "unknown",
        sessionAuthorized: true,
        dnsTlsValid: options.dnsTlsValid === true,
        rateLimitProfileId: readString(body.rateLimitProfileId) ?? "default",
    });
    if (!result.ok) {
        sendError(reply, 403, "public_preview_denied", result.reasonCode);
        return;
    }

    reply.code?.(201).send?.({ exposure: result.exposure });
}

async function handleRevokeExposure(
    request: RouteRequest,
    reply: RouteReply,
    options: RegisterLocalServicePublicRoutesOptions,
): Promise<void> {
    const exposureId = readExposureId(request);
    if (!exposureId) {
        sendError(reply, 400, "invalid_public_preview_request", "missing_exposure_id");
        return;
    }
    const exposure = options.resolveExposure?.(exposureId);
    if (!exposure) {
        sendError(reply, 404, "public_preview_not_found", "exposure_not_found");
        return;
    }
    if (!await isSessionAuthorized(request, options, { sessionId: exposure.sessionId, purpose: "public_revoke" })) {
        sendError(reply, 403, "public_preview_denied", "session_not_authorized");
        return;
    }

    const result = options.revokeExposure(exposureId, { actorId: readString(request.userId) ?? "unknown" });
    if (!result.ok) {
        sendError(reply, 404, "public_preview_not_found", result.reasonCode);
        return;
    }
    reply.send?.({ ok: true });
}

async function handlePublicPreviewRequest(
    request: RouteRequest,
    reply: RouteReply,
    options: RegisterLocalServicePublicRoutesOptions,
): Promise<unknown> {
    const exposureId = readExposureId(request);
    if (!exposureId) {
        sendError(reply, 400, "invalid_public_preview_request", "missing_exposure_id");
        return undefined;
    }

    const userId = options.readOptionalUserId
        ? await options.readOptionalUserId(request)
        : await readOptionalBearerUserId(request);
    const access = options.validateAccess({
        exposureId,
        rawToken: readString(request.query?.publicToken),
        authenticated: Boolean(userId),
    });
    if (!access.ok) {
        sendError(reply, 403, "public_preview_access_denied", access.reasonCode);
        return undefined;
    }

    const proxyHttp = options.proxyHttp ?? proxyLocalServicePreviewHttpRequest;
    if (!options.openTunnel && !options.proxyHttp) {
        sendError(reply, 503, "preview_transport_unavailable", "pms_tunnel_unavailable");
        return undefined;
    }

    return await proxyHttp({
        preview: access.preview,
        request: createPublicHttpRequest(request),
        response: createResponseSink(reply),
        openTunnel: options.openTunnel as OpenLocalServicePreviewTunnel,
    });
}

export function registerLocalServicePublicRoutes(
    app: Fastify,
    options: RegisterLocalServicePublicRoutesOptions,
): void {
    app.post(PUBLIC_CONTROL_ROUTE_PATH, {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        await handleCreateExposure(request as RouteRequest, reply as RouteReply, options);
    });

    app.delete(PUBLIC_RESOURCE_ROUTE_PATH, {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        await handleRevokeExposure(request as RouteRequest, reply as RouteReply, options);
    });

    for (const method of PUBLIC_PROXY_HTTP_METHODS) {
        const handler = async (request: unknown, reply: unknown) => {
            await handlePublicPreviewRequest(request as RouteRequest, reply as RouteReply, options);
        };
        if (method === "GET") {
            app.get(PUBLIC_PROXY_ROUTE_PATH, { exposeHeadRoute: false }, handler);
            continue;
        }
        app[method.toLowerCase() as Lowercase<typeof method>](PUBLIC_PROXY_ROUTE_PATH, handler);
    }
}
