import type { FileBackedTranscriptSessionLease, FileBackedTranscriptSessionStore } from '../../../../api/session/fileBackedTranscripts/store';
import { FileBackedTranscriptSessionRegistry } from '../../../../api/session/fileBackedTranscripts/store';

import type { ExternalSessionTranscriptRawMessageV1 } from '@happier-dev/protocol';
import { resolveCodexRolloutSessionStoreColdIdleMs, resolveCodexRolloutSessionStoreDetachedGraceMs } from '@happier-dev/plugins-codex/agent/rollout/session/cachePolicy';
import { createCodexRolloutSessionStore } from './createCodexRolloutSessionStore';
import type { CodexRolloutSessionStoreOptions } from './codexRolloutSessionStoreTypes';

type CodexRolloutTranscriptSessionStore = FileBackedTranscriptSessionStore<ExternalSessionTranscriptRawMessageV1, unknown, string | null>;

const registriesByActiveServerDir = new Map<string, FileBackedTranscriptSessionRegistry<CodexRolloutTranscriptSessionStore>>();

function getRegistry(activeServerDir: string, env: NodeJS.ProcessEnv): FileBackedTranscriptSessionRegistry<CodexRolloutTranscriptSessionStore> {
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
    hotAttach?: boolean;
    key: CodexRolloutSessionStoreOptions['key'];
}>): Promise<FileBackedTranscriptSessionLease<CodexRolloutTranscriptSessionStore>> {
    const env = params.env ?? process.env;
    return getRegistry(params.activeServerDir, env).acquire(params.key, {
        hotAttach: params.hotAttach !== false,
    });
}

export async function withCodexRolloutSessionStore<T>(params: Readonly<{
    activeServerDir: string;
    env?: NodeJS.ProcessEnv;
    key: CodexRolloutSessionStoreOptions['key'];
}>, handler: (store: CodexRolloutTranscriptSessionStore) => Promise<T>): Promise<T> {
    const lease = await acquireCodexRolloutSessionStore({
        ...params,
        hotAttach: false,
    });
    try {
        return await handler(lease.store);
    } finally {
        await lease.release();
    }
}
