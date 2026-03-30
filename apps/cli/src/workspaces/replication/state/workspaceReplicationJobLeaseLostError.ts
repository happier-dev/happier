export class WorkspaceReplicationJobLeaseLostError extends Error {
    readonly jobId: string;

    constructor(jobId: string) {
        super(`Workspace replication job lease lost: ${jobId}`);
        this.name = 'WorkspaceReplicationJobLeaseLostError';
        this.jobId = jobId;
    }
}
