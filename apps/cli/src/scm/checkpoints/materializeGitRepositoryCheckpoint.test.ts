import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withTempDir } from '@/testkit/fs/tempDir';
import { materializeGitRepositoryCheckpoint } from './materializeGitRepositoryCheckpoint';

const platformBoundary = vi.hoisted(() => ({ value: 'linux' }));
const directoryBoundary = vi.hoisted(() => ({ root: '' }));
// Only the OS platform fact is substituted. Native Git, raw parsing and actual
// disk materialization remain real, on a host that can represent these fixtures.
vi.mock('node:os', async importOriginal => ({ ...await importOriginal<typeof import('node:os')>(),
    platform: () => platformBoundary.value }));
// Model only an OS directory listing that collapsed two literal Git names.
// All raw Git commands and file creation still execute against the real disk.
vi.mock('node:fs/promises', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return { ...actual, readdir: async (...args: Parameters<typeof actual.readdir>) => {
        const entries: unknown = await Reflect.apply(actual.readdir, undefined, args);
        return directoryBoundary.root && args[0] === directoryBoundary.root && Array.isArray(entries)
            ? entries.filter((entry: unknown) => entry !== 'a' && (entry as { name?: unknown } | null)?.name !== 'a') : entries;
    } };
});

describe('raw checkpoint filesystem representation', () => {
    afterEach(() => { platformBoundary.value = 'linux'; directoryBoundary.root = ''; });

    it.each(['context.txt:secret', 'NUL', 'context.txt.', 'context.txt ', 'context\\name.txt'])('refuses Windows path %s instead of materializing a different file identity', async name => {
        await withTempDir('happier-checkpoint-path-', async directory => {
            const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
            git('init', '-q');
            git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
            writeFileSync(join(directory, name), 'Captured bytes\n');
            git('add', '.'); git('commit', '-qm', 'captured');
            const endpoint = git('rev-parse', 'HEAD');
            const target = join(directory, 'pinned');
            platformBoundary.value = 'win32';
            await expect(materializeGitRepositoryCheckpoint({ cwd: directory, endpoint, directory: target }))
                .rejects.toThrow();
            expect(existsSync(join(target, name))).toBe(false);
            platformBoundary.value = 'linux';
            await materializeGitRepositoryCheckpoint({ cwd: directory, endpoint, directory: join(directory, 'linux') });
            expect(readFileSync(join(directory, 'linux', name), 'utf8')).toBe('Captured bytes\n');
        });
    });

    it('materializes a valid neighboring Windows file name from exact raw objects despite replacement refs', async () => {
        await withTempDir('happier-checkpoint-valid-path-', async directory => {
            const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
            git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
            writeFileSync(join(directory, 'context.txt'), 'Captured bytes\n');
            git('add', '.'); git('commit', '-qm', 'captured');
            symlinkSync('context.txt', join(directory, 'link.txt'));
            git('add', '.');
            git('update-index', '--add', '--cacheinfo', `160000,${git('rev-parse', 'HEAD')},module`);
            git('commit', '-qm', 'captured link and Gitlink');
            const endpoint = git('rev-parse', 'HEAD');
            const capturedBlob = git('rev-parse', 'HEAD:context.txt');
            writeFileSync(join(directory, 'replacement.txt'), 'Replaced bytes\n');
            const replacement = git('hash-object', '-w', 'replacement.txt');
            git('replace', capturedBlob, replacement);
            platformBoundary.value = 'win32';
            await materializeGitRepositoryCheckpoint({ cwd: directory, endpoint, directory: join(directory, 'pinned') });
            expect(readFileSync(join(directory, 'pinned', 'context.txt'), 'utf8')).toBe('Captured bytes\n');
            expect(readFileSync(join(directory, 'pinned', 'link.txt'), 'utf8')).toBe('Captured bytes\n');
            expect(existsSync(join(directory, 'pinned', 'module'))).toBe(true);
        });
    });

    it('refuses collapsed native directory spelling and accepts the actual case-sensitive tree', async () => {
        await withTempDir('happier-checkpoint-directory-spelling-', async directory => {
            const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
            git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
            mkdirSync(join(directory, 'A')); mkdirSync(join(directory, 'a'));
            writeFileSync(join(directory, 'A', 'first.txt'), 'First\n');
            writeFileSync(join(directory, 'a', 'second.txt'), 'Second\n');
            git('add', '.'); git('commit', '-qm', 'literal directory identities');
            const endpoint = git('rev-parse', 'HEAD');
            directoryBoundary.root = join(directory, 'collapsed');
            await expect(materializeGitRepositoryCheckpoint({ cwd: directory, endpoint, directory: directoryBoundary.root }))
                .rejects.toThrow();
            directoryBoundary.root = '';
            await materializeGitRepositoryCheckpoint({ cwd: directory, endpoint, directory: join(directory, 'native') });
            expect(readFileSync(join(directory, 'native', 'A', 'first.txt'), 'utf8')).toBe('First\n');
            expect(readFileSync(join(directory, 'native', 'a', 'second.txt'), 'utf8')).toBe('Second\n');
        });
    });

    it.each([false, true])('refuses a chained symlink that resolves outside the pinned endpoint (target exists: %s)', async targetExists => {
        await withTempDir('happier-checkpoint-symlink-chain-', async directory => {
            const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
            git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
            mkdirSync(join(directory, 'dir'));
            symlinkSync('..', join(directory, 'dir', 'up'));
            symlinkSync('dir/up/../outside', join(directory, 'read-context'));
            git('add', '.'); git('commit', '-qm', 'captured links');
            if (targetExists) writeFileSync(join(directory, 'outside'), 'Uncaptured live bytes\n');
            await expect(materializeGitRepositoryCheckpoint({ cwd: directory, endpoint: git('rev-parse', 'HEAD'),
                directory: join(directory, 'pinned') })).rejects.toThrow();
        });
    });

    it('preserves valid dangling and cyclic captured symlink objects', async () => {
        await withTempDir('happier-checkpoint-unresolved-link-', async directory => {
            const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
            git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
            symlinkSync('missing', join(directory, 'dangling'));
            symlinkSync('cycle-b', join(directory, 'cycle-a'));
            symlinkSync('cycle-a', join(directory, 'cycle-b'));
            git('add', '.'); git('commit', '-qm', 'captured unresolved links');
            const target = join(directory, 'pinned');
            await materializeGitRepositoryCheckpoint({ cwd: directory, endpoint: git('rev-parse', 'HEAD'), directory: target });
            expect(readlinkSync(join(target, 'dangling'))).toBe('missing');
            expect(readlinkSync(join(target, 'cycle-a'))).toBe('cycle-b');
            expect(readlinkSync(join(target, 'cycle-b'))).toBe('cycle-a');
        });
    });

    it('refuses Windows aliases in raw symlink targets but preserves a contained parent-relative link', async () => {
        await withTempDir('happier-checkpoint-symlink-alias-', async directory => {
            const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
            git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
            writeFileSync(join(directory, 'context.txt'), 'Captured bytes\n');
            symlinkSync('context.txt:secret', join(directory, 'link'));
            git('add', '.'); git('commit', '-qm', 'captured alias');
            platformBoundary.value = 'win32';
            await expect(materializeGitRepositoryCheckpoint({ cwd: directory, endpoint: git('rev-parse', 'HEAD'),
                directory: join(directory, 'invalid') })).rejects.toThrow();
            platformBoundary.value = 'linux';
            // Native Git removes only this fixture link, never the primary checkout.
            git('rm', 'link');
            mkdirSync(join(directory, 'dir'));
            symlinkSync('../context.txt', join(directory, 'dir', 'link'));
            git('add', '.'); git('commit', '-qm', 'contained parent target');
            platformBoundary.value = 'win32';
            await materializeGitRepositoryCheckpoint({ cwd: directory, endpoint: git('rev-parse', 'HEAD'),
                directory: join(directory, 'valid') });
            expect(readFileSync(join(directory, 'valid', 'dir', 'link'), 'utf8')).toBe('Captured bytes\n');
        });
    });
});

