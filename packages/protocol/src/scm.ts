import { z } from 'zod';

export const SCM_COMMIT_MESSAGE_MAX_LENGTH = 4096;
export const SCM_COMMIT_PATCH_MAX_COUNT = 256;
export const SCM_COMMIT_PATCH_MAX_LENGTH = 200_000;

export const SCM_OPERATION_ERROR_CODES = {
  NOT_REPOSITORY: 'NOT_REPOSITORY',
  INVALID_PATH: 'INVALID_PATH',
  INVALID_REQUEST: 'INVALID_REQUEST',
  COMMAND_FAILED: 'COMMAND_FAILED',
  CHANGE_APPLY_FAILED: 'CHANGE_APPLY_FAILED',
  COMMIT_REQUIRED: 'COMMIT_REQUIRED',
  CONFLICTING_WORKTREE: 'CONFLICTING_WORKTREE',
  REMOTE_AUTH_REQUIRED: 'REMOTE_AUTH_REQUIRED',
  REMOTE_UPSTREAM_REQUIRED: 'REMOTE_UPSTREAM_REQUIRED',
  REMOTE_NON_FAST_FORWARD: 'REMOTE_NON_FAST_FORWARD',
  REMOTE_FF_ONLY_REQUIRED: 'REMOTE_FF_ONLY_REQUIRED',
  REMOTE_REJECTED: 'REMOTE_REJECTED',
  REMOTE_NOT_FOUND: 'REMOTE_NOT_FOUND',
  FEATURE_UNSUPPORTED: 'FEATURE_UNSUPPORTED',
  BACKEND_UNAVAILABLE: 'BACKEND_UNAVAILABLE',
} as const;

export type ScmOperationErrorCode =
  (typeof SCM_OPERATION_ERROR_CODES)[keyof typeof SCM_OPERATION_ERROR_CODES];

export const ScmOperationErrorCodeSchema = z.enum([
  SCM_OPERATION_ERROR_CODES.NOT_REPOSITORY,
  SCM_OPERATION_ERROR_CODES.INVALID_PATH,
  SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
  SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
  SCM_OPERATION_ERROR_CODES.CHANGE_APPLY_FAILED,
  SCM_OPERATION_ERROR_CODES.COMMIT_REQUIRED,
  SCM_OPERATION_ERROR_CODES.CONFLICTING_WORKTREE,
  SCM_OPERATION_ERROR_CODES.REMOTE_AUTH_REQUIRED,
  SCM_OPERATION_ERROR_CODES.REMOTE_UPSTREAM_REQUIRED,
  SCM_OPERATION_ERROR_CODES.REMOTE_NON_FAST_FORWARD,
  SCM_OPERATION_ERROR_CODES.REMOTE_FF_ONLY_REQUIRED,
  SCM_OPERATION_ERROR_CODES.REMOTE_REJECTED,
  SCM_OPERATION_ERROR_CODES.REMOTE_NOT_FOUND,
  SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
  SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE,
]);

export const ScmBackendIdSchema = z.enum(['git', 'sapling']);
export type ScmBackendId = z.infer<typeof ScmBackendIdSchema>;

export const ScmRepoModeSchema = z.enum(['.git', '.sl']);
export type ScmRepoMode = z.infer<typeof ScmRepoModeSchema>;

export const ScmBackendPreferenceSchema = z.object({
  kind: z.literal('prefer'),
  backendId: ScmBackendIdSchema,
});
export type ScmBackendPreference = z.infer<typeof ScmBackendPreferenceSchema>;

export const ScmDiffAreaSchema = z.enum(['included', 'pending', 'both']);
export type ScmDiffArea = z.infer<typeof ScmDiffAreaSchema>;

export const ScmChangeSetModelSchema = z.enum(['index', 'working-copy']);
export type ScmChangeSetModel = z.infer<typeof ScmChangeSetModelSchema>;

