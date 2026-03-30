import { join } from 'node:path';

export type WorkspaceReplicationPaths = Readonly<{
  rootDirectory: string;
  casDirectory: string;
  jobsDirectory: string;
  relationshipsDirectory: string;
  stagingDirectory: string;
}>;

const VALID_JOB_ID_REGEX = /^[A-Za-z0-9._-]+$/u;

export function createWorkspaceReplicationPaths(input: Readonly<{
  activeServerDir: string;
}>): WorkspaceReplicationPaths {
  const rootDirectory = join(input.activeServerDir, 'workspace-replication');
  return {
    rootDirectory,
    casDirectory: join(rootDirectory, 'cas'),
    jobsDirectory: join(rootDirectory, 'jobs'),
    relationshipsDirectory: join(rootDirectory, 'relationships'),
    stagingDirectory: join(rootDirectory, 'staging'),
  };
}

export function resolveWorkspaceReplicationCasBlobPath(input: Readonly<{
  casDirectory: string;
  digest: string;
}>): string {
  if (!input.digest.startsWith('sha256:')) {
    throw new Error(`Unsupported workspace replication CAS digest: ${input.digest}`);
  }
  const hex = input.digest.slice('sha256:'.length);
  if (!/^[a-f0-9]{64}$/u.test(hex)) {
    throw new Error(`Invalid workspace replication CAS digest: ${input.digest}`);
  }
  // Shard CAS blobs by digest prefix to avoid pathological single-directory scaling on large repos.
  return join(input.casDirectory, 'sha256', hex.slice(0, 2), hex);
}

export function resolveWorkspaceReplicationJobPath(input: Readonly<{
  jobsDirectory: string;
  jobId: string;
}>): string {
  if (!VALID_JOB_ID_REGEX.test(input.jobId)) {
    throw new Error(`Invalid workspace replication job id: ${input.jobId}`);
  }
  return join(input.jobsDirectory, `${input.jobId}.json`);
}

export function resolveWorkspaceReplicationJobStagingDirectory(input: Readonly<{
  stagingDirectory: string;
  jobId: string;
}>): string {
  if (!VALID_JOB_ID_REGEX.test(input.jobId)) {
    throw new Error(`Invalid workspace replication job id: ${input.jobId}`);
  }
  return join(input.stagingDirectory, input.jobId);
}

export function resolveWorkspaceReplicationRelationshipDirectory(input: Readonly<{
  relationshipsDirectory: string;
  relationshipId: string;
}>): string {
  if (!/^rel_[A-Za-z0-9_-]+$/u.test(input.relationshipId)) {
    throw new Error(`Invalid workspace replication relationship id: ${input.relationshipId}`);
  }
  return join(input.relationshipsDirectory, input.relationshipId);
}

export function resolveWorkspaceReplicationRelationshipRecordPath(input: Readonly<{
  relationshipDirectory: string;
}>): string {
  return join(input.relationshipDirectory, 'relationship.json');
}

export function resolveWorkspaceReplicationDirectionDirectory(input: Readonly<{
  relationshipDirectory: string;
  directionId: string;
}>): string {
  if (!/^dir_[A-Za-z0-9_-]+$/u.test(input.directionId)) {
    throw new Error(`Invalid workspace replication direction id: ${input.directionId}`);
  }
  return join(input.relationshipDirectory, 'directionalBaselines', input.directionId);
}

export function resolveWorkspaceReplicationBaselinePath(input: Readonly<{
  relationshipDirectory: string;
  directionId: string;
}>): string {
  return join(
    resolveWorkspaceReplicationDirectionDirectory({
      relationshipDirectory: input.relationshipDirectory,
      directionId: input.directionId,
    }),
    'baseline.json',
  );
}
