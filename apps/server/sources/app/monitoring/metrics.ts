import fastify from 'fastify';
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
            // Database driver metrics (statement durations, pool state) are registered in the
            // same registry by the storage owner (metrics/databaseDriverMetrics.ts).
            const metrics = await register.metrics();
            reply.type('text/plain; version=0.0.4; charset=utf-8');
            reply.send(metrics);
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

export async function startMetricsServer(): Promise<boolean> {
    const config = readMetricsServerConfigFromEnv(process.env);
    if (!config.enabled) {
        log({ module: 'metrics' }, 'Metrics server disabled');
        return false;
    }

    const app = await createMetricsServer();
    
    try {
        await app.listen({ port: config.port, host: '0.0.0.0' });
        log({ module: 'metrics' }, `Metrics server listening on port ${config.port}`);
        return true;
    } catch (error) {
        log({ module: 'metrics', level: 'error' }, `Failed to start metrics server: ${error}`);
        throw error;
    }
}
