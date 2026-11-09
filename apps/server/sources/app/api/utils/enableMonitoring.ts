import type { FastifyReply, FastifyRequest } from "fastify";
import { Fastify } from "../types";
import {
    httpRequestsCounter,
    httpRequestDurationHistogram,
} from "@/app/monitoring/metrics2";
import {
    sendDatabaseReadinessResponse,
    sendLivenessResponse,
} from "@/app/monitoring/readiness";
import { redactPublicShareCapabilityUrl } from "@happier-dev/protocol";
import type { ApiStartupIdentityHolder } from "@/app/runtime/startupReceipt";

export function enableMonitoring(
    app: Fastify,
    { apiStartupIdentity = null }: Readonly<{ apiStartupIdentity?: ApiStartupIdentityHolder | null }> = {},
) {
    // Add metrics hooks
    app.addHook('onRequest', async (request, reply) => {
        request.startTime = Date.now();
    });

    app.addHook('onResponse', async (request, reply) => {
        const duration = (Date.now() - (request.startTime || Date.now())) / 1000;
        const method = request.method;
        // Use routeOptions.url for the route template, fallback to parsed URL path
        const route = request.routeOptions?.url
            || redactPublicShareCapabilityUrl(request.url.split('?')[0])
            || 'unknown';
        const status = reply.statusCode.toString();

        // Increment request counter
        httpRequestsCounter.inc({ method, route, status });

        // Record request duration
        httpRequestDurationHistogram.observe({ method, route, status }, duration);
    });

    const livenessHandler = async (_request: FastifyRequest, reply: FastifyReply) => {
        sendLivenessResponse(reply);
    };

    const readinessHandler = async (_request: FastifyRequest, reply: FastifyReply) => {
        await sendDatabaseReadinessResponse(reply, {
            apiStartupInstanceId: apiStartupIdentity?.read()?.instanceId ?? null,
        });
    };

    app.get('/health', livenessHandler);
    app.get('/ready', readinessHandler);
}
