import { currentWorkspaceSource } from '@/workspaces/source/workspaceSource';
import type { ScmCommandRunner } from '../runtime';
import { gitCheckpointAdapter } from './gitCheckpointAdapter';
import type { RepositoryCheckpointPhaseRequest, RepositoryCheckpointPhaseResult, RepositoryCheckpointPhaseRunner } from './repositoryCheckpointPhaseWire';
import type { GitCheckpointBackendContext } from './types';

export type { RepositoryCheckpointPhaseRequest, RepositoryCheckpointPhaseResult, RepositoryCheckpointPhaseRunner } from './repositoryCheckpointPhaseWire';

/** Runs the phase's Git commands in this process, through the bound command runner or the workspace source. */
export async function runRepositoryCheckpointPhaseHere(request: RepositoryCheckpointPhaseRequest, options: Readonly<{
    scmCommandRunner?: ScmCommandRunner;
    signal?: AbortSignal;
}> = {}): Promise<RepositoryCheckpointPhaseResult> {
    const context: GitCheckpointBackendContext = {
        cwd: request.repository.cwd,
        projectKey: request.repository.projectKey,
        detection: { isRepo: true, rootPath: request.repository.rootPath, mode: '.git' },
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.scmCommandRunner ? { scmCommandRunner: options.scmCommandRunner } : {}),
        ...(request.repository.checkpointGitPaths ? { checkpointGitPaths: request.repository.checkpointGitPaths } : {}),
    };
    const captured = await gitCheckpointAdapter.capture({ context, checkpointRef: request.checkpointRef });
    const capturedAtMs = performance.timeOrigin + performance.now();
    if (!captured.success || !request.diff) return { captured, capturedAtMs };
    const diff = await gitCheckpointAdapter.diff({
        context, baseRef: request.diff.baseRef, finalRef: request.checkpointRef, baseRefSource: request.diff.baseRefSource,
        attributionScope: 'unknown', finalCommitSha: captured.commitSha,
        ...(request.diff.baseCommitSha ? { baseCommitSha: request.diff.baseCommitSha } : {}),
    });
    return { captured, capturedAtMs, diff };
}

/**
 * Placement decides where the phase runs, as it does for each Git command (`runScmCommand`): a
 * target-placed workspace runs Git through this process's workspace source; otherwise the host
 * port, when bound, runs the whole phase in the daemon.
 */
export function runRepositoryCheckpointPhase(request: RepositoryCheckpointPhaseRequest, ports: Readonly<{
    host?: RepositoryCheckpointPhaseRunner;
    scmCommandRunner?: ScmCommandRunner;
}>): Promise<RepositoryCheckpointPhaseResult> {
    return ports.host && currentWorkspaceSource().kind !== 'target'
        ? ports.host(request)
        : runRepositoryCheckpointPhaseHere(request, { scmCommandRunner: ports.scmCommandRunner });
}

/** The phase result when the host could not run it; no Git outcome exists. */
export function repositoryCheckpointPhaseUnavailable(): RepositoryCheckpointPhaseResult {
    return { captured: { success: false, kind: 'unavailable', reason: 'scm_exec_unavailable', error: 'scm_exec_unavailable', receipts: [] } };
}
