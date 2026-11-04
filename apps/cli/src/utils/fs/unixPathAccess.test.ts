import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createSessionNativeDirectory, grantExactUidPathAccess } from './unixPathAccess';

const inodeKey = (path: string) => { const entry = statSync(path); return `${entry.dev}:${entry.ino}`; };
const acl = vi.hoisted(() => new Map<string, Map<string, string>>());
const boundary = vi.hoisted(() => ({ commands: [] as string[], fail: false }));
// Model only the native ACL utility boundary; placement and cleanup use real fs.
vi.mock('node:child_process', () => ({ execFile(command: string, args: string[], _options: unknown,
    done: (error: Error | null, stdout: string) => void) {
    boundary.commands.push(command);
    if (command === 'setfacl' && boundary.fail) return done(new Error('Operation not supported'), '');
    const path = args.at(-1)!;
    const observed = statSync(path);
    const mode = observed.mode;
    const key = `${observed.dev}:${observed.ino}`;
    const access = (bits: number) => `${bits & 4 ? 'r' : '-'}${bits & 2 ? 'w' : '-'}${bits & 1 ? 'x' : '-'}`;
    const entries = acl.get(key) ?? new Map([['user:', access((mode >> 6) & 7)], ['group:', access((mode >> 3) & 7)], ['other:', access(mode & 7)]]);
    acl.set(key, entries);
    if (command === 'setfacl') {
        if (args.includes('-k')) for (const key of entries.keys()) if (key.startsWith('default:')) entries.delete(key);
        const replacement = args.indexOf('--set');
        if (replacement >= 0) for (const key of entries.keys()) if (!key.startsWith('default:')) entries.delete(key);
        const spec = replacement >= 0 ? args[replacement + 1] : undefined;
        if (spec) for (const entry of spec.split(',')) {
            const parts = entry.split(':');
            const value = parts.pop()!;
            const key = parts.join(':');
            entries.set(key, value);
        }
        done(null, '');
    } else done(new Error('Unexpected native command'), '');
} }));
afterEach(() => { vi.unstubAllEnvs(); acl.clear(); boundary.commands = []; boundary.fail = false; });

it.skipIf(process.platform !== 'linux').each([994, 996])('places UID %s transport leaves outside private TMPDIR with only exact access', async uid => {
    const privateRoot = await mkdtemp(join(tmpdir(), 'private-socket-parent-'));
    vi.stubEnv('TMPDIR', privateRoot);
    const directory = await createSessionNativeDirectory({ uid, access: 'rwx', prefix: 'happier-ipc-' });
    try {
        expect(dirname(directory.path)).toBe('/tmp');
        expect(acl.get(inodeKey(directory.path))?.get(`user:${uid}`)).toBe('rwx');
        expect([...acl.get(inodeKey(directory.path))!.keys()].filter(key => key.startsWith('user:'))).toEqual(['user:', `user:${uid}`]);
        expect([...acl.get(inodeKey(directory.path))!.keys()].some(key => key.startsWith('default:'))).toBe(false);
        expect((await stat(privateRoot)).mode & 0o777).toBe(0o700);
        expect(boundary.commands).toEqual(['setfacl']);
    } finally {
        await directory.dispose();
        await expect(stat(directory.path)).rejects.toMatchObject({ code: 'ENOENT' });
        await rm(privateRoot, { recursive: true, force: true });
    }
});

it.skipIf(process.platform !== 'linux')('inherits only daemon and selected member access for managed descendants', async () => {
    const path = await mkdtemp(join(tmpdir(), 'managed-member-leaf-'));
    try {
        await grantExactUidPathAccess({ path, uid: 994, access: 'rwx', directory: true, inherit: true });
        expect(Object.fromEntries(acl.get(inodeKey(path))!)).toMatchObject({
            'default:user:': 'rwx', 'default:user:994': 'rwx',
            [`default:user:${process.getuid!()}`]: 'rwx',
            'default:group:': '---', 'default:mask:': 'rwx', 'default:other:': '---',
        });
        expect(boundary.commands).toEqual(['setfacl']);
    } finally { await rm(path, { recursive: true, force: true }); }
});

it.skipIf(process.platform !== 'linux')('replaces pre-existing file permissions and named grants with exact member access', async () => {
    const root = await mkdtemp(join(tmpdir(), 'member-public-file-'));
    const path = join(root, 'entry');
    await writeFile(path, 'member data'); await chmod(path, 0o644);
    acl.set(inodeKey(path), new Map([['user:', 'rw-'], ['user:995', 'rwx'], ['group:', 'r--'], ['mask:', 'rwx'], ['other:', 'r--']]));
    try {
        await grantExactUidPathAccess({ path, uid: 994, access: 'rw-', directory: false });
        expect(Object.fromEntries(acl.get(inodeKey(path))!)).toEqual({
            'user:': 'rw-', 'user:994': 'rw-', 'group:': '---', 'mask:': 'rw-', 'other:': '---',
        });
        expect(boundary.commands).toEqual(['setfacl']);
    } finally { await rm(root, { recursive: true, force: true }); }
});

it.skipIf(process.platform !== 'linux')('removes stale directory defaults when inheritance is not requested', async () => {
    const path = await mkdtemp(join(tmpdir(), 'member-stale-default-'));
    acl.set(inodeKey(path), new Map([['user:', 'rwx'], ['group:', '---'], ['other:', '---'],
        ['default:user:', 'rwx'], ['default:user:995', 'rwx'], ['default:group:', 'r-x'], ['default:mask:', 'rwx'], ['default:other:', 'r-x']]));
    try {
        await grantExactUidPathAccess({ path, uid: 994, access: '--x', directory: true });
        expect(Object.fromEntries(acl.get(inodeKey(path))!)).toEqual({
            'user:': 'rwx', 'user:994': '--x', 'group:': '---', 'mask:': '--x', 'other:': '---',
        });
        expect(boundary.commands).toEqual(['setfacl']);
    } finally { await rm(path, { recursive: true, force: true }); }
});

it.skipIf(process.platform !== 'linux')('rejects when the native ACL write is unsupported', async () => {
    const path = await mkdtemp(join(tmpdir(), 'member-no-acl-'));
    boundary.fail = true;
    try {
        await expect(grantExactUidPathAccess({ path, uid: 994, access: 'rwx', directory: true })).rejects.toThrow('Native Unix path access is unavailable');
        expect(boundary.commands).toEqual(['setfacl']);
    } finally { await rm(path, { recursive: true, force: true }); }
});

// Fresh handoff/fork seed entries already carry their preserved source mode.
it.skipIf(process.platform !== 'linux').each([0o400, 0o500, 0o640])('grants selected UID only preserved owner permissions for seed mode %s', async mode => {
    const root = await mkdtemp(join(tmpdir(), 'seed-member-'));
    const path = join(root, 'entry');
    await writeFile(path, 'selected seed'); await chmod(path, mode);
    try {
        await grantExactUidPathAccess({ path, uid: 994, access: 'owner', directory: false, preservePermissions: true });
        const access = (bits: number) => `${bits & 4 ? 'r' : '-'}${bits & 2 ? 'w' : '-'}${bits & 1 ? 'x' : '-'}`;
        expect(Object.fromEntries(acl.get(inodeKey(path))!)).toEqual({
            'user:': access((mode >> 6) & 7), 'user:994': access((mode >> 6) & 7),
            'group:': access((mode >> 3) & 7), 'mask:': access(((mode >> 6) | (mode >> 3)) & 7), 'other:': access(mode & 7),
        });
    } finally { await rm(root, { recursive: true, force: true }); }
});
