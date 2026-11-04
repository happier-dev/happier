import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, mkdtemp, open, rm, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { removePinnedUnixPath, withPinnedDirectory, withPinnedUnixPath, type PinnedUnixDirectory } from './unixPinnedPath';

function runAclCommand(command: 'setfacl' | 'getfacl', args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(command, args, { encoding: 'utf8' }, (error, stdout) => {
            if (error) reject(new Error('Native Unix path access is unavailable'));
            else resolve(stdout);
        });
    });
}

function permissionAccess(bits: number): string {
    return `${bits & 4 ? 'r' : '-'}${bits & 2 ? 'w' : '-'}${bits & 1 ? 'x' : '-'}`;
}

function permissionBits(access: string): number {
    return (access[0] === 'r' ? 4 : 0) | (access[1] === 'w' ? 2 : 0) | (access[2] === 'x' ? 1 : 0);
}

type ExactUidPathAccess = Readonly<{
    path: string;
    uid: number;
    access: '--x' | 'rwx' | 'rw-' | 'owner';
    /** Fresh staging entries already carry their preserved source mode. */
    preservePermissions?: true;
    directory: boolean;
    inherit?: true;
}>;

function assertUid(uid: number): void {
    if (!Number.isSafeInteger(uid) || uid < 0) throw new Error('Native Unix path access is unavailable');
}

async function assertOwnedEntry(handle: FileHandle, directory: boolean) {
    const entry = await handle.stat();
    if (entry.uid !== process.getuid?.() || (directory ? !entry.isDirectory() : !entry.isFile() || entry.nlink !== 1)) {
        throw new Error('Native Unix path access is unavailable');
    }
    return entry;
}

async function grantPinnedEntry(input: ExactUidPathAccess, handle: FileHandle, path: string): Promise<void> {
    const observed = await assertOwnedEntry(handle, input.directory);
    if (input.uid === process.getuid?.()) return;
    const entry = input.preservePermissions ? observed : undefined;
    if (input.access === 'owner' && !entry) throw new Error('Native Unix path access is unavailable');
    const owner = entry ? permissionAccess((entry.mode >> 6) & 7) : input.directory ? 'rwx' : 'rw-';
    const group = entry ? permissionAccess((entry.mode >> 3) & 7) : '---';
    const other = entry ? permissionAccess(entry.mode & 7) : '---';
    const access = input.access === 'owner' ? owner : input.access;
    const mask = permissionAccess(permissionBits(group) | permissionBits(access));
    await runAclCommand('setfacl', ['-b', path]);
    if (input.directory) await runAclCommand('setfacl', ['-k', path]);
    await runAclCommand('setfacl', ['-m', entry
        ? `user::${owner},group::${group},other::${other},user:${input.uid}:${access},mask::${mask}`
        : `u:${input.uid}:${access}`, path]);
    const inherited = input.inherit ? [
        `default:user::${owner}`, `default:user:${process.getuid!()}:${owner}`, `default:user:${input.uid}:${access}`,
        `default:group::${group}`, `default:mask::${permissionAccess(permissionBits(mask) | permissionBits(owner))}`, `default:other::${other}`,
    ] : [];
    if (input.inherit) {
        await runAclCommand('setfacl', ['-m', inherited.map(entry => entry.replace(/^default:/, 'd:')).join(','), path]);
    }
    const actual = (await runAclCommand('getfacl', ['-n', '-c', '-p', path]))
        .split('\n').map(line => line.split('#')[0]!.trim()).filter(Boolean).sort();
    const expected = [`user::${owner}`, `user:${input.uid}:${access}`,
        `group::${group}`, `mask::${mask}`, `other::${other}`, ...inherited].sort();
    if (actual.length !== expected.length || actual.some((entry, index) => entry !== expected[index])) {
        throw new Error('Native Unix path access is unavailable');
    }
}

/** The leaf inode stays held through every native ACL command and verification. */
export async function grantExactUidPathAccess(input: ExactUidPathAccess): Promise<void> {
    if (input.uid === process.getuid?.()) return;
    assertUid(input.uid);
    await withPinnedUnixPath(input.path, input.directory, false, (entry, path) => grantPinnedEntry(input, entry, path));
}

type ExactUidDirectoryAccess = Readonly<{ path: string; uid: number; createIfMissing: boolean }>;

async function ensurePinnedDirectory(input: ExactUidDirectoryAccess, handle: FileHandle, path: string): Promise<void> {
    await assertOwnedEntry(handle, true);
    await handle.chmod(0o700);
    await grantPinnedEntry({ ...input, access: 'rwx', directory: true, inherit: true }, handle, path);
}

