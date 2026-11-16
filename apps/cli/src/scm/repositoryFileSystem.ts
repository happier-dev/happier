import { randomUUID } from 'node:crypto';
import { mkdtemp, open } from 'node:fs/promises';
import type { BackendRuntimeServices } from '@happier-dev/plugin-sdk/scm/backend';
import { currentWorkspaceSource } from '@/workspaces/source/workspaceSource';

/** Clone preparation and Git use the same admitted source, including guest paths. */
export function createScmRepositoryFileSystem(): NonNullable<BackendRuntimeServices['repositoryFileSystem']> {
    const source = currentWorkspaceSource();
    return {
        lstat: path => source.lstat(path),
        realpath: path => source.realpath(path),
        rm: (path, options) => source.rm(path, options),
        ...(source.kind === 'local' ? { openDirectory: (path: string) => open(path, 'r') } : {}),
        mkdir: (path, options) => source.mkdir(path, options),
        async mkdtemp(prefix) {
            if (source.kind === 'local') return mkdtemp(prefix);
            const path = `${prefix}${randomUUID()}`;
            await source.mkdir(path, { mode: 0o700 });
            return path;
        },
        readdir: async path => (await source.readdir(path)).map(entry => entry.name),
        rename: (from, to) => source.rename(from, to),
        rmdir: path => source.rmdir(path),
        unlink: path => source.rm(path),
        async writeExclusiveFile(path, contents) {
            const stream = source.openWrite(path, { mode: 0o600 });
            await stream.write(Buffer.from(contents));
            await stream.close();
        },
    };
}
