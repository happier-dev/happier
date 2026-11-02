import type { ScmBackendRegistry } from '../registry';
import { runWithScmBackendRegistryLease } from '../scmBackendCatalog';
import { resolveScmSelection } from '../resolveScmSelection';
import { buildScmWorkspaceIntegrationWorkspaceExportArtifactsWithBlobProviderFromTransferEntries } from './workspaceExportArtifacts';

/** Configured-remote authority and fetched-ref verification stay with the selected SCM backend. */
export async function fetchWorkspaceCommitRef(input: Readonly<{
    sourcePath: string; cloneUrl: string; ref: string; expectedCommitSha: string;
    signal?: AbortSignal; registry?: ScmBackendRegistry;
}>): Promise<void> {
    await runWithScmBackendRegistryLease(input.registry, async registry => {
        input.signal?.throwIfAborted();
        const resolved = await resolveScmSelection({ workingDirectory: input.sourcePath, cwd: input.sourcePath, registry });
        const fetch = resolved?.selection.backend.workspaceIntegration?.fetchCommitRef;
        if (!resolved || !fetch) throw Object.assign(new Error('SCM ref fetch is unavailable'), { code: 'unsupported' });
        await fetch({ context: resolved.context, cloneUrl: input.cloneUrl,
            ref: input.ref, expectedCommitSha: input.expectedCommitSha, signal: input.signal });
        input.signal?.throwIfAborted();
    });
}

/** Ref selection belongs to the same admitted SCM backend as immutable export. */
export async function resolveWorkspaceCommitRef(input: Readonly<{
    sourcePath: string; ref: string; signal?: AbortSignal; registry?: ScmBackendRegistry;
}>): Promise<string> {
    return runWithScmBackendRegistryLease(input.registry, async registry => {
        input.signal?.throwIfAborted();
        const resolved = await resolveScmSelection({ workingDirectory: input.sourcePath, cwd: input.sourcePath, registry });
        const resolver = resolved?.selection.backend.workspaceIntegration?.resolveCommitRef;
        if (!resolved || !resolver) throw Object.assign(new Error('SCM ref resolution is unavailable'), { code: 'unsupported' });
        const sha = await resolver({ context: resolved.context, ref: input.ref, signal: input.signal });
        input.signal?.throwIfAborted();
        if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(sha)) throw Object.assign(new Error('An immutable commit is required'), { code: 'git_selection_unavailable' });
        return sha;
    });
}

/** The existing SCM catalog selects the exporter; no worktree-transfer fallback is safe here. */
export async function exportWorkspaceCommit(input: Readonly<{
    sourcePath: string;
    commitSha: string;
    artifactDirectory: string;
    signal?: AbortSignal;
    registry?: ScmBackendRegistry;
}>) {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(input.commitSha)) {
        throw Object.assign(new Error('An immutable commit is required'), { code: 'git_selection_unavailable' });
    }
    return runWithScmBackendRegistryLease(input.registry, async registry => {
        input.signal?.throwIfAborted();
        const resolved = await resolveScmSelection({ workingDirectory: input.sourcePath, cwd: input.sourcePath, registry });
        const exporter = resolved?.selection.backend.workspaceIntegration?.exportCommit;
        if (!resolved || !exporter) throw Object.assign(new Error('SCM commit export is unavailable'), { code: 'unsupported' });
        const exported = await exporter({ context: resolved.context, commitSha: input.commitSha,
            artifactDirectory: input.artifactDirectory, signal: input.signal });
        try {
            input.signal?.throwIfAborted();
            if (exported.commitSha !== input.commitSha) throw Object.assign(new Error('Source commit changed'), { code: 'approval_stale' });
            const artifacts = await buildScmWorkspaceIntegrationWorkspaceExportArtifactsWithBlobProviderFromTransferEntries({ entries: exported.entries });
            // The shared portable manifest normalizes names. An immutable export may
            // never silently rename or omit a committed file at that boundary.
            const paths = new Set(artifacts.workspaceExportArtifacts.manifest.entries.filter(entry => entry.kind !== 'directory').map(entry => entry.relativePath));
            if (!exported.entries.every(entry => paths.delete(entry.relativePath)) || paths.size !== 0) {
                await artifacts.blobProvider.dispose?.();
                throw Object.assign(new Error('Commit paths cannot be materialized exactly'), { code: 'unsupported' });
            }
            return { ...artifacts, commitSha: exported.commitSha,
                ...(exported.commitSubject === undefined ? {} : { commitSubject: exported.commitSubject }), dispose: exported.dispose };
        } catch (error) { await exported.dispose(); throw error; }
    });
}
