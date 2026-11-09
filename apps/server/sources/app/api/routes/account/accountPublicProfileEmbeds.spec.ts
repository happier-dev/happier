import { describe, expect, it, vi } from 'vitest';
import { createAuthenticatedTestApp, withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerAccountPublicProfileRoutes } from './registerAccountPublicProfileRoutes';
import { loadPublicProfileHtml, registerPublicProfileReadRoutes } from './registerPublicProfileReadRoutes';
import * as htmlRenderer from '@/app/account/profile/render/publicProfileHtml';

describe('Account embed transport admission', () => {
    it('starts without painting a synthetic page and cold-renders complete HTML on first demand', async () => {
        const paint = vi.spyOn(htmlRenderer, 'renderPublicProfileHtml');
        const app = createAuthenticatedTestApp();
        registerPublicProfileReadRoutes(app);
        try {
            await app.listen({ host: '127.0.0.1', port: 0 });
            // Join any renderer import started by listening before measuring its work.
            const renderer = await loadPublicProfileHtml();
            expect(paint.mock.calls.length).toBe(0);
            const html = renderer.renderPublicProfileHtml({ kind: 'unavailable' });
            expect(paint.mock.calls.length).toBe(1);
            expect(html).toContain('No public profile here');
            const [head, body] = html.split('</style>');
            const defined = new Set([...(head ?? '').matchAll(/\.(r-[0-9a-z]+)\b/g)].map(match => match[1]));
            const used = [...new Set(body?.match(/\br-[0-9a-z]+\b/g) ?? [])];
            expect(used.length).toBeGreaterThan(0);
            expect(used.filter(name => !defined.has(name))).toEqual([]);
        } finally {
            await app.close();
            paint.mockRestore();
        }
    });

    it('protects captured Account reads and rejects caller-selected Accounts or private facts before reading storage', async () => {
        await withAuthenticatedTestApp(registerAccountPublicProfileRoutes, async app => {
            for (const url of ['/v1/account/public-profile/view', '/v1/account/public-profile/embed?kind=card&theme=auto&syntax=picture']) {
                expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
            }
            for (const url of ['/v1/account/public-profile/view?accountId=someone-else',
                '/v1/account/public-profile/embed?kind=card&theme=auto&syntax=picture&metric=tokens&snapshot=private']) {
                expect((await app.inject({ method: 'GET', url, headers: { 'x-test-user-id': 'captured-account' } })).statusCode).toBe(400);
            }
        });
    });
});
