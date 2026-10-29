import type { DaemonLocalServicePublicPreviewCreateRequestV1, DaemonLocalServicePublicPreviewRevokeRequestV1, DaemonLocalServicePublicPreviewStatusRequestV1, LocalServicePublicExposureModeV1, LocalServicePublicExposureV1, LocalServicePublicPreviewSnapshotV1 } from '@happier-dev/protocol/local/services/public/v1';
import type { LocalServicePreviewResourceV1 } from '@happier-dev/protocol/local/services/preview/v1';
import { isDeepStrictEqual } from 'node:util';
import { DaemonLocalServicePublicPreviewCreateRequestV1Schema, DaemonLocalServicePublicPreviewRevokeRequestV1Schema, DaemonLocalServicePublicPreviewStatusRequestV1Schema, DaemonLocalServicePublicPreviewStatusResponseV1Schema, isLocalServicePublicPreviewCreateConfirmed, resolveLocalServicePublicPreviewCreateFailureV1 } from '@happier-dev/protocol/local/services/public/v1';
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
    type OpenLocalServicePreviewTunnel,
    type ProxyLocalServicePreviewHttpRequestResult,
} from "@/app/local/services/preview/httpAdapter";
import { sendLocalServicePreviewHttpResponse, type LocalServicePreviewHttpReply } from '../httpResponse';
import { encodeLocalServiceRequestPath } from "@/app/local/services/preview/requestTarget";
import { scopedLocalServiceViewerTokenCookie } from '@/app/local/services/viewerCookie';
import { readLocalServicePublicStatus } from './status';
import { LOCAL_SERVICE_APPLICATION_HTTP_METHODS } from '../hostRoutes';
import { readLocalServiceRequestHostname, resolveLocalServiceExternalProtocol } from '@/app/local/services/preview/origin';
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
    LOCAL_SERVICE_PUBLIC_TOKEN_COOKIE_NAME,
} from "@/app/local/services/public/accessToken";

export type RegisterLocalServicePublicRoutesOptions = Readonly<{
    resolvePreview: (previewId: string) => LocalServicePreviewResourceV1 | null | undefined;
    resolveExposure?: (exposureId: string) => LocalServicePublicExposureV1 | null | undefined;
    resolveExposureByHost?: (hostname: string) => LocalServicePublicExposureV1 | null | undefined;
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

type RouteReply = LocalServicePreviewHttpReply;

const PUBLIC_CONTROL_ROUTE_PATH = "/v1/local-services/public";
const PUBLIC_STATUS_ROUTE_PATH = "/v1/local-services/public/status";
const PUBLIC_RESOURCE_ROUTE_PATH = "/v1/local-services/public/:exposureId";
const PUBLIC_PROXY_ROUTE_PATH = "/v1/local-services/public/:exposureId/*";
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

function createPublicHttpRequest(request: RouteRequest, configuredExternalProtocol: "http" | "https" | undefined, signal?: AbortSignal): LocalServicePreviewHttpRequest {
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
        externalProtocol: resolveLocalServiceExternalProtocol({
            requestIsSecure: request.protocol === "https",
            configured: configuredExternalProtocol,
        }),
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

function sendFeatureDisabled(reply: RouteReply): void {
    const refusal = resolveLocalServicePublicPreviewCreateFailureV1('public_preview_disabled');
    sendError(reply, refusal.statusCode, refusal.error, refusal.reasonCode);
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
        hostExposure?: LocalServicePublicExposureV1 | null;
        hostPath?: boolean;
    }>,
): void {
    applyPublicResponsePrivacyHeaders(reply);
    reply
        .code?.(303)
        .header?.("Set-Cookie", scopedLocalServiceViewerTokenCookie({
            name: LOCAL_SERVICE_PUBLIC_TOKEN_COOKIE_NAME,
            path: localServicePublicTokenCookiePath(input.exposureId, input.hostExposure),
            value: input.rawToken,
        }))
        .header?.("Location", input.hostPath ? `${input.path}${input.search}` : publicRedirectLocation(input))
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
        sendFeatureDisabled(reply);
        return;
    }
    if (!options.getStatus) {
        sendError(reply, 503, "public_preview_status_unavailable", "public_status_unavailable");
        return;
    }

    const parsed = DaemonLocalServicePublicPreviewStatusRequestV1Schema.safeParse(readBodyObject(request.body));
    if (!parsed.success) {
        sendError(reply, 400, "invalid_public_preview_status_request", "invalid_request");
        return;
    }

    const statusRequest = parsed.data;
    const result = await readLocalServicePublicStatus({
        request: statusRequest, userId: request.userId, getStatus: options.getStatus,
        resolvePreview: options.resolvePreview,
        authorizePreview: preview => isPreviewAuthorized(request, options, preview, 'public_status'),
        authorizeSession: sessionId => isSessionAuthorized(request, options, {
            sessionId, machineId: statusRequest.machineId, purpose: 'public_status',
        }),
    });
    if (!result.ok) {
        sendError(reply, result.statusCode, result.error, result.reasonCode);
        return;
    }
    reply.send?.(DaemonLocalServicePublicPreviewStatusResponseV1Schema.parse({
        protocolVersion: 1,
        snapshot: result.snapshot,
    }));
}

