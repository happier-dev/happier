import { readEncryptionFeatureEnv, type EncryptionFeatureEnv } from '@/app/features/catalog/readFeatureEnv';
import { isServerFeatureEnabledForRequest } from '@/app/features/catalog/serverFeatureGate';
import { resolveLightDataDir } from '@/flavors/light/env';

export type HomeSearchCapability = Readonly<{
    enabled: boolean;
    reason?: 'index_unavailable' | 'indexing';
}>;

/**
 * Plain-at-rest Homes index plaintext transcripts; encrypted content stays with client/daemon
 * search. `plaintext_only` is the one canonical storage-policy word: the Account-mode word
 * `plain` and any other value are not Home storage policies.
 */
export function isPlainHomeStoragePolicy(storagePolicy: string | undefined): boolean {
    return storagePolicy === 'plaintext_only';
}

/** Canonical production admission for the server-light Home-local search route/lifecycle. */
export function resolveHomeSearchRuntimeConfig(env: NodeJS.ProcessEnv): Readonly<{
    dataDir: string;
    storagePolicy: EncryptionFeatureEnv['storagePolicy'];
}> | null {
    // The encryption feature-env owner is the single storage-policy parser; it normalizes
    // the canonical enum and fails closed to `required_e2ee` for anything else.
    const { storagePolicy } = readEncryptionFeatureEnv(env);
    if ((env.HAPPIER_SERVER_FLAVOR ?? env.HAPPY_SERVER_FLAVOR) !== 'light'
        || (env.HAPPIER_DB_PROVIDER ?? env.HAPPY_DB_PROVIDER) !== 'sqlite'
        || (env.HAPPIER_FILES_BACKEND ?? env.HAPPY_FILES_BACKEND) !== 'local'
        || !isServerFeatureEnabledForRequest('search', env)
        || !isPlainHomeStoragePolicy(storagePolicy)
    ) return null;
    return { dataDir: resolveLightDataDir(env), storagePolicy };
}

/**
 * The lifecycle advertises a cold plain Home as available on demand. During an active
 * reconciliation the capability reports `indexing`; the search request awaits preparation
 * of its visible Session scopes. Daemon remains the provider for non-plain Homes.
 */
export function resolveHomeSearchCapability(input: Readonly<{
    indexReady: boolean;
    indexing?: boolean;
}>): HomeSearchCapability {
    if (input.indexing) return { enabled: false, reason: 'indexing' };
    if (!input.indexReady) return { enabled: false, reason: 'index_unavailable' };
    return { enabled: true };
}
