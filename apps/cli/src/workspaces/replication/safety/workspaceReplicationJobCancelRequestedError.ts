export class WorkspaceReplicationJobCancelRequestedError extends Error {
    readonly jobId: string;

    constructor(jobId: string) {
        super(`Workspace replication job cancel requested: ${jobId}`);
        this.name = 'WorkspaceReplicationJobCancelRequestedError';
        this.jobId = jobId;
    }
}
