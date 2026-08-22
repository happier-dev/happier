import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
    ensurePrivateOwnerDirectory,
    writePrivateOwnerFile,
} from '@/daemon/privateBearerFile';

import type {
    ManagedServiceCredentialFileOwner,
} from './managedServicesAdapter';

export function createManagedServiceCredentialFileOwner(
    input: Readonly<{ rootDir: string }>,
): ManagedServiceCredentialFileOwner {
    const rootDir = resolve(input.rootDir);
    return Object.freeze({
        async materialize({ files, retainCleanup }) {
            await ensurePrivateOwnerDirectory(rootDir);
            const leaseRoot = join(rootDir, randomUUID());
            await mkdir(leaseRoot, { mode: 0o700 });
            await ensurePrivateOwnerDirectory(leaseRoot);
            let disposed = false;
            let disposePromise: Promise<void> | null = null;
            const dispose = async (): Promise<void> => {
                if (disposed) return;
                if (disposePromise) return await disposePromise;
                const attempt = rm(leaseRoot, {
                    recursive: true,
                    force: true,
                });
                disposePromise = attempt;
                try {
                    await attempt;
                    disposed = true;
                } finally {
                    if (disposePromise === attempt) disposePromise = null;
                }
            };
            const pathsByFileId = Object.create(null) as Record<
                string,
                string
            >;
            try {
                retainCleanup(Object.freeze({ dispose }));
                for (const [fileId, contents] of Object.entries(files)) {
                    const path = join(
                        leaseRoot,
                        `${randomUUID()}.credential`,
                    );
                    await writePrivateOwnerFile({ path, contents });
                    pathsByFileId[fileId] = path;
                }
            } catch (error) {
                try {
                    await dispose();
                } catch (cleanupError) {
                    throw new AggregateError(
                        [error, cleanupError],
                        'Managed-service credential-file acquisition and cleanup failed',
                    );
                }
                throw error;
            }
            return Object.freeze({
                pathsByFileId: Object.freeze(pathsByFileId),
                dispose,
            });
        },
    });
}
