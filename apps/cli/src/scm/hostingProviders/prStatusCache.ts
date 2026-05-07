import type { ScmHostingProvider, ScmPullRequestSummary } from '@happier-dev/protocol';

export type PrStatusCacheKey = Readonly<{
    repoRootPath: string;
    provider: ScmHostingProvider;
    head: string;
    authProfileKey: string;
}>;

export type PrStatusCacheSuccessEntry = Readonly<{
    kind: 'success';
    pullRequests: readonly ScmPullRequestSummary[];
    fetchedAt: number;
    expiresAt: number;
}>;

export type PrStatusCacheErrorKind = 'auth' | 'not-found' | 'network';

export type PrStatusCacheErrorEntry = Readonly<{
    kind: 'error';
    errorKind: PrStatusCacheErrorKind;
    error: string;
    fetchedAt: number;
    expiresAt: number;
}>;

export type PrStatusCacheEntry = PrStatusCacheSuccessEntry | PrStatusCacheErrorEntry;

export type PrStatusCache = Readonly<{
    getFresh(key: PrStatusCacheKey): PrStatusCacheEntry | null;
    setSuccess(key: PrStatusCacheKey, pullRequests: readonly ScmPullRequestSummary[]): void;
    setError(key: PrStatusCacheKey, error: Readonly<{ kind: PrStatusCacheErrorKind; message: string }>): void;
    invalidate(key: Partial<Pick<PrStatusCacheKey, 'repoRootPath' | 'head'>>): void;
}>;

const SUCCESS_TTL_MS = 60_000;
const AUTH_ERROR_TTL_MS = 30_000;
const NOT_FOUND_TTL_MS = 30_000;
const NETWORK_ERROR_TTL_MS = 10_000;

function buildKey(input: PrStatusCacheKey): string {
    return JSON.stringify({
        repoRootPath: input.repoRootPath,
        providerKind: input.provider.kind,
        providerBaseUrl: input.provider.baseUrl,
        nameWithOwner: input.provider.nameWithOwner,
        head: input.head,
        authProfileKey: input.authProfileKey,
    });
}

function resolveErrorTtlMs(kind: PrStatusCacheErrorKind): number {
    switch (kind) {
        case 'auth':
            return AUTH_ERROR_TTL_MS;
        case 'not-found':
            return NOT_FOUND_TTL_MS;
        case 'network':
            return NETWORK_ERROR_TTL_MS;
    }
}

export function createPrStatusCache(params?: Readonly<{
    now?: () => number;
}>): PrStatusCache {
    const now = params?.now ?? Date.now;
    const entries = new Map<string, PrStatusCacheEntry>();

    return {
        getFresh(key) {
            const entry = entries.get(buildKey(key));
            if (!entry) return null;
            if (entry.expiresAt <= now()) {
                entries.delete(buildKey(key));
                return null;
            }
            return entry;
        },
        setSuccess(key, pullRequests) {
            const fetchedAt = now();
            entries.set(buildKey(key), {
                kind: 'success',
                pullRequests: [...pullRequests],
                fetchedAt,
                expiresAt: fetchedAt + SUCCESS_TTL_MS,
            });
        },
        setError(key, error) {
            const fetchedAt = now();
            entries.set(buildKey(key), {
                kind: 'error',
                errorKind: error.kind,
                error: error.message,
                fetchedAt,
                expiresAt: fetchedAt + resolveErrorTtlMs(error.kind),
            });
        },
        invalidate(partial) {
            for (const [rawKey] of entries) {
                const parsed = JSON.parse(rawKey) as Partial<PrStatusCacheKey>;
                if (partial.repoRootPath && parsed.repoRootPath !== partial.repoRootPath) continue;
                if (partial.head && parsed.head !== partial.head) continue;
                entries.delete(rawKey);
            }
        },
    };
}

export const defaultPrStatusCache = createPrStatusCache();
