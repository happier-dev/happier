import type { ScmDiffFileRequest, ScmDiffFileResponse, ScmStatusSnapshotRequest, ScmStatusSnapshotResponse, ScmWorkingSnapshot } from '@happier-dev/protocol';
import { ScmStatusSnapshotResponseSchema } from '@happier-dev/protocol';

import {
  createNonRepositoryScmSnapshotResponse,
  notRepositoryResponse,
  runScmRoute,
} from '@/scm/rpc/dispatch';

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
  const scopedKind = typeof (params.scope as any)?.kind === 'string' ? String((params.scope as any).kind) : null;
  const scopeInclude = Array.isArray((params.scope as any)?.include) ? (params.scope as any).include : null;

  const resolveCandidatePaths = (): string[] => {
    if (scopedKind === 'paths' && Array.isArray(scopeInclude) && scopeInclude.length > 0) {
      const seen = new Set<string>();
      const out: string[] = [];
      for (const value of scopeInclude) {
        const path = typeof value === 'string' ? value.trim() : '';
        if (!path || seen.has(path)) continue;
        seen.add(path);
        out.push(path);
        if (out.length >= maxFiles) break;
      }
      return out;
    }

    return (snapshot.entries ?? [])
      .filter((e) => e && typeof e.path === 'string' && (e.hasIncludedDelta || e.hasPendingDelta))
      .map((e) => e.path)
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

    if (!diffRes || typeof diffRes !== 'object') continue;
    if (!(diffRes as any).success) continue;
    const diff = typeof (diffRes as any).diff === 'string' ? String((diffRes as any).diff) : '';
    if (!diff) continue;

    const slice = diff.length > remaining ? diff.slice(0, remaining) : diff;
    remaining -= slice.length;
    diffsByPath.push({ path, diff: slice });
  }

  return { ok: true, snapshot, diffsByPath };
}
