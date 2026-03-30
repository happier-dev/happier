import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
    safeParseWorkspaceReplicationJobRecordFromDiskValue,
    type WorkspaceReplicationJobRecord,
} from '../jobs/workspaceReplicationJobStore';
import { createWorkspaceReplicationPaths } from '../state/workspaceReplicationPaths';

async function readWorkspaceReplicationJobRecord(filePath: string): Promise<WorkspaceReplicationJobRecord | null> {
    try {
        const raw = await readFile(filePath, 'utf8');
        return safeParseWorkspaceReplicationJobRecordFromDiskValue(JSON.parse(raw));
    } catch {
        return null;
    }
}

export async function listWorkspaceReplicationJobs(params: Readonly<{
    activeServerDir: string;
    correlationId?: string;
    limit?: number;
}>): Promise<readonly WorkspaceReplicationJobRecord[]> {
    const paths = createWorkspaceReplicationPaths({
        activeServerDir: params.activeServerDir,
    });

    try {
        const entries = await readdir(paths.jobsDirectory, { withFileTypes: true });
        const jobRecords: WorkspaceReplicationJobRecord[] = [];

        for (const entry of entries) {
            if (!entry.isFile() || !entry.name.endsWith('.json')) {
                continue;
            }
            const record = await readWorkspaceReplicationJobRecord(join(paths.jobsDirectory, entry.name));
            if (!record) {
                continue;
            }
            if (params.correlationId && record.correlationId !== params.correlationId) {
                continue;
            }
            jobRecords.push(record);
        }

        jobRecords.sort((left, right) => right.updatedAtMs - left.updatedAtMs);
        if (typeof params.limit === 'number') {
            return jobRecords.slice(0, Math.max(0, params.limit));
        }
        return jobRecords;
    } catch (error) {
        const nodeError = error as NodeJS.ErrnoException;
        if (nodeError?.code === 'ENOENT') {
            return [];
        }
        throw error;
    }
}
