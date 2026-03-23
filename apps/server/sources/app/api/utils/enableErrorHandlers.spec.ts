import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from "node:fs/promises";
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyEnvValues, snapshotEnv, restoreEnv } from "../testkit/env";
import { enableErrorHandlers } from './enableErrorHandlers';

describe('enableErrorHandlers', () => {
    it('responds 404 when UI index.html is missing (instead of 500)', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'happy-ui-missing-'));
        const app = Fastify();
        const envSnapshot = snapshotEnv();
        applyEnvValues({
            HAPPIER_SERVER_UI_DIR: dir,
            HAPPIER_SERVER_UI_PREFIX: '/',
        });

        try {
            enableErrorHandlers(app as any);
            await app.ready();

            const res = await app.inject({ method: 'GET', url: '/' });
            expect(res.statusCode).toBe(404);
        } finally {
            await app.close().catch(() => {});
            restoreEnv(envSnapshot);
            await rm(dir, { recursive: true, force: true });
        }
    });
});
