import { execFile } from 'node:child_process';
import { chmod, lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

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

/** The caller owns this leaf. Never grant access by changing its ancestors. */
export async function grantExactUidPathAccess(input: Readonly<{
    path: string;
    uid: number;
    access: '--x' | 'rwx' | 'rw-' | 'owner';
    /** Fresh staging entries already carry their preserved source mode. */
    preservePermissions?: true;
    directory: boolean;
    inherit?: true;
}>): Promise<void> {
    if (input.uid === process.getuid?.()) return;
    if (process.platform !== 'linux' || !Number.isSafeInteger(input.uid) || input.uid < 0 || !isAbsolute(input.path)) {
        throw new Error('Native Unix path access is unavailable');
    }
    const entry = input.preservePermissions ? await lstat(input.path) : undefined;
    if (input.access === 'owner' && !entry || entry && (entry.isSymbolicLink()
        || input.directory !== entry.isDirectory() || !entry.isDirectory() && !entry.isFile())) {
        throw new Error('Native Unix path access is unavailable');
    }
    const owner = entry ? permissionAccess((entry.mode >> 6) & 7) : input.directory ? 'rwx' : 'rw-';
    const group = entry ? permissionAccess((entry.mode >> 3) & 7) : '---';
    const other = entry ? permissionAccess(entry.mode & 7) : '---';
    const access = input.access === 'owner' ? owner : input.access;
    const mask = permissionAccess(permissionBits(group) | permissionBits(access));
    await runAclCommand('setfacl', ['-b', input.path]);
    if (input.directory) await runAclCommand('setfacl', ['-k', input.path]);
    await runAclCommand('setfacl', ['-m', entry
        ? `user::${owner},group::${group},other::${other},user:${input.uid}:${access},mask::${mask}`
        : `u:${input.uid}:${access}`, input.path]);
    const inherited = input.inherit ? [
        `default:user::${owner}`, `default:user:${process.getuid!()}:${owner}`, `default:user:${input.uid}:${access}`,
        `default:group::${group}`, `default:mask::${permissionAccess(permissionBits(mask) | permissionBits(owner))}`, `default:other::${other}`,
    ] : [];
    if (input.inherit) {
        await runAclCommand('setfacl', ['-m', inherited.map(entry => entry.replace(/^default:/, 'd:')).join(','), input.path]);
    }
    const actual = (await runAclCommand('getfacl', ['-n', '-c', '-p', input.path]))
        .split('\n').map(line => line.split('#')[0]!.trim()).filter(Boolean).sort();
    const expected = [`user::${owner}`, `user:${input.uid}:${access}`,
        `group::${group}`, `mask::${mask}`, `other::${other}`, ...inherited].sort();
    if (actual.length !== expected.length || actual.some((entry, index) => entry !== expected[index])) {
        throw new Error('Native Unix path access is unavailable');
    }
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
    const dispose = async () => { await rm(path, { recursive: true, force: true }); };
    try {
        await chmod(path, 0o700);
        await grantExactUidPathAccess({ path, uid: input.uid, access: input.access, directory: true });
        return { path, dispose };
    } catch (error) {
        await dispose();
        throw error;
    }
}
