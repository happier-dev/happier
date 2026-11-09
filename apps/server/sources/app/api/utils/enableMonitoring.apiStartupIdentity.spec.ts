import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify from 'fastify';
import { type ZodTypeProvider } from 'fastify-type-provider-zod';
import { describe, expect, it, vi } from 'vitest';

import type { Fastify as HappierFastify } from '../types';

// The database probe is the only boundary here; `/ready` routing and identity stay real.
vi.mock('@/storage/db', () => ({
    db: {},
    probeDbReadiness: vi.fn(async () => undefined),
}));

function createMonitoringApp(): HappierFastify {
    return Fastify().withTypeProvider<ZodTypeProvider>() as unknown as HappierFastify;
}

describe('enableMonitoring API startup identity', () => {
    it('exposes the identity from /ready only through its own holder and only after listen', async () => {
        const { enableMonitoring } = await import('./enableMonitoring');
        const { createApiStartupIdentityHolder } = await import('@/app/runtime/startupReceipt');
        const holder = createApiStartupIdentityHolder({
            HAPPIER_SERVER_STARTUP_RECEIPT_PATH: join(tmpdir(), 'startup.json'),
            HAPPIER_SERVER_STARTUP_RECEIPT_NONCE: 'activation-nonce-1',
        });
        const app = createMonitoringApp();
        const unrelatedApp = createMonitoringApp();

        try {
            enableMonitoring(app, { apiStartupIdentity: holder });
            enableMonitoring(unrelatedApp);
            await app.ready();
            await unrelatedApp.ready();

            const beforeListen = await app.inject({ method: 'GET', url: '/ready' });
            expect(beforeListen.statusCode).toBe(200);
            expect(beforeListen.json()).not.toHaveProperty('apiStartupIdentity');

            holder.record({ address: '0.0.0.0', family: 'IPv4', port: 53944 });
            const afterListen = await app.inject({ method: 'GET', url: '/ready' });
            expect(afterListen.statusCode).toBe(200);
            expect(afterListen.json().apiStartupIdentity).toEqual({ instanceId: holder.read()?.instanceId });

            const liveness = await app.inject({ method: 'GET', url: '/health' });
            expect(liveness.json()).not.toHaveProperty('apiStartupIdentity');
            const unrelated = await unrelatedApp.inject({ method: 'GET', url: '/ready' });
            expect(unrelated.json()).not.toHaveProperty('apiStartupIdentity');
        } finally {
            await app.close().catch(() => {});
            await unrelatedApp.close().catch(() => {});
        }
    });
});
