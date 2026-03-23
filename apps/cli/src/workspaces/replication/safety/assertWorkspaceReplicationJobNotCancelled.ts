import type { WorkspaceReplicationJobStore } from '../jobs/workspaceReplicationJobStore';
import { WorkspaceReplicationError } from '../workspaceReplicationError';

import { WorkspaceReplicationJobCancelRequestedError } from './workspaceReplicationJobCancelRequestedError';

export async function assertWorkspaceReplicationJobNotCancelled(input: Readonly<{
    jobStore: WorkspaceReplicationJobStore;
    jobId: string;
}>): Promise<void> {
    const current = await input.jobStore.read(input.jobId);
    if (!current) {
        throw new WorkspaceReplicationError({
            code: 'job_not_found',
            message: `Workspace replication job not found: ${input.jobId}`,
        });
    }

    if (current.cancelRequestedAtMs || current.status.status === 'aborted') {
        throw new WorkspaceReplicationJobCancelRequestedError(input.jobId);
    }
}
