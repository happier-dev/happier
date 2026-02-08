import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { enableMonitoring } from './enableMonitoring';
import { createLightSqliteHarness } from '@/testkit/lightSqliteHarness';

describe('enableMonitoring', () => {
    it('reports service as happier-server in /health responses', async () => {
        const harness = await createLightSqliteHarness({
            tempDirPrefix: 'happier-server-health-',
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
        });
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
            await harness.close().catch(() => {});
        }
    });
});
