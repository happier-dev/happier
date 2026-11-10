/** @moduleRealm daemon */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, posix, win32 } from 'node:path';

/** Native filesystem and remote/container namespaces keep their own path rules. */
export const joinNativePath: (...paths: string[]) => string = join;
export const joinPosixPath: (...paths: string[]) => string = posix.join;
export const isWindowsAbsolutePath: (path: string) => boolean = win32.isAbsolute;

import { withJsonOwnerFileLock } from '@happier-dev/cli-common/fs/jsonOwnerFileLock';

export type FsAtomicWriteTextInput = Readonly<{
    path: string;
    contents: string;
    mode?: number;
    temporaryDirectory?: string | null;
}>;

export type FsAtomicWriteInput = Readonly<{
    path: string;
    contents: string | Uint8Array;
    mode?: number;
    temporaryDirectory?: string | null;
}>;

export type FsAtomicWriteJsonInput = Readonly<{
    path: string;
    value: unknown;
    mode?: number;
    space?: number;
    temporaryDirectory?: string | null;
}>;

export type FsAtomicWriteTextInputV1 = FsAtomicWriteTextInput;
export type FsAtomicWriteJsonInputV1 = FsAtomicWriteJsonInput;

export type { FileSystemService } from './services/io.js';
export type {
    SecureTempDirectoryInputV1 as SecureTempDirectoryInput,
    SecureTempDirectoryV1 as SecureTempDirectory,
    SecureTempTextFileInputV1 as SecureTempTextFileInput,
} from './runtime/tempTextFile.js';
export { createSecureTempDirectorySync, writeSecureTempTextFileSync } from './runtime/tempTextFile.js';
export { createAbsolutePathSymlink } from './runtime/createAbsolutePathSymlink.js';
export { linkDirectoryChildren } from './runtime/linkDirectoryChildren.js';
export {
  canonicalizePath,
  canonicalizePathSync,
  expandHomePath,
  isCanonicalAbsolutePathInsideRoot,
  resolveHomeDirFromEnvironment,
  resolveConfiguredPath,
} from './sessions/fileStores/paths.js';

function resolveTemporaryFilePath(path: string, temporaryDirectory: string | null | undefined): string {
    const directory = temporaryDirectory && temporaryDirectory.trim().length > 0
        ? temporaryDirectory
        : dirname(path);
    return join(directory, `.happier-${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
}

export async function writeAtomicFile(input: FsAtomicWriteInput): Promise<void> {
    await mkdir(dirname(input.path), { recursive: true });
    const temporaryPath = resolveTemporaryFilePath(input.path, input.temporaryDirectory);
    await mkdir(dirname(temporaryPath), { recursive: true });
    let published = false;
    try {
        await writeFile(temporaryPath, input.contents, {
            ...(typeof input.contents === 'string' ? { encoding: 'utf8' as const } : {}),
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

export async function writeAtomicTextFile(input: FsAtomicWriteTextInput): Promise<void> {
    await writeAtomicFile(input);
}

export async function writeAtomicTextFileIfChanged(input: FsAtomicWriteTextInput): Promise<boolean> {
    const current = await readFile(input.path, 'utf8').catch(() => null);
    if (current === input.contents) return false;
    await writeAtomicTextFile(input);
    return true;
}

export async function writeAtomicJsonFile(input: FsAtomicWriteJsonInput): Promise<void> {
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
        signal?: AbortSignal;
        /** Called once when admission observes contention; diagnostics cannot interrupt admission. */
        onWait?: (info: Readonly<{ pid: number | null; heldForMs: number | null; waitedForMs: number }>) => void;
    }>,
    effect: () => Promise<TResult>,
): Promise<TResult> {
    return await withJsonOwnerFileLock({
        lockPath: options.lockPath,
        timeoutMs: options.timeoutMs,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.onWait ? { onWait: options.onWait } : {}),
        staleAfterMs: 60_000,
        errorCode: 'exclusive_file_lock_timeout',
    }, effect);
}
