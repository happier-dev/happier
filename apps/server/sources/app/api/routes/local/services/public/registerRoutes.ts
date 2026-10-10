import type {
    DaemonLocalServicePublicPreviewCreateRequestV1,
    DaemonLocalServicePublicPreviewRevokeRequestV1,
    DaemonLocalServicePublicPreviewStatusRequestV1,
    LocalServicePreviewResourceV1,
    LocalServicePublicExposureModeV1,
    LocalServicePublicExposureV1,
    LocalServicePublicPreviewSnapshotV1,
} from "@happier-dev/protocol";
import { isDeepStrictEqual } from 'node:util';
import {
    DaemonLocalServicePublicPreviewCreateRequestV1Schema,
    DaemonLocalServicePublicPreviewRevokeRequestV1Schema,
    DaemonLocalServicePublicPreviewStatusRequestV1Schema,
    DaemonLocalServicePublicPreviewStatusResponseV1Schema,
    isLocalServicePublicPreviewCreateConfirmed,
} from "@happier-dev/protocol";
import { readSessionAccessAuthenticationFromRequest, type SessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication";

import {
    SESSION_RUNTIME_PUBLIC_AUTH_FORBIDDEN_ERROR,
} from "@/app/api/utils/apiTokenRouteAdmission";
import { readOptionalPublicAuthDisposition } from "@/app/api/utils/optionalPublicAuth";
import type { Fastify } from "@/app/api/types";
import {
    proxyLocalServicePreviewHttpRequest,
    type LocalServicePreviewHttpRequest,
    type LocalServicePreviewHttpResponseHeaders,
    type LocalServicePreviewHttpResponseSink,
    type OpenLocalServicePreviewTunnel,
    type ProxyLocalServicePreviewHttpRequestResult,
} from "@/app/local/services/preview/httpAdapter";
import { writeLocalServicePreviewDownstream } from "@/app/local/services/preview/downstream";
import { encodeLocalServiceRequestPath } from "@/app/local/services/preview/requestTarget";
import {
    readLocalServicePublicClientKey,
    resolveLocalServicePublicAccessIdentity,
    type LocalServicePublicAccessPurpose,
    type LocalServicePublicAuthenticatedUser,
    type LocalServicePublicAccessServiceAuthorizer,
} from "@/app/local/services/public/accessAuthorization";
import {
    createPublicExposureObservabilityEmitter,
    handleLocalServicePublicWebSocketUpgrade,
    type LocalServicePublicWebSocketUpgradeOptions,
} from "@/app/local/services/public/websocket";
import type {
    LocalServicePublicRuntimeAccessResult,
    LocalServicePublicRuntimeCreateResult,
    LocalServicePublicRuntimeExchangeResult,
} from "@/app/local/services/public/runtime";
import {
    localServicePublicTokenCookiePath,
    readLocalServicePublicQueryToken,
    readLocalServicePublicTokenCookie,
    scopedLocalServicePublicTokenCookie,
} from "@/app/local/services/public/accessToken";

export type RegisterLocalServicePublicRoutesOptions = Readonly<{
    resolvePreview: (previewId: string) => LocalServicePreviewResourceV1 | null | undefined;
    resolveExposure?: (exposureId: string) => LocalServicePublicExposureV1 | null | undefined;
    authorizeServiceAccess?: LocalServicePublicAccessServiceAuthorizer;
    authorizeSessionAccess?: (input: Readonly<{
        userId: string;
        sessionId: string;
        purpose: "public_exposure" | "public_revoke" | "public_status" | LocalServicePublicAccessPurpose;
        authentication: SessionAccessAuthentication;
    }>) => boolean | Promise<boolean>;
    getStatus?: (request: DaemonLocalServicePublicPreviewStatusRequestV1) => LocalServicePublicPreviewSnapshotV1;
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
        sessionAuthorized: boolean;
        clientKey: string;
    }>) => LocalServicePublicRuntimeAccessResult;
    exchangeAccessToken?: (input: Readonly<{
        exposureId: string;
        rawToken: string | null;
    }>) => LocalServicePublicRuntimeExchangeResult;
    dnsTlsValid?: boolean;
    readOptionalAuthenticatedUser?: (request: unknown) => Promise<LocalServicePublicAuthenticatedUser | null>;
    openTunnel?: OpenLocalServicePreviewTunnel;
    /** The request is the one being served, so the decision reads that request's Home configuration. */
    featureEnabled?: (request: object) => boolean | Promise<boolean>;
    observability?: LocalServicePublicWebSocketUpgradeOptions["observability"];
    proxyHttp?: (input: Parameters<typeof proxyLocalServicePreviewHttpRequest>[0]) => Promise<ProxyLocalServicePreviewHttpRequestResult>;
    proxyWebSocket?: LocalServicePublicWebSocketUpgradeOptions["proxyWebSocket"];
    trustProxy?: LocalServicePublicWebSocketUpgradeOptions["trustProxy"];
    externalProtocol?: LocalServicePublicWebSocketUpgradeOptions["externalProtocol"];
    retainConnection?: LocalServicePublicWebSocketUpgradeOptions["retainConnection"];
}>;

