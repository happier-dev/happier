import { existsSync } from 'node:fs';
import { lstat, mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { replaceRuntimePayloadTree } from './copyRuntimePayloadTree';

describe('replaceRuntimePayloadTree', () => {
    it('skips AppleDouble files and nested node_modules/.bin shims', async () => {
        const workspace = await mkdtemp(join(tmpdir(), 'happier-copy-runtime-payload-tree-'));
        const sourcePath = join(workspace, 'source');
        const destinationPath = join(workspace, 'dest');

        await mkdir(join(sourcePath, 'package-dist'), { recursive: true });
        await mkdir(join(sourcePath, 'node_modules', 'example', 'node_modules', '.bin'), { recursive: true });
        await writeFile(join(sourcePath, 'happier.exe'), 'runtime-binary', 'utf8');
        await writeFile(join(sourcePath, 'package-dist', 'index.mjs'), 'export default \"ok\";\n', 'utf8');
        await writeFile(join(sourcePath, '._happier.exe'), 'appledouble', 'utf8');
        await writeFile(join(sourcePath, 'node_modules', 'example', 'node_modules', '.bin', 'yaml'), 'shim', 'utf8');

        try {
            await replaceRuntimePayloadTree({
                sourcePath,
                destinationPath,
            });

            expect(await readFile(join(destinationPath, 'happier.exe'), 'utf8')).toBe('runtime-binary');
            expect(await readFile(join(destinationPath, 'package-dist', 'index.mjs'), 'utf8')).toContain('ok');
            expect(existsSync(join(destinationPath, '._happier.exe'))).toBe(false);
            expect(existsSync(join(destinationPath, 'node_modules', 'example', 'node_modules', '.bin', 'yaml'))).toBe(false);
        }
        finally {
            await rm(workspace, { recursive: true, force: true });
        }
    });

    it('preserves symlinked payload entries instead of copying their target contents', async () => {
        const workspace = await mkdtemp(join(tmpdir(), 'happier-copy-runtime-payload-tree-symlink-'));
        const sourcePath = join(workspace, 'source');
        const destinationPath = join(workspace, 'dest');
        const externalTargetPath = join(workspace, 'external-runtime-sidecar.js');
        const symlinkPath = join(sourcePath, 'generated', 'runtime-sidecar.js');

        await mkdir(join(sourcePath, 'generated'), { recursive: true });
        await writeFile(externalTargetPath, 'export const outside = true;\n', 'utf8');
        await symlink(externalTargetPath, symlinkPath);

        try {
            await replaceRuntimePayloadTree({
                sourcePath,
                destinationPath,
            });

            const installedPath = join(destinationPath, 'generated', 'runtime-sidecar.js');
            await expect(lstat(installedPath)).resolves.toSatisfy((stats) => stats.isSymbolicLink());
            await expect(readlink(installedPath)).resolves.toBe(externalTargetPath);
        }
        finally {
            await rm(workspace, { recursive: true, force: true });
        }
    });
});
