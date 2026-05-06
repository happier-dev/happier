import { lstat, mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { FsEntryV1, FsPathInputV1, FsRuntimeServiceV1, FsStatV1, FsWriteTextInputV1 } from '@happier-dev/plugin-sdk';

function resolveScopedPath(rootDir: string, path: string): string {
    const resolved = resolve(rootDir, path);
    const relativePath = relative(rootDir, resolved);
    if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
        throw new Error(`Plugin filesystem path '${path}' escapes its scoped root`);
    }
    return resolved;
}

function assertRealPathInsideRoot(realRootDir: string, realPath: string, inputPath: string): void {
    const relativePath = relative(realRootDir, realPath);
    if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
        throw new Error(`Plugin filesystem path '${inputPath}' escapes its scoped root`);
    }
}

async function resolveExistingScopedPath(rootDir: string, path: string): Promise<string> {
    const resolved = resolveScopedPath(rootDir, path);
    const [realRootDir, realResolvedPath] = await Promise.all([
        realpath(rootDir),
        realpath(resolved),
    ]);
    assertRealPathInsideRoot(realRootDir, realResolvedPath, path);
    return realResolvedPath;
}

async function assertExistingDirectoryAncestorsStayScoped(rootDir: string, targetPath: string, inputPath: string): Promise<void> {
    await mkdir(rootDir, { recursive: true });
    const realRootDir = await realpath(rootDir);
    const relativeTarget = relative(rootDir, targetPath);
    if (!relativeTarget) {
        return;
    }

    const segments = relativeTarget.split(/[\\/]+/).filter(Boolean);
    let currentPath = rootDir;
    for (const segment of segments) {
        currentPath = join(currentPath, segment);
        try {
            const currentStat = await lstat(currentPath);
            if (currentStat.isSymbolicLink()) {
                throw new Error(`Plugin filesystem path '${inputPath}' escapes its scoped root`);
            }
            if (!currentStat.isDirectory()) {
                return;
            }
            assertRealPathInsideRoot(realRootDir, await realpath(currentPath), inputPath);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return;
            }
            throw error;
        }
    }
}

function projectKind(isFile: boolean, isDirectory: boolean): FsEntryV1['kind'] {
    if (isFile) {
        return 'file';
    }
    if (isDirectory) {
        return 'directory';
    }
    return 'other';
}

function projectStat(value: Awaited<ReturnType<typeof stat>>): FsStatV1 {
    return Object.freeze({
        kind: projectKind(value.isFile(), value.isDirectory()),
        size: Number(value.size),
        mtimeMs: Number(value.mtimeMs),
    });
}

export function createPluginFsService(params: Readonly<{
    rootDir: string;
    readAllowedPaths?: readonly string[];
    writeAllowedPaths?: readonly string[];
}>): FsRuntimeServiceV1 {
    const rootDir = resolve(params.rootDir);
    function assertPermission(inputPath: string, allowedPaths: readonly string[] | undefined, operation: string): void {
        if (allowedPaths === undefined) {
            return;
        }
        const resolvedInput = resolveScopedPath(rootDir, inputPath);
        for (const allowedPath of allowedPaths) {
            const trimmed = allowedPath.trim();
            const resolvedAllowedPath = trimmed.length === 0 || trimmed === '*'
                ? rootDir
                : resolveScopedPath(rootDir, trimmed);
            const relativePath = relative(resolvedAllowedPath, resolvedInput);
            if (!relativePath || (!relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath) && relativePath !== '..')) {
                return;
            }
        }
        throw new Error(`Plugin filesystem ${operation} permission is not declared for '${inputPath}'`);
    }
    const service: FsRuntimeServiceV1 = Object.freeze({
        async readText(input: FsPathInputV1): Promise<string> {
            assertPermission(input.path, params.readAllowedPaths, 'read');
            return await readFile(await resolveExistingScopedPath(rootDir, input.path), 'utf8');
        },
        async writeText(input: FsWriteTextInputV1): Promise<void> {
            assertPermission(input.path, params.writeAllowedPaths, 'write');
            const filePath = resolveScopedPath(rootDir, input.path);
            await assertExistingDirectoryAncestorsStayScoped(rootDir, dirname(filePath), input.path);
            await mkdir(dirname(filePath), { recursive: true });
            try {
                if ((await lstat(filePath)).isSymbolicLink()) {
                    throw new Error(`Plugin filesystem path '${input.path}' escapes its scoped root`);
                }
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                    throw error;
                }
            }
            assertRealPathInsideRoot(await realpath(rootDir), await realpath(dirname(filePath)), input.path);
            await writeFile(filePath, input.contents, 'utf8');
        },
        async mkdir(input: FsPathInputV1): Promise<void> {
            assertPermission(input.path, params.writeAllowedPaths, 'write');
            const dirPath = resolveScopedPath(rootDir, input.path);
            await assertExistingDirectoryAncestorsStayScoped(rootDir, dirPath, input.path);
            await mkdir(dirPath, { recursive: true });
        },
        async list(input: FsPathInputV1): Promise<readonly FsEntryV1[]> {
            assertPermission(input.path, params.readAllowedPaths, 'read');
            const dirPath = await resolveExistingScopedPath(rootDir, input.path);
            const entries = await readdir(dirPath, { withFileTypes: true });
            return Object.freeze(entries.map((entry) => Object.freeze({
                name: entry.name,
                kind: projectKind(entry.isFile(), entry.isDirectory()),
            })));
        },
        async stat(input: FsPathInputV1): Promise<FsStatV1 | null> {
            assertPermission(input.path, params.readAllowedPaths, 'read');
            try {
                return projectStat(await stat(await resolveExistingScopedPath(rootDir, input.path)));
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                    return null;
                }
                throw error;
            }
        },
    });
    return service;
}
