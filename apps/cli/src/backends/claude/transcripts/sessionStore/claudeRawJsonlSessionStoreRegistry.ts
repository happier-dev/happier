import type {
    FileBackedTranscriptSessionLease,
    FileBackedTranscriptSessionStore,
    FileBackedTranscriptSessionStoreFactory,
    FileBackedTranscriptSessionStoreKey,
} from '@/api/session/fileBackedTranscripts/store';
import { FileBackedTranscriptSessionRegistry } from '@/api/session/fileBackedTranscripts/store';

import {
    resolveClaudeJsonlSessionStoreColdIdleMs,
    resolveClaudeJsonlSessionStoreDetachedGraceMs,
} from './claudeJsonlSessionStoreCachePolicy';
import { createClaudeRawJsonlSessionStore } from './createClaudeRawJsonlSessionStore';

export type ClaudeRawJsonlSessionStore = ReturnType<typeof createClaudeRawJsonlSessionStore>;

const registriesByCachePolicyKey = new Map<string, FileBackedTranscriptSessionRegistry<ClaudeRawJsonlSessionStore>>();

function buildCachePolicyKey(env: NodeJS.ProcessEnv): string {
    return [
        resolveClaudeJsonlSessionStoreDetachedGraceMs(env),
        resolveClaudeJsonlSessionStoreColdIdleMs(env),
    ].join(':');
}

export function createClaudeRawJsonlSessionStoreRegistry<TStore extends FileBackedTranscriptSessionStore>(params: Readonly<{
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

function getRegistry(env: NodeJS.ProcessEnv): FileBackedTranscriptSessionRegistry<ClaudeRawJsonlSessionStore> {
    const cacheKey = buildCachePolicyKey(env);
    const existing = registriesByCachePolicyKey.get(cacheKey);
    if (existing) return existing;

    const registry = createClaudeRawJsonlSessionStoreRegistry({
        detachedGraceMs: resolveClaudeJsonlSessionStoreDetachedGraceMs(env),
        coldIdleMs: resolveClaudeJsonlSessionStoreColdIdleMs(env),
        createStore: async (key) => createClaudeRawJsonlSessionStore(key),
    });
    registriesByCachePolicyKey.set(cacheKey, registry);
    return registry;
}

export function clearClaudeRawJsonlSessionStoreRegistriesForTests(): void {
    registriesByCachePolicyKey.clear();
}

export async function acquireClaudeRawJsonlSessionStore<TStore extends FileBackedTranscriptSessionStore = ClaudeRawJsonlSessionStore>(params: Readonly<{
    env?: NodeJS.ProcessEnv;
    key: FileBackedTranscriptSessionStoreKey;
    registry?: FileBackedTranscriptSessionRegistry<TStore>;
}>): Promise<FileBackedTranscriptSessionLease<TStore>> {
    const env = params.env ?? process.env;
    const registry = (params.registry ?? getRegistry(env)) as FileBackedTranscriptSessionRegistry<TStore>;
    return registry.acquire(params.key);
}
