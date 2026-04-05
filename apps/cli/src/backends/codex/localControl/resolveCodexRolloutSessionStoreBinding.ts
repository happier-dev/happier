import { join, relative, resolve } from 'node:path';

import type { DirectSessionsSource } from '@happier-dev/protocol';

import { inferCodexDirectSessionsSourceFromHome } from '../directSessions/resolveCodexHomeEntriesForDirectSessionsSource';

type CodexRolloutSessionStoreBinding = Readonly<{
    activeServerDir: string;
    source: DirectSessionsSource;
    remoteSessionId: string;
    env: NodeJS.ProcessEnv;
}>;

function isPathInside(parentPath: string, childPath: string): boolean {
    const relativePath = relative(resolve(parentPath), resolve(childPath));
    return relativePath === '' || (!relativePath.startsWith('..') && !relativePath.includes('..\\'));
}

export function resolveCodexRolloutSessionStoreBinding(params: Readonly<{
    activeServerDir: string;
    candidateFilePath: string;
    codexHome: string | null;
    remoteSessionId: string | null;
    sessionMetaId: string | null;
}>): CodexRolloutSessionStoreBinding | undefined {
    const remoteSessionId = typeof params.remoteSessionId === 'string' && params.remoteSessionId.trim().length > 0
        ? params.remoteSessionId.trim()
        : null;
    const codexHome = typeof params.codexHome === 'string' && params.codexHome.trim().length > 0
        ? params.codexHome.trim()
        : null;
    if (!remoteSessionId || !codexHome) {
        return undefined;
    }

    const candidateFilePath = resolve(params.candidateFilePath);
    const canonicalSessionsRoot = join(resolve(codexHome), 'sessions');
    if (!isPathInside(canonicalSessionsRoot, candidateFilePath)) {
        return undefined;
    }

    const sessionMetaId = typeof params.sessionMetaId === 'string' && params.sessionMetaId.trim().length > 0
        ? params.sessionMetaId.trim()
        : null;
    const matchesSessionIdentity = candidateFilePath.includes(remoteSessionId)
        || sessionMetaId === remoteSessionId;
    if (!matchesSessionIdentity) {
        return undefined;
    }

    return {
        activeServerDir: params.activeServerDir,
        source: inferCodexDirectSessionsSourceFromHome({
            codexHome,
            activeServerDir: params.activeServerDir,
        }),
        remoteSessionId,
        env: process.env,
    };
}
