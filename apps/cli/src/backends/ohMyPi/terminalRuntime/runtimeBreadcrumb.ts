import { readFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';

import { canonicalizeDirectSessionsPath } from '@/session/external/sourceValidation';
import { getTerminalId } from '@/agent/terminalRuntime/providers/getTerminalId';

import { resolveConfiguredOhMyPiAgentDir } from '../session/external/resolveOhMyPiAgentDir';

export type ResolveOhMyPiTerminalRuntimeBreadcrumbParams = Readonly<{
    cwd: string;
    env?: NodeJS.ProcessEnv;
    terminalId?: string | null;
}>;

export type OhMyPiTerminalRuntimeBreadcrumb = Readonly<{
    agentDir: string;
    breadcrumbCwd: string;
    sessionFilePath: string;
    remoteSessionId: string;
    env: NodeJS.ProcessEnv;
}>;

function isPathInside(parentPath: string, childPath: string): boolean {
    const relativePath = relative(resolve(parentPath), resolve(childPath));
    return relativePath === '' || (!relativePath.startsWith('..') && !relativePath.includes('..\\'));
}

function parseRemoteSessionIdFromSessionFile(sessionFilePath: string): string | null {
    const fileName = basename(sessionFilePath);
    if (!fileName.endsWith('.jsonl')) {
        return null;
    }

    const stem = fileName.slice(0, -'.jsonl'.length);
    const separatorIndex = stem.indexOf('_');
    if (separatorIndex === -1 || separatorIndex === stem.length - 1) {
        return null;
    }

    const remoteSessionId = stem.slice(separatorIndex + 1).trim();
    return remoteSessionId.length > 0 ? remoteSessionId : null;
}

function canonicalizePotentiallyMissingFilePath(rawPath: string): string {
    const resolvedPath = resolve(rawPath);
    const canonicalDirectory = canonicalizeDirectSessionsPath(dirname(resolvedPath));
    return join(canonicalDirectory, basename(resolvedPath));
}

export function runtimeBreadcrumb(
    params: ResolveOhMyPiTerminalRuntimeBreadcrumbParams,
): OhMyPiTerminalRuntimeBreadcrumb | undefined {
    const env = params.env ?? process.env;
    const terminalId = params.terminalId ?? getTerminalId({ env });
    if (!terminalId) {
        return undefined;
    }

    const agentDir = resolveConfiguredOhMyPiAgentDir(env);
    const breadcrumbFile = join(agentDir, 'terminal-sessions', terminalId);

    let breadcrumbContent: string;
    try {
        breadcrumbContent = readFileSync(breadcrumbFile, 'utf8');
    } catch {
        return undefined;
    }

    const [breadcrumbCwdRaw, sessionFileRaw] = breadcrumbContent
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

    if (!breadcrumbCwdRaw || !sessionFileRaw) {
        return undefined;
    }

    if (resolve(breadcrumbCwdRaw) !== resolve(params.cwd)) {
        return undefined;
    }

    const sessionsRoot = join(agentDir, 'sessions');
    const sessionFilePath = canonicalizePotentiallyMissingFilePath(sessionFileRaw);
    if (!isPathInside(sessionsRoot, sessionFilePath)) {
        return undefined;
    }

    const remoteSessionId = parseRemoteSessionIdFromSessionFile(sessionFilePath);
    if (!remoteSessionId) {
        return undefined;
    }

    return {
        agentDir,
        breadcrumbCwd: resolve(breadcrumbCwdRaw),
        sessionFilePath,
        remoteSessionId,
        env,
    };
}
