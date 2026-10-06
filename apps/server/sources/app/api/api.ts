import fastify, { errorCodes, type FastifyBodyParser, type FastifyInstance } from "fastify";
import type { FastifyCorsOptions } from "@fastify/cors";
import {
    ACCOUNT_STORED_CONTENT_COMPATIBILITY_HTTP_HEADER,
    SERVER_HTTP_REQUEST_MAX_BODY_UTF8_BYTES_V1,
    SESSION_SYSTEM_RECORDS_PROTOCOL_HTTP_HEADER,
} from "@happier-dev/protocol";
import { log, logger } from "@/utils/logging/log";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { onShutdown } from "@/utils/process/shutdown";
import { Fastify } from "./types";
import { registerEphemeralRunnerRoutes } from "@/app/ephemeralRunner/routes";
import { authRoutes } from "./routes/auth/authRoutes";
import { pushRoutes } from "./routes/push/pushRoutes";
import { sessionRoutes } from "./routes/session/sessionRoutes";
import { connectRoutes } from "./routes/connect/connectRoutes";
import { accountRoutes } from "./routes/account/accountRoutes";
import { homeGovernanceRoutes } from "./routes/home/homeGovernanceRoutes";
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
import { V2_SESSION_LIST_SERVER_TIMING_REQUEST_HEADER } from "@/app/session/listing/timing";
import { startAutomationReplyHandoffWorker } from "@/app/automations/automationReplyHandoffWorker";
import { startAutomationScheduleWorker } from "@/app/automations/automationScheduleWorker";
import { registerExternalActionRoutes } from "./routes/actions/registerExternalActionRoutes";
import { registerExternalProviderApiRoutes } from "./routes/providers/registerExternalProviderApiRoutes";
import { registerTeamInvitationRoutes } from "@/app/teams/invitations/registerTeamInvitationRoutes";
import { registerTeamGroupRoutes } from "@/app/teams/groups/registerTeamGroupRoutes";
import { registerTeamMemberRoutes } from "@/app/teams/memberships/registerTeamMemberRoutes";
import { registerTeamDirectoryRoutes } from "@/app/teams/directory/registerTeamDirectoryRoutes";
import { registerTeamRoutes } from "@/app/teams/registerTeamRoutes";
import { registerManagedGitHubAppRoutes } from "@/app/integrations/github/githubManagedAppRoutes";
import { resolveJoinScreenHomeIdentity } from "@/app/teams/invitations/joinScreenHome";
import { registerAuthEmailApplicationLinkTarget, resolveAuthEmailReadiness } from "@/app/auth/email/resolveAuthEmailDelivery";
import { createHomeAuthEmailDelivery, createHomeMailLinkTargetResolver } from "@/app/auth/email/homeAuthEmailDelivery";
import type { AuthEmailDelivery } from "@/app/auth/email/authEmailDelivery";
import { readHomeConfigEnv, readHomeConfigEnvInTx } from "@/app/home/settings/homeSettings";
import { registerHomeSettingsRoutes } from "./routes/home/homeSettingsRoutes";
import { registerHomeRetentionRoutes } from "./routes/home/homeRetentionRoutes";
import { registerHomeReachabilityRoutes } from "./routes/home/homeReachabilityRoutes";
import { startHomeSearchLifecycle, type HomeSearchLifecycle } from "@/app/search/homeSearchLifecycle";
import { readCanonicalSessionMessagesPage } from "@/app/search/homeSearchCanonicalSessionMessages";
import { registerHomeSearchRoutes } from "@/app/search/homeSearchRoutes";
import { resolveHomeSearchRuntimeConfig } from "@/app/search/homeSearchCapability";
import { resolveHomeSearchDbPath } from "@/app/search/homeSearchDb";
import { getOrCreateServerIdentityId } from "@/app/serverIdentity/serverIdentity";
import { db } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import { buildSessionAccessWhere } from "@/app/session/access/sessionAccessWhere";
import {
    SESSION_TRANSCRIPT_PUBLICATION_SELECT,
    resolveSessionTranscriptPublicationConstraints,
} from '@/app/session/sessionTranscriptPublicationPolicy';
import type { HomeConnectionDescriptorContinuityStore } from '@/app/features/homeConnectionDescriptorContinuity';
import type { ResolveAuthEmailApplicationLinkTarget } from '@/app/auth/email/nativeAuthEmailOperations';
import { readHomeConnectionDescriptor } from '@/app/features/homeConnectionDescriptorPublication';

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
    SESSION_SYSTEM_RECORDS_PROTOCOL_HTTP_HEADER,
];
export const API_CORS_EXPOSED_HEADERS = [
    'server-timing',
    'x-happier-retry-reason',
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
        if (body.length === 0) {
            return done(null, undefined);
        }
        return done(new errorCodes.FST_ERR_CTP_INVALID_MEDIA_TYPE(), undefined);
    };
    app.addContentTypeParser('*', { parseAs: 'string' }, parseUnsupportedBody);
}

