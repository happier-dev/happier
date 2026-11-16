import { lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { readCurrentBackendRuntimeServices, type BackendRuntimeServices } from '@happier-dev/plugin-sdk/scm/backend';

type RepositoryFileSystem = NonNullable<BackendRuntimeServices['repositoryFileSystem']>;
const standaloneFileSystem: RepositoryFileSystem = {
    lstat, realpath, mkdir, mkdtemp, readdir, rename, rm, rmdir, unlink,
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
