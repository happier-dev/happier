import fastify, { errorCodes, type FastifyBodyParser, type FastifyInstance } from "fastify";
import type { FastifyCorsOptions } from "@fastify/cors";
import { ACCOUNT_STORED_CONTENT_COMPATIBILITY_HTTP_HEADER } from "@happier-dev/protocol";
import { log, logger } from "@/utils/logging/log";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { onShutdown } from "@/utils/process/shutdown";
import { Fastify } from "./types";
import { authRoutes } from "./routes/auth/authRoutes";
import { pushRoutes } from "./routes/push/pushRoutes";
import { sessionRoutes } from "./routes/session/sessionRoutes";
import { connectRoutes } from "./routes/connect/connectRoutes";
import { accountRoutes } from "./routes/account/accountRoutes";
import { changesRoutes } from "./routes/changes/changesRoutes";
import { startSocket } from "./socket";
import { machinesRoutes } from "./routes/machines/machinesRoutes";
import { devRoutes } from "./routes/dev/devRoutes";
import { versionRoutes } from "./routes/version/versionRoutes";
import { voiceRoutes } from "./routes/voice/voiceRoutes";
import { artifactsRoutes } from "./routes/artifacts/artifactsRoutes";
import { accessKeysRoutes } from "./routes/accessKeys/accessKeysRoutes";
import { enableMonitoring } from "./utils/enableMonitoring";
import { enableErrorHandlers } from "./utils/enableErrorHandlers";
import { enableAuthentication } from "./utils/enableAuthentication";
import { enableOptionalStatics } from "./utils/enableOptionalStatics";
import { userRoutes } from "./routes/user/userRoutes";
import { feedRoutes } from "./routes/feed/feedRoutes";
import { kvRoutes } from "./routes/kv/kvRoutes";
import { shareRoutes } from "./routes/share/shareRoutes";
import { publicShareRoutes } from "./routes/share/publicShareRoutes";
import { featuresRoutes } from "./routes/features/featuresRoutes";
import { sessionPendingRoutes } from "./routes/session/pendingRoutes";
import { bugReportDiagnosticsRoutes } from "./routes/diagnostics/bugReportDiagnosticsRoutes";
import { automationRoutes } from "./routes/automations/automationRoutes";
import { resolveApiRateLimitPluginOptions, resolveApiTrustProxy } from "./utils/apiRateLimitPolicy";
import { liveActivityTargetsRoutes } from "./routes/activity/liveActivityTargetsRoutes";
import { liveActivityRemoteUpdateRoutes } from "./routes/activity/liveActivityRemoteUpdateRoutes";
import { liveActivityHostedRelayRoutes } from "./routes/activity/liveActivityHostedRelayRoutes";
import { registerPeerMediationGrantRoutes } from "./routes/machines/peer/mediation/registerPeerMediationGrantRoutes";
import { registerReviewCommentRoutes } from "@/app/reviews/comments/routes";
import { registerPluginPermissionGrantRoutes } from "@/app/plugins/permissions/routes";
import { registerPluginAvailabilityRoutes } from "@/app/plugins/availability/routes";
import { pluginDataRoutes } from "./routes/plugins/data/pluginDataRoutes";
import { registerPluginWebhookDaemonRoutes } from "./routes/plugins/webhooks/registerPluginWebhookDaemonRoutes";
import { registerPluginWebhookIngressRoute } from "./routes/plugins/webhooks/registerPluginWebhookIngressRoute";
import { registerPluginWebhookEndpointRoutes } from "./routes/plugins/webhooks/registerPluginWebhookEndpointRoutes";
import { emitPluginWebhookDeliveryCommittedWakeV1 } from "@/app/plugins/webhooks/wake";
import { registerLocalServiceRoutes } from "./routes/local/services/registerRoutes";
import { V2_SESSION_LIST_SERVER_TIMING_REQUEST_HEADER } from "./routes/session/v2SessionListServerTiming";
import { startAutomationReplyHandoffWorker } from "@/app/automations/automationReplyHandoffWorker";

export function resolveApiListenHost(env: Record<string, string | undefined>): string {
    const host = (env.HAPPIER_SERVER_HOST ?? env.HAPPY_SERVER_HOST ?? '').toString().trim();
    return host.length > 0 ? host : '0.0.0.0';
}

export const DEFAULT_API_CORS_MAX_AGE_SECONDS = 600;
export const API_CORS_ALLOWED_HEADERS = [
    'authorization',
    'content-type',
    ACCOUNT_STORED_CONTENT_COMPATIBILITY_HTTP_HEADER,
    'idempotency-key',
    V2_SESSION_LIST_SERVER_TIMING_REQUEST_HEADER,
];
export const API_CORS_EXPOSED_HEADERS = [
    'server-timing',
];

