import { z } from 'zod';

export const GIT_COMMIT_MESSAGE_MAX_LENGTH = 4096;

export const GIT_OPERATION_ERROR_CODES = {
  NOT_GIT_REPO: 'NOT_GIT_REPO',
  INVALID_PATH: 'INVALID_PATH',
  INVALID_REQUEST: 'INVALID_REQUEST',
  COMMAND_FAILED: 'COMMAND_FAILED',
  PATCH_APPLY_FAILED: 'PATCH_APPLY_FAILED',
  COMMIT_REQUIRED: 'COMMIT_REQUIRED',
  CONFLICTING_WORKTREE: 'CONFLICTING_WORKTREE',
  REMOTE_AUTH_REQUIRED: 'REMOTE_AUTH_REQUIRED',
  REMOTE_UPSTREAM_REQUIRED: 'REMOTE_UPSTREAM_REQUIRED',
  REMOTE_NON_FAST_FORWARD: 'REMOTE_NON_FAST_FORWARD',
  REMOTE_FF_ONLY_REQUIRED: 'REMOTE_FF_ONLY_REQUIRED',
  REMOTE_REJECTED: 'REMOTE_REJECTED',
  REMOTE_NOT_FOUND: 'REMOTE_NOT_FOUND',
} as const;

export type GitOperationErrorCode =
  (typeof GIT_OPERATION_ERROR_CODES)[keyof typeof GIT_OPERATION_ERROR_CODES];

export const GitOperationErrorCodeSchema = z.enum([
  GIT_OPERATION_ERROR_CODES.NOT_GIT_REPO,
  GIT_OPERATION_ERROR_CODES.INVALID_PATH,
  GIT_OPERATION_ERROR_CODES.INVALID_REQUEST,
  GIT_OPERATION_ERROR_CODES.COMMAND_FAILED,
  GIT_OPERATION_ERROR_CODES.PATCH_APPLY_FAILED,
  GIT_OPERATION_ERROR_CODES.COMMIT_REQUIRED,
  GIT_OPERATION_ERROR_CODES.CONFLICTING_WORKTREE,
  GIT_OPERATION_ERROR_CODES.REMOTE_AUTH_REQUIRED,
  GIT_OPERATION_ERROR_CODES.REMOTE_UPSTREAM_REQUIRED,
  GIT_OPERATION_ERROR_CODES.REMOTE_NON_FAST_FORWARD,
  GIT_OPERATION_ERROR_CODES.REMOTE_FF_ONLY_REQUIRED,
  GIT_OPERATION_ERROR_CODES.REMOTE_REJECTED,
  GIT_OPERATION_ERROR_CODES.REMOTE_NOT_FOUND,
]);

export const GitEntryKindSchema = z.enum([
  'modified',
  'added',
  'deleted',
  'renamed',
  'copied',
  'untracked',
  'conflicted',
]);
export type GitEntryKind = z.infer<typeof GitEntryKindSchema>;

export const GitPathStatsSchema = z.object({
  stagedAdded: z.number().int().nonnegative(),
  stagedRemoved: z.number().int().nonnegative(),
  unstagedAdded: z.number().int().nonnegative(),
  unstagedRemoved: z.number().int().nonnegative(),
  isBinary: z.boolean(),
});
export type GitPathStats = z.infer<typeof GitPathStatsSchema>;

export const GitWorkingEntrySchema = z.object({
  path: z.string(),
  previousPath: z.string().nullable(),
  kind: GitEntryKindSchema,
  indexStatus: z.string(),
  worktreeStatus: z.string(),
  hasStagedDelta: z.boolean(),
  hasUnstagedDelta: z.boolean(),
  stats: GitPathStatsSchema,
});
export type GitWorkingEntry = z.infer<typeof GitWorkingEntrySchema>;

export const GitWorkingSnapshotSchema = z.object({
  projectKey: z.string(),
  fetchedAt: z.number().int(),
  repo: z.object({
    isGitRepo: z.boolean(),
    rootPath: z.string().nullable(),
  }),
  branch: z.object({
    head: z.string().nullable(),
    upstream: z.string().nullable(),
    ahead: z.number().int().nonnegative(),
    behind: z.number().int().nonnegative(),
    detached: z.boolean(),
  }),
  stashCount: z.number().int().nonnegative(),
  hasConflicts: z.boolean(),
  entries: z.array(GitWorkingEntrySchema),
  totals: z.object({
    stagedFiles: z.number().int().nonnegative(),
    unstagedFiles: z.number().int().nonnegative(),
    untrackedFiles: z.number().int().nonnegative(),
    stagedAdded: z.number().int().nonnegative(),
    stagedRemoved: z.number().int().nonnegative(),
    unstagedAdded: z.number().int().nonnegative(),
    unstagedRemoved: z.number().int().nonnegative(),
  }),
});
export type GitWorkingSnapshot = z.infer<typeof GitWorkingSnapshotSchema>;

