import { chmodSync, lstatSync, renameSync, statSync, symlinkSync } from 'node:fs';
import { link, mkdir, mkdtemp, readFile, rm, stat, writeFile, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import * as access from './unixPathAccess';

const boundary = vi.hoisted(() => ({ swap: undefined as (() => void) | undefined, inodes: [] as number[],
    beforeRead: undefined as ((path: string) => void) | undefined,
    afterOpen: undefined as ((path: string, handle: FileHandle) => Promise<void>) | undefined,
    acls: new Map<string, Map<string, string>>() }));
const inodeKey = (path: string) => { const entry = statSync(path); return `${entry.dev}:${entry.ino}`; };
// The native ACL utility is the only mocked permission boundary. Its target is
// opened by the real kernel after a hostile rename, just as setfacl would do.
vi.mock('node:child_process', () => ({ execFile(command: string, args: string[], _options: unknown,
    done: (error: Error | null, stdout: string) => void) {
    boundary.swap?.(); boundary.swap = undefined;
    const target = args.at(-1)!;
    const observed = statSync(target); const key = `${observed.dev}:${observed.ino}`;
    boundary.inodes.push(observed.ino);
    const entries = boundary.acls.get(key) ?? new Map([['user:', 'rwx'], ['group:', '---'], ['other:', '---']]);
    boundary.acls.set(key, entries);
    if (command === 'setfacl') {
        chmodSync(target, 0o750);
        if (args[0] === '-b') for (const key of entries.keys()) if (!['user:', 'group:', 'other:'].includes(key)) entries.delete(key);
        if (args[0] === '-k') for (const key of entries.keys()) if (key.startsWith('default:')) entries.delete(key);
        if (args[0] === '-m') for (const spec of args[1]!.split(',')) {
            const fields = spec.replace(/^d:/, 'default:').replace(/^u:/, 'user:').split(':');
            const value = fields.pop()!; const field = fields.join(':'); entries.set(field, value);
            if (/^user:\d+$/.test(field)) entries.set('mask:', value);
        }
        done(null, '');
    } else done(null, [...entries].map(([key, value]) => `${key}:${value}`).join('\n'));
} }));
vi.mock('node:fs/promises', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
        const handle = await actual.open(...args);
        await boundary.afterOpen?.(String(args[0]), handle);
        return handle;
    }, readdir: async (...args: Parameters<typeof actual.readdir>) => {
        boundary.beforeRead?.(String(args[0]));
        return actual.readdir(...args);
    } };
});

