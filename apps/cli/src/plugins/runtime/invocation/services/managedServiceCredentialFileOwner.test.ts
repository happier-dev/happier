import {
    chmod,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rm,
    stat,
    symlink,
} from 'node:fs/promises';
import { chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createManagedServiceCredentialFileOwner } from './managedServiceCredentialFileOwner';

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'happier-managed-service-files-'));
    tempDirs.push(dir);
    return dir;
}

afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map(async (dir) => {
        await rm(dir, { recursive: true, force: true });
    }));
});

describe('managed-service credential-file owner', () => {
    it('writes exact bytes to generated private paths and removes only the lease directory', async () => {
        const root = await createTempDir();
        const ownerRoot = join(root, 'managed-service-credentials');
        const owner = createManagedServiceCredentialFileOwner({
            rootDir: ownerRoot,
        });
        const files: Readonly<Record<string, Uint8Array>> = Object.freeze({
            '../../upstream-key': new Uint8Array([0x00, 0xff, 0x41]),
            'nested/account.json': new Uint8Array([0x7b, 0x7d, 0x0a]),
        });

        const lease = await owner.materialize({
            scope: Object.freeze({
                generation: 'provider-p',
                pluginId: 'acme.provider',
                contributionQualifiedId: 'acme.provider/providers/gateway',
                sessionId: 'session-one',
            }),
            files,
            retainCleanup() {},
        });

        expect(Object.keys(lease.pathsByFileId)).toEqual(Object.keys(files));
        const materializedPaths = Object.values(lease.pathsByFileId);
        expect(new Set(materializedPaths.map(dirname))).toHaveLength(1);
        for (const [fileId, path] of Object.entries(lease.pathsByFileId)) {
            const confined = relative(resolve(ownerRoot), resolve(path));
            expect(
                confined === '..'
                || confined.startsWith(`..${sep}`)
                || isAbsolute(confined),
            ).toBe(false);
            expect(basename(path)).not.toContain(fileId);
            await expect(readFile(path)).resolves.toEqual(Buffer.from(files[fileId]!));
            if (process.platform !== 'win32') {
                expect((await stat(path)).mode & 0o777).toBe(0o600);
            }
        }
        const leaseRoot = dirname(materializedPaths[0]!);
        if (process.platform !== 'win32') {
            expect((await stat(ownerRoot)).mode & 0o777).toBe(0o700);
            expect((await stat(leaseRoot)).mode & 0o777).toBe(0o700);
        }

        await lease.dispose();
        await lease.dispose();

        await expect(stat(leaseRoot)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(stat(ownerRoot)).resolves.toMatchObject({});
    });

    it.runIf(process.platform !== 'win32')(
        'rejects a symlinked owner root before writing credential bytes',
        async () => {
            const root = await createTempDir();
            const actualRoot = join(root, 'actual-credentials');
            const linkedRoot = join(root, 'linked-credentials');
            await mkdir(actualRoot, { mode: 0o700 });
            await symlink(actualRoot, linkedRoot, 'dir');
            const owner = createManagedServiceCredentialFileOwner({
                rootDir: linkedRoot,
            });

            await expect(owner.materialize({
                scope: Object.freeze({
                    generation: 'provider-p',
                    pluginId: 'acme.provider',
                    contributionQualifiedId:
                        'acme.provider/providers/gateway',
                }),
                files: Object.freeze({
                    credential: new Uint8Array([0x01]),
                }),
                retainCleanup() {},
            })).rejects.toThrow();

            await expect(readdir(actualRoot)).resolves.toEqual([]);
        },
    );

    it('removes already-written files when a later credential write fails', async () => {
        const root = await createTempDir();
        const ownerRoot = join(root, 'managed-service-credentials');
        const owner = createManagedServiceCredentialFileOwner({
            rootDir: ownerRoot,
        });
        const rejectedByNodeFileBoundary = new Proxy(
            new Uint8Array([0x02]),
            {},
        );

        await expect(owner.materialize({
            scope: Object.freeze({
                generation: 'provider-p',
                pluginId: 'acme.provider',
                contributionQualifiedId: 'acme.provider/providers/gateway',
            }),
            files: {
                first: new Uint8Array([0x01]),
                second: rejectedByNodeFileBoundary,
            },
            retainCleanup() {},
        })).rejects.toThrow();

        await expect(readdir(ownerRoot)).resolves.toEqual([]);
    });

    it.runIf(process.platform !== 'win32')(
        'exposes retryable cleanup custody when a later write and local rollback both fail',
        async () => {
            const root = await createTempDir();
            const ownerRoot = join(root, 'managed-service-credentials');
            const owner = createManagedServiceCredentialFileOwner({
                rootDir: ownerRoot,
            });
            const rejectedByNodeFileBoundary = new Proxy(
                new Uint8Array([0x02]),
                {},
            );
            const custody: {
                cleanup?: Readonly<{
                    dispose(): void | Promise<void>;
                }>;
            } = {};

            await expect(owner.materialize({
                scope: Object.freeze({
                    generation: 'provider-p',
                    pluginId: 'acme.provider',
                    contributionQualifiedId:
                        'acme.provider/providers/gateway',
                }),
                files: {
                    first: new Uint8Array([0x01]),
                    second: rejectedByNodeFileBoundary,
                },
                retainCleanup(cleanup) {
                    custody.cleanup = cleanup;
                    chmodSync(ownerRoot, 0o500);
                },
            })).rejects.toBeInstanceOf(AggregateError);

            await chmod(ownerRoot, 0o700);
            const cleanup = custody.cleanup;
            if (!cleanup) throw new Error('cleanup custody was not retained');
            await expect(cleanup.dispose()).resolves.toBeUndefined();
            await expect(readdir(ownerRoot)).resolves.toEqual([]);
        },
    );

    it('preserves prototype-like file ids only as mapping keys', async () => {
        const root = await createTempDir();
        const owner = createManagedServiceCredentialFileOwner({
            rootDir: join(root, 'managed-service-credentials'),
        });
        const files = Object.create(null) as Record<string, Uint8Array>;
        Object.defineProperty(files, '__proto__', {
            value: new Uint8Array([0x01]),
            enumerable: true,
        });

        const lease = await owner.materialize({
            scope: Object.freeze({
                generation: 'provider-p',
                pluginId: 'acme.provider',
                contributionQualifiedId: 'acme.provider/providers/gateway',
            }),
            files,
            retainCleanup() {},
        });

        expect(Object.keys(lease.pathsByFileId)).toEqual(['__proto__']);
        expect(basename(lease.pathsByFileId.__proto__!))
            .not.toContain('__proto__');
        await expect(readFile(lease.pathsByFileId.__proto__!))
            .resolves.toEqual(Buffer.from([0x01]));
        await lease.dispose();
    });

    it.runIf(process.platform !== 'win32')(
        'retries lease cleanup after a transient directory-removal failure',
        async () => {
            const root = await createTempDir();
            const ownerRoot = join(root, 'managed-service-credentials');
            const owner = createManagedServiceCredentialFileOwner({
                rootDir: ownerRoot,
            });
            const lease = await owner.materialize({
                scope: Object.freeze({
                    generation: 'provider-p',
                    pluginId: 'acme.provider',
                    contributionQualifiedId:
                        'acme.provider/providers/gateway',
                }),
                files: Object.freeze({
                    credential: new Uint8Array([0x01]),
                }),
                retainCleanup() {},
            });
            const leaseRoot = dirname(
                lease.pathsByFileId.credential!,
            );

            await chmod(ownerRoot, 0o500);
            await expect(lease.dispose()).rejects.toMatchObject({
                code: expect.stringMatching(/^(?:EACCES|EPERM)$/u),
            });
            await chmod(ownerRoot, 0o700);

            await expect(lease.dispose()).resolves.toBeUndefined();
            await expect(stat(leaseRoot)).rejects.toMatchObject({
                code: 'ENOENT',
            });
        },
    );
});
