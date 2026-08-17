import type { ScmRemoteInfo } from '@happier-dev/plugin-sdk/scm';

const SAPLING_PATH_LINE = /^([^=\s][^=]*?)\s*=\s*(.+)$/;
const PUSH_PATH_SUFFIX = '-push';

export function parseSaplingPaths(output: string): ScmRemoteInfo[] {
    const remotesByName = new Map<string, ScmRemoteInfo>();

    for (const rawLine of output.split(/\r?\n/g)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;

        const match = SAPLING_PATH_LINE.exec(line);
        if (!match) continue;

        const rawName = match[1]?.trim() ?? '';
        const url = match[2]?.trim() ?? '';
        if (!rawName || !url) continue;

        if (rawName.endsWith(PUSH_PATH_SUFFIX)) {
            const name = rawName.slice(0, -PUSH_PATH_SUFFIX.length);
            if (!name) continue;
            const remote = remotesByName.get(name) ?? { name };
            remote.pushUrl = url;
            remotesByName.set(name, remote);
            continue;
        }

        const remote = remotesByName.get(rawName) ?? { name: rawName };
        remote.fetchUrl = url;
        remotesByName.set(rawName, remote);
    }

    return Array.from(remotesByName.values());
}
