import type { ScmDiffFileRequest, ScmDiffFileResponse, ScmStatusSnapshotRequest, ScmStatusSnapshotResponse, ScmWorkingSnapshot } from '@happier-dev/protocol';
import {
  ExecutionRunScmCommitMessageScopeV1Schema,
  ScmDiffFileResponseSchema,
  ScmStatusSnapshotResponseSchema,
} from '@happier-dev/protocol';

import {
  createNonRepositoryScmSnapshotResponse,
  notRepositoryResponse,
  runScmRoute,
} from '@/scm/rpc/dispatch';

type ScmSnapshotEntry = Readonly<{
  path: string;
  hasIncludedDelta?: boolean;
  hasPendingDelta?: boolean;
}>;

function isScmSnapshotEntry(value: unknown): value is ScmSnapshotEntry {
  if (!value || typeof value !== 'object') return false;
  const anyValue = value as { path?: unknown };
  return typeof anyValue.path === 'string' && anyValue.path.trim().length > 0;
}

export async function loadScmCommitMessageContext(params: Readonly<{
  workingDirectory: string;
  maxFiles: number;
  maxTotalDiffChars: number;
  scope?: unknown;
}>): Promise<
  | { ok: true; snapshot: ScmWorkingSnapshot; diffsByPath: ReadonlyArray<{ path: string; diff: string }> }
  | { ok: false; errorCode: string; error: string }
> {
  const workingDirectory = params.workingDirectory;

  const snapshotRes = await runScmRoute<ScmStatusSnapshotRequest, ScmStatusSnapshotResponse>({
    request: {},
    workingDirectory,
    onNonRepository: async ({ cwd }) =>
      createNonRepositoryScmSnapshotResponse({
        workingDirectory,
        cwd,
      }),
    runWithBackend: ({ context, selection }) => selection.backend.statusSnapshot({ context, request: {} }),
  });

  const parsedSnapshot = ScmStatusSnapshotResponseSchema.safeParse(snapshotRes);
  if (!parsedSnapshot.success) {
    return { ok: false, errorCode: 'task_failed', error: 'Unsupported SCM snapshot response' };
  }
  if (!parsedSnapshot.data.success || !parsedSnapshot.data.snapshot) {
    return { ok: false, errorCode: parsedSnapshot.data.errorCode ?? 'not_repository', error: parsedSnapshot.data.error ?? 'Not a repository' };
  }

  const snapshot = parsedSnapshot.data.snapshot;
  if (!snapshot.repo?.isRepo) {
    return { ok: false, errorCode: 'not_repository', error: 'Not a repository' };
  }

  const maxFiles = Math.max(0, params.maxFiles);
  const parsedScope = ExecutionRunScmCommitMessageScopeV1Schema.safeParse(params.scope);
  const scopeInclude = parsedScope.success ? parsedScope.data.include ?? [] : [];

  const resolveCandidatePaths = (): string[] => {
    if (parsedScope.success && parsedScope.data.kind === 'paths' && scopeInclude.length > 0) {
      const seen = new Set<string>();
      const out: string[] = [];
      for (const value of scopeInclude) {
        const path = value.trim();
        if (!path || seen.has(path)) continue;
        seen.add(path);
        out.push(path);
        if (out.length >= maxFiles) break;
      }
      return out;
    }

    return (snapshot.entries ?? [])
      .filter(isScmSnapshotEntry)
      .filter((e) => Boolean(e.hasIncludedDelta || e.hasPendingDelta))
      .map((e) => e.path.trim())
      .slice(0, maxFiles);
  };

  const candidatePaths = resolveCandidatePaths();

  const diffsByPath: Array<{ path: string; diff: string }> = [];
  let remaining = params.maxTotalDiffChars;

  for (const path of candidatePaths) {
    if (remaining <= 0) break;
    const diffRes = await runScmRoute<ScmDiffFileRequest, ScmDiffFileResponse>({
      request: { path, area: 'both' },
      workingDirectory,
      onNonRepository: async () => notRepositoryResponse<ScmDiffFileResponse>(),
      runWithBackend: ({ context, selection }) => selection.backend.diffFile({ context, request: { path, area: 'both' } }),
    });

    const parsedDiff = ScmDiffFileResponseSchema.safeParse(diffRes);
    if (!parsedDiff.success || !parsedDiff.data.success) continue;
    const diff = parsedDiff.data.diff ?? '';
    if (!diff) continue;

    const slice = diff.length > remaining ? diff.slice(0, remaining) : diff;
    remaining -= slice.length;
    diffsByPath.push({ path, diff: slice });
  }

  return { ok: true, snapshot, diffsByPath };
}
