import type {
  FileBackedTranscriptSessionLease,
  FileBackedTranscriptSessionStore,
  FileBackedTranscriptSessionStoreKey,
} from '@/api/session/fileBackedTranscripts/store';
import { FileBackedTranscriptSessionRegistry } from '@/api/session/fileBackedTranscripts/store';

import { createOhMyPiJsonlSessionStore } from './createOhMyPiJsonlSessionStore';

export type OhMyPiJsonlSessionStore = ReturnType<typeof createOhMyPiJsonlSessionStore>;

const registriesByCachePolicyKey = new Map<string, FileBackedTranscriptSessionRegistry<OhMyPiJsonlSessionStore>>();

function resolveDetachedGraceMs(env: NodeJS.ProcessEnv): number {
  const raw = Number.parseInt(String(env.HAPPIER_EXTERNAL_SESSIONS_OH_MY_PI_DETACHED_GRACE_MS ?? ''), 10);
  const configured = Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : 10_000;
  return Math.max(0, Math.min(10 * 60_000, configured));
}

function resolveColdIdleMs(env: NodeJS.ProcessEnv): number {
  const raw = Number.parseInt(String(env.HAPPIER_EXTERNAL_SESSIONS_OH_MY_PI_COLD_IDLE_MS ?? ''), 10);
  const configured = Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : 60_000;
  return Math.max(0, Math.min(60 * 60_000, configured));
}

function buildCachePolicyKey(env: NodeJS.ProcessEnv): string {
  return `${resolveDetachedGraceMs(env)}:${resolveColdIdleMs(env)}`;
}

function getRegistry(env: NodeJS.ProcessEnv): FileBackedTranscriptSessionRegistry<OhMyPiJsonlSessionStore> {
  const cacheKey = buildCachePolicyKey(env);
  const existing = registriesByCachePolicyKey.get(cacheKey);
  if (existing) return existing;

  const registry = new FileBackedTranscriptSessionRegistry({
    detachedGraceMs: resolveDetachedGraceMs(env),
    coldIdleMs: resolveColdIdleMs(env),
    createStore: async (key) => createOhMyPiJsonlSessionStore(key),
  });
  registriesByCachePolicyKey.set(cacheKey, registry);
  return registry;
}

export function clearOhMyPiJsonlSessionStoreRegistriesForTests(): void {
  registriesByCachePolicyKey.clear();
}

export async function acquireOhMyPiJsonlSessionStore<TStore extends FileBackedTranscriptSessionStore = OhMyPiJsonlSessionStore>(params: Readonly<{
  env?: NodeJS.ProcessEnv;
  key: FileBackedTranscriptSessionStoreKey;
  registry?: FileBackedTranscriptSessionRegistry<TStore>;
}>): Promise<FileBackedTranscriptSessionLease<TStore>> {
  const env = params.env ?? process.env;
  const registry = (params.registry ?? getRegistry(env)) as FileBackedTranscriptSessionRegistry<TStore>;
  return registry.acquire(params.key);
}

export async function withOhMyPiJsonlSessionStore<TStore extends FileBackedTranscriptSessionStore = OhMyPiJsonlSessionStore, TResult = unknown>(params: Readonly<{
  env?: NodeJS.ProcessEnv;
  key: FileBackedTranscriptSessionStoreKey;
  registry?: FileBackedTranscriptSessionRegistry<TStore>;
}>, handler: (store: TStore) => Promise<TResult>): Promise<TResult> {
  const lease = await acquireOhMyPiJsonlSessionStore(params);
  try {
    return await handler(lease.store);
  } finally {
    await lease.release();
  }
}
