import type { ScmCommitSelectionPatch } from '@/sync/domains/state/storageTypes';

export interface ScmSelectionWorkspaceState {
    scmCommitSelection?: Record<string, number>;
    scmCommitSelectionPatches?: Record<string, ScmCommitSelectionPatch & { selectedAt: number }>;
    updatedAt: number;
}

export function markWorkspaceScmCommitSelectionPaths(
    workspace: ScmSelectionWorkspaceState,
    paths: string[],
    selectedAt: number = Date.now(),
): boolean {
    let changed = false;
    for (const path of paths) {
        if (!path || workspace.scmCommitSelection?.[path] === selectedAt) continue;
        workspace.scmCommitSelection ??= {};
        workspace.scmCommitSelection[path] = selectedAt;
        changed = true;
    }
    if (changed) workspace.updatedAt = Date.now();
    return changed;
}

export function unmarkWorkspaceScmCommitSelectionPaths(
    workspace: ScmSelectionWorkspaceState,
    paths: string[],
): boolean {
    const selection = workspace.scmCommitSelection;
    if (!selection) return false;
    let changed = false;
    for (const path of paths) {
        if (!path || !Object.hasOwn(selection, path)) continue;
        delete selection[path];
        changed = true;
    }
    if (!changed) return false;
    if (Object.keys(selection).length === 0) {
        delete workspace.scmCommitSelection;
    }
    workspace.updatedAt = Date.now();
    return true;
}

export function clearWorkspaceScmCommitSelectionPaths(
    workspace: ScmSelectionWorkspaceState,
): boolean {
    if (!workspace.scmCommitSelection) return false;
    delete workspace.scmCommitSelection;
    workspace.updatedAt = Date.now();
    return true;
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
): boolean {
    const selection = workspace.scmCommitSelection;
    if (!selection) return false;
    let changed = false;
    for (const path of Object.keys(selection)) {
        if (!activePaths.has(path)) {
            delete selection[path];
            changed = true;
        }
    }

    if (!changed) return false;
    if (Object.keys(selection).length === 0) {
        delete workspace.scmCommitSelection;
    }
    workspace.updatedAt = Date.now();
    return true;
}

export function upsertWorkspaceScmCommitSelectionPatch(
    workspace: ScmSelectionWorkspaceState,
    patchSelection: ScmCommitSelectionPatch,
    selectedAt: number = Date.now(),
): boolean {
    const path = patchSelection.path;
    const patch = patchSelection.patch;
    if (!path || !patch.trim()) return false;
    const previous = workspace.scmCommitSelectionPatches?.[path];
    if (previous?.patch === patch && previous.selectedAt === selectedAt) return false;

    if (!workspace.scmCommitSelectionPatches) {
        workspace.scmCommitSelectionPatches = {};
    }
    workspace.scmCommitSelectionPatches[path] = {
        path,
        patch,
        selectedAt,
    };
    workspace.updatedAt = Date.now();
    return true;
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
): boolean {
    if (!path) return false;

    const patches = workspace.scmCommitSelectionPatches;
    if (!patches || !Object.hasOwn(patches, path)) return false;

    delete patches[path];
    if (Object.keys(patches).length === 0) {
        delete workspace.scmCommitSelectionPatches;
    }
    workspace.updatedAt = Date.now();
    return true;
}

export function clearWorkspaceScmCommitSelectionPatches(
    workspace: ScmSelectionWorkspaceState,
): boolean {
    if (!workspace.scmCommitSelectionPatches) return false;
    delete workspace.scmCommitSelectionPatches;
    workspace.updatedAt = Date.now();
    return true;
}

export function pruneWorkspaceScmCommitSelectionPatches(
    workspace: ScmSelectionWorkspaceState,
    activePaths: Set<string>,
): boolean {
    const selection = workspace.scmCommitSelectionPatches;
    if (!selection) return false;
    let changed = false;
    for (const path of Object.keys(selection)) {
        if (!activePaths.has(path)) {
            delete selection[path];
            changed = true;
        }
    }

    if (!changed) return false;
    if (Object.keys(selection).length === 0) {
        delete workspace.scmCommitSelectionPatches;
    }
    workspace.updatedAt = Date.now();
    return true;
}
