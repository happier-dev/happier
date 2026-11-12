import { bundledUsageModelPriceCatalog, LITELLM_MODEL_PRICE_URL, parseLiteLlmModelPriceCatalog } from '@happier-dev/protocol/usage/usageModelPriceCatalog';
import { readServerConfig } from '@happier-dev/protocol/serverConfig/serverConfigCodec';
import { UsageModelPriceCatalogSchema, type UsageModelPriceCatalog } from '@happier-dev/protocol/usage/usageModelPriceSchemas';
import { readFromSimpleCache, writeToSimpleCache } from '@/storage/cache/simpleCache';
import { readHomeConfigEnv, readHomeConfigEnvInTx } from '@/app/home/settings/homeSettings';
import { createOutboundFetch } from '@/app/net/outboundIdentityFetch';
import { OutboundIdentityEndpointError } from '@/app/net/outboundIdentityNetworkPolicy';
import { USAGE_PRICE_SERVER_CONFIG } from './usagePriceServerConfig';
import type { Tx } from '@/storage/inTx';

export const USAGE_MODEL_PRICE_CACHE_KEY = 'usage:model-price-catalog:v1';

async function readStoredCatalog(reader?: Pick<Tx, 'simpleCache'>): Promise<UsageModelPriceCatalog> {
    return resolveStoredCatalog(await readFromSimpleCache(USAGE_MODEL_PRICE_CACHE_KEY, reader));
}

function resolveStoredCatalog(stored: string | null): UsageModelPriceCatalog {
    if (stored !== null) {
        try {
            const parsed = UsageModelPriceCatalogSchema.safeParse(JSON.parse(stored));
            if (parsed.success) return { ...parsed.data, provenance: { ...parsed.data.provenance,
                origin: parsed.data.provenance.origin === 'bundled' ? 'bundled' : 'cached' } };
        } catch { /* The public projection is reconstructible from the bundled source. */ }
    }
    return bundledUsageModelPriceCatalog;
}

function disabledCatalog(): UsageModelPriceCatalog {
    return { ...bundledUsageModelPriceCatalog, provenance: { ...bundledUsageModelPriceCatalog.provenance, fetchStatus: 'disabled' } };
}

async function isFetchEnabled(tx?: Tx): Promise<boolean> {
    const env = tx ? await readHomeConfigEnvInTx(tx) : await readHomeConfigEnv();
    return readServerConfig(env, USAGE_PRICE_SERVER_CONFIG.HAPPIER_USAGE_MODEL_PRICE_FETCH_ENABLED);
}

/** Query and price reads never fetch. Disabling selects bundled prices without discarding the cache. */
export async function readUsageModelPriceCatalog(): Promise<UsageModelPriceCatalog> {
    return resolveCapturedUsageModelPriceCatalog(await captureUsageModelPriceCatalog());
}

export interface CapturedUsageModelPriceCatalog {
    fetchEnabled: boolean;
    stored: string | null;
}

/** Current tariff inputs are independent reads; Home configuration owns its coherent singleton snapshot. */
export async function captureUsageModelPriceCatalog(): Promise<CapturedUsageModelPriceCatalog> {
    const fetchEnabled = await isFetchEnabled();
    return { fetchEnabled, stored: fetchEnabled ? await readFromSimpleCache(USAGE_MODEL_PRICE_CACHE_KEY) : null };
}

/** Composing readers capture tariff bytes in their existing snapshot and decode afterwards. */
export async function captureUsageModelPriceCatalogInTx(tx: Tx): Promise<CapturedUsageModelPriceCatalog> {
    const fetchEnabled = await isFetchEnabled(tx);
    return { fetchEnabled, stored: fetchEnabled ? await readFromSimpleCache(USAGE_MODEL_PRICE_CACHE_KEY, tx) : null };
}

export function resolveCapturedUsageModelPriceCatalog(captured: CapturedUsageModelPriceCatalog): UsageModelPriceCatalog {
    return captured.fetchEnabled ? resolveStoredCatalog(captured.stored) : disabledCatalog();
}

/** Only this explicit action accesses the static public source; no Account data enters the request. */
export async function refreshUsageModelPriceCatalog(): Promise<UsageModelPriceCatalog> {
    if (!await isFetchEnabled()) return disabledCatalog();
    const previous = await readStoredCatalog();
    const outbound = createOutboundFetch({ policy: { address: { kind: 'publicOnly' }, allowedPorts: [443], allowLoopbackHttp: false } });
    let errorCode = 'invalid_catalog';
    let catalog: UsageModelPriceCatalog;
    try {
        const response = await outbound.fetch(LITELLM_MODEL_PRICE_URL);
        if (!response.ok) {
            errorCode = `http_${response.status}`;
            throw new Error('Public catalog HTTP failure');
        }
        const asOfMs = Date.now();
        catalog = parseLiteLlmModelPriceCatalog(await response.json(), {
            source: 'litellm', origin: 'fetched', asOfMs,
            revision: response.headers.get('etag')?.trim() || `fetched:${asOfMs}`, fetchStatus: 'ready',
        });
    } catch (error) {
        if (error instanceof OutboundIdentityEndpointError) errorCode = error.code;
        catalog = { ...previous, provenance: { ...previous.provenance, fetchStatus: 'error', errorCode } };
    } finally {
        await outbound.close();
    }
    // Storage failure is not a public-source failure and must not be labelled as one.
    await writeToSimpleCache(USAGE_MODEL_PRICE_CACHE_KEY, JSON.stringify(catalog));
    return catalog;
}
