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
import type { OpenLocalServicePreviewTunnel } from "@/app/local/services/preview/httpAdapter";
import {
    createLocalServicePreviewTunnelOpener,
    type PeerTcpTunnelRelayTransportFactory,
} from "@/app/local/services/preview/tunnel";

export type LocalServiceRouteRuntimes = Readonly<{
    preview: LocalServicePreviewRuntime;
    public: LocalServicePublicRuntime;
}>;

export type RegisterLocalServiceRoutesOptions = Readonly<{
    env?: NodeJS.ProcessEnv;
    runtimes?: LocalServiceRouteRuntimes;
    authorizeSessionAccess?: LocalServiceRouteSessionAccessAuthorizer;
    openTunnel?: OpenLocalServicePreviewTunnel;
}>;

type LocalServiceRouteApp = Fastify & Readonly<{
    createPeerTcpTunnelRelayTransport?: PeerTcpTunnelRelayTransportFactory;
}>;

export type LocalServiceRouteSessionAccessPurpose =
    | LocalServicePreviewSessionAccessPurpose
    | "public_exposure"
    | "public_revoke";

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
    if (!featureEnv.publicPolicy.dnsTlsRequired) {
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

    return {
        preview: createLocalServicePreviewRuntime({
            tokenSecret: resolvePreviewTokenSecret(env),
            publicBaseUrl,
            hostOriginBaseDomain: featureEnv.previewHostOriginBaseDomain,
            tokenTtlMs: featureEnv.previewTokenTtlMs,
        }),
        public: createLocalServicePublicRuntime({
            publicBaseUrl,
            tokenSecret: resolvePublicTokenSecret(env),
            policy: featureEnv.publicPolicy,
        }),
    };
}

export function resolveLocalServiceRouteRequiredAccessLevel(
    purpose: LocalServiceRouteSessionAccessPurpose,
): AccessLevel {
    if (purpose === "proxy") return "view";
    if (purpose === "public_exposure" || purpose === "public_revoke") return "admin";
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
        validateAccess: (input) => runtimes.preview.validateAccess(input),
        authorizeSessionAccess,
        openTunnel,
        featureEnabled: () => isServerFeatureEnabledForRequest("localServices.preview", env),
    });

    registerLocalServicePublicRoutes(createServerFeatureGatedRouteApp(app, "localServices.publicPreview", env), {
        resolvePreview: (previewId) => runtimes.preview.resolvePreview(previewId),
        createExposure: (input) => runtimes.public.createExposure(input),
        revokeExposure: (exposureId, input) => runtimes.public.revokeExposure(exposureId, input),
        validateAccess: (input) => runtimes.public.validateAccess(input),
        authorizeSessionAccess,
        dnsTlsValid: resolveLocalServicePublicDnsTlsValid(env),
        openTunnel,
    });
}
