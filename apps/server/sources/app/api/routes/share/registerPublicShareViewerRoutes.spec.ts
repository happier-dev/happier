import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDbMocks, createDbTransactionMock, installDbModuleMock, inTxPostgresControlStatementMock } from '../../testkit/dbMocks';
import { homeConfigSnapshotPostgresQueryMock } from '@/app/home/settings/homeConfigSnapshot.testkit';

// Only the database transport is replaced; shell admission and HTTP routing stay real.
const mocks = createDbMocks({ artifact: ['findFirst'], publicSessionShare: ['findUnique'], homeSettings: ['findUnique'], homeGovernancePolicy: ['findUnique'] } as const);
const transactions = createDbTransactionMock(() => ({ ...mocks.db, ...inTxPostgresControlStatementMock, ...homeConfigSnapshotPostgresQueryMock }));
installDbModuleMock(() => ({ db: transactions.wrapDb({ ...mocks.db, ...homeConfigSnapshotPostgresQueryMock }) }));
// Home configuration now reads through the SQLite snapshot transport as well.
vi.doMock('@/storage/prisma', async importOriginal => ({
    ...await importOriginal<typeof import('@/storage/prisma')>(),
    withSqliteReadSnapshot: transactions.transaction,
}));
const { withAuthenticatedTestApp } = await import('../../testkit/sqliteFastify');
const { registerPublicShareViewerRoutes } = await import('./registerPublicShareViewerRoutes');
const { resolveStoredContentPublicShareSubjectOrigin } = await import('@/app/share/storedContentPublicShareOrigin');
const { checkStoredContentPublicShareRateLimit } = await import('@/app/share/storedContentPublicShare');
const PUBLIC_SHARE_VIEWER_SCRIPT = (await import('./publicShareViewerBundle.generated')).readPublicShareViewerScript();
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

    it.each(['share', 'profile'] as const)('prepares the %s viewer only on first demand and reuses its settled promise', async kind => {
        let listenJobs = 0;
        await withAuthenticatedTestApp(app => {
            // Fastify is the network/lifecycle boundary; the real hooks and imports run.
            const hooks = vi.spyOn(app, 'addHook');
            if (kind === 'share') registerPublicShareViewerRoutes(createServerFeatureGatedRouteApp(app, 'sharing.public'));
            else profileViewerOwner.registerPublicProfileReadRoutes(app);
            listenJobs = hooks.mock.calls.filter(call => call[0] === 'onListen').length;
        }, async app => {
            // A Home that never serves a public viewer keeps no viewer bundle resident.
            expect(listenJobs).toBe(0);
            await app.listen({ port: 0, host: '127.0.0.1' });
            const load = kind === 'share' ? shareViewerOwner.loadPublicShareViewerScript : profileViewerOwner.loadPublicProfileHtml;
            const first = load();
            expect(load()).toBe(first);
            if (kind === 'share') expect(await first).toBe(PUBLIC_SHARE_VIEWER_SCRIPT);
            else {
                const html = (await profileViewerOwner.loadPublicProfileHtml()).renderPublicProfileHtml({ kind: 'unavailable' });
                expect(html).toContain('Profile unavailable');
                expect(html).not.toContain('<script');
            }
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

    it.each(['isolated-origin', 'main-origin'] as const)('serves one content-addressed viewer on %s with immutable caching and unchanged admission', async mode => {
        if (mode === 'main-origin') {
            vi.stubEnv('HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__HOST_ORIGIN_DOMAIN', '');
            vi.stubEnv('HAPPIER_PUBLIC_SHARES_ALLOW_SUBPATH', '1');
        }
        const origin = resolveStoredContentPublicShareSubjectOrigin(share);
        if (!origin) throw new Error('Missing test origin');
        const headers = { host: new URL(origin).host };
        const digest = createHash('sha256').update(PUBLIC_SHARE_VIEWER_SCRIPT).digest('hex');
        const assetUrl = '/s/_viewer/' + digest + '.js';
        await withAuthenticatedTestApp(registerPublicShareViewerRoutes, async app => {
            for (const id of [lookupId, 'another-share']) {
                const landing = await app.inject({ method: 'GET', url: '/s/' + id, headers });
                expect(landing.statusCode).toBe(200);
                expect(landing.headers['cache-control']).toBe('no-store');
                expect(landing.body).toContain('<script src="' + assetUrl + '" defer>');
                expect(landing.body).not.toContain(id);
                expect(landing.body).not.toContain(PUBLIC_SHARE_VIEWER_SCRIPT);
            }
            const asset = await app.inject({ method: 'GET', url: assetUrl, headers });
            expect(asset.statusCode).toBe(200);
            expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
            expect(asset.headers['content-type']).toContain('application/javascript');
            expect(asset.headers['cross-origin-resource-policy']).toBe('same-origin');
            expect(asset.headers['x-content-type-options']).toBe('nosniff');
            expect(asset.headers['set-cookie']).toBeUndefined();
            expect(createHash('sha256').update(asset.body).digest('hex')).toBe(digest);
            expect(asset.body).toBe(PUBLIC_SHARE_VIEWER_SCRIPT);
            const legacy = await app.inject({ method: 'GET', url: '/s/' + lookupId + '/viewer.js', headers });
            expect(legacy.statusCode).toBe(200);
            expect(legacy.headers['cache-control']).toBe('no-store');
            expect(legacy.body).toBe(asset.body);
            const wrongDigest = await app.inject({ method: 'GET', url: '/s/_viewer/' + '0'.repeat(64) + '.js', headers });
            expect(wrongDigest.statusCode).toBe(404);
            expect(wrongDigest.headers['cache-control']).toBe('no-store');
            expect(wrongDigest.json()).toEqual({ error: 'public_share_unavailable' });
            for (const deniedHeaders of [
                { ...headers, authorization: 'Bearer secret' },
                { host: 'unconfigured.example.test' },
                ...(mode === 'isolated-origin' ? [{ ...headers, cookie: 'account=secret' }] : []),
            ]) {
                const refused = await app.inject({ method: 'GET', url: assetUrl, headers: deniedHeaders });
                expect(refused.statusCode).toBe(404);
                expect(refused.headers['cache-control']).toBe('no-store');
            }
            if (mode === 'main-origin') {
                const withCookie = await app.inject({ method: 'GET', url: assetUrl, headers: { ...headers, cookie: 'account=secret' } });
                expect(withCookie.statusCode).toBe(200);
                expect(withCookie.body).toBe(asset.body);
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
