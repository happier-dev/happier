import type { ScmCommitSelectionPatch } from '@/sync/domains/state/storageTypes';

export interface ScmSelectionProjectState {
    scmTouchedPathsBySession?: Record<string, Record<string, number>>;
    scmCommitSelectionBySession?: Record<string, Record<string, number>>;
    scmCommitSelectionPatchesBySession?: Record<string, Record<string, ScmCommitSelectionPatch & { selectedAt: number }>>;
    updatedAt: number;
}

export function markSessionScmTouchedPaths(
    project: ScmSelectionProjectState,
    sessionId: string,
    paths: string[],
    touchedAt: number = Date.now(),
): void {
    if (paths.length === 0) return;

    if (!project.scmTouchedPathsBySession) {
        project.scmTouchedPathsBySession = {};
    }
    if (!project.scmTouchedPathsBySession[sessionId]) {
        project.scmTouchedPathsBySession[sessionId] = {};
    }

    for (const path of paths) {
        if (!path) continue;
        project.scmTouchedPathsBySession[sessionId]![path] = touchedAt;
    }
    project.updatedAt = Date.now();
}

export function getSessionScmTouchedPaths(
    project: ScmSelectionProjectState | null | undefined,
    sessionId: string,
): string[] {
    if (!project?.scmTouchedPathsBySession?.[sessionId]) return [];
    return Object.keys(project.scmTouchedPathsBySession[sessionId]!).sort((a, b) => a.localeCompare(b));
}

export function pruneSessionScmTouchedPaths(
    project: ScmSelectionProjectState,
    sessionId: string,
    activePaths: Set<string>,
): void {
    const touched = project.scmTouchedPathsBySession?.[sessionId];
    if (!touched) return;

    for (const path of Object.keys(touched)) {
        if (!activePaths.has(path)) {
            delete touched[path];
        }
    }

    if (Object.keys(touched).length === 0 && project.scmTouchedPathsBySession) {
        delete project.scmTouchedPathsBySession[sessionId];
    }
    project.updatedAt = Date.now();
}

export function markSessionScmCommitSelectionPaths(
    project: ScmSelectionProjectState,
    sessionId: string,
    paths: string[],
    selectedAt: number = Date.now(),
): void {
    if (paths.length === 0) return;

    if (!project.scmCommitSelectionBySession) {
        project.scmCommitSelectionBySession = {};
    }
    if (!project.scmCommitSelectionBySession[sessionId]) {
        project.scmCommitSelectionBySession[sessionId] = {};
    }

    for (const path of paths) {
        if (!path) continue;
        project.scmCommitSelectionBySession[sessionId]![path] = selectedAt;
    }
    project.updatedAt = Date.now();
}

export function unmarkSessionScmCommitSelectionPaths(
    project: ScmSelectionProjectState,
    sessionId: string,
    paths: string[],
): void {
    const selection = project.scmCommitSelectionBySession?.[sessionId];
    if (!selection) return;
    if (paths.length === 0) return;

    for (const path of paths) {
        if (!path) continue;
        delete selection[path];
    }

    if (Object.keys(selection).length === 0 && project.scmCommitSelectionBySession) {
        delete project.scmCommitSelectionBySession[sessionId];
    }
    project.updatedAt = Date.now();
}

export function clearSessionScmCommitSelectionPaths(
    project: ScmSelectionProjectState,
    sessionId: string,
): void {
    if (!project.scmCommitSelectionBySession?.[sessionId]) return;
    delete project.scmCommitSelectionBySession[sessionId];
    project.updatedAt = Date.now();
}

export function getSessionScmCommitSelectionPaths(
    project: ScmSelectionProjectState | null | undefined,
    sessionId: string,
): string[] {
    if (!project?.scmCommitSelectionBySession?.[sessionId]) return [];
    return Object.keys(project.scmCommitSelectionBySession[sessionId]!).sort((a, b) => a.localeCompare(b));
}

export function pruneSessionScmCommitSelectionPaths(
    project: ScmSelectionProjectState,
    sessionId: string,
    activePaths: Set<string>,
): void {
    const selection = project.scmCommitSelectionBySession?.[sessionId];
    if (!selection) return;

    for (const path of Object.keys(selection)) {
        if (!activePaths.has(path)) {
            delete selection[path];
        }
    }

    if (Object.keys(selection).length === 0 && project.scmCommitSelectionBySession) {
        delete project.scmCommitSelectionBySession[sessionId];
    }
    project.updatedAt = Date.now();
}

export function upsertSessionScmCommitSelectionPatch(
    project: ScmSelectionProjectState,
    sessionId: string,
    patchSelection: ScmCommitSelectionPatch,
    selectedAt: number = Date.now(),
): void {
    const path = patchSelection.path.trim();
    const patch = patchSelection.patch;
    if (!path || !patch.trim()) return;

    if (!project.scmCommitSelectionPatchesBySession) {
        project.scmCommitSelectionPatchesBySession = {};
    }
    if (!project.scmCommitSelectionPatchesBySession[sessionId]) {
        project.scmCommitSelectionPatchesBySession[sessionId] = {};
    }
    project.scmCommitSelectionPatchesBySession[sessionId]![path] = {
        path,
        patch,
        selectedAt,
    };
    project.updatedAt = Date.now();
}

export function getSessionScmCommitSelectionPatches(
    project: ScmSelectionProjectState | null | undefined,
    sessionId: string,
): ScmCommitSelectionPatch[] {
    const selection = project?.scmCommitSelectionPatchesBySession?.[sessionId];
    if (!selection) return [];
    return Object.values(selection).sort((a, b) => a.path.localeCompare(b.path));
}

export function removeSessionScmCommitSelectionPatch(
    project: ScmSelectionProjectState,
    sessionId: string,
    path: string,
): void {
    const normalizedPath = path.trim();
    if (!normalizedPath) return;

    const patches = project.scmCommitSelectionPatchesBySession?.[sessionId];
    if (!patches) return;

    delete patches[normalizedPath];
    if (Object.keys(patches).length === 0 && project.scmCommitSelectionPatchesBySession) {
        delete project.scmCommitSelectionPatchesBySession[sessionId];
    }
    project.updatedAt = Date.now();
}

export function clearSessionScmCommitSelectionPatches(
    project: ScmSelectionProjectState,
    sessionId: string,
): void {
    if (!project.scmCommitSelectionPatchesBySession?.[sessionId]) return;
    delete project.scmCommitSelectionPatchesBySession[sessionId];
    project.updatedAt = Date.now();
}

export function pruneSessionScmCommitSelectionPatches(
    project: ScmSelectionProjectState,
    sessionId: string,
    activePaths: Set<string>,
): void {
    const selection = project.scmCommitSelectionPatchesBySession?.[sessionId];
    if (!selection) return;

    for (const path of Object.keys(selection)) {
        if (!activePaths.has(path)) {
            delete selection[path];
        }
    }

    if (Object.keys(selection).length === 0 && project.scmCommitSelectionPatchesBySession) {
        delete project.scmCommitSelectionPatchesBySession[sessionId];
    }
    project.updatedAt = Date.now();
}
