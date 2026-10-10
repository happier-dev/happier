import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Response as HttpResponse, fetch as httpFetch } from 'undici';
import { bundledUsageModelPriceCatalog } from '@happier-dev/protocol';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { withAuthenticatedTestApp } from '../../testkit/sqliteFastify';
import { registerAccountUsageRoutes } from './registerAccountUsageRoutes';

// HTTP and DNS are genuine system boundaries; catalog parsing, network policy and storage stay real.
vi.mock('undici', async (importOriginal) => ({ ...await importOriginal<typeof import('undici')>(), fetch: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: vi.fn(async () => [{ address: '185.199.108.133', family: 4 }]) }));

const cacheKey = 'usage:model-price-catalog:v1';
const rawCatalog = { 'catalog-model': { mode: 'chat', input_cost_per_token: 0.000002, output_cost_per_token: 0.000004 } };

describe('Account Usage public model prices', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-price-catalog-', initAuth: false }); }, 120_000);
    afterAll(async () => { await harness.close(); });
    afterEach(async () => {
        harness.resetEnv();
        vi.mocked(httpFetch).mockReset();
        await harness.resetDbTables([() => db.simpleCache.deleteMany(), () => db.account.deleteMany()]);
    });

    it('reads bundled prices without an outbound effect and obeys the server fetch-disabled setting on Refresh', async () => {
        const account = await db.account.create({ data: { publicKey: 'price-disabled' } });
        process.env.HAPPIER_USAGE_MODEL_PRICE_FETCH_ENABLED = 'false';
        await db.simpleCache.create({ data: { key: cacheKey, value: JSON.stringify({
            ...bundledUsageModelPriceCatalog, models: { 'cached-only-model': { inputUsdPerMillion: 123, outputUsdPerMillion: 123 } },
            provenance: { ...bundledUsageModelPriceCatalog.provenance, origin: 'fetched', revision: 'cached-only' },
        }) } });
        vi.mocked(httpFetch).mockRejectedValue(new Error('Unexpected outbound request'));
        await withAuthenticatedTestApp(registerAccountUsageRoutes, async (app) => {
            const headers = { 'x-test-user-id': account.id };
            const initial = await app.inject({ method: 'GET', url: '/v1/account/usage/prices', headers });
            expect(initial.statusCode).toBe(200);
            expect(initial.json().models).toEqual(bundledUsageModelPriceCatalog.models);
            expect(initial.json().provenance).toMatchObject({ origin: 'bundled', fetchStatus: 'disabled' });
            const disabled = await app.inject({ method: 'POST', url: '/v1/account/usage/prices/refresh', headers, payload: {} });
            expect(disabled.statusCode).toBe(200);
            expect(disabled.json().provenance).toMatchObject({ origin: 'bundled', fetchStatus: 'disabled' });
            expect(httpFetch).not.toHaveBeenCalled();
            expect(JSON.parse((await db.simpleCache.findUniqueOrThrow({ where: { key: cacheKey } })).value).provenance.revision).toBe('cached-only');
            process.env.HAPPIER_USAGE_MODEL_PRICE_FETCH_ENABLED = 'true';
            const reenabled = await app.inject({ method: 'GET', url: '/v1/account/usage/prices', headers });
            expect(reenabled.json()).toMatchObject({ models: { 'cached-only-model': { inputUsdPerMillion: 123 } },
                provenance: { origin: 'cached', fetchStatus: 'ready', revision: 'cached-only' } });
            expect(httpFetch).not.toHaveBeenCalled();
        });
    });

    it('falls back with error provenance for HTTP, network and invalid-file failures, then recovers and preserves cached prices', async () => {
        const account = await db.account.create({ data: { publicKey: 'price-recovery' } });
        await withAuthenticatedTestApp(registerAccountUsageRoutes, async (app) => {
            const headers = { 'x-test-user-id': account.id };
            const refresh = () => app.inject({ method: 'POST', url: '/v1/account/usage/prices/refresh', headers, payload: {} });
            for (const failure of ['http', 'network', 'invalid'] as const) {
                if (failure === 'network') vi.mocked(httpFetch).mockRejectedValueOnce(new Error('network failure'));
                else vi.mocked(httpFetch).mockResolvedValueOnce(new HttpResponse(failure === 'http' ? '{}' : '{"garbage":true}', { status: failure === 'http' ? 503 : 200 }));
                const result = await refresh();
                expect(result.statusCode).toBe(200);
                expect(result.json().provenance).toMatchObject({ origin: 'bundled', fetchStatus: 'error' });
                expect(result.json().provenance.errorCode).toBe(failure === 'http' ? 'http_503' : failure === 'network' ? 'fetch_failed' : 'invalid_catalog');
            }
            vi.mocked(httpFetch).mockResolvedValueOnce(new HttpResponse(JSON.stringify(rawCatalog), { status: 200, headers: { etag: 'catalog-v1' } }));
            const recovered = await refresh();
            expect(recovered.statusCode).toBe(200);
            expect(recovered.json()).toMatchObject({ models: { 'catalog-model': { inputUsdPerMillion: 2, outputUsdPerMillion: 4 } },
                provenance: { origin: 'fetched', fetchStatus: 'ready', revision: 'catalog-v1' } });
            const [url, init] = vi.mocked(httpFetch).mock.calls.at(-1)!;
            expect(String(url)).toBe('https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json');
            expect(init).toMatchObject({ redirect: 'manual' });
            expect(init?.headers).toBeUndefined();
            expect(init?.body).toBeUndefined();
            expect(await db.simpleCache.findUnique({ where: { key: cacheKey } })).not.toBeNull();
            vi.mocked(httpFetch).mockRejectedValueOnce(new Error('offline again'));
            const offline = await refresh();
            expect(offline.json()).toMatchObject({ models: recovered.json().models, provenance: { origin: 'cached', fetchStatus: 'error' } });
            const read = await app.inject({ method: 'GET', url: '/v1/account/usage/prices', headers });
            expect(read.json()).toMatchObject({ models: recovered.json().models, provenance: { origin: 'cached', fetchStatus: 'error' } });
        });
    });
});
