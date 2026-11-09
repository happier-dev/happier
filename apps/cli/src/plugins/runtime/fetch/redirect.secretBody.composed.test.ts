import { fixture, origin, ref, safeResponse, sentinel } from './pluginSecretUseHttp.testkit';
import { describe, expect, it } from 'vitest';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

describe('redirects with registered saved-secret bytes', () => {
    it('lets trusted plugin secret use choose its initial origin', async () => {
        const f = fixture('plain');
        const { service, effect } = f.makeService(async input => {
            expect(input.url).toBe('https://undeclared.example/variables');
            expect(new TextDecoder().decode(input.body)).toContain(sentinel);
            return safeResponse();
        });
        await runWithServerHttpBaseUrl('https://secret-home.example', async () => {
            const value = await f.secrets.readSavedSecret(ref, { resourceRevision: 3 });
            await expect(service.request({ url: 'https://undeclared.example/variables', method: 'POST', redirect: 'error',
                body: new TextEncoder().encode(JSON.stringify({ value })) }))
                .resolves.toMatchObject({ status: 200 });
        });
        expect(effect).toHaveBeenCalledOnce();
    });

    it('refuses cross-origin 307 before resending registered bytes', async () => {
        const f = fixture('plain');
        const delivered: string[] = [];
        const { service, effect } = f.makeService(async input => {
            delivered.push(new TextDecoder().decode(input.body));
            return { ...safeResponse(), status: 307, headers: { location: 'https://other.example/variables' } };
        });
        await runWithServerHttpBaseUrl('https://secret-home.example', async () => {
            const value = await f.secrets.readSavedSecret(ref, { resourceRevision: 3 });
            await expect(service.request({ url: `${origin}/variables`, method: 'POST', redirect: 'follow',
                body: new TextEncoder().encode(JSON.stringify({ value })) }))
                .rejects.toMatchObject({ code: 'credential_request_redirect_refused', retryable: false });
        });
        expect(effect).toHaveBeenCalledTimes(1);
        expect(delivered[0]).toContain(sentinel);
    });

    it('follows a same-origin 307 with one captured Account read', async () => {
        let catalogReads = 0;
        const f = fixture('plain', { onCatalogRead: () => { catalogReads += 1; } });
        const urls: string[] = [];
        const { service, effect } = f.makeService(async input => {
            urls.push(input.url);
            expect(new TextDecoder().decode(input.body)).toContain(sentinel);
            return urls.length === 1 ? { ...safeResponse(), status: 307, headers: { location: '/next' } } : safeResponse();
        });
        await runWithServerHttpBaseUrl('https://secret-home.example', async () => {
            const value = await f.secrets.readSavedSecret(ref, { resourceRevision: 3 });
            await expect(service.request({ url: `${origin}/variables`, method: 'POST', redirect: 'follow',
                body: new TextEncoder().encode(JSON.stringify({ value })) }))
                .resolves.toMatchObject({ status: 200 });
        });
        expect(effect).toHaveBeenCalledTimes(2);
        expect(catalogReads).toBe(1);
        expect(urls).toEqual([`${origin}/variables`, `${origin}/next`]);
    });
});
