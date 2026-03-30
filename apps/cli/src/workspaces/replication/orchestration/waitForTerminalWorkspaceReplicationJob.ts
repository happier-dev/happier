import type { WorkspaceReplicationEngine } from '../workspaceReplicationEngine';

const TERMINAL_WORKSPACE_REPLICATION_JOB_STATUSES = new Set<string>([
    'completed',
    'aborted',
    'failed',
    'awaiting_recovery',
]);

type WorkspaceReplicationJobStatus = Awaited<ReturnType<WorkspaceReplicationEngine['getJobStatus']>>;

export async function waitForTerminalWorkspaceReplicationJob(params: Readonly<{
    engine: WorkspaceReplicationEngine;
    jobId: string;
    assertCanContinue?: () => Promise<void>;
}>): Promise<WorkspaceReplicationJobStatus> {
    // Poll on a coarse interval to avoid hammering the job store while still providing fast convergence.
    while (true) {
        await params.assertCanContinue?.();
        const record = await params.engine.getJobStatus(params.jobId);
        if (TERMINAL_WORKSPACE_REPLICATION_JOB_STATUSES.has(record.status.status)) {
            return record;
        }
        await new Promise<void>((resolve) => {
            setTimeout(resolve, 250);
        });
    }
}
