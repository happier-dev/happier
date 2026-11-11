import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { auth } from '@/app/auth/auth';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';

const logSpy = vi.hoisted(() => vi.fn());

vi.mock('@/utils/logging/log', () => ({
    log: logSpy,
}));

function stringifyForSearch(value: unknown): string {
    if (typeof value === 'string') return value;
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function expectNoSecretLeak(secret: string) {
    const rendered = logSpy.mock.calls.flat().map(stringifyForSearch).join(' ');
    expect(rendered).not.toContain(secret);
}

async function withApp(run: (app: ReturnType<typeof Fastify>) => Promise<void>) {
    const app = Fastify();
    try {
        await run(app);
    } finally {
        await app.close().catch(() => {});
    }
}

describe('log redaction', () => {
    let harness: LightSqliteHarness;
    let token: string;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-log-redaction-', initAuth: true });
    }, 120_000);

    afterAll(async () => {
        await harness?.close();
    });

    beforeEach(() => {
        logSpy.mockClear();
    });

    it(
        'enableAuthentication never logs API-token bearer values',
        async () => {
        const { enableAuthentication } = await import('./enableAuthentication');
        await withApp(async (app) => {
            enableAuthentication(app as any);

            const account = await db.account.create({ data: { encryptionMode: 'plain' } });
            token = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });

            const reply = {
                code: vi.fn(() => reply),
                send: vi.fn(() => reply),
            };

            await (app as any).authenticate(
                { headers: { authorization: `Bearer ${token}` }, url: '/v1/account/profile', routeOptions: { config: {} } },
                reply
            );

            expectNoSecretLeak(token);
            expectNoSecretLeak(`Bearer ${token}`);
        });
        },
        20_000,
    );

    it('refuses an invalid bearer credential while keeping it out of logs', async () => {
        const { enableAuthentication } = await import('./enableAuthentication');
        await withApp(async (app) => {
            enableAuthentication(app as any);
            const invalidToken = 'invalid-log-redaction-token';
            const reply = { code: vi.fn(() => reply), send: vi.fn(() => reply) };

            await (app as any).authenticate(
                { headers: { authorization: `Bearer ${invalidToken}` }, url: '/v1/account/profile', routeOptions: { config: {} } },
                reply,
            );

            expect(reply.code).toHaveBeenCalledWith(401);
            expectNoSecretLeak(invalidToken);
            expectNoSecretLeak(`Bearer ${invalidToken}`);
        });
    });

    it('enableErrorHandlers never logs Authorization/Cookie header values in 404 handler', async () => {
        const { enableErrorHandlers } = await import('./enableErrorHandlers');
        await withApp(async (app) => {
            enableErrorHandlers(app as any);
            await app.ready();

            await app.inject({
                method: 'GET',
                url: '/definitely-not-a-route',
                headers: {
                    authorization: 'Bearer SUPER_SECRET_TOKEN',
                    cookie: 'session=SUPER_SECRET_COOKIE',
                },
            });

            expectNoSecretLeak('SUPER_SECRET_TOKEN');
            expectNoSecretLeak('SUPER_SECRET_COOKIE');
        });
    });
});
