import { chmod, lstat, utimes } from 'node:fs/promises';

export type WorkspaceMetadataEntryKind = 'directory' | 'file' | 'symlink';

export type ApplyWorkspaceMetadataResult = Readonly<{
    modeApplied: boolean;
    mtimeApplied: boolean;
}>;

function normalizeMode(mode: number): number {
    if (!Number.isInteger(mode) || mode < 0) {
        throw new Error('Workspace metadata mode must be a non-negative integer');
    }

    return mode & 0o777;
}

function normalizeMtimeMs(mtimeMs: number): number {
    if (!Number.isFinite(mtimeMs) || mtimeMs < 0) {
        throw new Error('Workspace metadata mtimeMs must be a non-negative finite number');
    }

    return mtimeMs;
}

export async function applyWorkspaceMetadata(params: Readonly<{
    entryKind: WorkspaceMetadataEntryKind;
    entryPath: string;
    mode?: number;
    mtimeMs?: number;
}>): Promise<ApplyWorkspaceMetadataResult> {
    if (params.entryKind === 'symlink') {
        return {
            modeApplied: false,
            mtimeApplied: false,
        };
    }

    let modeApplied = false;
    if (params.mode !== undefined) {
        await chmod(params.entryPath, normalizeMode(params.mode));
        modeApplied = true;
    }

    let mtimeApplied = false;
    if (params.mtimeMs !== undefined) {
        const stats = await lstat(params.entryPath);
        const atime = Number.isFinite(stats.atimeMs) ? stats.atimeMs / 1000 : new Date(stats.atime);
        await utimes(params.entryPath, atime, normalizeMtimeMs(params.mtimeMs) / 1000);
        mtimeApplied = true;
    }

    return {
        modeApplied,
        mtimeApplied,
    };
}
