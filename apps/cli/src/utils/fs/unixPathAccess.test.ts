import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createSessionNativeDirectory, grantExactUidPathAccess } from './unixPathAccess';

const acl = vi.hoisted(() => new Map<string, Map<string, string>>());
// Model only the native ACL utility boundary; placement and cleanup use real fs.
vi.mock('node:child_process', () => ({ execFile(command: string, args: string[], _options: unknown,
    done: (error: Error | null, stdout: string) => void) {
    const path = args.at(-1)!;
    const mode = statSync(path).mode;
    const access = (bits: number) => `${bits & 4 ? 'r' : '-'}${bits & 2 ? 'w' : '-'}${bits & 1 ? 'x' : '-'}`;
    const entries = acl.get(path) ?? new Map([['user:', access((mode >> 6) & 7)], ['group:', access((mode >> 3) & 7)], ['other:', access(mode & 7)]]);
    acl.set(path, entries);
    if (command === 'setfacl') {
        if (args[0] === '-b') for (const key of entries.keys()) if (!['user:', 'group:', 'other:'].includes(key)) entries.delete(key);
        if (args[0] === '-k') for (const key of entries.keys()) if (key.startsWith('default:')) entries.delete(key);
        if (args[0] === '-m') for (const entry of args[1]!.split(',')) {
            const parts = entry.split(':');
            const value = parts.pop()!;
            const key = parts.join(':').replace(/^d:(user|group|other|mask):/, 'default:$1:').replace(/^u:/, 'user:').replace(/^d:u:/, 'default:user:')
                .replace(/^d:g:/, 'default:group:').replace(/^d:o:/, 'default:other:').replace(/^d:m:/, 'default:mask:');
            entries.set(key, value);
            if (/^user:\d+$/.test(key)) entries.set('mask:', value);
        }
        done(null, '');
    } else if (command === 'getfacl') done(null, [...entries].map(([key, value]) => `${key}:${value}`).join('\n'));
    else done(new Error('Unexpected native command'), '');
} }));
afterEach(() => { vi.unstubAllEnvs(); acl.clear(); });

it.skipIf(process.platform !== 'linux').each([994, 996])('places UID %s transport leaves outside private TMPDIR with only exact access', async uid => {
    const privateRoot = await mkdtemp(join(tmpdir(), 'private-socket-parent-'));
    vi.stubEnv('TMPDIR', privateRoot);
    const directory = await createSessionNativeDirectory({ uid, access: 'rwx', prefix: 'happier-ipc-' });
    try {
        expect(dirname(directory.path)).toBe('/tmp');
        expect(acl.get(directory.path)?.get(`user:${uid}`)).toBe('rwx');
        expect([...acl.get(directory.path)!.keys()].filter(key => key.startsWith('user:'))).toEqual(['user:', `user:${uid}`]);
        expect([...acl.get(directory.path)!.keys()].some(key => key.startsWith('default:'))).toBe(false);
        expect((await stat(privateRoot)).mode & 0o777).toBe(0o700);
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
        expect(Object.fromEntries(acl.get(path)!)).toMatchObject({
            'default:user:': 'rwx', 'default:user:994': 'rwx',
            [`default:user:${process.getuid!()}`]: 'rwx',
            'default:group:': '---', 'default:mask:': 'rwx', 'default:other:': '---',
        });
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
        expect(Object.fromEntries(acl.get(path)!)).toEqual({
            'user:': access((mode >> 6) & 7), 'user:994': access((mode >> 6) & 7),
            'group:': access((mode >> 3) & 7), 'mask:': access(((mode >> 6) | (mode >> 3)) & 7), 'other:': access(mode & 7),
        });
    } finally { await rm(root, { recursive: true, force: true }); }
});
