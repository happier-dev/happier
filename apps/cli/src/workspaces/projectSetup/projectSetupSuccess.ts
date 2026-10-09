import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { ProjectSetupSuccessV1Schema, StoredProjectSetupSuccessV1Schema, type ProjectSetupSuccessV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectSetupSuccessV1';

import { writeJsonAtomicSync } from '@/utils/fs/writeJsonAtomicSync';

export type ProjectSetupSuccessTarget = Readonly<{ serverId: string; machineId: string; workspaceRefId: string }>;

class ProjectSetupSuccessUnavailableError extends Error {
    readonly code = 'project_setup_success_unavailable';
    constructor() { super('Completed Project setup facts are unavailable'); this.name = 'ProjectSetupSuccessUnavailableError'; }
}

/** Target-local completion facts, outside repository bytes and Workspace Sync. Not a trust authority. */
export function createProjectSetupSuccessStore(input: Readonly<{ homeDir: string }>) {
    function pathFor(target: ProjectSetupSuccessTarget): string {
        // Opaque identity segments also support separators and Windows drive-like ids.
        const segment = (value: string) => {
            if (!value) throw new ProjectSetupSuccessUnavailableError();
            return `id-${encodeURIComponent(value)}`;
        };
        return join(input.homeDir, 'project-setup', segment(target.serverId), segment(target.machineId), `${segment(target.workspaceRefId)}.json`);
    }
    async function read(target: ProjectSetupSuccessTarget): Promise<ProjectSetupSuccessV1 | null> {
        let bytes: string;
        try { bytes = await readFile(pathFor(target), 'utf8'); }
        catch (error) {
            if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return null;
            throw new ProjectSetupSuccessUnavailableError();
        }
        try {
            const value = StoredProjectSetupSuccessV1Schema.parse(JSON.parse(bytes));
            if (value.workspaceRefId !== target.workspaceRefId) throw new ProjectSetupSuccessUnavailableError();
            return value;
        } catch { throw new ProjectSetupSuccessUnavailableError(); }
    }
    async function readMatching(target: ProjectSetupSuccessTarget, basis: Omit<ProjectSetupSuccessV1, 'v' | 'workspaceRefId' | 'completedAtMs'>): Promise<ProjectSetupSuccessV1 | null> {
        const value = await read(target);
        return value !== null && value.cwd === basis.cwd
            && value.platform.os === basis.platform.os && value.platform.arch === basis.platform.arch
            && value.reviewedEffectDigest === basis.reviewedEffectDigest && value.setupInputsDigest === basis.setupInputsDigest
            && value.environmentBindingReferences.length === basis.environmentBindingReferences.length
            && value.environmentBindingReferences.every((reference, index) => reference === basis.environmentBindingReferences[index]) ? value : null;
    }
    return {
        pathFor,
        read,
        readMatching,
        async matches(target: ProjectSetupSuccessTarget, basis: Omit<ProjectSetupSuccessV1, 'v' | 'workspaceRefId' | 'completedAtMs'>): Promise<boolean> {
            return await readMatching(target, basis) !== null;
        },
        async recordCompletion(target: ProjectSetupSuccessTarget, success: ProjectSetupSuccessV1): Promise<void> {
            const value = ProjectSetupSuccessV1Schema.parse(success);
            if (value.workspaceRefId !== target.workspaceRefId) throw new ProjectSetupSuccessUnavailableError();
            writeJsonAtomicSync(pathFor(target), value);
        },
        async invalidate(target: ProjectSetupSuccessTarget): Promise<void> {
            try { await unlink(pathFor(target)); }
            catch (error) {
                if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return;
                throw new ProjectSetupSuccessUnavailableError();
            }
        },
    };
}