export function createApiCorsOptions(env: Record<string, string | undefined>): FastifyCorsOptions {
    return {
        origin: '*',
        // Keep permissive defaults for now. Tighten via a proxy/WAF or by
        // changing this list once deployments are stable.
        allowedHeaders: API_CORS_ALLOWED_HEADERS,
        exposedHeaders: API_CORS_EXPOSED_HEADERS,
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        maxAge: resolveApiCorsMaxAgeSeconds(env),
    };
}

export function resolveApiCorsMaxAgeSeconds(env: Record<string, string | undefined>): number {
    const raw = (env.HAPPIER_API_CORS_MAX_AGE_SECONDS ?? env.HAPPY_API_CORS_MAX_AGE_SECONDS ?? '').toString().trim();
    if (!raw) return DEFAULT_API_CORS_MAX_AGE_SECONDS;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_API_CORS_MAX_AGE_SECONDS;
    return parsed;
}

export function enableContentTypeParsers(app: Pick<FastifyInstance, 'addContentTypeParser'>): void {
    const parseUnsupportedBody: FastifyBodyParser<string> = (_request, body, done) => {
        if (body.trim() === '') {
            return done(null, undefined);
        }
        return done(new errorCodes.FST_ERR_CTP_INVALID_MEDIA_TYPE(), undefined);
    };
    app.addContentTypeParser('*', { parseAs: 'string' }, parseUnsupportedBody);
}

export function registerApiRoutes(typed: Fastify): void {
    authRoutes(typed);
    pushRoutes(typed);
    sessionRoutes(typed);
    accountRoutes(typed);
    changesRoutes(typed);
    connectRoutes(typed);
    machinesRoutes(typed);
    artifactsRoutes(typed);
    accessKeysRoutes(typed);
    devRoutes(typed);
    versionRoutes(typed);
    featuresRoutes(typed);
    bugReportDiagnosticsRoutes(typed);
    sessionPendingRoutes(typed);
    voiceRoutes(typed);
    userRoutes(typed);
    feedRoutes(typed);
    kvRoutes(typed);
    shareRoutes(typed);
    publicShareRoutes(typed);
    automationRoutes(typed);
    liveActivityTargetsRoutes(typed);
    liveActivityRemoteUpdateRoutes(typed);
    liveActivityHostedRelayRoutes(typed);
    registerPeerMediationGrantRoutes(typed);
    registerLocalServiceRoutes(typed);
    registerPluginPermissionGrantRoutes(typed);
    registerPluginAvailabilityRoutes(typed);
    pluginDataRoutes(typed);
    registerPluginWebhookDaemonRoutes(typed);
    registerPluginWebhookEndpointRoutes(typed);
    registerPluginWebhookIngressRoute(typed, {
        onCommittedWake: emitPluginWebhookDeliveryCommittedWakeV1,
    });
    registerReviewCommentRoutes(typed);
}

export async function startApi() {

    // Configure
    log('Starting API...');

    // Start API
    const trustProxy = resolveApiTrustProxy(process.env);
    const app = fastify({
        loggerInstance: logger,
        bodyLimit: 1024 * 1024 * 100, // 100MB
        forceCloseConnections: 'idle',
        ...(typeof trustProxy !== "undefined" ? { trustProxy } : null),
    });
    enableContentTypeParsers(app);
    app.register(import('@fastify/cors'), createApiCorsOptions(process.env));
    app.register(import('@fastify/rate-limit'), resolveApiRateLimitPluginOptions(process.env));

    enableOptionalStatics(app);

    // Create typed provider
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;

    // Enable features
    enableMonitoring(typed);
    enableErrorHandlers(typed);
    enableAuthentication(typed);

    // Socket relay services must be available before route composition so
    // server HTTP routes can open PMS relay tunnels without a test-only seam.
    startSocket(typed);

    // Routes
    registerApiRoutes(typed);

    // Start HTTP 
    const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3005;
    await app.listen({ port, host: resolveApiListenHost(process.env) });
    const automationReplyHandoffWorker = startAutomationReplyHandoffWorker({
        dispatch: async (request) => await typed.forwardAutomationReplyHandoffToMachine(request),
    });
    onShutdown('automation-reply-handoff-worker', async () => {
        await automationReplyHandoffWorker.stop();
    });
    onShutdown('api:http', async () => {
        await app.close();
    });

    // End
    log('API ready on port http://localhost:' + port);
}
