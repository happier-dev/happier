import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { withExclusiveFileLock } from '@happier-dev/plugin-sdk/fs';

import {
    ensurePrivateOwnerDirectory,
    writePrivateOwnerFile,
} from '@/daemon/privateBearerFile';
import { writeProtectedLocalStateFileAtomic } from '@/utils/fs/protectedLocalState';

import type {
    ManagedServiceCredentialFileOwner,
} from './managedServicesAdapter';

export function createManagedServiceCredentialFileOwner(
    input: Readonly<{ rootDir: string }>,
): ManagedServiceCredentialFileOwner {
    const rootDir = resolve(input.rootDir);
    return Object.freeze({
        async withMaterializedFiles({ scope, files, relativePathsByFileId, signal, deferCleanupFailure, retainCleanup }, effect) {
            await ensurePrivateOwnerDirectory(rootDir);
            const pluginRoot = resolve(rootDir, scope.pluginId);
            if (dirname(pluginRoot) !== rootDir) throw new Error('private_credential_path_unsafe');
            await ensurePrivateOwnerDirectory(pluginRoot);
            const pathsByFileId: Record<string, string> = Object.create(null);
            let deliveryRoot: string | null = null;
            const fileIds = Object.keys(typeof files === 'function' ? relativePathsByFileId : files);
            for (const fileId of fileIds) {
                const spelling = relativePathsByFileId[fileId];
                if (!spelling || isAbsolute(spelling)) throw new Error('private_credential_path_unsafe');
                const path = resolve(pluginRoot, spelling.replaceAll('\\', '/'));
                const confined = relative(pluginRoot, path);
                if (!confined || confined === '..' || confined.startsWith(`..${sep}`) || isAbsolute(confined)) {
                    throw new Error('private_credential_path_unsafe');
                }
                if (deliveryRoot && deliveryRoot !== dirname(path)) throw new Error('private_credential_path_unsafe');
                deliveryRoot = dirname(path);
                pathsByFileId[fileId] = path;
            }
            if (!deliveryRoot || new Set(Object.values(pathsByFileId)).size !== fileIds.length) {
                throw new Error('private_credential_path_unsafe');
            }
            // Walk every owned component through the cross-platform protection
            // owner before the lock or files can follow an existing symlink.
            let parent = pluginRoot;
            for (const component of relative(pluginRoot, deliveryRoot).split(sep).filter(Boolean)) {
                parent = join(parent, component);
                await ensurePrivateOwnerDirectory(parent);
            }
            const lockOptions = { lockPath: join(deliveryRoot, '.credential-delivery.lock'),
                // The containing invocation's signal owns its operation budget.
                // The existing generic owner supports Infinity; no phase cutoff.
                timeoutMs: Infinity, signal,
            };
            return await withExclusiveFileLock(lockOptions, async () => {
                const published: string[] = [];
                let disposed = false;
                let disposal: Promise<void> | null = null;
                let lockHeld = true;
                const disposeLocked = async (): Promise<void> => {
                    if (disposed) return;
                    if (disposal) return await disposal;
                    const attempt = Promise.all(published.map(path => rm(path, { force: true }))).then(() => undefined);
                    disposal = attempt;
                    try { await attempt; disposed = true; }
                    finally { if (disposal === attempt) disposal = null; }
                };
                const dispose = async (): Promise<void> => {
                    if (disposed) return;
                    if (lockHeld) return await disposeLocked();
                    // A retained retry must join the same exclusion owner,
                    // since another invocation may now be reading this path.
                    await withExclusiveFileLock({ ...lockOptions, signal: undefined }, disposeLocked);
                };
                const lease = Object.freeze({ pathsByFileId: Object.freeze(pathsByFileId), dispose });
                retainCleanup(lease);
                let effectSucceeded = false;
                try {
                    const selectedFiles = typeof files === 'function' ? await files() : files;
                    const selectedIds = Object.keys(selectedFiles);
                    if (selectedIds.length !== fileIds.length || selectedIds.some(id => !Object.hasOwn(pathsByFileId, id))) {
                        throw new Error('private_credential_path_unsafe');
                    }
                    for (const [fileId, contents] of Object.entries(selectedFiles)) {
                        const path = pathsByFileId[fileId]!;
                        await writeProtectedLocalStateFileAtomic(path, contents, { authority: 'owned' });
                        published.push(path);
                    }
                    const result = await effect(lease);
                    effectSucceeded = true;
                    return result;
                } finally {
                    // Never recursively remove the native state root: claims,
                    // tombstones and known-host facts have native lifetimes.
                    try { await disposeLocked(); }
                    catch (error) {
                        // Let acquisition's result reach the existing validator
                        // before invocation completion retries and reports the
                        // retained cleanup failure through that same owner.
                        if (!effectSucceeded || !deferCleanupFailure) throw error;
                    } finally { lockHeld = false; }
                }
            });
        },
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
