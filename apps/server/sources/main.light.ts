import 'reflect-metadata';
import 'dotenv/config';

import { initializeServerSentry } from '@/app/monitoring/sentry';
import { registerProcessHandlers } from '@/utils/process/processHandlers';

async function run(): Promise<void> {
    process.env.HAPPY_SERVER_FLAVOR = 'light';
    process.env.HAPPIER_SERVER_FLAVOR = 'light';

    // Initialize Sentry before importing the server runtime so auto-instrumentation can patch dependencies (Fastify, etc).
    initializeServerSentry(process.env);
    registerProcessHandlers();

    const { startServer } = await import('@/startServer');
    await startServer('light');
}

void run().catch((e) => {
    console.error(e);
    process.exit(1);
});
