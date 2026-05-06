import { join, relative, resolve } from 'node:path';

import type { LocalHostedDirectTranscriptBinding } from '@/agent/terminalRuntime/directTranscriptBinding';

import { inferCodexDirectSessionsSourceFromHome } from '../externalSessions/homeEntries';
import { parseCodexRolloutSessionIdFromFilename } from '../rollout/discovery/parseCodexRolloutSessionIdFromFilename';

function isPathInside(parentPath: string, childPath: string): boolean {
    const relativePath = relative(resolve(parentPath), resolve(childPath));
    return relativePath === '' || (!relativePath.startsWith('..') && !relativePath.includes('..\\'));
}

export function resolveCodexTerminalRuntimeTranscriptBinding(params: Readonly<{
    activeServerDir: string;
    candidateFilePath: string;
    codexHome: string | null;
    remoteSessionId: string | null;
    sessionMetaId: string | null;
}>): LocalHostedDirectTranscriptBinding | undefined {
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
    const matchesSessionIdentity = parseCodexRolloutSessionIdFromFilename(candidateFilePath) === remoteSessionId
        || sessionMetaId === remoteSessionId;
    if (!matchesSessionIdentity) {
        return undefined;
    }

    return {
        providerId: 'codex',
        source: inferCodexDirectSessionsSourceFromHome({
            codexHome,
            activeServerDir: params.activeServerDir,
        }),
        remoteSessionId,
        env: process.env,
    };
}
