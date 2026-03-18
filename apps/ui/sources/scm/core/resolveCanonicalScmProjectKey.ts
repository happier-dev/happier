import { normalizeFileSystemPath } from '@/sync/domains/fileSystem/normalizeFileSystemPath';

function readSnapshotRootPath(snapshot: unknown): string | null {
    if (!snapshot || typeof snapshot !== 'object') {
        return null;
    }

    const repo = (snapshot as { repo?: unknown }).repo;
    if (!repo || typeof repo !== 'object') {
        return null;
    }

    return normalizeFileSystemPath((repo as { rootPath?: unknown }).rootPath) ?? null;
}

export function resolveCanonicalScmProjectKey(params: Readonly<{
    fallbackProjectKey: string;
    machineId?: string | null;
    snapshot: unknown;
}>): string {
    const machineId = typeof params.machineId === 'string' ? params.machineId.trim() : '';
    const rootPath = readSnapshotRootPath(params.snapshot);
    if (!machineId || !rootPath) {
        return params.fallbackProjectKey;
    }
    return `${machineId}:${rootPath}`;
}
