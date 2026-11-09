import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDbMocks, createDbTransactionMock, installDbModuleMock, inTxPostgresControlStatementMock } from '../../testkit/dbMocks';
import { homeConfigSnapshotPostgresQueryMock } from '@/app/home/settings/homeConfigSnapshot.testkit';

// Only the database transport is replaced; shell admission and HTTP routing stay real.
const mocks = createDbMocks({ artifact: ['findFirst'], publicSessionShare: ['findUnique'], homeSettings: ['findUnique'], homeGovernancePolicy: ['findUnique'] } as const);
const transactions = createDbTransactionMock(() => ({ ...mocks.db, ...inTxPostgresControlStatementMock, ...homeConfigSnapshotPostgresQueryMock }));
installDbModuleMock(() => ({ db: transactions.wrapDb(mocks.db) }));
// Home configuration now reads through the SQLite snapshot transport as well.
vi.doMock('@/storage/prisma', async importOriginal => ({
    ...await importOriginal<typeof import('@/storage/prisma')>(),
    withSqliteReadSnapshot: transactions.transaction,
}));
const { withAuthenticatedTestApp } = await import('../../testkit/sqliteFastify');
const { registerPublicShareViewerRoutes } = await import('./registerPublicShareViewerRoutes');
const { resolveStoredContentPublicShareSubjectOrigin } = await import('@/app/share/storedContentPublicShareOrigin');
const { checkStoredContentPublicShareRateLimit } = await import('@/app/share/storedContentPublicShare');
const { PUBLIC_SHARE_VIEWER_SCRIPT } = await import('./publicShareViewerBundle.generated');
const shareViewerOwner = await import('./registerPublicShareViewerRoutes');
const profileViewerOwner = await import('../account/registerPublicProfileReadRoutes');
const { createServerFeatureGatedRouteApp } = await import('@/app/features/catalog/serverFeatureGate');

