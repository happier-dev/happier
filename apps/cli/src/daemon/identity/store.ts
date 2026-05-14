import { randomUUID } from 'node:crypto';
import { chmod, link, mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import {
    chmodSync,
    closeSync,
    existsSync,
    fsyncSync,
    linkSync,
    mkdirSync,
    openSync,
    readFileSync,
    rmSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import tweetnacl from 'tweetnacl';
import {
    MachineInstallationIdentityV1Schema,
    type MachineInstallationIdentityV1,
} from '@happier-dev/protocol';

import { encodeBase64 } from '@/api/encryption';
import { configuration } from '@/configuration';

const CREATION_LOCK_RETRY_INTERVAL_MS = 25;
const CREATION_LOCK_MAX_ATTEMPTS = 400;
const CREATION_LOCK_STALE_MS = 10_000;

function createInstallationIdentity(now: number): MachineInstallationIdentityV1 {
    const keyPair = tweetnacl.sign.keyPair();
    return {
        version: 1,
        installationId: randomUUID(),
        createdAt: now,
        publicKey: encodeBase64(keyPair.publicKey, 'base64url'),
        privateKey: encodeBase64(keyPair.secretKey, 'base64url'),
    };
}

function parseInstallationIdentity(raw: string, path: string): MachineInstallationIdentityV1 {
    try {
        return MachineInstallationIdentityV1Schema.parse(JSON.parse(raw));
    } catch (error) {
        throw new Error(`Invalid installation identity file at ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
}

function isFileExistsError(error: unknown): boolean {
    return typeof error === 'object'
        && error !== null
        && 'code' in error
        && (error as NodeJS.ErrnoException).code === 'EEXIST';
}

function resolveCreationLockPath(path: string): string {
    return `${path}.lock`;
}

function createTempIdentityPath(path: string): string {
    return `${path}.${process.pid}.${randomUUID()}.tmp`;
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function delaySync(ms: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

async function readExistingInstallationIdentity(path: string): Promise<MachineInstallationIdentityV1> {
    const identity = parseInstallationIdentity(await readFile(path, 'utf8'), path);
    await chmodPrivate(path).catch(() => {});
    return identity;
}

function readExistingInstallationIdentitySync(path: string): MachineInstallationIdentityV1 {
    const identity = parseInstallationIdentity(readFileSync(path, 'utf8'), path);
    try {
        chmodPrivateSync(path);
    } catch {
        // best-effort
    }
    return identity;
}

async function chmodPrivate(path: string): Promise<void> {
    if (process.platform === 'win32') return;
    await chmod(path, 0o600);
}

function chmodPrivateSync(path: string): void {
    if (process.platform === 'win32') return;
    chmodSync(path, 0o600);
}

async function fsyncDirectory(path: string): Promise<void> {
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
        handle = await open(path, 'r');
        await handle.sync();
    } catch {
        // best-effort
    } finally {
        await handle?.close().catch(() => {});
    }
}

function fsyncDirectorySync(path: string): void {
    let fd: number | null = null;
    try {
        fd = openSync(path, 'r');
        fsyncSync(fd);
    } catch {
        // best-effort
    } finally {
        if (fd !== null) {
            try {
                closeSync(fd);
            } catch {
                // best-effort
            }
        }
    }
}

async function publishInstallationIdentity(
    path: string,
    identity: MachineInstallationIdentityV1,
): Promise<boolean> {
    const tempPath = createTempIdentityPath(path);
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
        handle = await open(tempPath, 'wx', 0o600);
        await handle.writeFile(JSON.stringify(identity, null, 2), 'utf8');
        await handle.sync();
        await handle.close();
        handle = null;
        await link(tempPath, path);
        await rm(tempPath, { force: true }).catch(() => {});
        await chmodPrivate(path).catch(() => {});
        await fsyncDirectory(dirname(path));
        return true;
    } catch (error) {
        await handle?.close().catch(() => {});
        await rm(tempPath, { force: true }).catch(() => {});
        if (isFileExistsError(error)) return false;
        throw error;
    }
}

function publishInstallationIdentitySync(path: string, identity: MachineInstallationIdentityV1): boolean {
    const tempPath = createTempIdentityPath(path);
    let fd: number | null = null;
    try {
        fd = openSync(tempPath, 'wx', 0o600);
        writeFileSync(fd, JSON.stringify(identity, null, 2), 'utf8');
        fsyncSync(fd);
        closeSync(fd);
        fd = null;
        linkSync(tempPath, path);
        try {
            unlinkSync(tempPath);
        } catch {
            // best-effort
        }
        try {
            chmodPrivateSync(path);
        } catch {
            // best-effort
        }
        fsyncDirectorySync(dirname(path));
        return true;
    } catch (error) {
        if (fd !== null) {
            try {
                closeSync(fd);
            } catch {
                // best-effort
            }
        }
        rmSync(tempPath, { force: true });
        if (isFileExistsError(error)) return false;
        throw error;
    }
}

async function acquireCreationLock(path: string): Promise<Awaited<ReturnType<typeof open>> | null> {
    try {
        const handle = await open(resolveCreationLockPath(path), 'wx', 0o600);
        await handle.writeFile(`${process.pid}\n`, 'utf8');
        await handle.sync().catch(() => {});
        return handle;
    } catch (error) {
        if (isFileExistsError(error)) return null;
        throw error;
    }
}

async function removeStaleCreationLock(path: string): Promise<void> {
    const lockPath = resolveCreationLockPath(path);
    try {
        const stats = await stat(lockPath);
        if (Date.now() - stats.mtimeMs > CREATION_LOCK_STALE_MS) {
            await rm(lockPath, { force: true });
        }
    } catch {
        // Missing or unreadable locks are handled by the next acquire attempt.
    }
}

function acquireCreationLockSync(path: string): number | null {
    try {
        const fd = openSync(resolveCreationLockPath(path), 'wx', 0o600);
        writeFileSync(fd, `${process.pid}\n`, 'utf8');
        try {
            fsyncSync(fd);
        } catch {
            // best-effort
        }
        return fd;
    } catch (error) {
        if (isFileExistsError(error)) return null;
        throw error;
    }
}

function removeStaleCreationLockSync(path: string): void {
    const lockPath = resolveCreationLockPath(path);
    try {
        const stats = statSync(lockPath);
        if (Date.now() - stats.mtimeMs > CREATION_LOCK_STALE_MS) {
            rmSync(lockPath, { force: true });
        }
    } catch {
        // Missing or unreadable locks are handled by the next acquire attempt.
    }
}

async function releaseCreationLock(path: string, handle: Awaited<ReturnType<typeof open>>): Promise<void> {
    await handle.close().catch(() => {});
    await rm(resolveCreationLockPath(path), { force: true }).catch(() => {});
}

function releaseCreationLockSync(path: string, fd: number): void {
    try {
        closeSync(fd);
    } catch {
        // best-effort
    }
    rmSync(resolveCreationLockPath(path), { force: true });
}

export async function readOrCreateInstallationIdentity(
    path = configuration.installationIdentityFile,
): Promise<MachineInstallationIdentityV1> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });

    for (let attempt = 0; attempt < CREATION_LOCK_MAX_ATTEMPTS; attempt += 1) {
        if (existsSync(path)) {
            return readExistingInstallationIdentity(path);
        }

        const lock = await acquireCreationLock(path);
        if (lock) {
            try {
                if (existsSync(path)) {
                    return readExistingInstallationIdentity(path);
                }
                const identity = createInstallationIdentity(Date.now());
                const published = await publishInstallationIdentity(path, identity);
                return published ? identity : readExistingInstallationIdentity(path);
            } finally {
                await releaseCreationLock(path, lock);
            }
        }

        await removeStaleCreationLock(path);
        await delay(CREATION_LOCK_RETRY_INTERVAL_MS);
    }

    throw new Error(`Timed out waiting for installation identity creation lock at ${resolveCreationLockPath(path)}`);
}

export function readOrCreateInstallationIdentitySync(
    path = configuration.installationIdentityFile,
): MachineInstallationIdentityV1 {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

    for (let attempt = 0; attempt < CREATION_LOCK_MAX_ATTEMPTS; attempt += 1) {
        if (existsSync(path)) {
            return readExistingInstallationIdentitySync(path);
        }

        const lock = acquireCreationLockSync(path);
        if (lock !== null) {
            try {
                if (existsSync(path)) {
                    return readExistingInstallationIdentitySync(path);
                }
                const identity = createInstallationIdentity(Date.now());
                const published = publishInstallationIdentitySync(path, identity);
                return published ? identity : readExistingInstallationIdentitySync(path);
            } finally {
                releaseCreationLockSync(path, lock);
            }
        }

        removeStaleCreationLockSync(path);
        delaySync(CREATION_LOCK_RETRY_INTERVAL_MS);
    }

    throw new Error(`Timed out waiting for installation identity creation lock at ${resolveCreationLockPath(path)}`);
}

export function readInstallationIdentityIfExistsSync(
    path = configuration.installationIdentityFile,
): MachineInstallationIdentityV1 | null {
    if (!existsSync(path)) return null;
    const identity = parseInstallationIdentity(readFileSync(path, 'utf8'), path);
    try {
        chmodPrivateSync(path);
    } catch {
        // best-effort
    }
    return identity;
}
