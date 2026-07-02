import {
  ReviewScmScopeV1Schema,
  ReviewStartInputSchema,
  type ReviewBase,
  type ReviewChangeType,
  type ReviewScmScopeBaseRefV1,
  type ReviewScmScopeDiagnosticCodeV1,
  type ReviewScmScopeDiagnosticV1,
  type ReviewScmScopePathV1,
  type ReviewScmScopeV1,
  type ScmWorkingEntry,
  type ScmWorkingSnapshot,
} from '@happier-dev/protocol';

import { resolveScmSelection } from '@/scm/resolveScmSelection';
import { defaultScmBackendRegistry } from '@/scm/scmBackendCatalog';
import type { ScmBackendRegistry } from '@/scm/registry';
import { normalizeRepoRootRelativePath, resolveCwd } from '@/scm/runtime';

type ReviewInputRecord = Readonly<Record<string, unknown>>;

export type ResolveReviewScmScopeInput = Readonly<{
  cwd: string;
  workingDirectory?: string;
  intentInput?: unknown;
  registry?: ScmBackendRegistry;
}>;

function isRecord(value: unknown): value is ReviewInputRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readStringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function unsupportedScope(input: Readonly<{
  code: ReviewScmScopeDiagnosticCodeV1;
  message: string;
  severity?: ReviewScmScopeDiagnosticV1['severity'];
}>): ReviewScmScopeV1 {
  return ReviewScmScopeV1Schema.parse({
    kind: 'review_scm_scope.v1',
    status: 'unsupported',
    scmBackendId: null,
    scmMode: null,
    repositoryRoot: null,
    worktreeRoot: null,
    baseRef: { source: 'unavailable', ref: null },
    selectedPaths: [],
    committedPaths: [],
    uncommittedPaths: [],
    changedPaths: [],
    diff: { committedAvailable: false, uncommittedAvailable: false },
    diagnostics: [{
      code: input.code,
      severity: input.severity ?? 'error',
      message: input.message,
    }],
  });
}

function parseReviewInput(intentInput: unknown): Readonly<{
  record: ReviewInputRecord;
  changeType: ReviewChangeType;
  base: ReviewBase;
}> {
  const raw = isRecord(intentInput) ? intentInput : {};
  const parsed = ReviewStartInputSchema.safeParse({
    engineIds: ['review-scope'],
    instructions: 'Review.',
    ...raw,
  });
  if (parsed.success) {
    return {
      record: parsed.data,
      changeType: parsed.data.changeType,
      base: parsed.data.base,
    };
  }
  return {
    record: raw,
    changeType: 'uncommitted',
    base: { kind: 'none' },
  };
}

function uniqueSafePaths(paths: readonly string[]): readonly string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    const normalized = normalizeRepoRootRelativePath(path);
    if (!normalized.ok) continue;
    if (seen.has(normalized.relativePath)) continue;
    seen.add(normalized.relativePath);
    out.push(normalized.relativePath);
  }
  return out;
}

function explicitSelectedPaths(record: ReviewInputRecord): readonly string[] {
  const fromTopLevel = readStringArray(record.selectedPaths).concat(readStringArray(record.selectedFiles));
  const engines = isRecord(record.engines) ? record.engines : {};
  const coderabbit = isRecord(engines.coderabbit) ? engines.coderabbit : {};
  const deepsec = isRecord(engines.deepsec) ? engines.deepsec : {};
  return uniqueSafePaths([
    ...fromTopLevel,
    ...readStringArray(coderabbit.selectedPaths),
    ...readStringArray(coderabbit.selectedFiles),
    ...readStringArray(deepsec.selectedPaths),
    ...readStringArray(deepsec.selectedFiles),
  ]);
}

function resolveBaseRef(input: Readonly<{
  base: ReviewBase;
  snapshot: ScmWorkingSnapshot;
}>): ReviewScmScopeBaseRefV1 {
  if (input.base.kind === 'branch') {
    return { source: 'explicit', ref: input.base.baseBranch };
  }
  if (input.base.kind === 'commit') {
    return { source: 'explicit', ref: input.base.baseCommit };
  }
  const upstream = readString(input.snapshot.branch.upstream);
  if (upstream) {
    return { source: 'branch_upstream', ref: upstream };
  }
  const defaultBranch = readString(input.snapshot.repo.defaultBranch);
  if (defaultBranch) {
    return { source: 'default_branch', ref: defaultBranch };
  }
  return { source: 'unavailable', ref: null };
}

