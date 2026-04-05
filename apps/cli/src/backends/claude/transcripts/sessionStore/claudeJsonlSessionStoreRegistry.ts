import type { FileBackedTranscriptSessionLease, FileBackedTranscriptSessionStore, FileBackedTranscriptSessionStoreFactory, FileBackedTranscriptSessionStoreKey } from '@/api/session/fileBackedTranscripts/store';
import { FileBackedTranscriptSessionRegistry } from '@/api/session/fileBackedTranscripts/store';

import { resolveClaudeJsonlSessionStoreColdIdleMs, resolveClaudeJsonlSessionStoreDetachedGraceMs } from './claudeJsonlSessionStoreCachePolicy';
import { createClaudeJsonlSessionStore } from './createClaudeJsonlSessionStore';

export type ClaudeJsonlSessionStore = ReturnType<typeof createClaudeJsonlSessionStore>;

const registriesByCachePolicyKey = new Map<string, FileBackedTranscriptSessionRegistry<ClaudeJsonlSessionStore>>();

function buildCachePolicyKey(env: NodeJS.ProcessEnv): string {
    return [
        resolveClaudeJsonlSessionStoreDetachedGraceMs(env),
        resolveClaudeJsonlSessionStoreColdIdleMs(env),
    ].join(':');
}

export function createClaudeJsonlSessionStoreRegistry<TStore extends FileBackedTranscriptSessionStore>(params: Readonly<{
    detachedGraceMs: number;
    coldIdleMs: number;
    createStore: FileBackedTranscriptSessionStoreFactory<TStore>;
}>): FileBackedTranscriptSessionRegistry<TStore> {
    return new FileBackedTranscriptSessionRegistry({
        detachedGraceMs: params.detachedGraceMs,
        coldIdleMs: params.coldIdleMs,
        createStore: params.createStore,
    });
}

function getRegistry(env: NodeJS.ProcessEnv): FileBackedTranscriptSessionRegistry<ClaudeJsonlSessionStore> {
    const cacheKey = buildCachePolicyKey(env);
    const existing = registriesByCachePolicyKey.get(cacheKey);
    if (existing) return existing;

    const registry = createClaudeJsonlSessionStoreRegistry({
        detachedGraceMs: resolveClaudeJsonlSessionStoreDetachedGraceMs(env),
        coldIdleMs: resolveClaudeJsonlSessionStoreColdIdleMs(env),
        createStore: async (key) => createClaudeJsonlSessionStore(key),
    });
    registriesByCachePolicyKey.set(cacheKey, registry);
    return registry;
}

export function clearClaudeJsonlSessionStoreRegistriesForTests(): void {
    registriesByCachePolicyKey.clear();
}

export async function acquireClaudeJsonlSessionStore<TStore extends FileBackedTranscriptSessionStore = ClaudeJsonlSessionStore>(params: Readonly<{
    env?: NodeJS.ProcessEnv;
    key: FileBackedTranscriptSessionStoreKey;
    registry?: FileBackedTranscriptSessionRegistry<TStore>;
}>): Promise<FileBackedTranscriptSessionLease<TStore>> {
    const env = params.env ?? process.env;
    const registry = (params.registry ?? getRegistry(env)) as FileBackedTranscriptSessionRegistry<TStore>;
    return registry.acquire(params.key);
}

export async function withClaudeJsonlSessionStore<TStore extends FileBackedTranscriptSessionStore = ClaudeJsonlSessionStore, TResult = unknown>(params: Readonly<{
    env?: NodeJS.ProcessEnv;
    key: FileBackedTranscriptSessionStoreKey;
    registry?: FileBackedTranscriptSessionRegistry<TStore>;
}>, handler: (store: TStore) => Promise<TResult>): Promise<TResult> {
    const lease = await acquireClaudeJsonlSessionStore(params);
    try {
        return await handler(lease.store);
    } finally {
        await lease.release();
    }
}