export const ScmCapabilitiesSchema = z.object({
  readStatus: z.boolean(),
  readDiffFile: z.boolean(),
  readDiffCommit: z.boolean(),
  readLog: z.boolean(),
  writeInclude: z.boolean(),
  writeExclude: z.boolean(),
  writeCommit: z.boolean(),
  writeCommitPathSelection: z.boolean(),
  writeCommitLineSelection: z.boolean(),
  writeBackout: z.boolean(),
  writeRemoteFetch: z.boolean(),
  writeRemotePull: z.boolean(),
  writeRemotePush: z.boolean(),
  workspaceWorktreeCreate: z.boolean(),
  changeSetModel: ScmChangeSetModelSchema,
  supportedDiffAreas: z.array(ScmDiffAreaSchema).min(1),
  operationLabels: z
    .object({
      commit: z.string().optional(),
      include: z.string().optional(),
      exclude: z.string().optional(),
      backout: z.string().optional(),
      fetch: z.string().optional(),
      pull: z.string().optional(),
      push: z.string().optional(),
    })
    .optional(),
});
export type ScmCapabilities = z.infer<typeof ScmCapabilitiesSchema>;

export const ScmEntryKindSchema = z.enum([
  'modified',
  'added',
  'deleted',
  'renamed',
  'copied',
  'untracked',
  'conflicted',
]);
export type ScmEntryKind = z.infer<typeof ScmEntryKindSchema>;

export const ScmPathStatsSchema = z.object({
  includedAdded: z.number().int().nonnegative(),
  includedRemoved: z.number().int().nonnegative(),
  pendingAdded: z.number().int().nonnegative(),
  pendingRemoved: z.number().int().nonnegative(),
  isBinary: z.boolean(),
});
export type ScmPathStats = z.infer<typeof ScmPathStatsSchema>;

export const ScmWorkingEntrySchema = z.object({
  path: z.string(),
  previousPath: z.string().nullable(),
  kind: ScmEntryKindSchema,
  includeStatus: z.string(),
  pendingStatus: z.string(),
  hasIncludedDelta: z.boolean(),
  hasPendingDelta: z.boolean(),
  stats: ScmPathStatsSchema,
});
export type ScmWorkingEntry = z.infer<typeof ScmWorkingEntrySchema>;

export const ScmWorkingSnapshotSchema = z.object({
  projectKey: z.string(),
  fetchedAt: z.number().int(),
  repo: z.object({
    isRepo: z.boolean(),
    rootPath: z.string().nullable(),
    backendId: ScmBackendIdSchema.nullable(),
    mode: ScmRepoModeSchema.nullable(),
  }),
  capabilities: ScmCapabilitiesSchema,
  branch: z.object({
    head: z.string().nullable(),
    upstream: z.string().nullable(),
    ahead: z.number().int().nonnegative(),
    behind: z.number().int().nonnegative(),
    detached: z.boolean(),
  }),
  stashCount: z.number().int().nonnegative().optional(),
  hasConflicts: z.boolean(),
  entries: z.array(ScmWorkingEntrySchema),
  totals: z.object({
    includedFiles: z.number().int().nonnegative(),
    pendingFiles: z.number().int().nonnegative(),
    untrackedFiles: z.number().int().nonnegative(),
    includedAdded: z.number().int().nonnegative(),
    includedRemoved: z.number().int().nonnegative(),
    pendingAdded: z.number().int().nonnegative(),
    pendingRemoved: z.number().int().nonnegative(),
  }),
});
export type ScmWorkingSnapshot = z.infer<typeof ScmWorkingSnapshotSchema>;

export const ScmRequestBaseSchema = z.object({
  cwd: z.string().optional(),
  backendPreference: ScmBackendPreferenceSchema.optional(),
});
export type ScmRequestBase = z.infer<typeof ScmRequestBaseSchema>;

export const ScmBackendDescribeRequestSchema = ScmRequestBaseSchema;
export type ScmBackendDescribeRequest = z.infer<typeof ScmBackendDescribeRequestSchema>;

