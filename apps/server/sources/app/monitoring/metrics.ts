import fastify from 'fastify';
import { db } from '@/storage/db';
import { register } from '@/app/monitoring/metrics/index';
import { log } from '@/utils/logging/log';
import { readMetricsServerConfigFromEnv } from '@/config/monitoring';
import { createHealthyMonitoringResponse, sendDatabaseReadinessResponse } from './readiness';

export async function createMetricsServer() {
    const app = fastify({
        logger: false // Disable logging for metrics server
    });

    app.get('/metrics', async (_request, reply) => {
        try {
            // Get Prisma metrics in Prometheus format
            const prismaMetrics = await db.$metrics.prometheus();
            
            // Get custom application metrics
            const appMetrics = await register.metrics();
            
            // Combine both metrics
            const combinedMetrics = prismaMetrics + '\n' + appMetrics;
            
            reply.type('text/plain; version=0.0.4; charset=utf-8');
            reply.send(combinedMetrics);
        } catch (error) {
            log({ module: 'metrics', level: 'error' }, `Error generating metrics: ${error}`);
            reply.code(500).send('Internal Server Error');
        }
    });

    app.get('/health', async (_request, reply) => {
        reply.send(createHealthyMonitoringResponse());
    });

    app.get('/ready', async (_request, reply) => {
        await sendDatabaseReadinessResponse(reply);
    });

    return app;
}

export async function startMetricsServer(): Promise<void> {
    const config = readMetricsServerConfigFromEnv(process.env);
    if (!config.enabled) {
        log({ module: 'metrics' }, 'Metrics server disabled');
        return;
    }

    const app = await createMetricsServer();
    
    try {
        await app.listen({ port: config.port, host: '0.0.0.0' });
        log({ module: 'metrics' }, `Metrics server listening on port ${config.port}`);
    } catch (error) {
        log({ module: 'metrics', level: 'error' }, `Failed to start metrics server: ${error}`);
        throw error;
    }
}
