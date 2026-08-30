import 'reflect-metadata';
import { initializeServerSentry } from '@/app/monitoring/sentry';
import { resolveServerFlavorFromEnv } from '@/config/backends';
import { registerProcessHandlers } from '@/utils/process/processHandlers';

async function run(): Promise<void> {
    const flavor = resolveServerFlavorFromEnv(process.env, 'full');
    process.env.HAPPY_SERVER_FLAVOR = flavor;
    process.env.HAPPIER_SERVER_FLAVOR = flavor;

    // Initialize Sentry before importing the server runtime so auto-instrumentation can patch dependencies (Fastify, etc).
    initializeServerSentry(process.env);
    registerProcessHandlers();

    const { startServer } = await import('@/startServer');
    await startServer(flavor);
}

void run()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .then(() => {
        process.exit(0);
    });
