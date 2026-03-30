import Fastify from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';

import { db } from '@/storage/db';
import { auth } from '@/app/auth/auth';
import { authRoutes } from './authRoutes';
import { enableAuthentication } from '../../utils/enableAuthentication';
import { createAppCloseTracker } from '../../testkit/appLifecycle';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';

const { trackApp, closeTrackedApps } = createAppCloseTracker();

function createTestApp() {
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;
    enableAuthentication(typed);
    return trackApp(typed);
}

describe('authRoutes (auth ping) (integration)', () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: 'happier-auth-ping-',
            initAuth: true,
            initEncrypt: true,
        });
    }, 120_000);

    afterEach(async () => {
        await closeTrackedApps();
        harness.resetEnv();
        vi.unstubAllGlobals();
        await db.account.deleteMany();
    });

    afterAll(async () => {
        await harness.close();
    });

    it('returns 200 from GET /v1/auth/ping when authorized', async () => {
        const account = await db.account.create({
            data: { publicKey: `pk-${Date.now()}` },
            select: { id: true },
        });
        const token = await auth.createToken(account.id);

        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: 'GET',
            url: '/v1/auth/ping',
            headers: { authorization: `Bearer ${token}` },
        });

        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ ok: true });
    });

    it('returns 401 from GET /v1/auth/ping when missing auth', async () => {
        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: 'GET',
            url: '/v1/auth/ping',
        });

        expect(res.statusCode).toBe(401);
    });

    it('returns 401 from GET /v1/auth/ping when token is invalid', async () => {
        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: 'GET',
            url: '/v1/auth/ping',
            headers: { authorization: 'Bearer invalid-token' },
        });

        expect(res.statusCode).toBe(401);
    });
});

