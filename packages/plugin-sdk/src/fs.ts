import { randomUUID } from 'node:crypto';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { withJsonOwnerFileLock } from './internal/fs/jsonOwnerFileLock.js';

export type FsPathInputV1 = Readonly<{
    path: string;
}>;

export type FsWriteTextInputV1 = FsPathInputV1 & Readonly<{
    contents: string;
}>;

export type FsAtomicWriteTextInputV1 = FsWriteTextInputV1 & Readonly<{
    mode?: number;
    temporaryDirectory?: string | null;
}>;

export type FsAtomicWriteJsonInputV1 = FsPathInputV1 & Readonly<{
    value: unknown;
    mode?: number;
    space?: number;
    temporaryDirectory?: string | null;
}>;

export type FsCreateTempDirectoryInputV1 = Readonly<{
    prefix?: string;
}>;

export type FsTempTextFileInputV1 = Readonly<{
    suffix?: string;
    contents: string;
}>;

export type FsScopedPathListFileInputV1 = Readonly<{
    suffix?: string;
    paths: readonly string[];
}>;

export type FsScopedPathListDiagnosticCodeV1 =
    | 'scope_unavailable'
    | 'path_invalid'
    | 'path_escape'
    | 'path_missing'
    | 'path_not_file';

export type FsScopedPathListDiagnosticV1 = Readonly<{
    code: FsScopedPathListDiagnosticCodeV1;
    severity: 'error';
    messageKey: string;
    path?: string;
    detail?: Readonly<Record<string, unknown>>;
}>;

export type FsScopedPathListFileResultV1 =
    | Readonly<{
        status: 'created';
        path: string;
        paths: readonly string[];
    }>
    | Readonly<{
        status: 'blocked';
        diagnostics: readonly FsScopedPathListDiagnosticV1[];
    }>;

export interface FsTempDirectoryV1 {
    readonly path: string;
    createTextFile(input: FsTempTextFileInputV1): Promise<string>;
    createScopedPathListFile(input: FsScopedPathListFileInputV1): Promise<FsScopedPathListFileResultV1>;
    readText(input: FsPathInputV1): Promise<string>;
    cleanup(): Promise<void>;
}

export type FsEntryV1 = Readonly<{
    name: string;
    kind: 'file' | 'directory' | 'other';
}>;

export type FsStatV1 = Readonly<{
    kind: 'file' | 'directory' | 'other';
    size: number;
    mtimeMs: number;
}>;

export interface FsRuntimeServiceV1 {
    readText(input: FsPathInputV1): Promise<string>;
    writeText(input: FsWriteTextInputV1): Promise<void>;
    mkdir(input: FsPathInputV1): Promise<void>;
    list(input: FsPathInputV1): Promise<readonly FsEntryV1[]>;
    stat(input: FsPathInputV1): Promise<FsStatV1 | null>;
    createTempDirectory(input?: FsCreateTempDirectoryInputV1): Promise<FsTempDirectoryV1>;
}

function resolveTemporaryFilePath(path: string, temporaryDirectory: string | null | undefined): string {
    const directory = temporaryDirectory && temporaryDirectory.trim().length > 0
        ? temporaryDirectory
        : dirname(path);
    return join(directory, `.happier-${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
}

export async function writeAtomicTextFile(input: FsAtomicWriteTextInputV1): Promise<void> {
    await mkdir(dirname(input.path), { recursive: true });
    const temporaryPath = resolveTemporaryFilePath(input.path, input.temporaryDirectory);
    await mkdir(dirname(temporaryPath), { recursive: true });
    let published = false;
    try {
        await writeFile(temporaryPath, input.contents, {
            encoding: 'utf8',
            ...(input.mode === undefined ? {} : { mode: input.mode }),
            flag: 'wx',
        });
        await rename(temporaryPath, input.path);
        published = true;
    } finally {
        if (!published) {
            await unlink(temporaryPath).catch(() => undefined);
        }
    }
}

export async function writeAtomicJsonFile(input: FsAtomicWriteJsonInputV1): Promise<void> {
    const serialized = JSON.stringify(input.value, null, input.space ?? 2);
    if (serialized === undefined) {
        throw new TypeError('writeAtomicJsonFile requires a JSON-serializable document value');
    }
    await writeAtomicTextFile({
        path: input.path,
        contents: `${serialized}\n`,
        ...(input.mode === undefined ? {} : { mode: input.mode }),
        ...(input.temporaryDirectory === undefined ? {} : { temporaryDirectory: input.temporaryDirectory }),
    });
}

export async function withExclusiveFileLock<TResult>(
    options: Readonly<{
        lockPath: string;
        timeoutMs: number;
    }>,
    effect: () => Promise<TResult>,
): Promise<TResult> {
    return await withJsonOwnerFileLock({
        lockPath: options.lockPath,
        timeoutMs: options.timeoutMs,
        staleAfterMs: 60_000,
        errorCode: 'exclusive_file_lock_timeout',
    }, effect);
}
