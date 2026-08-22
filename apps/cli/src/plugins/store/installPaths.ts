import { join, resolve } from 'node:path';

import { encodePluginIdForFilesystem } from '@happier-dev/protocol';
import { isCanonicalAbsolutePathInsideRoot } from '@/utils/path/expandHomeDirPath';

function assertPathWithinRoot(rootDir: string, candidatePath: string, label: string): void {
    const normalizedRoot = resolve(rootDir);
    const normalizedCandidate = resolve(candidatePath);
    if (!isCanonicalAbsolutePathInsideRoot(normalizedRoot, normalizedCandidate)) {
        throw new Error(`Resolved plugin install path escaped the plugin install root for ${label}`);
    }
}

export function resolveInstalledPluginContainerDir(installedDir: string, pluginId: string): string {
    const containerDir = join(installedDir, encodePluginIdForFilesystem(pluginId));
    assertPathWithinRoot(installedDir, containerDir, pluginId);
    return containerDir;
}

export function resolveInstalledPluginCurrentPath(installedDir: string, pluginId: string): string {
    const containerDir = resolveInstalledPluginContainerDir(installedDir, pluginId);
    const currentPath = join(containerDir, 'current');
    assertPathWithinRoot(installedDir, currentPath, pluginId);
    return currentPath;
}
