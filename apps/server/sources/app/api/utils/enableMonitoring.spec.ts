import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { enableMonitoring } from './enableMonitoring';
import { applyLightDefaultEnv } from '@/flavors/light/env';
import { db, initDbPglite, shutdownDbPglite } from '@/storage/db';

describe('enableMonitoring', () => {
    it('reports service as happier-server in /health responses', async () => {
        const base = await mkdtemp(join(tmpdir(), 'happier-server-health-'));
        const envBackup = { ...process.env };

        try {
            process.env = { ...process.env, HAPPY_SERVER_LIGHT_DATA_DIR: base };
            applyLightDefaultEnv(process.env, { homedir: base });
            await initDbPglite();

            const app = Fastify();
            enableMonitoring(app as any);
            await app.ready();

            const res = await app.inject({ method: 'GET', url: '/health' });
            expect(res.statusCode).toBe(200);
            const body = res.json() as { service?: string };
            expect(body.service).toBe('happier-server');

            await app.close();
            await db.$disconnect();
            await shutdownDbPglite();
        } finally {
            process.env = envBackup;
            await rm(base, { recursive: true, force: true });
        }
    });
});
