import { constants } from 'node:fs';
import { access, copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, rmdir, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { readCurrentBackendRuntimeServices, type BackendRuntimeServices } from '@happier-dev/plugin-sdk/scm/backend';

type RepositoryFileSystem = NonNullable<BackendRuntimeServices['repositoryFileSystem']>;
const standaloneFileSystem: RepositoryFileSystem = {
    lstat, realpath, mkdir, mkdtemp, readdir, rename, rm, rmdir, unlink, readFile, writeFile, stat,
    filePublication: {
        async copyFileExclusive(from, to) {
            const { atime, mtime } = await stat(from);
            await copyFile(from, to, constants.COPYFILE_EXCL);
            return { atime, mtime };
        },
        setFileTimes: utimes,
        accessExecutable: path => access(path, constants.X_OK),
        async openExclusiveFile(path) {
            const handle = await open(path, 'wx');
            try {
                const { mode } = await handle.stat();
                return {
                    mode,
                    async writeFrom(sourcePath, mode) {
                        if (mode !== undefined) await handle.chmod(mode);
                        await handle.writeFile(await readFile(sourcePath));
                        await handle.sync();
                    },
                    close: () => handle.close(),
                };
            } catch (error) {
                await handle.close();
                await unlink(path);
                throw error;
            }
        },
    },
    openDirectory: path => open(path, 'r'),
    writeExclusiveFile: (path, contents) => writeFile(path, contents, { flag: 'wx', mode: 0o600 }),
};

/** A host-bound backend never substitutes the plugin process's disk for its admitted source. */
export function readRepositoryFileSystem(): RepositoryFileSystem {
    const services = readCurrentBackendRuntimeServices();
    if (!services) return standaloneFileSystem;
    if (!services.repositoryFileSystem) throw Object.assign(new Error('SCM workspace filesystem is unavailable'), {
        code: 'BACKEND_UNAVAILABLE',
    });
    return services.repositoryFileSystem;
}