describe('checkpoint materialization through the workspace source', () => {
    it('streams every blob through the source write stream and awaits asynchronous target writes', async () => {
        const { localWorkspaceSource } = await import('@/workspaces/source/localWorkspaceSource');
        const { runWithWorkspaceSource } = await import('@/workspaces/source/workspaceSource');
        await withTempDir('happier-checkpoint-source-', async directory => {
            const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
            git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
            mkdirSync(join(directory, 'dir'));
            writeFileSync(join(directory, 'dir', 'file.txt'), 'x'.repeat(200_000));
            writeFileSync(join(directory, 'top.txt'), 'top\n');
            git('add', '.'); git('commit', '-qm', 'tree');
            const endpoint = git('rev-parse', 'HEAD');
            const opened: string[] = [];
            let pendingWrites = 0;
            // A target stand-in on this disk whose writes settle later, like holder frames.
            const source = { ...localWorkspaceSource, kind: 'target' as const, id: 'target:checkpoint',
                openWrite: (path: string, options?: Readonly<{ mode?: number }>) => {
                    opened.push(path);
                    const local = localWorkspaceSource.openWrite(path, options);
                    let chain = Promise.resolve();
                    return {
                        write: (bytes: Uint8Array) => {
                            const copy = Buffer.from(bytes);
                            pendingWrites++;
                            return chain = chain.then(() => new Promise<void>(resolve => setTimeout(resolve, 1)))
                                .then(() => { local.write(copy); pendingWrites--; });
                        },
                        close: () => chain = chain.then(() => { local.close(); }),
                    };
                } };
            const target = join(directory, 'pinned');
            await runWithWorkspaceSource(source, () => materializeGitRepositoryCheckpoint({ cwd: directory, endpoint, directory: target }));
            expect(pendingWrites).toBe(0);
            expect(opened.sort()).toEqual([join(target, 'dir', 'file.txt'), join(target, 'top.txt')]);
            expect(readFileSync(join(target, 'dir', 'file.txt'), 'utf8')).toBe('x'.repeat(200_000));
            expect(readFileSync(join(target, 'top.txt'), 'utf8')).toBe('top\n');
        });
    });
});
