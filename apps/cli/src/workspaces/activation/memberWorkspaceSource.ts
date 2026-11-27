import { isPluginError, PluginError } from '@happier-dev/plugin-sdk/errors';
import { localWorkspaceSource } from '@/workspaces/source/localWorkspaceSource';
import type { WorkspaceSource, WorkspaceEntryStats } from '@/workspaces/source/workspaceSource';
import { validatePath, type PathValidationResult } from '@/rpc/handlers/pathSecurity';

type Entry = Readonly<{ name: string; file: boolean; directory: boolean; link: boolean }>;
type EntryStats = Pick<WorkspaceEntryStats, 'size' | 'mtimeMs' | 'ctimeMs' | 'dev' | 'ino' | 'mode'> & Omit<Entry, 'name'>;

/** OS facts only. Account material and operation custody remain in the parent. */
export type MemberWorkspaceReadServices = Readonly<{
    validatePathWithinRoot(path: string, root: string): Promise<PathValidationResult>;
    readFile(path: string): Promise<Uint8Array>;
    realpath(path: string): Promise<string>;
    stat(path: string): Promise<EntryStats>;
    readdir(path: string): Promise<readonly Entry[]>;
}>;

async function read<T>(effect: () => Promise<T>): Promise<T> {
    try { return await effect(); }
    catch (error) {
        const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
            ? error.code : 'workspace_effect_protocol_invalid';
        throw new PluginError({ code, message: code });
    }
}

/** Created only by the member worker, so these operations never open host paths. */
export function createMemberWorkspaceReadServices(): MemberWorkspaceReadServices {
    return {
        validatePathWithinRoot: async (path, root) => validatePath(path, root),
        readFile: path => read(() => localWorkspaceSource.readFile(path)),
        realpath: path => read(() => localWorkspaceSource.realpath(path)),
        stat: path => read(async () => {
            const value = await localWorkspaceSource.stat(path);
            return { size: value.size, mtimeMs: value.mtimeMs, ctimeMs: value.ctimeMs, dev: value.dev, ino: value.ino, mode: value.mode,
                file: value.isFile(), directory: value.isDirectory(), link: value.isSymbolicLink() };
        }),
        readdir: path => read(async () => (await localWorkspaceSource.readdir(path)).map(value => ({ name: value.name,
            file: value.isFile(), directory: value.isDirectory(), link: value.isSymbolicLink() }))),
    };
}

/** Read-only workspace port for the host's existing Project review owner. */
export function createMemberWorkspaceReadSource(services: MemberWorkspaceReadServices, id: string): WorkspaceSource {
    const unavailable = (): never => { throw new PluginError({ code: 'workspace_effect_protocol_invalid', message: 'Member workspace operation is unavailable' }); };
    const receive = async <T>(effect: () => Promise<T>): Promise<T> => {
        try { return await effect(); }
        catch (error) {
            if (isPluginError(error)) throw Object.assign(new Error(error.data.message), { code: error.data.code });
            throw error;
        }
    };
    return {
        kind: 'target', id,
        validatePathWithinRoot: (path, root) => receive(() => services.validatePathWithinRoot(path, root)),
        readFile: async path => Buffer.from(await receive(() => services.readFile(path))),
        realpath: path => receive(() => services.realpath(path)),
        stat: async path => {
            const value = await receive(() => services.stat(path));
            return { ...value, mtime: new Date(value.mtimeMs), isFile: () => value.file,
                isDirectory: () => value.directory, isSymbolicLink: () => value.link };
        },
        readdir: async path => (await receive(() => services.readdir(path))).map(value => ({ name: value.name,
            isFile: () => value.file, isDirectory: () => value.directory, isSymbolicLink: () => value.link })),
        lstat: unavailable, readlink: unavailable, open: unavailable, writeFile: unavailable, mkdir: unavailable,
        rmdir: unavailable, rename: unavailable, rm: unavailable, copyFile: unavailable, symlink: unavailable,
        openWrite: unavailable, replaceFile: unavailable, resolveExecutable: unavailable, spawn: unavailable,
        toolLaunch: unavailable, watchTree: unavailable, watchFile: unavailable,
    };
}
