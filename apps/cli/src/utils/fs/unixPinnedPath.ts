import { constants } from 'node:fs';
import { mkdir, open, readdir, rmdir, unlink, type FileHandle } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

const unavailable = () => new Error('Native Unix path access is unavailable');
const descriptorPath = (handle: FileHandle) => `/proc/${process.pid}/fd/${handle.fd}`;
// Linux O_PATH pins even unreadable entries and does not open devices or FIFOs.
const O_PATH = 0x200000;
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

function components(path: string, relative: boolean): string[] {
    if (relative === isAbsolute(path) || path.includes('\0')) throw unavailable();
    const parts = path.split('/').filter(part => part !== '' && part !== '.');
    if (parts.some(part => part === '..')) throw unavailable();
    return parts;
}

export interface PinnedUnixDirectory {
    readonly path: string;
    withEntry<T>(path: string, directory: boolean, createIfMissing: boolean,
        effect: (entry: FileHandle, path: string) => Promise<T>): Promise<T>;
    remove(path: string): Promise<void>;
    withDirectory<T>(path: string, createIfMissing: boolean, effect: (directory: PinnedUnixDirectory) => Promise<T>): Promise<T>;
}

async function withEntry<T>(parent: FileHandle, parts: string[], directory: boolean, createIfMissing: boolean,
    effect: (entry: FileHandle, path: string) => Promise<T>): Promise<T> {
    if (parts.length === 0) return effect(parent, descriptorPath(parent));
    const [name, ...rest] = parts;
    const path = `${descriptorPath(parent)}/${name}`;
    const flags = rest.length > 0 || directory ? directoryFlags : O_PATH | constants.O_NOFOLLOW;
    let entry: FileHandle;
    try { entry = await open(path, flags); }
    catch (error) {
        if (!createIfMissing || !directory || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        // mkdir is relative to a pinned parent. A competing replacement is still
        // checked by the subsequent no-follow open; no chmod follows a name.
        try { await mkdir(path, { mode: 0o700 }); }
        catch (createError) { if ((createError as NodeJS.ErrnoException).code !== 'EEXIST') throw createError; }
        entry = await open(path, flags);
    }
    try {
        if (rest.length > 0) return await withEntry(entry, rest, directory, createIfMissing, effect);
        return await effect(entry, descriptorPath(entry));
    } finally { await entry.close(); }
}

async function removeEntry(parent: FileHandle, name: string): Promise<void> {
    const path = `${descriptorPath(parent)}/${name}`;
    let entry: FileHandle;
    try { entry = await open(path, O_PATH | constants.O_NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    try {
        const observed = await entry.stat();
        if (!observed.isDirectory()) {
            // unlink never follows the final symlink, including a replacement.
            await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
            return;
        }
        for (const child of await readdir(descriptorPath(entry))) await removeEntry(entry, child);
        try { await rmdir(path); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
            // A replacement symlink is removed as a link, never traversed.
            if ((error as NodeJS.ErrnoException).code === 'ENOTDIR') await unlink(path);
            else throw error;
        }
    } finally { await entry.close(); }
}

function directoryCapability(handle: FileHandle): PinnedUnixDirectory {
    return {
        path: descriptorPath(handle),
        withEntry: (path, directory, createIfMissing, effect) => withEntry(handle, components(path, true), directory, createIfMissing, effect),
        withDirectory: (path, createIfMissing, effect) => withEntry(handle, components(path, true), true, createIfMissing,
            entry => effect(directoryCapability(entry))),
        async remove(path) {
            const parts = components(path, true); const name = parts.pop();
            if (!name) throw unavailable();
            await withEntry(handle, parts, true, false, parent => removeEntry(parent, name));
        },
    };
}

/** Every component is opened relative to its held parent, never through a symlink. */
export async function withPinnedUnixPath<T>(path: string, directory: boolean, createIfMissing: boolean,
    effect: (entry: FileHandle, path: string) => Promise<T>): Promise<T> {
    if (process.platform !== 'linux') throw unavailable();
    const parts = components(path, false);
    const root = await open('/', directoryFlags);
    try { return await withEntry(root, parts, directory, createIfMissing, effect); }
    finally { await root.close(); }
}

export async function withPinnedDirectory<T>(path: string, effect: (directory: PinnedUnixDirectory) => Promise<T>): Promise<T> {
    return withPinnedUnixPath(path, true, false, async handle => effect(directoryCapability(handle)));
}

export async function removePinnedUnixPath(path: string): Promise<void> {
    const parts = components(path, false); const name = parts.pop();
    if (!name) throw unavailable();
    await withPinnedUnixPath(`/${parts.join('/')}`, true, false, parent => removeEntry(parent, name))
        .catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
}
