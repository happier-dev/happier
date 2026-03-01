import { sessionListDirectory } from '@/sync/ops';

export type RepositoryDirectoryEntry = {
    name: string;
    type: 'file' | 'directory';
};

export type ListRepositoryDirectoryEntriesResult =
    | { ok: true; entries: RepositoryDirectoryEntry[] }
    | { ok: false; error: string };

const repositoryDirectoryCache = new Map<string, RepositoryDirectoryEntry[]>();
const repositoryDirectoryWarmInFlight = new Map<string, Promise<ListRepositoryDirectoryEntriesResult>>();

function getCacheKey(sessionId: string, directoryPath: string): string {
    return `${sessionId}:${directoryPath}`;
}

export function getCachedRepositoryDirectoryEntries(input: {
    sessionId: string;
    directoryPath: string;
}): RepositoryDirectoryEntry[] | null {
    const key = getCacheKey(input.sessionId, input.directoryPath);
    const cached = repositoryDirectoryCache.get(key);
    return cached ? cached.slice() : null;
}

export function setCachedRepositoryDirectoryEntries(input: {
    sessionId: string;
    directoryPath: string;
    entries: RepositoryDirectoryEntry[];
}): void {
    const key = getCacheKey(input.sessionId, input.directoryPath);
    repositoryDirectoryCache.set(key, input.entries.slice());
}

export async function warmRepositoryDirectoryCache(input: {
    sessionId: string;
    directoryPath: string;
}): Promise<ListRepositoryDirectoryEntriesResult> {
    const cached = getCachedRepositoryDirectoryEntries(input);
    if (cached) {
        return { ok: true, entries: cached };
    }

    const key = getCacheKey(input.sessionId, input.directoryPath);
    const inFlight = repositoryDirectoryWarmInFlight.get(key);
    if (inFlight) {
        return await inFlight;
    }

    const promise = (async () => {
        try {
            return await listRepositoryDirectoryEntries(input);
        } finally {
            repositoryDirectoryWarmInFlight.delete(key);
        }
    })();
    repositoryDirectoryWarmInFlight.set(key, promise);
    return await promise;
}

type SessionListDirectoryLikeResponse = {
    success?: boolean;
    error?: string | null;
    entries?: Array<{
        name?: string;
        type?: 'file' | 'directory' | 'other';
    }>;
};

function normalizeName(name: string): string {
    return name.normalize('NFKC');
}

export function sortRepositoryDirectoryEntries(entries: RepositoryDirectoryEntry[]): RepositoryDirectoryEntry[] {
    const copy = entries.slice();
    copy.sort((a, b) => {
        if (a.type !== b.type) {
            return a.type === 'directory' ? -1 : 1;
        }
        // Normalize only for sorting; keep raw names for identity/path resolution.
        return normalizeName(a.name).localeCompare(normalizeName(b.name), undefined, { sensitivity: 'base' });
    });
    return copy;
}

export async function listRepositoryDirectoryEntries(input: {
    sessionId: string;
    directoryPath: string;
}): Promise<ListRepositoryDirectoryEntriesResult> {
    const response = await sessionListDirectory(input.sessionId, input.directoryPath) as unknown as SessionListDirectoryLikeResponse | null;
    if (!response) {
        return { ok: false, error: 'unknown_error' };
    }
    if (response.success !== true) {
        const err = typeof response.error === 'string' ? response.error.trim() : '';
        return { ok: false, error: err || 'unknown_error' };
    }
    if (!Array.isArray(response.entries)) {
        return { ok: false, error: 'unknown_error' };
    }

    const entries: RepositoryDirectoryEntry[] = [];
    for (const entry of response.entries) {
        if (!entry || typeof entry.name !== 'string') continue;
        const raw = entry.name.trim();
        if (!raw) continue;
        if (entry.type !== 'file' && entry.type !== 'directory') continue;
        entries.push({ name: raw, type: entry.type });
    }

    const sorted = sortRepositoryDirectoryEntries(entries);
    setCachedRepositoryDirectoryEntries({
        sessionId: input.sessionId,
        directoryPath: input.directoryPath,
        entries: sorted,
    });
    return { ok: true, entries: sorted };
}
