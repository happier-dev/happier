import { normalizeFileSystemPath } from '@/sync/domains/fileSystem/normalizeFileSystemPath';
import { resolveAbsolutePath } from '@/utils/path/pathUtils';

type SpawnAttemptKeyOptions = Readonly<{
    machineId: string;
    serverId?: string | null;
    directory: string;
}>;

export function resolveSpawnAttemptDirectoryIdentity(
    directory: string,
    machineHomeDir?: string | null,
): string {
    const identity = normalizeFileSystemPath(
        resolveAbsolutePath(directory.trim(), machineHomeDir?.trim() || undefined),
    );
    if (!identity) {
        throw new Error('Spawn attempt directory identity is unavailable');
    }
    return identity;
}

export function createSpawnAttemptKeyForFreshSpawnOptions<T extends SpawnAttemptKeyOptions>(
    options: T,
    machineHomeDir: string,
): string {
    const directory = resolveSpawnAttemptDirectoryIdentity(options.directory, machineHomeDir);
    return `machine.spawn_new:${JSON.stringify({
        machineId: options.machineId.trim(),
        serverId: options.serverId?.trim() ?? null,
        directory,
    })}`;
}
