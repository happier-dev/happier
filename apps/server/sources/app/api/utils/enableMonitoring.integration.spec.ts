import Fastify from 'fastify';
import { type ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { enableMonitoring } from './enableMonitoring';
import { createLightSqliteHarness } from '@/testkit/lightSqliteHarness';
import type { Fastify as HappierFastify } from '../types';

function createMonitoringApp(): HappierFastify {
    return Fastify().withTypeProvider<ZodTypeProvider>() as unknown as HappierFastify;
}

describe('enableMonitoring', () => {
    let harness: Awaited<ReturnType<typeof createLightSqliteHarness>>;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: 'happier-server-health-',
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
        });
    });

    afterAll(async () => {
        await harness?.close().catch(() => {});
    });

    it('reports service as happier-server in liveness response for /health', async () => {
        const app = createMonitoringApp();

        try {
            enableMonitoring(app);
            await app.ready();

            const res = await app.inject({ method: 'GET', url: '/health' });
            expect(res.statusCode).toBe(200);
            const body = res.json() as { service?: string };
            expect(body.service).toBe('happier-server');
        } finally {
            await app.close().catch(() => {});
        }
    });

    it('returns the full healthy liveness response body shape from /health', async () => {
        const app = createMonitoringApp();

        try {
            enableMonitoring(app);
            await app.ready();

            const res = await app.inject({ method: 'GET', url: '/health' });
            expect(res.statusCode).toBe(200);
            const body = res.json() as { status?: string; timestamp?: string; service?: string };
            expect(body.status).toBe('ok');
            expect(body.service).toBe('happier-server');
            expect(typeof body.timestamp).toBe('string');
            expect(Number.isNaN(new Date(body.timestamp ?? '').getTime())).toBe(false);
        } finally {
            await app.close().catch(() => {});
        }
    });

    it('returns the full ready response body shape from /ready when the database responds', async () => {
        const app = createMonitoringApp();

        try {
            enableMonitoring(app);
            await app.ready();

            const res = await app.inject({ method: 'GET', url: '/ready' });
            expect(res.statusCode).toBe(200);
            const body = res.json() as { status?: string; timestamp?: string; service?: string };
            expect(body.status).toBe('ok');
            expect(body.service).toBe('happier-server');
            expect(typeof body.timestamp).toBe('string');
            expect(Number.isNaN(new Date(body.timestamp ?? '').getTime())).toBe(false);
        } finally {
            await app.close().catch(() => {});
        }
    });

    it.each(['/live', '/health/db'])('does not expose removed monitoring alias %s', async (url) => {
        const app = createMonitoringApp();

        try {
            enableMonitoring(app);
            await app.ready();

            const res = await app.inject({ method: 'GET', url });
            expect(res.statusCode).toBe(404);
        } finally {
            await app.close().catch(() => {});
        }
    });
});