export async function ensureExactUidDirectoryAccess(input: ExactUidDirectoryAccess): Promise<void> {
    assertUid(input.uid);
    await withPinnedUnixPath(input.path, true, input.createIfMissing, (entry, path) => ensurePinnedDirectory(input, entry, path));
}

export async function removeUnixPathTree(path: string): Promise<void> {
    if (process.platform === 'linux') await removePinnedUnixPath(path);
    else await rm(path, { recursive: true, force: true });
}

export interface PinnedUnixDirectoryAccess {
    /** Only valid during the callback. Filesystem writes must precede member grants. */
    readonly path: string;
    chmod(path: string, mode: number): Promise<void>;
    utimes(path: string, atime: Date | number, mtime: Date | number): Promise<void>;
    withDirectory<T>(path: string, options: Readonly<{ createIfMissing: boolean }>, effect: (directory: PinnedUnixDirectoryAccess) => Promise<T>): Promise<T>;
    grantExactUidPathAccess(input: ExactUidPathAccess): Promise<void>;
    ensureExactUidDirectoryAccess(input: ExactUidDirectoryAccess): Promise<void>;
    remove(path: string): Promise<void>;
}

function directoryAccess(directory: PinnedUnixDirectory): PinnedUnixDirectoryAccess {
    async function metadata(path: string, effect: (entry: FileHandle) => Promise<void>): Promise<void> {
        await directory.withEntry(path, false, false, async (entry, pinnedPath) => {
            const observed = await entry.stat();
            await assertOwnedEntry(entry, observed.isDirectory());
            // O_PATH pins unreadable files; reopening the held inode cannot
            // follow a renamed filesystem entry. Neither mode truncates files.
            const writable = await open(pinnedPath, constants.O_RDONLY | constants.O_NONBLOCK)
                .catch(() => open(pinnedPath, constants.O_WRONLY | constants.O_NONBLOCK));
            try { await effect(writable); } finally { await writable.close(); }
        });
    }
    return {
        path: directory.path,
        chmod: (path, mode) => metadata(path, entry => entry.chmod(mode)),
        utimes: (path, atime, mtime) => metadata(path, entry => entry.utimes(atime, mtime)),
        withDirectory: (path, options, effect) => directory.withDirectory(path, options.createIfMissing, async child => {
            await child.withEntry('', true, false, async entry => { await assertOwnedEntry(entry, true); });
            return effect(directoryAccess(child));
        }),
        async grantExactUidPathAccess(input) {
            assertUid(input.uid);
            await directory.withEntry(input.path, input.directory, false, (entry, path) => grantPinnedEntry(input, entry, path));
        },
        async ensureExactUidDirectoryAccess(input) {
            assertUid(input.uid);
            await directory.withEntry(input.path, true, input.createIfMissing, (entry, path) => ensurePinnedDirectory(input, entry, path));
        },
        remove: path => directory.remove(path),
    };
}

/** Scoped filesystem authority; raw /proc paths are never accepted as trusted roots. */
export async function withPinnedUnixDirectory<T>(path: string, effect: (directory: PinnedUnixDirectoryAccess) => Promise<T>): Promise<T> {
    return withPinnedDirectory(path, directory => effect(directoryAccess(directory)));
}

/** A transient daemon-owned leaf, accessible only to its selected native UID. */
export async function createSessionNativeDirectory(input: Readonly<{
    uid: number;
    prefix: string;
    access: '--x' | 'rwx';
    runtimeRoot?: string;
}>): Promise<Readonly<{ path: string; dispose(): Promise<void> }>> {
    if (process.platform === 'win32' || !Number.isSafeInteger(input.uid) || input.uid < 0
        || (input.runtimeRoot !== undefined && !isAbsolute(input.runtimeRoot))) {
        throw new Error('Native Unix path access is unavailable');
    }
    const sameIdentity = input.uid === process.getuid?.();
    if (!sameIdentity && process.platform !== 'linux') throw new Error('Native Unix path access is unavailable');
    // A different UID cannot traverse the custodian's private TMPDIR.
    const runtimeRoot = input.runtimeRoot ?? (sameIdentity ? tmpdir() : '/tmp');
    const path = await mkdtemp(join(runtimeRoot, input.prefix));
    const dispose = async () => {
        if (sameIdentity) await rm(path, { recursive: true, force: true });
        else await removeUnixPathTree(path);
    };
    try {
        if (!sameIdentity && process.platform === 'linux') {
            await withPinnedUnixPath(path, true, false, async (entry, pinnedPath) => {
                await assertOwnedEntry(entry, true);
                await entry.chmod(0o700);
                await grantPinnedEntry({ path, uid: input.uid, access: input.access, directory: true }, entry, pinnedPath);
            });
        } else { await chmod(path, 0o700); }
        return { path, dispose };
    } catch (error) {
        await dispose();
        throw error;
    }
}
