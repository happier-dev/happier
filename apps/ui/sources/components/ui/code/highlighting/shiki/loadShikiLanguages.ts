import type { DynamicImportLanguageRegistration, LanguageInput, LanguageRegistration } from 'shiki';

import { readBundledAssetBytes } from '@/utils/assets/readBundledAssetBytes';
import { SHIKI_LANGUAGE_ASSETS } from './generatedShikiGrammarAssets';

type AssetModule = Parameters<typeof readBundledAssetBytes>[0];

// Match imported grammar modules: a packaged registration is read once and shared
// across languages and themes. A failed acquisition remains retryable.
const registrations = new Map<AssetModule, Promise<LanguageRegistration>>();

function loadRegistration(asset: AssetModule): Promise<LanguageRegistration> {
    const cached = registrations.get(asset);
    if (cached) return cached;
    const promise = (async () => {
        const bytes = await readBundledAssetBytes(asset);
        if (!bytes) throw new Error('Packaged Shiki grammar is unavailable');
        return JSON.parse(new TextDecoder().decode(bytes)) as LanguageRegistration;
    })().catch(error => {
        registrations.delete(asset);
        throw error;
    });
    registrations.set(asset, promise);
    return promise;
}

export const bundledShikiLanguageLoaders: Record<string, DynamicImportLanguageRegistration> = Object.fromEntries(
    Object.entries(SHIKI_LANGUAGE_ASSETS).map(([id, assets]) => [
        id,
        async () => ({ default: await Promise.all(assets.map(loadRegistration)) }),
    ]),
);

export async function loadShikiLanguages(): Promise<Record<string, LanguageInput>> {
    return bundledShikiLanguageLoaders;
}
