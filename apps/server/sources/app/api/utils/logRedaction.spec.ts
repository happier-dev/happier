import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const logSpy = vi.fn();

vi.mock('@/utils/log', () => ({
    log: logSpy,
}));

vi.mock('@/app/auth/auth', () => ({
    auth: {
        verifyToken: vi.fn(async () => ({ userId: 'user_123' })),
    },
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

describe('log redaction', () => {
    beforeEach(() => {
        logSpy.mockClear();
    });

    it('enableAuthentication never logs bearer tokens', async () => {
        const { enableAuthentication } = await import('./enableAuthentication');
        const app = Fastify();
        enableAuthentication(app as any);

        const reply = {
            code: vi.fn(() => reply),
            send: vi.fn(() => reply),
        };

        await (app as any).authenticate(
            { headers: { authorization: 'Bearer SUPER_SECRET_TOKEN' }, url: '/v1/account/profile' },
            reply
        );

        expectNoSecretLeak('SUPER_SECRET_TOKEN');
        // Ensure we also never log the literal header content (including scheme).
        expectNoSecretLeak('Bearer SUPER_SECRET_TOKEN');
    });

    it('enableErrorHandlers never logs Authorization/Cookie header values in 404 handler', async () => {
        const { enableErrorHandlers } = await import('./enableErrorHandlers');
        const app = Fastify();
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

