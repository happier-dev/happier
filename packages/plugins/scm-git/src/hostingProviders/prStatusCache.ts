import type {
  ScmHostingProviderRef,
  ScmOperationErrorCode,
  ScmPullRequestState,
  ScmPullRequestSummary,
} from '@happier-dev/plugin-sdk/scm';

export type PrStatusCacheConfig = Readonly<{
    successTtlMs: number;
    authErrorTtlMs: number;
    notFoundErrorTtlMs: number;
    networkErrorTtlMs: number;
    maxEntries: number;
}>;

export const DEFAULT_PR_STATUS_CACHE_CONFIG: PrStatusCacheConfig = Object.freeze({
    successTtlMs: 30_000,
    authErrorTtlMs: 5_000,
    notFoundErrorTtlMs: 15_000,
    networkErrorTtlMs: 5_000,
    maxEntries: 128,
});

export type PrStatusCacheKey = Readonly<{
    workspaceKey: string;
    repoRootPath: string;
    provider: ScmHostingProviderRef;
    baseBranch?: string | null;
    headBranch: string;
    headRepositoryNameWithOwner?: string | null;
    state?: ScmPullRequestState;
    authProfileKey?: string;
}>;

export type PrStatusCacheInvalidationScope = Readonly<{
    repoRootPath: string;
    providerId?: string;
    headBranch?: string;
}>;

export type PrStatusCacheSuccessEntry = Readonly<{
    kind: 'success';
    key: PrStatusCacheKey;
    pullRequests: readonly ScmPullRequestSummary[];
    fetchedAt: number;
    expiresAt: number;
}>;

export type PrStatusCacheErrorKind = 'auth' | 'notFound' | 'network';

export type PrStatusCacheErrorEntry = Readonly<{
    kind: 'error';
    key: PrStatusCacheKey;
    error: string;
    errorCode?: ScmOperationErrorCode;
    errorKind: PrStatusCacheErrorKind;
    fetchedAt: number;
    expiresAt: number;
}>;

export type PrStatusCacheEntry = PrStatusCacheSuccessEntry | PrStatusCacheErrorEntry;

export type PrStatusCache = Readonly<{
    getFresh(key: PrStatusCacheKey): PrStatusCacheEntry | null;
    getFreshForAnyAuthProfile(key: Omit<PrStatusCacheKey, 'authProfileKey'> & Readonly<{ authProfileKey?: string }>): PrStatusCacheEntry | null;
    setSuccess(input: Readonly<{
        key: PrStatusCacheKey;
        pullRequests: readonly ScmPullRequestSummary[];
        fetchedAt?: number;
    }>): PrStatusCacheSuccessEntry;
    setError(input: Readonly<{
        key: PrStatusCacheKey;
        error: string;
        errorCode?: ScmOperationErrorCode;
        errorKind: PrStatusCacheErrorKind;
        fetchedAt?: number;
    }>): PrStatusCacheErrorEntry;
    invalidate(scope: PrStatusCacheInvalidationScope): void;
    clear(): void;
}>;

function normalizeOptional(value: string | null | undefined): string {
    return value?.trim() ?? '';
}

function normalizeProviderNameWithOwner(provider: ScmHostingProviderRef): string {
    return provider.nameWithOwner?.trim() ?? '';
}

function stableCacheKey(key: PrStatusCacheKey): string {
    return JSON.stringify({
        workspaceKey: key.workspaceKey,
        repoRootPath: key.repoRootPath,
        providerId: key.provider.id,
        providerKind: key.provider.kind,
        providerBaseUrl: key.provider.baseUrl,
        nameWithOwner: normalizeProviderNameWithOwner(key.provider),
        baseBranch: normalizeOptional(key.baseBranch),
        headBranch: normalizeOptional(key.headBranch),
        headRepositoryNameWithOwner: normalizeOptional(key.headRepositoryNameWithOwner),
        state: key.state ?? 'open',
        authProfileKey: key.authProfileKey ?? '',
    });
}

function sameLogicalKey(left: PrStatusCacheKey, right: Omit<PrStatusCacheKey, 'authProfileKey'>): boolean {
    return left.workspaceKey === right.workspaceKey
        && left.repoRootPath === right.repoRootPath
        && left.provider.id === right.provider.id
        && left.provider.kind === right.provider.kind
        && left.provider.baseUrl === right.provider.baseUrl
        && normalizeProviderNameWithOwner(left.provider) === normalizeProviderNameWithOwner(right.provider)
        && normalizeOptional(left.baseBranch) === normalizeOptional(right.baseBranch)
        && normalizeOptional(left.headBranch) === normalizeOptional(right.headBranch)
        && normalizeOptional(left.headRepositoryNameWithOwner) === normalizeOptional(right.headRepositoryNameWithOwner)
        && (left.state ?? 'open') === (right.state ?? 'open');
}

