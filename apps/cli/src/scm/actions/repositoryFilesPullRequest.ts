import { createHash } from 'node:crypto';
import type { ScmActionId } from '@happier-dev/protocol';
import { ScmFileAtRevisionRequestSchema, ScmFileAtRevisionResponseSchema } from '@happier-dev/protocol/scm/fileAtRevision';
import { ScmWorktreeCreateResponseSchema, ScmWorktreeRemoveResponseSchema,
  SCM_WORKTREE_REMOVE_AUTHORIZATION_TOKEN } from '@happier-dev/protocol/scm/worktrees';
import { ScmCommitCreateResponseSchema } from '@happier-dev/protocol/scm';
import { ScmPullRequestOpenOrReuseResponseSchema } from '@happier-dev/protocol/scm/pullRequests';
import { FilesystemMutationOutputSchema, FilesystemWriteFileOutputSchema } from '@happier-dev/protocol/actions/filesystemActionFamily';
import { ScmStatusSnapshotResponseSchema } from '@happier-dev/protocol/scm';
import type { ScmRepositoryFilesPullRequestPartialV1, ScmRepositoryFilesPullRequestResultV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';

export type RepositoryFilesPullRequestHost = Readonly<{
  executeScm(actionId: ScmActionId, input: unknown): Promise<unknown>;
  writeFile(input: Readonly<{ rootPath: string; path: string; content: string; expectedHash: string | null }>): Promise<unknown>;
  deleteFile(input: Readonly<{ rootPath: string; path: string; recursive: false }>): Promise<unknown>;
}>;
export type RepositoryFilesPullRequestInput<TContent extends string | null = string | null> = Readonly<{
  cwd: string; baseCommit: string; baseBranch: string; branchName: string; title: string;
  files: readonly Readonly<{ path: string; content: TContent }>[];
}>;
export type RepositoryFilesPullRequestReview<TContent extends string | null = string | null> = Omit<RepositoryFilesPullRequestInput<TContent>, 'files'> & Readonly<{
  files: readonly Readonly<{ path: string; before: string | null; content: TContent; expectedHash: string | null }>[];
}>;
type Worktree = Readonly<{ path: string; branchName: string }>;
export type RepositoryFilesPullRequestPartial = ScmRepositoryFilesPullRequestPartialV1;
export type RepositoryFilesPullRequestResult = ScmRepositoryFilesPullRequestResultV1;

/** Captures immutable before/after bytes for the caller's ordinary exact-input review. */
export async function prepareRepositoryFilesPullRequest<TContent extends string | null>(input: RepositoryFilesPullRequestInput<TContent>,
  host: RepositoryFilesPullRequestHost): Promise<RepositoryFilesPullRequestReview<TContent>> {
  const files: RepositoryFilesPullRequestReview<TContent>['files'][number][] = [];
  for (const file of input.files) {
    const request = ScmFileAtRevisionRequestSchema.parse({ cwd: input.cwd, path: file.path, selector: { commit: input.baseCommit } });
    const read = ScmFileAtRevisionResponseSchema.parse(await host.executeScm('scm.file.read', request));
    if (!read.success && read.errorCode !== 'not_found') throw Object.assign(new Error(read.error ?? read.errorCode), { code: read.errorCode });
    const bytes = read.success ? Buffer.from(read.contentBase64, 'base64') : null;
    files.push({ path: request.path, content: file.content, before: bytes?.toString('utf8') ?? null,
      expectedHash: bytes === null ? null : createHash('sha256').update(bytes).digest('hex') });
  }
  return { ...input, files };
}

/** SCM owns the worktree, scoped commit, push and PR. The caller owns admission and review. */
export async function openRepositoryFilesPullRequest(review: RepositoryFilesPullRequestReview,
  host: RepositoryFilesPullRequestHost, continuation?: RepositoryFilesPullRequestPartial): Promise<RepositoryFilesPullRequestResult> {
  let worktree: Worktree | undefined;
  let headCommit = continuation?.headCommit;
  let pullRequest = continuation?.pullRequest;
  const writtenPaths = new Set(continuation?.writtenPaths ?? []);
  let stage: RepositoryFilesPullRequestPartial['stage'] = 'worktree';
  const partial = (errorCode: string): RepositoryFilesPullRequestPartial => ({ kind: 'partial', stage, errorCode,
    ...(worktree ? { worktree } : {}), ...(headCommit ? { headCommit } : {}), ...(pullRequest ? { pullRequest } : {}), writtenPaths: [...writtenPaths] });
  try {
    {
      const created = ScmWorktreeCreateResponseSchema.parse(await host.executeScm('scm.worktree.create', {
        cwd: review.cwd, displayName: review.branchName, baseRef: review.baseCommit, branchMode: 'new',
      }));
      if (!created.success) return partial(created.errorCode ?? 'COMMAND_FAILED');
      worktree = { path: created.worktreePath, branchName: created.branchName };
      // A public continuation cannot grant an arbitrary filesystem destination.
      if (continuation?.worktree && (continuation.worktree.path !== worktree.path
        || continuation.worktree.branchName !== worktree.branchName)) return partial('CONFLICTING_WORKTREE');
    }
    if (headCommit) {
      const status = ScmStatusSnapshotResponseSchema.parse(await host.executeScm('scm.status.snapshot', { cwd: worktree.path }));
      if (!status.success || status.snapshot?.branch.headOid !== headCommit) return partial('COMMIT_HEAD_CHANGED');
      const captured = await prepareRepositoryFilesPullRequest({ ...review, cwd: worktree.path, baseCommit: headCommit }, host);
      if (captured.files.some(file => file.before !== file.content)) return partial('FILE_CHANGED');
    }
    if (!headCommit) {
      stage = 'write';
      for (const file of review.files) {
        if (file.content === null) {
          // Only the owned worktree at the reviewed immutable base is changed.
          if (file.before !== null && !writtenPaths.has(file.path)) {
            const removed = FilesystemMutationOutputSchema.parse(await host.deleteFile({ rootPath: worktree.path,
              path: file.path, recursive: false }));
            if (!removed.success) return partial(removed.errorCode ?? 'file_replace_failed');
          }
        } else {
          const written = FilesystemWriteFileOutputSchema.parse(await host.writeFile({ rootPath: worktree.path,
            path: file.path, content: Buffer.from(file.content, 'utf8').toString('base64'), expectedHash: writtenPaths.has(file.path)
              ? createHash('sha256').update(file.content, 'utf8').digest('hex') : file.expectedHash }));
          if (!written.success) return partial(written.errorCode ?? 'file_replace_failed');
        }
        writtenPaths.add(file.path);
      }
      stage = 'commit';
      const committed = ScmCommitCreateResponseSchema.parse(await host.executeScm('scm.commit.create', {
        cwd: worktree.path, message: review.title, expectedHeadOid: review.baseCommit,
        expectedRef: `refs/heads/${worktree.branchName}`, scope: { kind: 'paths', include: review.files.map(file => file.path) },
      }));
      if (!committed.success) return partial(committed.errorCode ?? 'COMMAND_FAILED');
      if (committed.publication?.state !== 'published' || !committed.publication.candidateOid) return partial('COMMAND_OUTCOME_UNKNOWN');
      headCommit = committed.publication.candidateOid;
    }
    if (!pullRequest) {
      stage = 'pullRequest';
      // openOrReuse already owns branch publication and exact head/base reuse.
      const opened = ScmPullRequestOpenOrReuseResponseSchema.parse(await host.executeScm('scm.pullRequest.openOrReuse', {
        cwd: worktree.path, base: review.baseBranch, head: worktree.branchName, title: review.title,
      }));
      if (!opened.success) return partial(opened.errorCode ?? 'COMMAND_FAILED');
      if (!opened.pullRequest) return partial('COMMAND_OUTCOME_UNKNOWN');
      pullRequest = opened.pullRequest;
    }
    stage = 'cleanup';
    const removed = ScmWorktreeRemoveResponseSchema.parse(await host.executeScm('scm.worktree.remove', {
      cwd: review.cwd, worktreePath: worktree.path, confirmed: true, authorizationToken: SCM_WORKTREE_REMOVE_AUTHORIZATION_TOKEN,
    }));
    if (!removed.success) return partial(removed.errorCode ?? 'COMMAND_FAILED');
    return { kind: 'pullRequest', pullRequest, headCommit, branchName: worktree.branchName };
  } catch (error) {
    return partial(error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'invalid_action_output');
  }
}
