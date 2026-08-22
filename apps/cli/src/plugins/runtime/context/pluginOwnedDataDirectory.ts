import { lstat, realpath, rm } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

import { PluginIdSchema } from '@happier-dev/protocol';
import { isCanonicalAbsolutePathInsideRoot } from '@/utils/path/expandHomeDirPath';

import { PluginContextServiceError } from './errors';
import { normalizePluginStorageNamespace } from './pluginNamespace';

export type PreparedPluginOwnedDataDirectoryRemoval = Readonly<{
    existed: boolean;
    directoryPath: string;
    remove: () => Promise<void>;
}>;

async function inspectPluginOwnedDirectory(params: Readonly<{
    rootDir: string;
    directoryPath: string;
    errorCode: string;
}>): Promise<boolean> {
    let targetStat;
    try {
        targetStat = await lstat(params.directoryPath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return false;
        throw error;
    }
    if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
        throw new PluginContextServiceError(
            params.errorCode,
            'Plugin-owned data path must be a non-symlink directory',
        );
    }

    const [rootRealPath, targetRealPath] = await Promise.all([
        realpath(params.rootDir),
        realpath(params.directoryPath),
    ]);
    const containedRelativePath = relative(rootRealPath, targetRealPath);
    if (
        !containedRelativePath
        || !isCanonicalAbsolutePathInsideRoot(rootRealPath, targetRealPath)
        || resolve(rootRealPath, containedRelativePath) !== targetRealPath
        || containedRelativePath.includes(sep)
    ) {
        throw new PluginContextServiceError(
            params.errorCode,
            'Plugin-owned data path escaped its canonical namespace root',
        );
    }
    return true;
}

export async function preparePluginOwnedDataDirectoryRemoval(params: Readonly<{
    pluginId: string;
    rootDir: string;
    errorCode: string;
    removeDirectory?: (directoryPath: string) => Promise<void>;
}>): Promise<PreparedPluginOwnedDataDirectoryRemoval> {
    const parsedPluginId = PluginIdSchema.safeParse(params.pluginId);
    if (!parsedPluginId.success) {
        throw new PluginContextServiceError(
            'PLUGIN_DATA_REMOVAL_IDENTITY_INVALID',
            'Destructive plugin data removal requires a canonical plugin id',
        );
    }
    const pluginId = parsedPluginId.data;
    const pluginNamespace = normalizePluginStorageNamespace(pluginId);
    if (pluginNamespace !== pluginId) {
        throw new PluginContextServiceError(
            'PLUGIN_DATA_REMOVAL_IDENTITY_INVALID',
            'Destructive plugin data removal requires an unambiguous plugin namespace',
        );
    }
    const rootDir = resolve(params.rootDir);
    const directoryPath = resolve(rootDir, pluginNamespace);
    if (relative(rootDir, directoryPath) !== pluginNamespace) {
        throw new PluginContextServiceError(
            'PLUGIN_DATA_REMOVAL_PATH_INVALID',
            'Plugin data removal path escaped its canonical namespace root',
        );
    }
    const existed = await inspectPluginOwnedDirectory({
        rootDir,
        directoryPath,
        errorCode: params.errorCode,
    });
    const removeDirectory = params.removeDirectory
        ?? (async (path: string) => await rm(path, { recursive: true, force: true }));
    return Object.freeze({
        existed,
        directoryPath,
        remove: async () => {
            const stillExists = await inspectPluginOwnedDirectory({
                rootDir,
                directoryPath,
                errorCode: params.errorCode,
            });
            if (!stillExists) return;
            await removeDirectory(directoryPath);
        },
    });
}
