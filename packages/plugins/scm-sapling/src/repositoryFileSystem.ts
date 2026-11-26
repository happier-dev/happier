import { rm, stat } from 'node:fs/promises';
import { readCurrentBackendRuntimeServices, type BackendRuntimeServices } from '@happier-dev/plugin-sdk/scm/backend';

type SaplingRepositoryFileSystem = Pick<
    NonNullable<BackendRuntimeServices['repositoryFileSystem']>,
    'stat' | 'rm' | 'commandPaths'
>;

const standaloneFileSystem: SaplingRepositoryFileSystem = {
    stat,
    rm,
};

/** A host-bound backend never substitutes the plugin process's disk for its admitted source. */
export function readRepositoryFileSystem(): SaplingRepositoryFileSystem {
    const services = readCurrentBackendRuntimeServices();
    if (!services) return standaloneFileSystem;
    if (!services.repositoryFileSystem) {
        throw Object.assign(new Error('SCM workspace filesystem is unavailable'), {
            code: 'BACKEND_UNAVAILABLE',
        });
    }
    return services.repositoryFileSystem;
}
