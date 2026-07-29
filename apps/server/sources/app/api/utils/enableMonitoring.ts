import type { FastifyReply, FastifyRequest } from "fastify";
import type { Fastify } from "../types";
import {
    classifyHotEndpointFamily,
    httpHotEndpointRequestDurationHistogram,
    httpHotEndpointRequestsCounter,
    httpRequestDurationHistogram,
    httpRequestsCounter,
} from "@/app/monitoring/metrics/index";
import {
    createHealthyMonitoringResponse,
    createShuttingDownMonitoringResponse,
    type DatabaseReadinessProbe,
    type MonitoringReadinessEnv,
    sendDatabaseReadinessResponse,
} from "@/app/monitoring/readiness";
import { isShutdown } from "@/utils/process/shutdown";
import { redactPublicShareCapabilityUrl } from "@happier-dev/protocol";

type EnableMonitoringOptions = Readonly<{
    env?: MonitoringReadinessEnv;
    databaseReadinessProbe?: DatabaseReadinessProbe;
}>;

export function enableMonitoring(app: Fastify, options: EnableMonitoringOptions = {}) {
    // Add metrics hooks
    app.addHook('onRequest', async (request, _reply) => {
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

        const family = classifyHotEndpointFamily(route);
        if (family) {
            httpHotEndpointRequestsCounter.inc({ family, method, route, status });
            httpHotEndpointRequestDurationHistogram.observe({ family, method, route, status }, duration);
        }
    });

    const livenessHandler = async (_request: FastifyRequest, reply: FastifyReply) => {
        if (isShutdown()) {
            reply.code(503).send(createShuttingDownMonitoringResponse());
            return;
        }
        reply.send(createHealthyMonitoringResponse());
    };

    const readinessHandler = async (_request: FastifyRequest, reply: FastifyReply) => {
        await sendDatabaseReadinessResponse(reply, options);
    };

    app.get('/health', livenessHandler);
    app.get('/ready', readinessHandler);
}
