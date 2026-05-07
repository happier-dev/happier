import type { ScmRemoteInfo } from '@happier-dev/protocol';

const GIT_REMOTE_VERBOSE_LINE = /^(\S+)\s+(.+?)\s+\((fetch|push)\)$/;

export function parseGitRemoteVerbose(output: string): ScmRemoteInfo[] {
    const remotesByName = new Map<string, ScmRemoteInfo>();

    for (const line of output.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        const match = GIT_REMOTE_VERBOSE_LINE.exec(trimmed);
        if (!match) continue;

        const name = match[1]?.trim() ?? '';
        const url = match[2]?.trim() ?? '';
        const kind = match[3];
        if (!name || !url) continue;

        const remote = remotesByName.get(name) ?? { name };
        if (kind === 'fetch') {
            remote.fetchUrl = url;
        } else if (kind === 'push') {
            remote.pushUrl = url;
        }
        remotesByName.set(name, remote);
    }

    return Array.from(remotesByName.values());
}
