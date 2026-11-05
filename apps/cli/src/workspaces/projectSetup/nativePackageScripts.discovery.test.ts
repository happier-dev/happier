import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

const filesystemWork = vi.hoisted(() => ({ resolutions: 0, directories: [] as string[] }));

// Observe platform path/filesystem work while exercising the real discovery walk.
vi.mock('node:path', async importOriginal => {
    const actual = await importOriginal<typeof import('node:path')>();
    return { ...actual, resolve: (...paths: string[]) => {
        filesystemWork.resolutions += 1;
        return actual.resolve(...paths);
    } };
});
vi.mock('node:fs/promises', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return { ...actual, readdir: (...args: Parameters<typeof actual.readdir>) => {
        filesystemWork.directories.push(String(args[0]));
        return actual.readdir(...args);
    } };
});

import { collectNativePackageDirectories } from './nativePackageScripts';

it('retains only input-root identities while scanning overlapping native package trees once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-package-discovery-'));
    const child = join(root, 'packages', 'child');
    const ignored = join(root, 'node_modules', 'explicit');
    const outside = await mkdtemp(join(tmpdir(), 'happier-package-outside-'));
    const linked = join(root, 'linked');
    try {
        await mkdir(child, { recursive: true });
        await mkdir(ignored, { recursive: true });
        await symlink(outside, linked, 'junction');
        for (const directory of [root, child, ignored, outside]) {
            await writeFile(join(directory, 'package.json'), '{}');
        }
        for (const roots of [[root, child, ignored, linked], [child, root, linked, ignored]]) {
            filesystemWork.resolutions = 0;
            filesystemWork.directories.length = 0;
            const packages = await collectNativePackageDirectories(roots);
            expect(packages.sort()).toEqual([root, child, ignored, linked].sort());
            expect(new Set(filesystemWork.directories).size).toBe(filesystemWork.directories.length);
            // Descendants are already joined absolute paths, and cannot cycle:
            // directory symlinks are not traversed. Only explicit roots need identity storage.
            expect(filesystemWork.resolutions).toBe(roots.length);
        }
    } finally {
        await rm(root, { recursive: true, force: true });
        await rm(outside, { recursive: true, force: true });
    }
});