export const ScmBackendDescribeResponseSchema = z.object({
  success: z.boolean(),
  backendId: ScmBackendIdSchema.optional(),
  repoMode: ScmRepoModeSchema.optional(),
  isRepo: z.boolean().optional(),
  capabilities: ScmCapabilitiesSchema.optional(),
  error: z.string().optional(),
  errorCode: ScmOperationErrorCodeSchema.optional(),
});
export type ScmBackendDescribeResponse = z.infer<typeof ScmBackendDescribeResponseSchema>;

export const ScmStatusSnapshotRequestSchema = ScmRequestBaseSchema;
export type ScmStatusSnapshotRequest = z.infer<typeof ScmStatusSnapshotRequestSchema>;

export const ScmStatusSnapshotResponseSchema = z.object({
  success: z.boolean(),
  snapshot: ScmWorkingSnapshotSchema.optional(),
  error: z.string().optional(),
  errorCode: ScmOperationErrorCodeSchema.optional(),
});
export type ScmStatusSnapshotResponse = z.infer<typeof ScmStatusSnapshotResponseSchema>;

export const ScmDiffFileRequestSchema = ScmRequestBaseSchema.extend({
  path: z.string(),
  area: ScmDiffAreaSchema.optional(),
});
export type ScmDiffFileRequest = z.infer<typeof ScmDiffFileRequestSchema>;

export const ScmDiffFileResponseSchema = z.object({
  success: z.boolean(),
  diff: z.string().optional(),
  error: z.string().optional(),
  errorCode: ScmOperationErrorCodeSchema.optional(),
});
export type ScmDiffFileResponse = z.infer<typeof ScmDiffFileResponseSchema>;

export const ScmDiffCommitRequestSchema = ScmRequestBaseSchema.extend({
  commit: z.string(),
});
export type ScmDiffCommitRequest = z.infer<typeof ScmDiffCommitRequestSchema>;

export const ScmDiffCommitResponseSchema = z.object({
  success: z.boolean(),
  diff: z.string().optional(),
  error: z.string().optional(),
  errorCode: ScmOperationErrorCodeSchema.optional(),
});
export type ScmDiffCommitResponse = z.infer<typeof ScmDiffCommitResponseSchema>;

export const ScmChangeApplyRequestSchema = ScmRequestBaseSchema.extend({
  paths: z.array(z.string()).optional(),
  patch: z.string().optional(),
});
export type ScmChangeApplyRequest = z.infer<typeof ScmChangeApplyRequestSchema>;

export const ScmChangeApplyResponseSchema = z.object({
  success: z.boolean(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  error: z.string().optional(),
  errorCode: ScmOperationErrorCodeSchema.optional(),
});
export type ScmChangeApplyResponse = z.infer<typeof ScmChangeApplyResponseSchema>;

export const ScmChangeDiscardEntrySchema = z.object({
  path: z.string(),
  kind: ScmEntryKindSchema,
});
export type ScmChangeDiscardEntry = z.infer<typeof ScmChangeDiscardEntrySchema>;

export const ScmChangeDiscardRequestSchema = ScmRequestBaseSchema.extend({
  entries: z.array(ScmChangeDiscardEntrySchema).min(1),
});
export type ScmChangeDiscardRequest = z.infer<typeof ScmChangeDiscardRequestSchema>;

export const ScmChangeDiscardResponseSchema = z.object({
  success: z.boolean(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  error: z.string().optional(),
  errorCode: ScmOperationErrorCodeSchema.optional(),
});
export type ScmChangeDiscardResponse = z.infer<typeof ScmChangeDiscardResponseSchema>;

export const ScmCommitPatchSchema = z.object({
  path: z.string(),
  patch: z.string().min(1).max(SCM_COMMIT_PATCH_MAX_LENGTH),
});
export type ScmCommitPatch = z.infer<typeof ScmCommitPatchSchema>;

export const ScmCommitCreateRequestSchema = ScmRequestBaseSchema.extend({
  message: z.string().max(SCM_COMMIT_MESSAGE_MAX_LENGTH),
  scope: z
    .union([
      z.object({
        kind: z.literal('all-pending'),
      }),
      z.object({
        kind: z.literal('paths'),
        include: z.array(z.string()).min(1),
        exclude: z.array(z.string()).optional(),
      }),
    ])
    .optional(),
  patches: z.array(ScmCommitPatchSchema).min(1).max(SCM_COMMIT_PATCH_MAX_COUNT).optional(),
});
export type ScmCommitCreateRequest = z.infer<typeof ScmCommitCreateRequestSchema>;

export const ScmCommitCreateResponseSchema = z.object({
  success: z.boolean(),
  commitSha: z.string().optional(),
  error: z.string().optional(),
  errorCode: ScmOperationErrorCodeSchema.optional(),
});
export type ScmCommitCreateResponse = z.infer<typeof ScmCommitCreateResponseSchema>;

function normalizeScmPatchPathToken(raw: string): string | null {
  let value = raw.trim();
  if (!value || value === '/dev/null') return null;

  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    value = value.slice(1, -1);
  }

  value = value.replace(/^([ab])\//, '').replace(/^\.\/+/, '').trim();
  if (!value || value === '/dev/null') return null;
  return value;
}

function tokenizeScmDiffHeader(value: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] ?? '';
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && /\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }

  if (current) tokens.push(current);
  return tokens;
}