type RouteRequest = Readonly<{
    method?: string;
    protocol?: string;
    ip?: string;
    socket?: Readonly<{ remoteAddress?: string }>;
    params?: Record<string, unknown>;
    query?: Record<string, unknown>;
    headers?: Record<string, unknown>;
    body?: unknown;
    userId?: string;
    authAuthority?: "present_user" | "account_automation";
    authTokenKind?: "account" | "account_directory" | "terminal" | "api_token" | "ephemeral_session_runner";
    sessionRuntimePrincipal?: SessionAccessAuthentication["sessionRuntimePrincipal"];
    authTokenAuthenticationEvidence?: readonly import("@happier-dev/protocol").AuthTokenAuthenticationEvidenceV1[];
}>;

type RouteReply = {
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

const PUBLIC_CONTROL_ROUTE_PATH = "/v1/local-services/public";
const PUBLIC_STATUS_ROUTE_PATH = "/v1/local-services/public/status";
const PUBLIC_RESOURCE_ROUTE_PATH = "/v1/local-services/public/:exposureId";
const PUBLIC_PROXY_ROUTE_PATH = "/v1/local-services/public/:exposureId/*";
const PUBLIC_PROXY_HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;
const PUBLIC_RESPONSE_REFERRER_POLICY_HEADER = "Referrer-Policy";
const PUBLIC_RESPONSE_REFERRER_POLICY_VALUE = "no-referrer";
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

function previewMatchesCreateRequest(
    preview: LocalServicePreviewResourceV1,
    request: DaemonLocalServicePublicPreviewCreateRequestV1,
): boolean {
    return preview.previewId === request.previewId
        && preview.machineId === request.machineId
        && preview.sessionId === request.sessionId
        && isDeepStrictEqual(preview.serviceTarget, request.serviceTarget);
}

function exposureMatchesRevokeRequest(
    exposure: LocalServicePublicExposureV1,
    request: DaemonLocalServicePublicPreviewRevokeRequestV1,
): boolean {
    return exposure.exposureId === request.exposureId
        && exposure.previewId === request.previewId
        && exposure.machineId === request.machineId
        && exposure.sessionId === request.sessionId
        && isDeepStrictEqual(exposure.serviceTarget, request.serviceTarget);
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

function withPublicResponsePrivacyHeaders(
    headers: LocalServicePreviewHttpResponseHeaders,
): LocalServicePreviewHttpResponseHeaders {
    const next: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries(headers)) {
        if (name.toLowerCase() === "referrer-policy") continue;
        next[name] = value;
    }
    next[PUBLIC_RESPONSE_REFERRER_POLICY_HEADER] = PUBLIC_RESPONSE_REFERRER_POLICY_VALUE;
    return next;
}

function applyPublicResponsePrivacyHeaders(reply: RouteReply): void {
    reply.header?.(PUBLIC_RESPONSE_REFERRER_POLICY_HEADER, PUBLIC_RESPONSE_REFERRER_POLICY_VALUE);
}

function createResponseSink(reply: RouteReply): LocalServicePreviewHttpResponseSink {
    return {
        writeHead(statusCode, statusMessage, headers) {
            const safeHeaders = withPublicResponsePrivacyHeaders(headers);
            if (reply.raw?.writeHead) {
                reply.raw.writeHead(statusCode, statusMessage, { ...safeHeaders });
                return;
            }
            reply.code?.(statusCode);
            for (const [name, value] of Object.entries(safeHeaders)) {
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

function createPublicHttpRequest(request: RouteRequest, signal?: AbortSignal): LocalServicePreviewHttpRequest {
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
        signal,
        externalProtocol: request.protocol === "https" ? "https" : "http",
    };
}

function sendError(reply: RouteReply, statusCode: number, error: string, reasonCode: string): void {
    applyPublicResponsePrivacyHeaders(reply);
    reply.code?.(statusCode).send?.({ error, reasonCode });
}

function sendNotFound(reply: RouteReply): void {
    applyPublicResponsePrivacyHeaders(reply);
    reply.code?.(404).send?.({ error: "not_found" });
}

function publicRedirectLocation(input: Readonly<{
    exposureId: string;
    path: string;
    search: string;
}>): string {
    const root = localServicePublicTokenCookiePath(input.exposureId);
    const suffix = input.path === "/" ? "" : input.path;
    return `${root}${suffix}${input.search}`;
}

function redirectPublicTokenExchange(
    reply: RouteReply,
    input: Readonly<{
        exposureId: string;
        path: string;
        search: string;
        rawToken: string;
    }>,
): void {
    applyPublicResponsePrivacyHeaders(reply);
    reply
        .code?.(303)
        .header?.("Set-Cookie", scopedLocalServicePublicTokenCookie({
            path: localServicePublicTokenCookiePath(input.exposureId),
            rawToken: input.rawToken,
            secure: true,
        }))
        .header?.("Location", publicRedirectLocation(input))
        .send?.();
}

async function isPublicPreviewFeatureEnabled(options: RegisterLocalServicePublicRoutesOptions, request: object): Promise<boolean> {
    if (!options.featureEnabled) return true;
    try {
        return await options.featureEnabled(request) === true;
    } catch {
        return false;
    }
}

async function isSessionAuthorized(
    request: RouteRequest,
    options: RegisterLocalServicePublicRoutesOptions,
    input: Readonly<{
        sessionId: string;
        machineId: string;
        purpose: "public_exposure" | "public_revoke" | "public_status";
    }>,
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

async function isPreviewAuthorized(
    request: RouteRequest,
    options: RegisterLocalServicePublicRoutesOptions,
    preview: LocalServicePreviewResourceV1,
    purpose: 'public_exposure' | 'public_revoke' | 'public_status',
): Promise<boolean> {
    if (preview.serviceTarget) {
        const userId = readString(request.userId);
        if (!userId || !options.authorizeServiceAccess) return false;
        try {
            return await options.authorizeServiceAccess({ userId, preview, authentication: readSessionAccessAuthenticationFromRequest(request) }) === true;
        } catch { return false; }
    }
    return Boolean(preview.sessionId && await isSessionAuthorized(request, options, {
        sessionId: preview.sessionId, machineId: preview.machineId, purpose,
    }));
}

async function handleGetStatus(
    request: RouteRequest,
    reply: RouteReply,
    options: RegisterLocalServicePublicRoutesOptions,
): Promise<void> {
    if (!await isPublicPreviewFeatureEnabled(options, request)) {
        sendNotFound(reply);
        return;
    }
    if (!options.getStatus) {
        sendError(reply, 503, "public_preview_status_unavailable", "public_status_unavailable");
        return;
    }

    const parsed = DaemonLocalServicePublicPreviewStatusRequestV1Schema.safeParse(readBodyObject(request.body));
    if (!parsed.success || !parsed.data.sessionId && !parsed.data.previewId) {
        sendError(reply, 400, "invalid_public_preview_status_request", "invalid_request");
        return;
    }

    const statusRequest = parsed.data;
    let scopedPreview: LocalServicePreviewResourceV1 | null = null;
    if (statusRequest.previewId) {
        const preview = options.resolvePreview(statusRequest.previewId);
        if (!preview) {
            sendError(reply, 404, "preview_not_found", "preview_not_found");
            return;
        }
        if (preview.machineId !== statusRequest.machineId || preview.sessionId !== statusRequest.sessionId
            || statusRequest.serviceTarget && !isDeepStrictEqual(preview.serviceTarget, statusRequest.serviceTarget)) {
            sendError(reply, 403, "public_preview_denied", "preview_binding_mismatch");
            return;
        }
        scopedPreview = preview;
    }

    if (!(scopedPreview ? await isPreviewAuthorized(request, options, scopedPreview, 'public_status')
        : statusRequest.sessionId && await isSessionAuthorized(request, options, {
            sessionId: statusRequest.sessionId, machineId: statusRequest.machineId, purpose: 'public_status',
        }))) {
        sendError(reply, 403, "public_preview_denied", "session_not_authorized");
        return;
    }

    const snapshot = options.getStatus(statusRequest);
    reply.send?.(DaemonLocalServicePublicPreviewStatusResponseV1Schema.parse({
        protocolVersion: 1,
        snapshot,
    }));
}

async function handleCreateExposure(
    request: RouteRequest,
    reply: RouteReply,
    options: RegisterLocalServicePublicRoutesOptions,
): Promise<void> {
    if (!await isPublicPreviewFeatureEnabled(options, request)) {
        sendNotFound(reply);
        return;
    }

    const parsed = DaemonLocalServicePublicPreviewCreateRequestV1Schema.safeParse(request.body);
    if (!parsed.success) {
        sendError(reply, 400, "invalid_public_preview_request", "invalid_request");
        return;
    }

    const { data: createRequest } = parsed;
    if (!isLocalServicePublicPreviewCreateConfirmed(createRequest)) {
        sendError(reply, 403, "public_preview_denied", "confirmation_required");
        return;
    }
    const preview = options.resolvePreview(createRequest.previewId);
    if (!preview) {
        sendError(reply, 404, "preview_not_found", "preview_not_found");
        return;
    }
    if (!previewMatchesCreateRequest(preview, createRequest)) {
        sendError(reply, 403, "public_preview_denied", "preview_binding_mismatch");
        return;
    }
    if (!await isPreviewAuthorized(request, options, preview, 'public_exposure')) {
        sendError(reply, 403, "public_preview_denied", "session_not_authorized");
        return;
    }

    const currentPreview = options.resolvePreview(createRequest.previewId);
    if (!currentPreview || !previewMatchesCreateRequest(currentPreview, createRequest)) {
        sendError(reply, 403, 'public_preview_denied', 'preview_binding_mismatch');
        return;
    }

    const result = options.createExposure({
        preview: currentPreview,
        requestedMode: createRequest.mode,
        requestedTtlMs: createRequest.ttlMs,
        actorId: readString(request.userId) ?? "unknown",
        sessionAuthorized: true,
        dnsTlsValid: options.dnsTlsValid === true,
        rateLimitProfileId: createRequest.rateLimitProfileId ?? "default",
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
    if (!await isPublicPreviewFeatureEnabled(options, request)) {
        sendNotFound(reply);
        return;
    }

    const exposureId = readExposureId(request);
    if (!exposureId) {
        sendError(reply, 400, "invalid_public_preview_request", "missing_exposure_id");
        return;
    }
    const parsed = DaemonLocalServicePublicPreviewRevokeRequestV1Schema.safeParse(request.body);
    if (!parsed.success || parsed.data.exposureId !== exposureId) {
        sendError(reply, 400, "invalid_public_preview_request", "invalid_request");
        return;
    }

    const { data: revokeRequest } = parsed;
    const exposure = options.resolveExposure?.(revokeRequest.exposureId);
    if (!exposure) {
        sendError(reply, 404, "public_preview_not_found", "exposure_not_found");
        return;
    }
    if (!exposureMatchesRevokeRequest(exposure, revokeRequest)) {
        sendError(reply, 403, "public_preview_denied", "exposure_binding_mismatch");
        return;
    }
    const preview = options.resolvePreview(exposure.previewId);
    if (!(exposure.serviceTarget
        ? preview && preview.machineId === exposure.machineId && isDeepStrictEqual(preview.serviceTarget, exposure.serviceTarget)
            && await isPreviewAuthorized(request, options, preview, 'public_revoke')
        : exposure.sessionId && await isSessionAuthorized(request, options, {
            sessionId: exposure.sessionId, machineId: exposure.machineId, purpose: 'public_revoke',
        }))) {
        sendError(reply, 403, "public_preview_denied", "session_not_authorized");
        return;
    }

    const result = options.revokeExposure(revokeRequest.exposureId, { actorId: readString(request.userId) ?? "unknown" });
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
    if (!await isPublicPreviewFeatureEnabled(options, request)) {
        sendNotFound(reply);
        return undefined;
    }

    const exposureId = readExposureId(request);
    if (!exposureId) {
        sendError(reply, 400, "invalid_public_preview_request", "missing_exposure_id");
        return undefined;
    }

    const bearerAuth = await readOptionalPublicAuthDisposition(request.headers?.authorization);
    if (bearerAuth.status === "session_runtime_forbidden") {
        sendError(reply, 403, "public_preview_access_denied", SESSION_RUNTIME_PUBLIC_AUTH_FORBIDDEN_ERROR);
        return undefined;
    }
    const principal = bearerAuth.status === "authenticated"
        ? {
            userId: bearerAuth.principal.userId,
            authentication: {
                env: process.env,
                authority: bearerAuth.principal.authority,
                authenticationEvidence: bearerAuth.principal.authenticationEvidence,
            },
        }
        : options.readOptionalAuthenticatedUser
            ? await options.readOptionalAuthenticatedUser(request)
            : null;
    const queryToken = readLocalServicePublicQueryToken(request.query);
    if (queryToken) {
        const exchanged = options.exchangeAccessToken?.({
            exposureId,
            rawToken: queryToken,
        }) ?? { ok: false as const, reasonCode: "public_token_exchange_unavailable" };
        if (!exchanged.ok) {
            sendError(reply, 403, "public_preview_access_denied", exchanged.reasonCode);
            return undefined;
        }
        redirectPublicTokenExchange(reply, {
            exposureId,
            path: readWildcardPath(request),
            search: serializeQuery(request.query),
            rawToken: exchanged.rawToken,
        });
        return undefined;
    }

    // S-2: an authenticated exposure is bound to one session; holding any account on this server
    // is not authorization to reach it. S-5: bucket the rate limiter per client, not per exposure.
    const identity = await resolveLocalServicePublicAccessIdentity({
        exposureId,
        principal,
        resolveExposure: options.resolveExposure,
        authorizeSessionAccess: options.authorizeSessionAccess,
        resolvePreview: options.resolvePreview,
        authorizeServiceAccess: options.authorizeServiceAccess,
    });
    const access = options.validateAccess({
        exposureId,
        rawToken: readLocalServicePublicTokenCookie(request.headers),
        authenticated: identity.authenticated,
        sessionAuthorized: identity.sessionAuthorized,
        clientKey: readLocalServicePublicClientKey([request.ip, request.socket?.remoteAddress]),
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

    const registration = new AbortController();
    const releaseConnection = options.retainConnection?.(exposureId, () => {
        registration.abort();
        reply.raw?.destroy?.();
    }, options.resolveExposure?.(exposureId)?.mode === 'authenticated' ? principal?.userId : undefined);
    if (registration.signal.aborted) { releaseConnection?.(); return undefined; }
    const downstream = createDownstreamAbortSignal(reply);
    const signal = downstream ? AbortSignal.any([registration.signal, downstream]) : registration.signal;
    try {
        return await proxyHttp({
            preview: access.preview,
            request: createPublicHttpRequest(request, signal),
            response: createResponseSink(reply),
            openTunnel: options.openTunnel as OpenLocalServicePreviewTunnel,
            observability: createPublicExposureObservabilityEmitter(options.observability, exposureId),
        });
    } finally {
        releaseConnection?.();
    }
}

export function registerLocalServicePublicRoutes(
    app: Fastify,
    options: RegisterLocalServicePublicRoutesOptions,
): void {
    // The upgrade handling is async (S-2 resolves the caller's session access before validating
    // access), so the promise is returned rather than discarded. Node ignores an `upgrade`
    // listener's return value; returning it lets callers and tests await the completed handling
    // instead of guessing how many microtasks it takes.
    app.server?.on?.("upgrade", (request, socket, head) => (
        handleLocalServicePublicWebSocketUpgrade(request, socket, head, options)
    ));

    app.post(PUBLIC_CONTROL_ROUTE_PATH, {
        preHandler: app.authenticate,
        config: {
            restrictedCredentialBinding: {
                scope: "session",
                session: "body.sessionId",
                machine: "body.machineId",
            },
        },
    }, async (request, reply) => {
        await handleCreateExposure(request as RouteRequest, reply as RouteReply, options);
    });

    app.post(PUBLIC_STATUS_ROUTE_PATH, {
        preHandler: app.authenticate,
        config: {
            restrictedCredentialBinding: {
                scope: "session",
                session: "body.sessionId",
                machine: "body.machineId",
            },
        },
    }, async (request, reply) => {
        await handleGetStatus(request as RouteRequest, reply as RouteReply, options);
    });

    app.delete(PUBLIC_RESOURCE_ROUTE_PATH, {
        preHandler: app.authenticate,
        config: {
            restrictedCredentialBinding: {
                scope: "session",
                session: "body.sessionId",
                machine: "body.machineId",
            },
        },
    }, async (request, reply) => {
        await handleRevokeExposure(request as RouteRequest, reply as RouteReply, options);
    });

    app.register(async (dataPlane) => {
        // Only application traffic bypasses API parsing; exposure control requests above
        // keep Fastify's JSON parser in their parent scope.
        dataPlane.removeContentTypeParser(["application/json", "text/plain", "*"]);
        dataPlane.addContentTypeParser("*", (_request, payload, done) => done(null, payload));
        for (const method of PUBLIC_PROXY_HTTP_METHODS) {
            const handler = async (request: unknown, reply: unknown) => {
                await handlePublicPreviewRequest(request as RouteRequest, reply as RouteReply, options);
            };
            const registerProxyRoute = (path: string) => {
                if (method === "GET") {
                    dataPlane.get(path, { exposeHeadRoute: false }, handler);
                    return;
                }
                dataPlane[method.toLowerCase() as Lowercase<typeof method>](path, handler);
            };
            if (method !== "DELETE") {
                registerProxyRoute(PUBLIC_RESOURCE_ROUTE_PATH);
            }
            registerProxyRoute(PUBLIC_PROXY_ROUTE_PATH);
        }
    });
}