describe('public share landing recovery through the HTTP owner', () => {
    const lookupId = '22222222-2222-4222-8222-222222222222';
    const share = { id: '33333333-3333-4333-8333-333333333333', sessionId: 'session', artifactId: null,
        keyDerivation: 'fragment_v1', expiresAt: null, maxUses: null, useCount: 0 };
    beforeEach(() => {
        mocks.reset();
        mocks.db.homeSettings.findUnique.mockResolvedValue(null);
        mocks.db.homeGovernancePolicy.findUnique.mockResolvedValue(null);
        mocks.db.artifact.findFirst.mockResolvedValue({ id: 'artifact' });
        vi.stubEnv('HAPPIER_PUBLIC_SERVER_URL', 'https://home.example.test');
        vi.stubEnv('HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__HOST_ORIGIN_DOMAIN', 'preview.example.test');
        vi.stubEnv('HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOW_TEST_RATE_LIMIT_CHECKER', '1');
    });
    afterEach(() => vi.unstubAllEnvs());

    it.each(['share', 'profile'] as const)('warms the %s viewer only after listen and reuses its settled promise on first demand', async kind => {
        let listenJobs = 0;
        await withAuthenticatedTestApp(app => {
            // Fastify is the network/lifecycle boundary; the real hook and imports run.
            const hooks = vi.spyOn(app, 'addHook');
            if (kind === 'share') registerPublicShareViewerRoutes(createServerFeatureGatedRouteApp(app, 'sharing.public'));
            else profileViewerOwner.registerPublicProfileReadRoutes(app);
            listenJobs = hooks.mock.calls.filter(call => call[0] === 'onListen').length;
        }, async app => {
            expect(listenJobs).toBe(1);
            // A settled import alone leaves React/RNW's first render on the visitor.
            // Observe real rendering; do not replace the renderer with a mock result.
            const render = kind === 'profile'
                ? vi.spyOn(await import('@/app/account/profile/render/publicProfileHtml'), 'renderPublicProfileHtml')
                : undefined;
            const preparationEvents = vi.spyOn(app.log, 'info');
            expect(render?.mock.calls.length ?? 0).toBe(0);
            await app.listen({ port: 0, host: '127.0.0.1' });
            await vi.dynamicImportSettled();
            const load = kind === 'share' ? shareViewerOwner.loadPublicShareViewerScript : profileViewerOwner.loadPublicProfileHtml;
            const first = load();
            expect(load()).toBe(first);
            let alreadyPrepared = false;
            void first.then(() => { alreadyPrepared = true; });
            await Promise.resolve();
            expect(alreadyPrepared).toBe(true);
            if (kind === 'share') expect(await first).toBe(PUBLIC_SHARE_VIEWER_SCRIPT);
            else {
                expect(render).toHaveBeenCalledExactlyOnceWith({ kind: 'unavailable' });
                expect(preparationEvents).toHaveBeenCalledWith({ viewer: 'profile', elapsedMs: expect.any(Number) },
                    'Post-listen public viewer prepared');
                const html = (await profileViewerOwner.loadPublicProfileHtml()).renderPublicProfileHtml({ kind: 'unavailable' });
                expect(html).toContain('Profile unavailable');
                expect(html).toContain('<style>');
                expect(html).not.toContain('<script');
                expect(render).toHaveBeenCalledTimes(2);
                render?.mockRestore();
            }
            preparationEvents.mockRestore();
        });
    });

    it.each(['session', 'artifact'] as const)('serves the static %s landing without reading available, expired, spent or revoked shares', async kind => {
        const row = { ...share, sessionId: kind === 'session' ? 'session' : null, artifactId: kind === 'artifact' ? 'artifact' : null };
        const origin = resolveStoredContentPublicShareSubjectOrigin(row);
        if (!origin) throw new Error('Missing test origin');
        await withAuthenticatedTestApp(registerPublicShareViewerRoutes, async app => {
            const headers = { host: new URL(origin).host };
            mocks.db.publicSessionShare.findUnique.mockResolvedValue(row);
            const available = await app.inject({ method: 'GET', url: `/s/${lookupId}`, headers });
            expect(available.statusCode).toBe(200);
            expect(mocks.db.publicSessionShare.findUnique).not.toHaveBeenCalled();
            expect(mocks.db.artifact.findFirst).not.toHaveBeenCalled();
            // An encrypted bundle's stored policy is opened by the browser, so
            // the shell is the network ceiling; the opaque guest narrows it.
            for (const directive of ['script-src', 'style-src', 'img-src', 'font-src', 'connect-src']) {
                expect(String(available.headers['content-security-policy']).split(';').find(part => part.trim().startsWith(directive)))
                    .toContain('https:');
            }
            for (const unavailable of [{ ...row, expiresAt: new Date(1) }, { ...row, maxUses: 1, useCount: 1 }, null]) {
                mocks.db.publicSessionShare.findUnique.mockResolvedValue(unavailable);
                const landing = await app.inject({ method: 'GET', url: `/s/${lookupId}`, headers });
                expect(landing.statusCode).toBe(200);
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
            expect(mocks.db.publicSessionShare.findUnique).not.toHaveBeenCalled();
            expect(mocks.db.artifact.findFirst).not.toHaveBeenCalled();
        });
    });

    it('leaves the content request bucket untouched by repeated static landings and assets', async () => {
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
            const next = await app.inject({ method: 'GET', url: `/s/${lookupId}`, headers });
            expect(next.statusCode).toBe(200);
            expect(next.headers['content-type']).toContain('text/html');
            expect(next.body).toBe(first.body);
            expect((await app.inject({ method: 'GET', url: `/s/${lookupId}/viewer.js`, headers })).statusCode).toBe(200);
            expect(checkStoredContentPublicShareRateLimit(share.id, '127.0.0.1')).toBe('allowed');
            expect(checkStoredContentPublicShareRateLimit(share.id, '127.0.0.1')).toBe('limited');
            expect(mocks.db.publicSessionShare.findUnique).not.toHaveBeenCalled();
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
