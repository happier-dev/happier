import fastify from "fastify";
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

export function resolveApiListenHost(env: Record<string, string | undefined>): string {
    const host = (env.HAPPIER_SERVER_HOST ?? env.HAPPY_SERVER_HOST ?? '').toString().trim();
    return host.length > 0 ? host : '0.0.0.0';
}

export async function startApi() {

    // Configure
    log('Starting API...');

    // Start API
    const app = fastify({
        loggerInstance: logger,
        bodyLimit: 1024 * 1024 * 100, // 100MB
    });
    app.register(import('@fastify/cors'), {
        origin: '*',
        // Keep permissive defaults for now. Tighten via a proxy/WAF or by
        // changing this list once deployments are stable.
        allowedHeaders: ['authorization', 'content-type'],
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
    });
    app.register(import('@fastify/rate-limit'), {
        global: false // Only apply to routes with explicit config
    });

    enableOptionalStatics(app);

    // Create typed provider
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;

    // Enable features
    enableMonitoring(typed);
    enableErrorHandlers(typed);
    enableAuthentication(typed);

    // Routes
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

    // Start HTTP 
    const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3005;
    await app.listen({ port, host: resolveApiListenHost(process.env) });
    onShutdown('api', async () => {
        await app.close();
    });

    // Start Socket
    startSocket(typed);

    // End
    log('API ready on port http://localhost:' + port);
}