function parseScmGitDiffHeaderPath(line: string): string[] {
  const raw = line.slice('diff --git '.length).trim();
  if (!raw) return [];

  const tokens = tokenizeScmDiffHeader(raw);
  if (tokens.length < 2) return [];

  const left = normalizeScmPatchPathToken(tokens[0] ?? '');
  const right = normalizeScmPatchPathToken(tokens[1] ?? '');
  return [left, right].filter((value): value is string => Boolean(value));
}

export function parseScmPatchPaths(patch: string): string[] {
  const normalized = String(patch ?? '').replace(/\r\n/g, '\n');
  if (!normalized.trim()) return [];

  const seen = new Set<string>();
  for (const line of normalized.split('\n')) {
    if (line.startsWith('diff --git ')) {
      for (const path of parseScmGitDiffHeaderPath(line)) {
        seen.add(path);
      }
      continue;
    }

    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      const parsed = normalizeScmPatchPathToken(line.slice(4));
      if (parsed) seen.add(parsed);
    }
  }

  return Array.from(seen);
}

export function isScmPatchBoundToPath(path: string, patch: string): boolean {
  const normalizedPath = normalizeScmPatchPathToken(path);
  if (!normalizedPath) return false;
  const parsedPaths = parseScmPatchPaths(patch);
  if (parsedPaths.length === 0) return false;
  return parsedPaths.every((parsedPath) => parsedPath === normalizedPath);
}

export const ScmLogEntrySchema = z.object({
  sha: z.string(),
  shortSha: z.string(),
  authorName: z.string(),
  authorEmail: z.string(),
  timestamp: z.number().int(),
  subject: z.string(),
  body: z.string(),
});
export type ScmLogEntry = z.infer<typeof ScmLogEntrySchema>;

export const ScmLogListRequestSchema = ScmRequestBaseSchema.extend({
  limit: z.number().int().min(1).max(500).optional(),
  skip: z.number().int().min(0).optional(),
});
export type ScmLogListRequest = z.infer<typeof ScmLogListRequestSchema>;

export const ScmLogListResponseSchema = z.object({
  success: z.boolean(),
  entries: z.array(ScmLogEntrySchema).optional(),
  error: z.string().optional(),
  errorCode: ScmOperationErrorCodeSchema.optional(),
});
export type ScmLogListResponse = z.infer<typeof ScmLogListResponseSchema>;

export const ScmCommitBackoutRequestSchema = ScmRequestBaseSchema.extend({
  commit: z.string(),
});
export type ScmCommitBackoutRequest = z.infer<typeof ScmCommitBackoutRequestSchema>;

