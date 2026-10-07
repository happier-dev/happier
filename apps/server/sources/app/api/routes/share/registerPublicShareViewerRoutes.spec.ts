import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDbMocks, installDbModuleMock } from '../../testkit/dbMocks';

// Only the database transport is replaced; shell admission and HTTP routing stay real.
const mocks = createDbMocks({ artifact: ['findFirst'], publicSessionShare: ['findUnique'] } as const);
installDbModuleMock(() => ({ db: mocks.db }));
const { withAuthenticatedTestApp } = await import('../../testkit/sqliteFastify');
const { registerPublicShareViewerRoutes } = await import('./registerPublicShareViewerRoutes');
const { resolveStoredContentPublicShareSubjectOrigin } = await import('@/app/share/storedContentPublicShareOrigin');
const { PUBLIC_SHARE_VIEWER_SCRIPT } = await import('./publicShareViewerBundle.generated');

describe('public share landing recovery through the HTTP owner', () => {
    const lookupId = '22222222-2222-4222-8222-222222222222';
    const share = { id: '33333333-3333-4333-8333-333333333333', sessionId: 'session', artifactId: null,
        keyDerivation: 'fragment_v1', expiresAt: null, maxUses: null, useCount: 0 };
    beforeEach(() => {
        mocks.reset();
        mocks.db.artifact.findFirst.mockResolvedValue({ id: 'artifact' });
        vi.stubEnv('HAPPIER_PUBLIC_SERVER_URL', 'https://home.example.test');
        vi.stubEnv('HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__HOST_ORIGIN_DOMAIN', 'preview.example.test');
        vi.stubEnv('HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOW_TEST_RATE_LIMIT_CHECKER', '1');
    });
    afterEach(() => vi.unstubAllEnvs());

    it.each(['session', 'artifact'] as const)('keeps the shared %s viewer available for expired, spent and revoked links', async kind => {
        const row = { ...share, sessionId: kind === 'session' ? 'session' : null, artifactId: kind === 'artifact' ? 'artifact' : null };
        const origin = resolveStoredContentPublicShareSubjectOrigin(row);
        if (!origin) throw new Error('Missing test origin');
        await withAuthenticatedTestApp(registerPublicShareViewerRoutes, async app => {
            const headers = { host: new URL(origin).host };
            mocks.db.publicSessionShare.findUnique.mockResolvedValue(row);
            const available = await app.inject({ method: 'GET', url: `/s/${lookupId}`, headers });
            expect(available.statusCode).toBe(200);
            for (const unavailable of [{ ...row, expiresAt: new Date(1) }, { ...row, maxUses: 1, useCount: 1 }, null]) {
                mocks.db.publicSessionShare.findUnique.mockResolvedValue(unavailable);
                const landing = await app.inject({ method: 'GET', url: `/s/${lookupId}`, headers });
                expect(landing.statusCode).toBe(404);
                expect(landing.headers['content-type']).toContain('text/html');
                expect(landing.body).toBe(available.body);
                expect(landing.headers['content-security-policy']).toContain("connect-src 'self'");
                expect(landing.headers['cache-control']).toBe('no-store');
                expect(landing.headers['referrer-policy']).toBe('no-referrer');
                expect(landing.headers['set-cookie']).toBeUndefined();
                const asset = await app.inject({ method: 'GET', url: `/s/${lookupId}/viewer.js`, headers });
                expect(asset.statusCode).toBe(200);
                expect(asset.headers['content-type']).toContain('application/javascript');
                expect(asset.body).toBe(PUBLIC_SHARE_VIEWER_SCRIPT);
            }
        });
    });

    it('retains the rate-limited status while the same shell and static client remain usable', async () => {
        vi.stubEnv('HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_CHECKER', 'fixed_window');
        vi.stubEnv('HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_MAX_REQUESTS', '1');
        vi.stubEnv('HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_WINDOW_MS', '60000');
        mocks.db.publicSessionShare.findUnique.mockResolvedValue(share);
        const origin = resolveStoredContentPublicShareSubjectOrigin(share);
        if (!origin) throw new Error('Missing test origin');
        await withAuthenticatedTestApp(registerPublicShareViewerRoutes, async app => {
            const headers = { host: new URL(origin).host };
            const first = await app.inject({ method: 'GET', url: `/s/${lookupId}`, headers });
            expect(first.statusCode).toBe(200);
            const limited = await app.inject({ method: 'GET', url: `/s/${lookupId}`, headers });
            expect(limited.statusCode).toBe(429);
            expect(limited.headers['content-type']).toContain('text/html');
            expect(limited.body).toBe(first.body);
            expect((await app.inject({ method: 'GET', url: `/s/${lookupId}/viewer.js`, headers })).statusCode).toBe(200);
        });
    });

    it('still refuses credential-bearing landings and assets', async () => {
        await withAuthenticatedTestApp(registerPublicShareViewerRoutes, async app => {
            for (const url of [`/s/${lookupId}`, `/s/${lookupId}/viewer.js`]) {
                for (const headers of [{ cookie: 'account=secret' }, { authorization: 'Bearer secret' }]) {
                    const response = await app.inject({ method: 'GET', url, headers });
                    expect(response.statusCode).toBe(404);
                    expect(response.json()).toEqual({ error: 'public_share_unavailable' });
                }
            }
        });
    });
});