function diffAvailable(input: Readonly<{
  area: 'committed' | 'uncommitted';
  snapshot: ScmWorkingSnapshot;
  entry?: ScmWorkingEntry;
}>): boolean {
  if (!input.snapshot.capabilities.readDiffFile) return false;
  if (input.entry?.stats.isBinary) return false;
  const areas = input.snapshot.capabilities.supportedDiffAreas;
  if (input.area === 'committed') {
    return areas.includes('included') || areas.includes('both');
  }
  return areas.includes('pending') || areas.includes('both');
}

function toReviewScopePath(input: Readonly<{
  entry: ScmWorkingEntry;
  snapshot: ScmWorkingSnapshot;
}>): ReviewScmScopePathV1 {
  return {
    path: input.entry.path,
    previousPath: input.entry.previousPath,
    kind: input.entry.kind,
    hasCommittedDelta: input.entry.hasIncludedDelta,
    hasUncommittedDelta: input.entry.hasPendingDelta,
    diff: {
      committedAvailable: input.entry.hasIncludedDelta && diffAvailable({
        area: 'committed',
        snapshot: input.snapshot,
        entry: input.entry,
      }),
      uncommittedAvailable: input.entry.hasPendingDelta && diffAvailable({
        area: 'uncommitted',
        snapshot: input.snapshot,
        entry: input.entry,
      }),
      isBinary: input.entry.stats.isBinary,
    },
  };
}

function selectPathsForChangeType(input: Readonly<{
  explicitPaths: readonly string[];
  changeType: ReviewChangeType;
  committedPaths: readonly ReviewScmScopePathV1[];
  uncommittedPaths: readonly ReviewScmScopePathV1[];
  changedPaths: readonly ReviewScmScopePathV1[];
}>): readonly string[] {
  if (input.explicitPaths.length > 0) return input.explicitPaths;
  if (input.changeType === 'committed') {
    return input.committedPaths.map((entry) => entry.path);
  }
  if (input.changeType === 'all') {
    return input.changedPaths.map((entry) => entry.path);
  }
  return input.uncommittedPaths.map((entry) => entry.path);
}

export async function resolveReviewScmScope(input: ResolveReviewScmScopeInput): Promise<ReviewScmScopeV1> {
  const workingDirectory = input.workingDirectory ?? input.cwd;
  const resolvedCwd = resolveCwd(input.cwd, workingDirectory);
  if (!resolvedCwd.ok) {
    return unsupportedScope({
      code: 'invalid_path',
      message: resolvedCwd.error,
    });
  }

  const registry = input.registry ?? defaultScmBackendRegistry;
  const selected = await resolveScmSelection({
    workingDirectory,
    cwd: resolvedCwd.cwd,
    registry,
  });
  if (!selected) {
    return unsupportedScope({
      code: 'not_repository',
      message: 'Review scope requires a source-control repository in the current session directory.',
    });
  }

  const status = await selected.selection.backend.statusSnapshot({
    context: selected.context,
    request: { cwd: resolvedCwd.cwd, includeWorktreeStatus: true },
  });
  if (!status.success || !status.snapshot || !status.snapshot.repo.isRepo) {
    return unsupportedScope({
      code: status.errorCode === 'INVALID_PATH' ? 'invalid_path' : 'scm_status_unavailable',
      message: status.error || 'SCM status snapshot is unavailable for the current review scope.',
    });
  }

  const reviewInput = parseReviewInput(input.intentInput);
  const changedPaths = status.snapshot.entries.map((entry) => toReviewScopePath({
    entry,
    snapshot: status.snapshot!,
  }));
  const committedPaths = changedPaths.filter((entry) => entry.hasCommittedDelta);
  const uncommittedPaths = changedPaths.filter((entry) => entry.hasUncommittedDelta);
  const explicitPaths = explicitSelectedPaths(reviewInput.record);
  const selectedPaths = uniqueSafePaths(selectPathsForChangeType({
    explicitPaths,
    changeType: reviewInput.changeType,
    committedPaths,
    uncommittedPaths,
    changedPaths,
  }));

  return ReviewScmScopeV1Schema.parse({
    kind: 'review_scm_scope.v1',
    status: 'supported',
    scmBackendId: status.snapshot.repo.backendId ?? selected.selection.backend.id,
    scmMode: status.snapshot.repo.mode ?? selected.selection.mode,
    repositoryRoot: status.snapshot.repo.rootPath ?? selected.context.detection.rootPath,
    worktreeRoot: status.snapshot.repo.rootPath ?? selected.context.detection.rootPath,
    baseRef: resolveBaseRef({ base: reviewInput.base, snapshot: status.snapshot }),
    selectedPaths,
    committedPaths,
    uncommittedPaths,
    changedPaths,
    diff: {
      committedAvailable: committedPaths.some((entry) => entry.diff.committedAvailable),
      uncommittedAvailable: uncommittedPaths.some((entry) => entry.diff.uncommittedAvailable),
    },
    diagnostics: [],
  });
}