const roots: string[] = [];
async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'unix-path-race-')); roots.push(root);
    const parent = join(root, 'member'); const victim = join(root, 'owner-private');
    await mkdir(parent); await mkdir(victim, { mode: 0o700 });
    return { root, parent, victim };
}
afterEach(async () => {
    boundary.swap = undefined; boundary.inodes = []; boundary.beforeRead = undefined; boundary.afterOpen = undefined; boundary.acls.clear();
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it.skipIf(process.platform !== 'linux').each(['leaf', 'parent'] as const)('does not traverse a removal %s replaced by a symlink before enumeration', async replacement => {
    const { root, parent, victim } = await fixture();
    const leaf = join(parent, 'payload'); await mkdir(leaf);
    await writeFile(join(leaf, 'discard'), 'staged');
    await writeFile(join(victim, 'keep'), 'private');
    await mkdir(join(victim, 'payload')); await writeFile(join(victim, 'payload', 'keep'), 'private');
    const inode = (await stat(leaf)).ino;
    boundary.beforeRead = path => {
        if (statSync(path).ino !== inode) return;
        boundary.beforeRead = undefined;
        const replaced = replacement === 'leaf' ? leaf : parent;
        renameSync(replaced, join(root, 'displaced'));
        symlinkSync(victim, replaced);
    };
    await access.removeUnixPathTree(leaf);
    expect(await readFile(join(victim, 'keep'), 'utf8')).toBe('private');
    expect((await stat(victim)).mode & 0o777).toBe(0o700);
    expect(await readFile(join(victim, 'payload', 'keep'), 'utf8')).toBe('private');
    if (replacement === 'leaf') await expect(stat(leaf)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(root, 'displaced', ...(replacement === 'parent' ? ['payload'] : []), 'discard')))
        .rejects.toMatchObject({ code: 'ENOENT' });
});

it.skipIf(process.platform !== 'linux')('refuses an existing symlink in every ACL ancestor before executing a command', async () => {
    const { parent, victim } = await fixture();
    await mkdir(join(victim, 'payload'));
    const alias = join(parent, 'alias'); symlinkSync(victim, alias);
    await expect(access.grantExactUidPathAccess({ path: join(alias, 'payload'), uid: 994, access: 'rwx', directory: true }))
        .rejects.toThrow();
    expect(boundary.inodes).toEqual([]);
});

it.skipIf(process.platform !== 'linux').each(['leaf', 'parent'] as const)(
    'pins the ACL inode through a hostile %s replacement at the native boundary', async replacement => {
        const { root, parent, victim } = await fixture();
        const leaf = join(parent, 'payload'); await mkdir(leaf, { mode: 0o700 });
        await mkdir(join(victim, 'payload'), { mode: 0o700 });
        const inode = (await stat(leaf)).ino;
        const victimKey = inodeKey(replacement === 'leaf' ? victim : join(victim, 'payload'));
        const victimAcl = new Map([['user:', 'rwx'], ['group:', '---'], ['other:', '---']]);
        boundary.acls.set(victimKey, new Map(victimAcl));
        boundary.swap = () => {
            const replaced = replacement === 'leaf' ? leaf : parent;
            renameSync(replaced, join(root, 'displaced'));
            symlinkSync(victim, replaced);
        };
        await access.grantExactUidPathAccess({ path: leaf, uid: 994, access: 'rwx', directory: true });
        expect(boundary.inodes.every(actual => actual === inode)).toBe(true);
        expect(boundary.acls.get(victimKey)).toEqual(victimAcl);
        expect((await stat(victim)).mode & 0o777).toBe(0o700);
        if (replacement === 'parent') expect((await stat(join(victim, 'payload'))).mode & 0o777).toBe(0o700);
    },
);

it.skipIf(process.platform !== 'linux')('ensures permissions on the held directory after a leaf replacement before fchmod', async () => {
    const { root, parent, victim } = await fixture();
    const leaf = join(parent, 'payload'); await mkdir(leaf, { mode: 0o750 });
    chmodSync(victim, 0o755);
    const inode = (await stat(leaf)).ino;
    boundary.afterOpen = async (_path, handle) => {
        if ((await handle.stat()).ino !== inode) return;
        boundary.afterOpen = undefined;
        renameSync(leaf, join(root, 'displaced')); symlinkSync(victim, leaf);
    };
    await access.ensureExactUidDirectoryAccess({ path: leaf, uid: 994, createIfMissing: false });
    expect(boundary.inodes.every(actual => actual === inode)).toBe(true);
    expect((await stat(victim)).mode & 0o777).toBe(0o755);
});

it.skipIf(process.platform !== 'linux')('applies staged metadata to a pinned file without truncating or following its replacement', async () => {
    const { root, parent, victim } = await fixture();
    const file = join(parent, 'seed'); const victimFile = join(victim, 'secret');
    await writeFile(file, 'staged', { mode: 0o600 }); await writeFile(victimFile, 'private', { mode: 0o600 });
    const inode = (await stat(file)).ino; const originalTime = (await stat(victimFile)).mtimeMs;
    await access.withPinnedUnixDirectory(parent, async directory => {
        boundary.afterOpen = async (_path, handle) => {
            if ((await handle.stat()).ino !== inode) return;
            boundary.afterOpen = undefined;
            renameSync(file, join(root, 'displaced')); symlinkSync(victimFile, file);
        };
        await directory.chmod('seed', 0o400);
        await expect(directory.utimes('seed', 1000, 1000)).rejects.toThrow();
    });
    expect((await stat(victimFile)).mode & 0o777).toBe(0o600);
    expect((await stat(victimFile)).mtimeMs).toBe(originalTime);
    expect(await readFile(victimFile, 'utf8')).toBe('private');
    expect(await readFile(join(root, 'displaced'), 'utf8')).toBe('staged');
    expect((await stat(join(root, 'displaced'))).mode & 0o777).toBe(0o400);
});

it.skipIf(process.platform !== 'linux')('refuses a hard-linked ACL file before executing a native permission command', async () => {
    const { parent, victim } = await fixture();
    const file = join(victim, 'secret'); const alias = join(parent, 'alias');
    await writeFile(file, 'private', { mode: 0o600 }); await link(file, alias);
    await expect(access.grantExactUidPathAccess({ path: alias, uid: 994, access: 'rw-', directory: false }))
        .rejects.toThrow();
    expect(boundary.inodes).toEqual([]);
    expect(await readFile(file, 'utf8')).toBe('private');
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
});
