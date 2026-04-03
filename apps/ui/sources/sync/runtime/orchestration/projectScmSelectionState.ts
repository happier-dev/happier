import type { ScmCommitSelectionPatch } from '@/sync/domains/state/storageTypes';

export interface ScmSelectionWorkspaceState {
    scmTouchedPaths?: Record<string, number>;
    scmCommitSelection?: Record<string, number>;
    scmCommitSelectionPatches?: Record<string, ScmCommitSelectionPatch & { selectedAt: number }>;
    updatedAt: number;
}

export function markWorkspaceScmTouchedPaths(
    workspace: ScmSelectionWorkspaceState,
    paths: string[],
    touchedAt: number = Date.now(),
): void {
    if (paths.length === 0) return;

    if (!workspace.scmTouchedPaths) {
        workspace.scmTouchedPaths = {};
    }

    for (const path of paths) {
        if (!path) continue;
        workspace.scmTouchedPaths[path] = touchedAt;
    }
    workspace.updatedAt = Date.now();
}

export function getWorkspaceScmTouchedPaths(
    workspace: ScmSelectionWorkspaceState | null | undefined,
): string[] {
    const touched = workspace?.scmTouchedPaths;
    if (!touched) return [];
    return Object.keys(touched).sort((a, b) => a.localeCompare(b));
}

export function pruneWorkspaceScmTouchedPaths(
    workspace: ScmSelectionWorkspaceState,
    activePaths: Set<string>,
): void {
    const touched = workspace.scmTouchedPaths;
    if (!touched) return;

    for (const path of Object.keys(touched)) {
        if (!activePaths.has(path)) {
            delete touched[path];
        }
    }

    if (Object.keys(touched).length === 0) {
        delete workspace.scmTouchedPaths;
    }
    workspace.updatedAt = Date.now();
}

export function markWorkspaceScmCommitSelectionPaths(
    workspace: ScmSelectionWorkspaceState,
    paths: string[],
    selectedAt: number = Date.now(),
): void {
    if (paths.length === 0) return;

    if (!workspace.scmCommitSelection) {
        workspace.scmCommitSelection = {};
    }

    for (const path of paths) {
        if (!path) continue;
        workspace.scmCommitSelection[path] = selectedAt;
    }
    workspace.updatedAt = Date.now();
}

export function unmarkWorkspaceScmCommitSelectionPaths(
    workspace: ScmSelectionWorkspaceState,
    paths: string[],
): void {
    const selection = workspace.scmCommitSelection;
    if (!selection) return;
    if (paths.length === 0) return;

    for (const path of paths) {
        if (!path) continue;
        delete selection[path];
    }

    if (Object.keys(selection).length === 0) {
        delete workspace.scmCommitSelection;
    }
    workspace.updatedAt = Date.now();
}

export function clearWorkspaceScmCommitSelectionPaths(
    workspace: ScmSelectionWorkspaceState,
): void {
    if (!workspace.scmCommitSelection) return;
    delete workspace.scmCommitSelection;
    workspace.updatedAt = Date.now();
}

export function getWorkspaceScmCommitSelectionPaths(
    workspace: ScmSelectionWorkspaceState | null | undefined,
): string[] {
    const selection = workspace?.scmCommitSelection;
    if (!selection) return [];
    return Object.keys(selection).sort((a, b) => a.localeCompare(b));
}

export function pruneWorkspaceScmCommitSelectionPaths(
    workspace: ScmSelectionWorkspaceState,
    activePaths: Set<string>,
): void {
    const selection = workspace.scmCommitSelection;
    if (!selection) return;

    for (const path of Object.keys(selection)) {
        if (!activePaths.has(path)) {
            delete selection[path];
        }
    }

    if (Object.keys(selection).length === 0) {
        delete workspace.scmCommitSelection;
    }
    workspace.updatedAt = Date.now();
}

export function upsertWorkspaceScmCommitSelectionPatch(
    workspace: ScmSelectionWorkspaceState,
    patchSelection: ScmCommitSelectionPatch,
    selectedAt: number = Date.now(),
): void {
    const path = patchSelection.path.trim();
    const patch = patchSelection.patch;
    if (!path || !patch.trim()) return;

    if (!workspace.scmCommitSelectionPatches) {
        workspace.scmCommitSelectionPatches = {};
    }
    workspace.scmCommitSelectionPatches[path] = {
        path,
        patch,
        selectedAt,
    };
    workspace.updatedAt = Date.now();
}

export function getWorkspaceScmCommitSelectionPatches(
    workspace: ScmSelectionWorkspaceState | null | undefined,
): ScmCommitSelectionPatch[] {
    const selection = workspace?.scmCommitSelectionPatches;
    if (!selection) return [];
    return Object.values(selection).sort((a, b) => a.path.localeCompare(b.path));
}

export function removeWorkspaceScmCommitSelectionPatch(
    workspace: ScmSelectionWorkspaceState,
    path: string,
): void {
    const normalizedPath = path.trim();
    if (!normalizedPath) return;

    const patches = workspace.scmCommitSelectionPatches;
    if (!patches) return;

    delete patches[normalizedPath];
    if (Object.keys(patches).length === 0) {
        delete workspace.scmCommitSelectionPatches;
    }
    workspace.updatedAt = Date.now();
}

export function clearWorkspaceScmCommitSelectionPatches(
    workspace: ScmSelectionWorkspaceState,
): void {
    if (!workspace.scmCommitSelectionPatches) return;
    delete workspace.scmCommitSelectionPatches;
    workspace.updatedAt = Date.now();
}

export function pruneWorkspaceScmCommitSelectionPatches(
    workspace: ScmSelectionWorkspaceState,
    activePaths: Set<string>,
): void {
    const selection = workspace.scmCommitSelectionPatches;
    if (!selection) return;

    for (const path of Object.keys(selection)) {
        if (!activePaths.has(path)) {
            delete selection[path];
        }
    }

    if (Object.keys(selection).length === 0) {
        delete workspace.scmCommitSelectionPatches;
    }
    workspace.updatedAt = Date.now();
}