async function handleCreateExposure(
    request: RouteRequest,
    reply: RouteReply,
    options: RegisterLocalServicePublicRoutesOptions,
): Promise<void> {
    if (!await isPublicPreviewFeatureEnabled(options, request)) {
        sendFeatureDisabled(reply);
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
        const failure = resolveLocalServicePublicPreviewCreateFailureV1(result.reasonCode);
        sendError(reply, failure.statusCode, failure.error, failure.reasonCode);
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
        sendFeatureDisabled(reply);
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

export async function handleLocalServicePublicHttpRequest(
    requestInput: unknown,
    replyInput: unknown,
    options: RegisterLocalServicePublicRoutesOptions,
): Promise<unknown> {
    const request = requestInput as RouteRequest;
    const reply = replyInput as RouteReply;
    if (!await isPublicPreviewFeatureEnabled(options, request)) {
        sendNotFound(reply);
        return undefined;
    }
    const hostname = readLocalServiceRequestHostname(request.headers);
    const hostExposure = hostname ? options.resolveExposureByHost?.(hostname) : null;
    const pathExposureId = readExposureId(request);
    const exposureId = pathExposureId ?? hostExposure?.exposureId;
    if (!exposureId) {
        sendError(reply, 400, "invalid_public_preview_request", "missing_exposure_id");
        return undefined;
    }
    if (options.resolveExposureByHost && pathExposureId && hostExposure?.exposureId !== pathExposureId) {
        sendError(reply, 403, 'public_preview_access_denied', 'exposure_binding_mismatch');
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
            hostExposure,
            hostPath: !pathExposureId,
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

    const registration = new AbortController();
    const releaseConnection = options.retainConnection?.(exposureId, () => {
        registration.abort();
        reply.raw?.destroy?.();
    }, options.resolveExposure?.(exposureId)?.mode === 'authenticated' ? principal?.userId : undefined);
    if (registration.signal.aborted) { releaseConnection?.(); return undefined; }
    const downstream = createDownstreamAbortSignal(reply);
    const signal = downstream ? AbortSignal.any([registration.signal, downstream]) : registration.signal;
    return sendLocalServicePreviewHttpResponse(reply, async (response) => {
        try {
            return await proxyHttp({
                preview: access.preview,
                request: createPublicHttpRequest(request, options.externalProtocol, signal),
                response,
                openTunnel: options.openTunnel,
                observability: createPublicExposureObservabilityEmitter(options.observability, exposureId),
            });
        } finally {
            releaseConnection?.();
        }
    }, withPublicResponsePrivacyHeaders);
}

export function registerLocalServicePublicRoutes(
    app: Fastify,
    options: RegisterLocalServicePublicRoutesOptions,
    controlApp: Fastify = app,
): void {
    // Node ignores the listener's Promise; contain admission failures as well as forwarding.
    // Returning the contained Promise still lets registration callers await completion.
    app.server?.on?.("upgrade", (request, socket, head) => (
        handleLocalServicePublicWebSocketUpgrade(request, socket, head, options)
            .catch(() => { socket.destroy?.(); })
    ));

    controlApp.post(PUBLIC_CONTROL_ROUTE_PATH, {
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

    controlApp.post(PUBLIC_STATUS_ROUTE_PATH, {
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

    controlApp.delete(PUBLIC_RESOURCE_ROUTE_PATH, {
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
        for (const method of LOCAL_SERVICE_APPLICATION_HTTP_METHODS) {
            const handler = async (request: unknown, reply: unknown) => {
                await handleLocalServicePublicHttpRequest(request, reply, options);
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