function ttlForError(config: PrStatusCacheConfig, kind: PrStatusCacheErrorKind): number {
    if (kind === 'auth') return config.authErrorTtlMs;
    if (kind === 'notFound') return config.notFoundErrorTtlMs;
    return config.networkErrorTtlMs;
}

function isFresh(entry: PrStatusCacheEntry, now: number): boolean {
    return entry.expiresAt > now;
}

function assertConfig(config: PrStatusCacheConfig): PrStatusCacheConfig {
    return {
        successTtlMs: Math.max(0, config.successTtlMs),
        authErrorTtlMs: Math.max(0, config.authErrorTtlMs),
        notFoundErrorTtlMs: Math.max(0, config.notFoundErrorTtlMs),
        networkErrorTtlMs: Math.max(0, config.networkErrorTtlMs),
        maxEntries: Math.max(1, Math.trunc(config.maxEntries)),
    };
}

export function createPrStatusCache(input?: Readonly<{
    now?: () => number;
    config?: Partial<PrStatusCacheConfig>;
}>): PrStatusCache {
    const now = input?.now ?? Date.now;
    const config = assertConfig({
        ...DEFAULT_PR_STATUS_CACHE_CONFIG,
        ...input?.config,
    });
    const entries = new Map<string, PrStatusCacheEntry>();

    function pruneExpired(timestamp: number): void {
        for (const [key, entry] of entries) {
            if (!isFresh(entry, timestamp)) {
                entries.delete(key);
            }
        }
    }

    function enforceBound(): void {
        while (entries.size > config.maxEntries) {
            let oldestKey: string | null = null;
            let oldestFetchedAt = Number.POSITIVE_INFINITY;
            for (const [key, entry] of entries) {
                if (entry.fetchedAt < oldestFetchedAt) {
                    oldestFetchedAt = entry.fetchedAt;
                    oldestKey = key;
                }
            }
            if (!oldestKey) return;
            entries.delete(oldestKey);
        }
    }

    function setEntry(entry: PrStatusCacheEntry): void {
        entries.set(stableCacheKey(entry.key), entry);
        enforceBound();
    }

    return Object.freeze({
        getFresh(key) {
            const timestamp = now();
            pruneExpired(timestamp);
            const entry = entries.get(stableCacheKey(key)) ?? null;
            return entry && isFresh(entry, timestamp) ? entry : null;
        },
        getFreshForAnyAuthProfile(key) {
            const timestamp = now();
            pruneExpired(timestamp);
            let freshest: PrStatusCacheEntry | null = null;
            for (const entry of entries.values()) {
                if (!sameLogicalKey(entry.key, key) || !isFresh(entry, timestamp)) {
                    continue;
                }
                if (!freshest || entry.fetchedAt > freshest.fetchedAt) {
                    freshest = entry;
                }
            }
            return freshest;
        },
        setSuccess({ key, pullRequests, fetchedAt }) {
            const timestamp = fetchedAt ?? now();
            const entry: PrStatusCacheSuccessEntry = Object.freeze({
                kind: 'success',
                key,
                pullRequests: Object.freeze([...pullRequests]),
                fetchedAt: timestamp,
                expiresAt: timestamp + config.successTtlMs,
            });
            setEntry(entry);
            return entry;
        },
        setError({ key, error, errorCode, errorKind, fetchedAt }) {
            const timestamp = fetchedAt ?? now();
            const entry: PrStatusCacheErrorEntry = Object.freeze({
                kind: 'error',
                key,
                error,
                ...(errorCode ? { errorCode } : {}),
                errorKind,
                fetchedAt: timestamp,
                expiresAt: timestamp + ttlForError(config, errorKind),
            });
            setEntry(entry);
            return entry;
        },
        invalidate(scope) {
            for (const [key, entry] of entries) {
                if (entry.key.repoRootPath !== scope.repoRootPath) {
                    continue;
                }
                if (scope.providerId && entry.key.provider.id !== scope.providerId) {
                    continue;
                }
                if (scope.headBranch && entry.key.headBranch !== scope.headBranch) {
                    continue;
                }
                entries.delete(key);
            }
        },
        clear() {
            entries.clear();
        },
    });
}

export const defaultPrStatusCache = createPrStatusCache();
