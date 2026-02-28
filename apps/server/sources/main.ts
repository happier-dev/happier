import 'reflect-metadata';
import { initializeServerSentry } from '@/app/monitoring/sentry';
import { registerProcessHandlers } from '@/utils/process/processHandlers';

async function run(): Promise<void> {
    process.env.HAPPY_SERVER_FLAVOR = 'full';
    process.env.HAPPIER_SERVER_FLAVOR = 'full';

    // Initialize Sentry before importing the server runtime so auto-instrumentation can patch dependencies (Fastify, etc).
    initializeServerSentry(process.env);
    registerProcessHandlers();

    const { startServer } = await import('@/startServer');
    await startServer('full');
}

void run()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .then(() => {
        process.exit(0);
    });
