import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import type {
    FsCreateTempDirectoryInputV1,
    FsEntryV1,
    FsPathInputV1,
    FsRuntimeServiceV1,
    FsScopedPathListDiagnosticV1,
    FsScopedPathListFileInputV1,
    FsScopedPathListFileResultV1,
    FsStatV1,
    FsTempTextFileInputV1,
    FsWriteTextInputV1,
} from '@happier-dev/plugin-sdk';

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

function normalizeTempPrefix(input: FsCreateTempDirectoryInputV1 | undefined): string {
    const prefix = input?.prefix?.trim() || 'happier-plugin-';
    if (/[\0\\/]/.test(prefix)) {
        throw new Error('Plugin filesystem temp prefix must not contain path separators');
    }
    return prefix;
}

function normalizeTempSuffix(input: Readonly<{ suffix?: string }>): string {
    const suffix = input.suffix?.trim() ?? '';
    if (/[\0\\/]/.test(suffix)) {
        throw new Error('Plugin filesystem temp file suffix must not contain path separators');
    }
    return suffix;
}

function createScopedPathListDiagnostic(params: Readonly<{
    code: FsScopedPathListDiagnosticV1['code'];
    path?: string;
    detail?: Readonly<Record<string, unknown>>;
}>): FsScopedPathListDiagnosticV1 {
    const suffix = params.code === 'scope_unavailable'
        ? 'scopeUnavailable'
        : params.code === 'path_invalid'
            ? 'pathInvalid'
            : params.code === 'path_escape'
                ? 'pathEscape'
                : params.code === 'path_missing'
                    ? 'pathMissing'
                    : 'pathNotFile';
    return Object.freeze({
        code: params.code,
        severity: 'error',
        messageKey: `plugins.fs.scopedPathList.${suffix}`,
        ...(params.path ? { path: params.path } : {}),
        ...(params.detail ? { detail: Object.freeze({ ...params.detail }) } : {}),
    });
}

function normalizeScopedPathListEntry(path: string): string | FsScopedPathListDiagnosticV1 {
    const trimmed = path.trim();
    if (!trimmed || /[\0\r\n]/.test(trimmed)) {
        return createScopedPathListDiagnostic({
            code: 'path_invalid',
            path,
        });
    }
    const slashNormalized = trimmed.replace(/\\/g, '/');
    if (
        slashNormalized.startsWith('/')
        || slashNormalized.startsWith('~')
        || /^[A-Za-z]:/.test(slashNormalized)
    ) {
        return createScopedPathListDiagnostic({
            code: 'path_escape',
            path: slashNormalized,
        });
    }
    const segments = slashNormalized.split('/').filter((segment) => segment && segment !== '.');
    if (segments.length === 0 || segments.includes('..')) {
        return createScopedPathListDiagnostic({
            code: 'path_escape',
            path: slashNormalized,
        });
    }
    return segments.join('/');
}

async function resolveScopedRootDir(
    readScopedRootDir: (() => string | null | Promise<string | null>) | undefined,
): Promise<string | null> {
    const root = await readScopedRootDir?.();
    const trimmed = typeof root === 'string' ? root.trim() : '';
    if (!trimmed) {
        return null;
    }
    try {
        return await realpath(resolve(trimmed));
    } catch {
        return null;
    }
}

async function createScopedPathListFile(params: Readonly<{
    tempRoot: string;
    input: FsScopedPathListFileInputV1;
    readScopedRootDir?: () => string | null | Promise<string | null>;
}>): Promise<FsScopedPathListFileResultV1> {
    const realScopeRoot = await resolveScopedRootDir(params.readScopedRootDir);
    if (!realScopeRoot) {
        return Object.freeze({
            status: 'blocked',
            diagnostics: Object.freeze([createScopedPathListDiagnostic({ code: 'scope_unavailable' })]),
        });
    }

    const diagnostics: FsScopedPathListDiagnosticV1[] = [];
    const paths: string[] = [];
    const seen = new Set<string>();
    for (const rawPath of params.input.paths) {
        const normalized = normalizeScopedPathListEntry(rawPath);
        if (typeof normalized !== 'string') {
            diagnostics.push(normalized);
            continue;
        }
        const resolvedPath = resolveScopedPath(realScopeRoot, normalized);
        try {
            const realResolvedPath = await realpath(resolvedPath);
            assertRealPathInsideRoot(realScopeRoot, realResolvedPath, normalized);
            const resolvedStat = await stat(realResolvedPath);
            if (!resolvedStat.isFile()) {
                diagnostics.push(createScopedPathListDiagnostic({
                    code: 'path_not_file',
                    path: normalized,
                }));
                continue;
            }
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            diagnostics.push(createScopedPathListDiagnostic({
                code: code === 'ENOENT' ? 'path_missing' : 'path_escape',
                path: normalized,
            }));
            continue;
        }
        if (!seen.has(normalized)) {
            seen.add(normalized);
            paths.push(normalized);
        }
    }

    if (diagnostics.length > 0 || paths.length === 0) {
        return Object.freeze({
            status: 'blocked',
            diagnostics: Object.freeze(diagnostics.length > 0
                ? diagnostics
                : [createScopedPathListDiagnostic({ code: 'path_invalid' })]),
        });
    }

    const suffix = normalizeTempSuffix(params.input);
    const filePath = join(params.tempRoot, `${randomUUID()}${suffix}`);
    await writeFile(filePath, `${paths.join('\n')}\n`, 'utf8');
    return Object.freeze({
        status: 'created',
        path: filePath,
        paths: Object.freeze(paths),
    });
}

export function createPluginFsService(params: Readonly<{
    rootDir: string;
    readAllowedPaths?: readonly string[];
    writeAllowedPaths?: readonly string[];
    readScopedRootDir?: () => string | null | Promise<string | null>;
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
        async createTempDirectory(input?: FsCreateTempDirectoryInputV1) {
            const tempRoot = await mkdtemp(join(tmpdir(), normalizeTempPrefix(input)));
            return Object.freeze({
                path: tempRoot,
                async createTextFile(fileInput: FsTempTextFileInputV1): Promise<string> {
                    const suffix = normalizeTempSuffix(fileInput);
                    const filePath = join(tempRoot, `${randomUUID()}${suffix}`);
                    await writeFile(filePath, fileInput.contents, 'utf8');
                    return filePath;
                },
                async createScopedPathListFile(fileInput: FsScopedPathListFileInputV1): Promise<FsScopedPathListFileResultV1> {
                    return await createScopedPathListFile({
                        tempRoot,
                        input: fileInput,
                        readScopedRootDir: params.readScopedRootDir,
                    });
                },
                async readText(fileInput: FsPathInputV1): Promise<string> {
                    return await readFile(await resolveExistingScopedPath(tempRoot, fileInput.path), 'utf8');
                },
                async cleanup(): Promise<void> {
                    await rm(tempRoot, { recursive: true, force: true });
                },
            });
        },
    });
    return service;
}
