import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { enableMonitoring } from './enableMonitoring';
import { createLightSqliteHarness } from '@/testkit/lightSqliteHarness';

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

    it('reports service as happier-server in /health responses', async () => {
        const app = Fastify();

        try {
            enableMonitoring(app as any);
            await app.ready();

            const res = await app.inject({ method: 'GET', url: '/health' });
            expect(res.statusCode).toBe(200);
            const body = res.json() as { service?: string };
            expect(body.service).toBe('happier-server');
        } finally {
            await app.close().catch(() => {});
        }
    });

    it('returns the full healthy response body shape from /health', async () => {
        const app = Fastify();

        try {
            enableMonitoring(app as any);
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
});
