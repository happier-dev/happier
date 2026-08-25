import type { Fastify } from "@/app/api/types";
import {
    registerLocalServicePreviewRoutes,
    type LocalServicePreviewSessionAccessPurpose,
} from "@/app/api/routes/local/services/preview/registerRoutes";
import { registerLocalServicePublicRoutes } from "@/app/api/routes/local/services/public/registerRoutes";
import {
    createServerFeatureGatedRouteApp,
    isServerFeatureEnabledForRequest,
} from "@/app/features/catalog/serverFeatureGate";
import { readLocalServicesFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import {
    checkSessionAccess,
    requireAccessLevel,
    type AccessLevel,
} from "@/app/share/accessControl";
import {
    normalizeHttpUrl,
    resolveConfiguredCanonicalServerUrl,
} from "@/app/serverUrls/effectiveServerUrls";
import {
    createLocalServicePreviewRuntime,
    type LocalServicePreviewRuntime,
} from "@/app/local/services/preview/runtime";
import {
    createLocalServicePublicRuntime,
    type LocalServicePublicRuntime,
} from "@/app/local/services/public/runtime";
import { createLocalServicePublicAuditRecorder } from "@/app/local/services/public/audit";
import { createLocalServicePublicRateLimitChecker } from "@/app/local/services/public/rateLimits";
import {
    LocalServicePublicPreviewExchangeRequestV1Schema,
    LocalServicePublicPreviewExchangeResponseV1Schema,
} from "@happier-dev/protocol";
import type { OpenLocalServicePreviewTunnel } from "@/app/local/services/preview/httpAdapter";
import {
    createLocalServicePreviewTunnelOpener,
    type PeerTcpTunnelRelayTransportFactory,
} from "@/app/local/services/preview/tunnel";
import type { PeerMediationObservabilityEmitter } from "@/app/api/socket/peer/mediation/observability/events";
import {
    localServicePublicTokenCookiePath,
    scopedLocalServicePublicTokenCookie,
} from "@/app/local/services/public/accessToken";

export type LocalServiceRouteRuntimes = Readonly<{
    preview: LocalServicePreviewRuntime;
    public: LocalServicePublicRuntime;
}>;

const PUBLIC_EXCHANGE_ROUTE_PATH = "/v1/local-services/public/:exposureId/exchange";

type ExchangeRouteRequest = Readonly<{
    params?: Record<string, unknown>;
    query?: unknown;
    body?: unknown;
}>;

type ExchangeRouteReply = {
    code?: (statusCode: number) => ExchangeRouteReply;
    header?: (name: string, value: string | readonly string[]) => ExchangeRouteReply;
    send?: (payload?: unknown) => unknown;
};

export type RegisterLocalServiceRoutesOptions = Readonly<{
    env?: NodeJS.ProcessEnv;
    runtimes?: LocalServiceRouteRuntimes;
    authorizeSessionAccess?: LocalServiceRouteSessionAccessAuthorizer;
    openTunnel?: OpenLocalServicePreviewTunnel;
}>;

type LocalServiceRouteApp = Fastify & Readonly<{
    createPeerTcpTunnelRelayTransport?: PeerTcpTunnelRelayTransportFactory;
    peerMediationObservability?: PeerMediationObservabilityEmitter;
}>;

export type LocalServiceRouteSessionAccessPurpose =
    | LocalServicePreviewSessionAccessPurpose
    | "public_exposure"
    | "public_revoke"
    | "public_status"
    | "public_access";

export type LocalServiceRouteSessionAccessAuthorizer = (input: Readonly<{
    userId: string;
    sessionId: string;
    purpose: LocalServiceRouteSessionAccessPurpose;
}>) => boolean | Promise<boolean>;

function firstNonEmpty(...values: readonly (string | undefined)[]): string | null {
    for (const value of values) {
        if (typeof value === "string" && value.trim().length > 0) {
            return value.trim();
        }
    }
    return null;
}

function resolvePublicBaseUrl(env: NodeJS.ProcessEnv): string | null {
    return resolveConfiguredCanonicalServerUrl(env) ?? normalizeHttpUrl(String(env.PUBLIC_URL ?? ""));
}

function isHttpsUrl(value: string | null): boolean {
    if (!value) return false;
    try {
        return new URL(value).protocol === "https:";
    } catch {
        return false;
    }
}

function resolveLocalServicePublicDnsTlsValid(env: NodeJS.ProcessEnv): boolean {
    const featureEnv = readLocalServicesFeatureEnv(env);
    if (!featureEnv.publicPolicy.dnsTlsRequired && env.NODE_ENV !== "production") {
        return true;
    }
    return Boolean(featureEnv.previewHostOriginBaseDomain) && isHttpsUrl(resolvePublicBaseUrl(env));
}

function resolvePreviewTokenSecret(env: NodeJS.ProcessEnv): string | null {
    return firstNonEmpty(
        env.HAPPIER_LOCAL_SERVICES_PREVIEW_TOKEN_SECRET,
        env.HAPPIER_LOCAL_SERVICES_TOKEN_SECRET,
        env.HANDY_MASTER_SECRET,
    );
}

function resolvePublicTokenSecret(env: NodeJS.ProcessEnv): string | null {
    return firstNonEmpty(
        env.HAPPIER_LOCAL_SERVICES_PUBLIC_PREVIEW_TOKEN_SECRET,
        env.HAPPIER_LOCAL_SERVICES_TOKEN_SECRET,
        env.HANDY_MASTER_SECRET,
    );
}

export function createLocalServiceRouteRuntimes(env: NodeJS.ProcessEnv): LocalServiceRouteRuntimes {
    const featureEnv = readLocalServicesFeatureEnv(env);
    const publicBaseUrl = resolvePublicBaseUrl(env);
    const publicAuditRecorder = createLocalServicePublicAuditRecorder(featureEnv.publicAuditDependency);
    const publicRateLimitChecker = createLocalServicePublicRateLimitChecker(featureEnv.publicRateLimitDependency);

    const preview = createLocalServicePreviewRuntime({
        tokenSecret: resolvePreviewTokenSecret(env),
        publicBaseUrl,
        hostOriginBaseDomain: featureEnv.previewHostOriginBaseDomain,
        tokenTtlMs: featureEnv.previewTokenTtlMs,
    });
    return {
        preview,
        public: createLocalServicePublicRuntime({
            publicBaseUrl,
            // S-3: public exposures are minted on their own isolated origin under this domain.
            hostOriginBaseDomain: featureEnv.previewHostOriginBaseDomain,
            tokenSecret: resolvePublicTokenSecret(env),
            policy: featureEnv.publicPolicy,
            resolvePreview: (previewId) => preview.resolvePreview(previewId),
            ...publicAuditRecorder,
            ...(publicRateLimitChecker ? { checkRateLimit: publicRateLimitChecker } : {}),
        }),
    };
}

export function resolveLocalServiceRouteRequiredAccessLevel(
    purpose: LocalServiceRouteSessionAccessPurpose,
): AccessLevel {
    if (purpose === "proxy") return "view";
    // S-2: reaching an `authenticated` exposure is a read of someone's session-bound service, so
    // it needs the same level as the private preview data plane — not the `admin` level that
    // creating or revoking the exposure needs.
    if (purpose === "public_access") return "view";
    if (purpose === "public_exposure" || purpose === "public_revoke" || purpose === "public_status") return "admin";
    return "edit";
}

export function createLocalServiceRouteSessionAccessAuthorizer(): LocalServiceRouteSessionAccessAuthorizer {
    return async ({ userId, sessionId, purpose }) => {
        const access = await checkSessionAccess(userId, sessionId);
        if (!access) return false;
        return requireAccessLevel(access, resolveLocalServiceRouteRequiredAccessLevel(purpose));
    };
}

export function registerLocalServiceRoutes(
    app: Fastify,
    options: RegisterLocalServiceRoutesOptions = {},
): void {
    const routeApp = app as LocalServiceRouteApp;
    const env = options.env ?? process.env;
    const featureEnv = readLocalServicesFeatureEnv(env);
    const runtimes = options.runtimes ?? createLocalServiceRouteRuntimes(env);
    const authorizeSessionAccess = options.authorizeSessionAccess ?? createLocalServiceRouteSessionAccessAuthorizer();
    const openTunnel = options.openTunnel
        ?? (
            routeApp.createPeerTcpTunnelRelayTransport
                ? createLocalServicePreviewTunnelOpener({
                    env,
                    resolvePreviewAccountId: (previewId) => runtimes.preview.resolvePreviewContext(previewId)?.accountId ?? null,
                    createRelayTransport: routeApp.createPeerTcpTunnelRelayTransport,
                })
                : undefined
        );

    registerLocalServicePreviewRoutes(createServerFeatureGatedRouteApp(app, "localServices.preview", env), {
        registerPreview: (input) => runtimes.preview.registerPreview(input),
        unregisterPreview: (previewId) => runtimes.preview.unregisterPreview(previewId),
        resolvePreview: (previewId) => runtimes.preview.resolvePreview(previewId),
        resolvePreviewByHost: (hostname) => runtimes.preview.resolvePreviewByHost(hostname),
        hostOriginBaseDomain: featureEnv.previewHostOriginBaseDomain,
        // F-5: mark the path-mode exchange cookie `Secure` on an https deployment. It cannot be
        // unconditional — on plain http the browser drops a `Secure` cookie and the private
        // preview stops working entirely.
        publicBaseUrlSecure: isHttpsUrl(resolvePublicBaseUrl(env)),
        validateAccess: (input) => runtimes.preview.validateAccess(input),
        exchangeAccessToken: (input) => runtimes.preview.exchangeAccessToken(input),
        authorizeSessionAccess,
        openTunnel,
        observability: routeApp.peerMediationObservability,
        resolvePreviewAccountId: (previewId) => runtimes.preview.resolvePreviewContext(previewId)?.accountId ?? null,
        featureEnabled: () => isServerFeatureEnabledForRequest("localServices.preview", env),
    });

    const publicRouteApp = createServerFeatureGatedRouteApp(app, "localServices.publicPreview", env);
    registerLocalServicePublicRoutes(publicRouteApp, {
        resolvePreview: (previewId) => runtimes.preview.resolvePreview(previewId),
        getStatus: (request) => runtimes.public.getSnapshot(request),
        createExposure: (input) => runtimes.public.createExposure(input),
        resolveExposure: (exposureId) => runtimes.public.resolveExposure(exposureId),
        revokeExposure: (exposureId, input) => runtimes.public.revokeExposure(exposureId, input),
        validateAccess: (input) => runtimes.public.validateAccess(input),
        exchangeAccessToken: (input) => runtimes.public.exchangeAccessToken(input),
        authorizeSessionAccess,
        dnsTlsValid: resolveLocalServicePublicDnsTlsValid(env),
        featureEnabled: () => isServerFeatureEnabledForRequest("localServices.publicPreview", env),
        openTunnel,
        observability: routeApp.peerMediationObservability,
    });

    // U3: one-time exchange of the capability URL token. Mirrors the private preview
    // url->cookie rotation: a `secret_link` URL token is validated once and rotated to a
    // fresh follow-up credential, so the URL is not an indefinitely replayable credential.
    registerLocalServicePublicExchangeRoute(publicRouteApp, runtimes, env);
}

function readExchangeToken(query: unknown, body: unknown): string | null {
    const fromQuery = query && typeof query === "object"
        ? (query as Record<string, unknown>).publicToken
        : undefined;
    if (typeof fromQuery === "string" && fromQuery.trim().length > 0) {
        return fromQuery;
    }
    const parsedBody = LocalServicePublicPreviewExchangeRequestV1Schema.safeParse(body);
    return parsedBody.success ? parsedBody.data.publicToken : null;
}

function registerLocalServicePublicExchangeRoute(
    app: Fastify,
    runtimes: LocalServiceRouteRuntimes,
    env: NodeJS.ProcessEnv,
): void {
    app.post(PUBLIC_EXCHANGE_ROUTE_PATH, async (request: unknown, reply: unknown) => {
        const typedRequest = request as ExchangeRouteRequest;
        const typedReply = reply as ExchangeRouteReply;
        if (!isServerFeatureEnabledForRequest("localServices.publicPreview", env)) {
            typedReply.code?.(404).send?.({ error: "not_found" });
            return;
        }
        const exposureId = typeof typedRequest.params?.exposureId === "string"
            ? typedRequest.params.exposureId
            : null;
        if (!exposureId || !exposureId.trim()) {
            typedReply.code?.(400).send?.({ error: "invalid_request", reasonCode: "missing_exposure_id" });
            return;
        }
        const rawToken = readExchangeToken(typedRequest.query, typedRequest.body);
        const result = runtimes.public.exchangeAccessToken({ exposureId, rawToken });
        if (!result.ok) {
            typedReply.code?.(403).send?.({ error: "public_preview_access_denied", reasonCode: result.reasonCode });
            return;
        }
        typedReply
            .header?.("Set-Cookie", scopedLocalServicePublicTokenCookie({
                path: localServicePublicTokenCookiePath(result.exposureId),
                rawToken: result.rawToken,
                secure: true,
            }))
            .send?.(LocalServicePublicPreviewExchangeResponseV1Schema.parse({
                protocolVersion: 1,
                exposureId: result.exposureId,
                publicToken: result.rawToken,
                expiresAt: result.expiresAt,
            }));
    });
}