export function registerApiRoutes(typed: Fastify, params: Readonly<{
    resolveHomeSearchCapability?: () => ReturnType<HomeSearchLifecycle['capability']> | undefined;
    homeConnectionDescriptorContinuityStore?: HomeConnectionDescriptorContinuityStore | null;
    authEmailDelivery?: AuthEmailDelivery;
    resolveAuthEmailApplicationLinkTarget?: ResolveAuthEmailApplicationLinkTarget;
}> = {}): void {
    const authEmail = {
        // Resolved per send from the Home's effective mail settings (plan §3.3), never captured at
        // startup, so a saved SMTP password is used by the next message.
        delivery: params.authEmailDelivery ?? createHomeAuthEmailDelivery(),
    };
    const hasLifecycleSelectedDescriptorOwner = Object.prototype.hasOwnProperty.call(
        params,
        'homeConnectionDescriptorContinuityStore',
    );
    const resolveHomeConnectionDescriptor = hasLifecycleSelectedDescriptorOwner
        ? async (tx?: Tx) => {
            const continuityStore = params.homeConnectionDescriptorContinuityStore;
            if (!continuityStore) return undefined;
            // The live overlay carries a stored or inferred public address (plan §3.2).
            return readHomeConnectionDescriptor({
                env: tx ? await readHomeConfigEnvInTx(tx) : await readHomeConfigEnv(),
                continuityStore,
                visibility: 'authenticated',
                tx,
            });
        }
        : undefined;
    const resolveAuthEmailApplicationLinkTarget = params.resolveAuthEmailApplicationLinkTarget
        ?? createHomeMailLinkTargetResolver({ continuityStore: params.homeConnectionDescriptorContinuityStore });
    // The one mail-readiness owner reads the same link target the mail routes render from, for the
    // routes below and for environment-only readers (feature projection, Home governance).
    const isAuthEmailReady = async () => await resolveAuthEmailReadiness({
        transportReady: await authEmail.delivery.isReady(),
        resolveApplicationLinkTarget: resolveAuthEmailApplicationLinkTarget,
    });
    registerAuthEmailApplicationLinkTarget(resolveAuthEmailApplicationLinkTarget);
    authRoutes(typed, {
        ...(resolveHomeConnectionDescriptor ? { resolveHomeConnectionDescriptor } : {}),
        isEmailDeliveryReady: isAuthEmailReady,
        authEmailDelivery: authEmail.delivery,
        resolveApplicationLinkTarget: resolveAuthEmailApplicationLinkTarget,
    });
    pushRoutes(typed);
    sessionRoutes(typed);
    registerEphemeralRunnerRoutes(typed);
    accountRoutes(typed);
    homeGovernanceRoutes(typed);
    registerHomeSettingsRoutes(typed, { authEmailDelivery: authEmail.delivery });
    registerHomeRetentionRoutes(typed);
    registerHomeReachabilityRoutes(typed);
    changesRoutes(typed);
    connectRoutes(typed);
    machinesRoutes(typed);
    artifactsRoutes(typed);
    accessKeysRoutes(typed);
    devRoutes(typed);
    versionRoutes(typed);
    featuresRoutes(typed, {
        resolveHomeSearchCapability: params.resolveHomeSearchCapability,
        homeConnectionDescriptorContinuityStore: params.homeConnectionDescriptorContinuityStore,
    });
    bugReportDiagnosticsRoutes(typed);
    sessionPendingRoutes(typed);
    voiceRoutes(typed);
    userRoutes(typed);
    feedRoutes(typed);
    kvRoutes(typed);
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
    registerExternalActionRoutes(typed);
    registerExternalProviderApiRoutes(typed);
    registerReviewCommentRoutes(typed);
    // Team lifecycle, policy, and branding. These need no composed dependency:
    // the domain owns its own authorization, transaction, and media boundary, and
    // the single `teams` feature gate is applied inside the route module.
    // The member sign-in link on Team Authentication is rendered from the same
    // Home application origin and portable carrier the invitation link uses, so
    // both links address the identical Home.
    registerTeamRoutes(typed, process.env, {
        // One link-target owner for mail, invitation and member sign-in links (Home-effective env).
        resolveMemberSignInLinkTarget: async () => await resolveAuthEmailApplicationLinkTarget(),
    });
    registerManagedGitHubAppRoutes(typed);
    // Team membership and flat Groups. Like Team lifecycle they compose nothing
    // external: the membership owner holds the capability, owner-invariant, and
    // history decisions, and the Group owner holds the contribution union.
    registerTeamMemberRoutes(typed);
    registerTeamGroupRoutes(typed);
    registerTeamDirectoryRoutes(typed);
    // Team invitations compose owners that already exist: the Home identity and
    // storage disclosure, the configured application origin, the Account/email
    // lane's verified-mailbox fact, and the transactional mail boundary. This
    // route family owns none of them.
    registerTeamInvitationRoutes(typed, {
        resolveJoinLinkTarget: async () => await resolveAuthEmailApplicationLinkTarget(),
        resolveJoinScreenHomeIdentity: async () => resolveJoinScreenHomeIdentity(await readHomeConfigEnv()),
        email: {
            delivery: authEmail.delivery,
            isDeliveryReady: isAuthEmailReady,
        },
    });
}