export const GitStatusSnapshotRequestSchema = z.object({
  cwd: z.string().optional(),
});
export type GitStatusSnapshotRequest = z.infer<typeof GitStatusSnapshotRequestSchema>;

export const GitStatusSnapshotResponseSchema = z.object({
  success: z.boolean(),
  snapshot: GitWorkingSnapshotSchema.optional(),
  error: z.string().optional(),
  errorCode: GitOperationErrorCodeSchema.optional(),
});
export type GitStatusSnapshotResponse = z.infer<typeof GitStatusSnapshotResponseSchema>;

export const GitDiffFileModeSchema = z.enum(['staged', 'unstaged', 'both']);
export type GitDiffFileMode = z.infer<typeof GitDiffFileModeSchema>;

export const GitDiffFileRequestSchema = z.object({
  cwd: z.string().optional(),
  path: z.string(),
  mode: GitDiffFileModeSchema.optional(),
});
export type GitDiffFileRequest = z.infer<typeof GitDiffFileRequestSchema>;

export const GitDiffFileResponseSchema = z.object({
  success: z.boolean(),
  diff: z.string().optional(),
  error: z.string().optional(),
  errorCode: GitOperationErrorCodeSchema.optional(),
});
export type GitDiffFileResponse = z.infer<typeof GitDiffFileResponseSchema>;

export const GitDiffCommitRequestSchema = z.object({
  cwd: z.string().optional(),
  commit: z.string(),
});
export type GitDiffCommitRequest = z.infer<typeof GitDiffCommitRequestSchema>;

export const GitDiffCommitResponseSchema = z.object({
  success: z.boolean(),
  diff: z.string().optional(),
  error: z.string().optional(),
  errorCode: GitOperationErrorCodeSchema.optional(),
});
export type GitDiffCommitResponse = z.infer<typeof GitDiffCommitResponseSchema>;

export const GitPatchApplyRequestSchema = z.object({
  cwd: z.string().optional(),
  paths: z.array(z.string()).optional(),
  patch: z.string().optional(),
});
export type GitPatchApplyRequest = z.infer<typeof GitPatchApplyRequestSchema>;

export const GitPatchApplyResponseSchema = z.object({
  success: z.boolean(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  error: z.string().optional(),
  errorCode: GitOperationErrorCodeSchema.optional(),
});
export type GitPatchApplyResponse = z.infer<typeof GitPatchApplyResponseSchema>;

export const GitCommitCreateRequestSchema = z.object({
  cwd: z.string().optional(),
  message: z.string().max(GIT_COMMIT_MESSAGE_MAX_LENGTH),
});
export type GitCommitCreateRequest = z.infer<typeof GitCommitCreateRequestSchema>;

export const GitCommitCreateResponseSchema = z.object({
  success: z.boolean(),
  commitSha: z.string().optional(),
  error: z.string().optional(),
  errorCode: GitOperationErrorCodeSchema.optional(),
});
export type GitCommitCreateResponse = z.infer<typeof GitCommitCreateResponseSchema>;

export const GitLogEntrySchema = z.object({
  sha: z.string(),
  shortSha: z.string(),
  authorName: z.string(),
  authorEmail: z.string(),
  timestamp: z.number().int(),
  subject: z.string(),
  body: z.string(),
});
export type GitLogEntry = z.infer<typeof GitLogEntrySchema>;

export const GitLogListRequestSchema = z.object({
  cwd: z.string().optional(),
  limit: z.number().int().min(1).max(500).optional(),
  skip: z.number().int().min(0).optional(),
});
export type GitLogListRequest = z.infer<typeof GitLogListRequestSchema>;

export const GitLogListResponseSchema = z.object({
  success: z.boolean(),
  entries: z.array(GitLogEntrySchema).optional(),
  error: z.string().optional(),
  errorCode: GitOperationErrorCodeSchema.optional(),
});
export type GitLogListResponse = z.infer<typeof GitLogListResponseSchema>;

export const GitCommitRevertRequestSchema = z.object({
  cwd: z.string().optional(),
  commit: z.string(),
});
export type GitCommitRevertRequest = z.infer<typeof GitCommitRevertRequestSchema>;

export const GitCommitRevertResponseSchema = z.object({
  success: z.boolean(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  error: z.string().optional(),
  errorCode: GitOperationErrorCodeSchema.optional(),
});
export type GitCommitRevertResponse = z.infer<typeof GitCommitRevertResponseSchema>;

export const GitRemoteRequestSchema = z.object({
  cwd: z.string().optional(),
  remote: z.string().optional(),
  branch: z.string().optional(),
});
export type GitRemoteRequest = z.infer<typeof GitRemoteRequestSchema>;

export const GitRemoteResponseSchema = z.object({
  success: z.boolean(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  error: z.string().optional(),
  errorCode: GitOperationErrorCodeSchema.optional(),
});
export type GitRemoteResponse = z.infer<typeof GitRemoteResponseSchema>;