export const ScmCommitBackoutResponseSchema = z.object({
  success: z.boolean(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  error: z.string().optional(),
  errorCode: ScmOperationErrorCodeSchema.optional(),
});
export type ScmCommitBackoutResponse = z.infer<typeof ScmCommitBackoutResponseSchema>;

export const ScmRemoteRequestSchema = ScmRequestBaseSchema.extend({
  remote: z.string().optional(),
  branch: z.string().optional(),
});
export type ScmRemoteRequest = z.infer<typeof ScmRemoteRequestSchema>;

export const ScmRemoteResponseSchema = z.object({
  success: z.boolean(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  error: z.string().optional(),
  errorCode: ScmOperationErrorCodeSchema.optional(),
});
export type ScmRemoteResponse = z.infer<typeof ScmRemoteResponseSchema>;

export type ScmRemoteTarget = {
  remote: string;
  branch: string | null;
};

export function parseScmUpstreamRef(upstream: string | null | undefined): ScmRemoteTarget | null {
  if (!upstream) return null;
  const slashIndex = upstream.indexOf('/');
  if (slashIndex <= 0 || slashIndex === upstream.length - 1) {
    return null;
  }
  return {
    remote: upstream.slice(0, slashIndex),
    branch: upstream.slice(slashIndex + 1),
  };
}

export function inferScmRemoteTarget(input: {
  upstream: string | null | undefined;
  head: string | null | undefined;
  defaultRemote?: string;
  allowHeadFallback?: boolean;
}): ScmRemoteTarget {
  const parsed = parseScmUpstreamRef(input.upstream);
  if (parsed) return parsed;
  return {
    remote: input.defaultRemote ?? 'origin',
    branch: input.allowHeadFallback ? (input.head ?? null) : null,
  };
}

export type ScmRemoteMutationKind = 'push' | 'pull';

export type ScmRemoteMutationReason =
  | 'conflicts_present'
  | 'upstream_required'
  | 'detached_head'
  | 'branch_behind_remote'
  | 'clean_worktree_required';

export type ScmRemoteMutationSnapshot = {
  hasConflicts: boolean;
  branch: Pick<ScmWorkingSnapshot['branch'], 'head' | 'upstream' | 'behind' | 'detached'>;
  totals: Pick<ScmWorkingSnapshot['totals'], 'includedFiles' | 'pendingFiles' | 'untrackedFiles'>;
};

export type ScmRemoteMutationPolicy = {
  requireUpstreamWhenNoExplicitTarget: boolean;
  requireActiveHead: boolean;
  blockPushOnConflicts: boolean;
  blockPushWhenBehind: boolean;
  requireCleanPull: boolean;
};

export type ScmRemoteMutationResult =
  | { ok: true }
  | { ok: false; reason: ScmRemoteMutationReason };

export type ScmRemoteRequestNormalizationResult =
  | { ok: true; request: { remote: string | undefined; branch: string | undefined } }
  | { ok: false; error: string };

const CONTROL_CHAR_REGEX = /[\u0000-\u001F\u007F]/;

function hasUnsupportedRemoteRefSyntax(value: string, label: 'Remote name' | 'Branch name'): boolean {
  if (CONTROL_CHAR_REGEX.test(value)) return true;
  if (value.includes('\\')) return true;
  if (value.includes('//')) return true;
  if (value.startsWith('/') || value.endsWith('/')) return true;
  if (value.includes('@{') || value.includes('..')) return true;

  if (label === 'Remote name') {
    return value.includes(':');
  }

  return (
    value.startsWith('+') ||
    value.startsWith('.') ||
    value.endsWith('.') ||
    value.endsWith('.lock') ||
    value.includes(':') ||
    value.includes('^') ||
    value.includes('~') ||
    value.includes('?') ||
    value.includes('*') ||
    value.includes('[')
  );
}

function normalizeRemoteRefValue(
  value: string | undefined,
  label: 'Remote name' | 'Branch name'
): { ok: true; value: string | undefined } | { ok: false; error: string } {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  const normalized = value.trim();
  if (!normalized) {
    return { ok: true, value: undefined };
  }
  if (normalized.startsWith('-')) {
    return { ok: false, error: `${label} cannot start with "-"` };
  }
  if (/\s/.test(normalized)) {
    return { ok: false, error: `${label} must not contain whitespace` };
  }
  if (normalized.includes('\0')) {
    return { ok: false, error: `${label} contains unsupported characters` };
  }
  if (hasUnsupportedRemoteRefSyntax(normalized, label)) {
    return { ok: false, error: `${label} contains unsupported syntax` };
  }
  return { ok: true, value: normalized };
}

export function normalizeScmRemoteRequest(
  request: Readonly<Pick<ScmRemoteRequest, 'remote' | 'branch'>>
): ScmRemoteRequestNormalizationResult {
  const remote = normalizeRemoteRefValue(request.remote, 'Remote name');
  if (!remote.ok) {
    return remote;
  }
  const branch = normalizeRemoteRefValue(request.branch, 'Branch name');
  if (!branch.ok) {
    return branch;
  }
  return {
    ok: true,
    request: {
      remote: remote.value,
      branch: branch.value,
    },
  };
}

export function hasAnyPendingScmChanges(snapshot: Pick<ScmRemoteMutationSnapshot, 'totals'>): boolean {
  return (
    snapshot.totals.includedFiles > 0 ||
    snapshot.totals.pendingFiles > 0 ||
    snapshot.totals.untrackedFiles > 0
  );
}

export function evaluateScmRemoteMutationPolicy(input: {
  kind: ScmRemoteMutationKind;
  snapshot: ScmRemoteMutationSnapshot;
  hasExplicitTarget: boolean;
  policy: ScmRemoteMutationPolicy;
}): ScmRemoteMutationResult {
  const { kind, snapshot, hasExplicitTarget, policy } = input;

  if (kind === 'push' && policy.blockPushOnConflicts && snapshot.hasConflicts) {
    return { ok: false, reason: 'conflicts_present' };
  }

  if (policy.requireUpstreamWhenNoExplicitTarget && !hasExplicitTarget && !snapshot.branch.upstream) {
    return { ok: false, reason: 'upstream_required' };
  }

  if (snapshot.branch.detached || (policy.requireActiveHead && !snapshot.branch.head)) {
    return { ok: false, reason: 'detached_head' };
  }

  if (kind === 'push' && policy.blockPushWhenBehind && snapshot.branch.behind > 0) {
    return { ok: false, reason: 'branch_behind_remote' };
  }

  if (kind === 'pull' && policy.requireCleanPull && (snapshot.hasConflicts || hasAnyPendingScmChanges(snapshot))) {
    return { ok: false, reason: 'clean_worktree_required' };
  }

  return { ok: true };
}

export type ScmOperationErrorCategory =
  | 'repository'
  | 'path'
  | 'request'
  | 'command'
  | 'change'
  | 'commit'
  | 'worktree'
  | 'remote'
  | 'capability'
  | 'backend'
  | 'unknown';

export function classifyScmOperationErrorCode(
  errorCode: ScmOperationErrorCode | undefined
): ScmOperationErrorCategory {
  switch (errorCode) {
    case SCM_OPERATION_ERROR_CODES.NOT_REPOSITORY:
      return 'repository';
    case SCM_OPERATION_ERROR_CODES.INVALID_PATH:
      return 'path';
    case SCM_OPERATION_ERROR_CODES.INVALID_REQUEST:
      return 'request';
    case SCM_OPERATION_ERROR_CODES.COMMAND_FAILED:
      return 'command';
    case SCM_OPERATION_ERROR_CODES.CHANGE_APPLY_FAILED:
      return 'change';
    case SCM_OPERATION_ERROR_CODES.COMMIT_REQUIRED:
      return 'commit';
    case SCM_OPERATION_ERROR_CODES.CONFLICTING_WORKTREE:
      return 'worktree';
    case SCM_OPERATION_ERROR_CODES.REMOTE_AUTH_REQUIRED:
    case SCM_OPERATION_ERROR_CODES.REMOTE_UPSTREAM_REQUIRED:
    case SCM_OPERATION_ERROR_CODES.REMOTE_NON_FAST_FORWARD:
    case SCM_OPERATION_ERROR_CODES.REMOTE_FF_ONLY_REQUIRED:
    case SCM_OPERATION_ERROR_CODES.REMOTE_REJECTED:
    case SCM_OPERATION_ERROR_CODES.REMOTE_NOT_FOUND:
      return 'remote';
    case SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED:
      return 'capability';
    case SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE:
      return 'backend';
    default:
      return 'unknown';
  }
}

export function mapSaplingScmErrorCode(stderr: string): ScmOperationErrorCode {
  const lower = String(stderr ?? '').toLowerCase();
  if (lower.includes('no repository found') || lower.includes('not inside a repository')) {
    return SCM_OPERATION_ERROR_CODES.NOT_REPOSITORY;
  }
  if (lower.includes('authentication') || lower.includes('permission denied') || lower.includes('authorization')) {
    return SCM_OPERATION_ERROR_CODES.REMOTE_AUTH_REQUIRED;
  }
  if (lower.includes('bookmark') && lower.includes('not found')) {
    return SCM_OPERATION_ERROR_CODES.REMOTE_UPSTREAM_REQUIRED;
  }
  if (lower.includes("use '--to' to specify destination bookmark")) {
    return SCM_OPERATION_ERROR_CODES.REMOTE_UPSTREAM_REQUIRED;
  }
  if (lower.includes('you must specify a destination for the update')) {
    return SCM_OPERATION_ERROR_CODES.REMOTE_UPSTREAM_REQUIRED;
  }
  if (lower.includes('does not have a name')) {
    return SCM_OPERATION_ERROR_CODES.REMOTE_NOT_FOUND;
  }
  if (lower.includes('non-fast-forward') || lower.includes('push creates new remote head')) {
    return SCM_OPERATION_ERROR_CODES.REMOTE_NON_FAST_FORWARD;
  }
  if (lower.includes('remote rejected')) {
    return SCM_OPERATION_ERROR_CODES.REMOTE_REJECTED;
  }
  return SCM_OPERATION_ERROR_CODES.COMMAND_FAILED;
}

export function mapGitScmErrorCode(stderr: string): ScmOperationErrorCode {
  const lower = String(stderr ?? '').toLowerCase();
  if (lower.includes('not a git repository')) {
    return SCM_OPERATION_ERROR_CODES.NOT_REPOSITORY;
  }
  if (lower.includes('no such remote') || lower.includes('does not appear to be a git repository')) {
    return SCM_OPERATION_ERROR_CODES.REMOTE_NOT_FOUND;
  }
  if (
    lower.includes('authentication failed') ||
    lower.includes('permission denied') ||
    lower.includes('could not read username') ||
    lower.includes('terminal prompts disabled') ||
    lower.includes('support for password authentication was removed')
  ) {
    return SCM_OPERATION_ERROR_CODES.REMOTE_AUTH_REQUIRED;
  }
  if (
    lower.includes('no upstream configured') ||
    lower.includes('has no upstream branch') ||
    lower.includes('no tracking information for the current branch')
  ) {
    return SCM_OPERATION_ERROR_CODES.REMOTE_UPSTREAM_REQUIRED;
  }
  if (
    lower.includes('non-fast-forward') ||
    lower.includes('fetch first') ||
    lower.includes('tip of your current branch is behind')
  ) {
    return SCM_OPERATION_ERROR_CODES.REMOTE_NON_FAST_FORWARD;
  }
  if (lower.includes('not possible to fast-forward') || (lower.includes('ff-only') && lower.includes('aborting'))) {
    return SCM_OPERATION_ERROR_CODES.REMOTE_FF_ONLY_REQUIRED;
  }
  if (
    lower.includes('remote rejected') ||
    lower.includes('pre-receive hook declined') ||
    lower.includes('protected branch hook declined') ||
    lower.includes('remote: error: gh006') ||
    lower.includes('remote: error: gh013')
  ) {
    return SCM_OPERATION_ERROR_CODES.REMOTE_REJECTED;
  }
  return SCM_OPERATION_ERROR_CODES.COMMAND_FAILED;
}