export async function startApi(params: Readonly<{
    homeConnectionDescriptorContinuityStore?: HomeConnectionDescriptorContinuityStore | null;
}> = {}) {

    // Configure
    log('Starting API...');

    // Start API
    const trustProxy = resolveApiTrustProxy(process.env);
    const app = fastify({
        loggerInstance: logger,
        bodyLimit: SERVER_HTTP_REQUEST_MAX_BODY_UTF8_BYTES_V1,
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

    // Home search construction is intentionally I/O-free. Opening and reconciliation start only after listen.
    const homeSearchConfig = resolveHomeSearchRuntimeConfig(process.env);
    const homeSearch = homeSearchConfig
        ? startHomeSearchLifecycle({
            dbPath: resolveHomeSearchDbPath(homeSearchConfig.dataDir),
            homeServerIdentityId: async () => await getOrCreateServerIdentityId(process.env),
            storagePolicy: homeSearchConfig.storagePolicy,
            readCanonicalMessagesPage: readCanonicalSessionMessagesPage,
        })
        : null;

    // Routes
    registerApiRoutes(typed, {
        resolveHomeSearchCapability: homeSearch ? () => homeSearch.capability() : undefined,
        homeConnectionDescriptorContinuityStore: params.homeConnectionDescriptorContinuityStore,
    });
    if (homeSearch) {
        registerHomeSearchRoutes(typed, {
            service: homeSearch,
            resolveVisibleSessions: async (userId, authentication) => resolveSessionTranscriptPublicationConstraints(
                await inTx(async (tx) => {
                    const accessWhere = await buildSessionAccessWhere({
                        tx,
                        accountId: userId,
                        capability: 'readTranscript',
                        mode: 'effective_access_v1',
                        authentication,
                    });
                    return await tx.session.findMany({
                        where: accessWhere,
                        select: { id: true, ...SESSION_TRANSCRIPT_PUBLICATION_SELECT },
                    });
                }),
            ),
        });
        onShutdown('home-search', async () => { await homeSearch.stop(); });
    }

    // Start HTTP 
    const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3005;
    await app.listen({ port, host: resolveApiListenHost(process.env) });
    // Home search starts after the API is initialized and stops before the DB shutdown phase.
    homeSearch?.start();
    const automationReplyHandoffWorker = startAutomationReplyHandoffWorker({
        dispatch: async (request) => await typed.forwardAutomationReplyHandoffToMachine(request),
    });
    onShutdown('automation-reply-handoff-worker', async () => {
        await automationReplyHandoffWorker.stop();
    });
    const automationScheduleWorker = startAutomationScheduleWorker();
    onShutdown('automation-schedule-worker', async () => {
        await automationScheduleWorker.stop();
    });
    onShutdown('api:http', async () => {
        await app.close();
    });

    // End
    log('API ready on port http://localhost:' + port);
    return app;
}
