/** @moduleRealm daemon */
import { randomUUID } from 'node:crypto';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { withJsonOwnerFileLock } from './host/fs/jsonOwnerFileLock.js';

export type FsAtomicWriteTextInput = Readonly<{
    path: string;
    contents: string;
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
    SecureTempTextFileInputV1 as SecureTempTextFileInput,
} from './runtime/tempTextFile.js';
export { writeSecureTempTextFileSync } from './runtime/tempTextFile.js';
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

export async function writeAtomicTextFile(input: FsAtomicWriteTextInput): Promise<void> {
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
