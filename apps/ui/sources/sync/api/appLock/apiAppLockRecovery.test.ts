import { beforeEach, describe, expect, it, vi } from 'vitest';

const { serverFetch } = vi.hoisted(() => ({ serverFetch: vi.fn() }));
// The relay HTTP transport is the external boundary; keep response parsing real.
vi.mock('@/sync/http/client', () => ({ serverFetch }));

import { apiAppLockMailSettingsGet, apiAppLockMailSettingsSave, apiAppLockMailSettingsSendTest } from './apiAppLockRecovery';

const settings = {
    host: 'smtp.example.com', port: 587, security: 'starttls' as const,
    username: 'owner@example.com', fromAddress: 'owner@example.com',
};

describe('app lock mail settings responses', () => {
    beforeEach(() => {
        serverFetch.mockReset();
    });

    it('reports a relay save failure as a server error, not a lost connection', async () => {
        serverFetch.mockResolvedValue(new Response(JSON.stringify({ error: 'Internal Server Error' }), { status: 500 }));
        await expect(apiAppLockMailSettingsSave(settings)).resolves.toEqual({ ok: false, error: 'server' });
    });

    it('reports an unreadable settings response as a server error', async () => {
        serverFetch.mockResolvedValue(new Response('<html>Proxy error</html>', { status: 200 }));
        await expect(apiAppLockMailSettingsGet()).resolves.toEqual({ ok: false, error: 'server' });
    });

    it('preserves a specific email delivery failure', async () => {
        serverFetch.mockResolvedValue(new Response(JSON.stringify({ error: 'email_failed' }), { status: 502 }));
        await expect(apiAppLockMailSettingsSendTest()).resolves.toEqual({ ok: false, error: 'email_failed' });
        expect(serverFetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ body: '{}' }), {});
    });

    it('reserves the connection error for transport failures', async () => {
        const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
        serverFetch.mockRejectedValue(new TypeError('Failed to fetch'));
        try {
            await expect(apiAppLockMailSettingsSave(settings)).resolves.toEqual({ ok: false, error: 'network' });
        } finally {
            logged.mockRestore();
        }
    });
});
