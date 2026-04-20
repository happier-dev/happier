import type { FileBackedTranscriptSessionLease, FileBackedTranscriptSessionStore } from '../../../../api/session/fileBackedTranscripts/store';
import { FileBackedTranscriptSessionRegistry } from '../../../../api/session/fileBackedTranscripts/store';

import { resolveCodexRolloutSessionStoreColdIdleMs, resolveCodexRolloutSessionStoreDetachedGraceMs } from './codexRolloutSessionStoreCachePolicy';
import { createCodexRolloutSessionStore } from './createCodexRolloutSessionStore';
import type { CodexRolloutSessionStoreOptions } from './codexRolloutSessionStoreTypes';

const registriesByActiveServerDir = new Map<string, FileBackedTranscriptSessionRegistry<FileBackedTranscriptSessionStore>>();

function getRegistry(activeServerDir: string, env: NodeJS.ProcessEnv): FileBackedTranscriptSessionRegistry<FileBackedTranscriptSessionStore> {
    const existing = registriesByActiveServerDir.get(activeServerDir);
    if (existing) return existing;

    const registry = new FileBackedTranscriptSessionRegistry({
        detachedGraceMs: resolveCodexRolloutSessionStoreDetachedGraceMs(env),
        coldIdleMs: resolveCodexRolloutSessionStoreColdIdleMs(env),
        createStore: async (key) => createCodexRolloutSessionStore({
            key: {
                providerId: 'codex',
                source: key.source,
                remoteSessionId: key.remoteSessionId,
            },
            activeServerDir,
            env,
        }),
    });
    registriesByActiveServerDir.set(activeServerDir, registry);
    return registry;
}

export async function acquireCodexRolloutSessionStore(params: Readonly<{
    activeServerDir: string;
    env?: NodeJS.ProcessEnv;
    key: CodexRolloutSessionStoreOptions['key'];
}>): Promise<FileBackedTranscriptSessionLease<FileBackedTranscriptSessionStore>> {
    const env = params.env ?? process.env;
    return getRegistry(params.activeServerDir, env).acquire(params.key);
}

export async function withCodexRolloutSessionStore<T>(params: Readonly<{
    activeServerDir: string;
    env?: NodeJS.ProcessEnv;
    key: CodexRolloutSessionStoreOptions['key'];
}>, handler: (store: FileBackedTranscriptSessionStore) => Promise<T>): Promise<T> {
    const lease = await acquireCodexRolloutSessionStore(params);
    try {
        return await handler(lease.store);
    } finally {
        await lease.release();
    }
}
