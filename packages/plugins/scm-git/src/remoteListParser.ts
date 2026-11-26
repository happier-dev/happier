import type { ScmRemoteInfo } from '@happier-dev/plugin-sdk/scm';

const GIT_REMOTE_VERBOSE_LINE = /^(\S+)\s+(.+?)\s+\((fetch|push)\)$/;

/** Redact only a URL password; keep address bytes and password-free/scp-style remotes intact. */
export function redactGitRemotePasswords(text: string): string {
    return text.replace(/([a-z][a-z0-9+.-]*:\/\/[^\s/:@]*:)[^\s/]+@/gi, '$1***@');
}

export function parseGitRemoteVerbose(output: string,
    projectUrl: (url: string) => string = redactGitRemotePasswords): ScmRemoteInfo[] {
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
            remote.fetchUrl = projectUrl(url);
        } else if (kind === 'push') {
            remote.pushUrl = projectUrl(url);
        }
        remotesByName.set(name, remote);
    }

    return Array.from(remotesByName.values());
}
