import type {
  ExecutionRunScmDiffSummaryInputV1,
  ScmDiffFileRequest,
  ScmDiffFileResponse,
  ScmDiffSummaryMetadata,
  ScmDiffSummaryTruncation,
  ScmStatusSnapshotRequest,
  ScmStatusSnapshotResponse,
  TurnChangeSet,
  ChangeEvidenceSource,
} from '@happier-dev/protocol';
import { ScmStatusSnapshotResponseSchema } from '@happier-dev/protocol';

import {
  createNonRepositoryScmSnapshotResponse,
  notRepositoryResponse,
  runScmRoute,
} from '@/scm/rpc/dispatch';

import type { ScmDiffSummaryPromptFile } from './buildDiffSummaryPrompt';

type ScmSnapshotEntry = Readonly<{
  path: string;
  kind?: unknown;
  hasIncludedDelta?: boolean;
  hasPendingDelta?: boolean;
  pendingStatus?: unknown;
  includeStatus?: unknown;
}>;

const AGENT_REPORTED_TURN_SOURCES = new Set<ChangeEvidenceSource>([
  'provider_native',
  'provider_tool',
  'canonical_diff_tool',
  'canonical_patch_tool',
]);

function isScmSnapshotEntry(value: unknown): value is ScmSnapshotEntry {
  if (!value || typeof value !== 'object') return false;
  const anyValue = value as { path?: unknown };
  return typeof anyValue.path === 'string' && anyValue.path.trim().length > 0;
}

function buildTurnCheckpointSourceKey(input: ExecutionRunScmDiffSummaryInputV1): string {
  const turnId = input.turnId?.trim() || 'unknown-turn';
  const receiptId = input.checkpointReceiptId?.trim() || 'unknown-receipt';
  return `turnCheckpoint:${turnId}:${receiptId}`;
}

function deriveTruncation(params: Readonly<{
  originalFileCount: number;
  emittedFileCount: number;
  remainingChars: number;
}>): ScmDiffSummaryTruncation | undefined {
  if (params.emittedFileCount < params.originalFileCount) {
    return {
      reason: 'fileCount',
      droppedFiles: params.originalFileCount - params.emittedFileCount,
    };
  }
  if (params.remainingChars <= 0) {
    return { reason: 'diffBytes' };
  }
  return undefined;
}

function selectBoundedFiles(files: readonly ScmDiffSummaryPromptFile[], maxFiles: number, maxTotalDiffChars: number): Readonly<{
  files: readonly ScmDiffSummaryPromptFile[];
  truncation?: ScmDiffSummaryTruncation;
}> {
  const out: ScmDiffSummaryPromptFile[] = [];
  let remaining = Math.max(0, maxTotalDiffChars);

  for (const file of files.slice(0, Math.max(0, maxFiles))) {
    const diff = typeof file.unifiedDiff === 'string' ? file.unifiedDiff : '';
    const slicedDiff = diff.length > remaining ? diff.slice(0, remaining) : diff;
    remaining -= slicedDiff.length;
    out.push({
      ...file,
      ...(diff ? { unifiedDiff: slicedDiff } : {}),
    });
    if (remaining <= 0) break;
  }

  return {
    files: Object.freeze(out),
    truncation: deriveTruncation({
      originalFileCount: files.length,
      emittedFileCount: out.length,
      remainingChars: remaining,
    }),
  };
}

function buildMetadataFromTurnChangeSet(input: ExecutionRunScmDiffSummaryInputV1, turnChangeSet: TurnChangeSet): ScmDiffSummaryMetadata {
  const checkpoint = turnChangeSet.repositoryCheckpoint;
  return {
    source: input.source,
    sourceKey: buildTurnCheckpointSourceKey(input),
    ...(input.turnId ? { turnId: input.turnId } : { turnId: turnChangeSet.turnId }),
    ...(input.checkpointReceiptId ? { checkpointReceiptId: input.checkpointReceiptId } : {}),
    ...(input.turnEvidenceMode ? { turnEvidenceMode: input.turnEvidenceMode } : {}),
    ...(checkpoint?.contentConfidence ? { contentConfidence: checkpoint.contentConfidence } : {}),
    ...(checkpoint?.attributionScope ? { attributionScope: checkpoint.attributionScope } : {}),
  };
}

function acceptsTurnEvidenceSource(
  mode: ExecutionRunScmDiffSummaryInputV1['turnEvidenceMode'] | undefined,
  source: ChangeEvidenceSource,
): boolean {
  if (mode === 'agent_reported') return AGENT_REPORTED_TURN_SOURCES.has(source);
  if (mode === 'checkpoint') return source === 'scm_checkpoint';
  return true;
}

function loadTurnCheckpointContext(input: ExecutionRunScmDiffSummaryInputV1): Readonly<{
  metadata: ScmDiffSummaryMetadata;
  files: readonly ScmDiffSummaryPromptFile[];
  truncation?: ScmDiffSummaryTruncation;
}> {
  const turnChangeSet = input.turnChangeSet;
  if (!turnChangeSet) {
    throw Object.assign(new Error('TurnChangeSet evidence is required for checkpoint-backed diff summaries'), {
      code: 'TURN_CHANGE_SET_REQUIRED',
    });
  }

  if (input.turnId && input.turnId !== turnChangeSet.turnId) {
    throw Object.assign(new Error('TurnChangeSet turnId does not match diff-summary input'), {
      code: 'CHECKPOINT_NOT_FOUND',
    });
  }

  if (input.checkpointReceiptId) {
    const receiptMatches = turnChangeSet.repositoryCheckpoint?.receipts.some((receipt) => receipt.id === input.checkpointReceiptId) === true;
    if (!receiptMatches) {
      throw Object.assign(new Error('Checkpoint receipt was not found on the supplied TurnChangeSet'), {
        code: 'CHECKPOINT_NOT_FOUND',
      });
    }
  }

  const allFiles = turnChangeSet.files
    .filter((file) => acceptsTurnEvidenceSource(input.turnEvidenceMode, file.source))
    .map((file) => ({
      path: file.filePath,
      changeKind: file.changeKind,
      source: file.source,
      confidence: file.confidence,
      description: file.description,
      unifiedDiff: file.unifiedDiff,
      binary: file.binary,
    }));

  const bounded = selectBoundedFiles(
    allFiles,
    typeof input.maxFiles === 'number' ? input.maxFiles : 40,
    typeof input.maxTotalDiffChars === 'number' ? input.maxTotalDiffChars : 120_000,
  );

  return {
    metadata: buildMetadataFromTurnChangeSet(input, turnChangeSet),
    files: bounded.files,
    ...(bounded.truncation ? { truncation: bounded.truncation } : {}),
  };
}

export async function loadScmDiffSummaryContext(params: Readonly<{
  input: ExecutionRunScmDiffSummaryInputV1;
  workingDirectory: string;
}>): Promise<Readonly<{
  metadata: ScmDiffSummaryMetadata;
  files: readonly ScmDiffSummaryPromptFile[];
  truncation?: ScmDiffSummaryTruncation;
}>> {
  if (params.input.source.kind === 'turnCheckpoint') {
    return loadTurnCheckpointContext(params.input);
  }

  const snapshotRes = await runScmRoute<ScmStatusSnapshotRequest, ScmStatusSnapshotResponse>({
    request: {},
    workingDirectory: params.workingDirectory,
    onNonRepository: async ({ cwd }) =>
      createNonRepositoryScmSnapshotResponse({
        workingDirectory: params.workingDirectory,
        cwd,
      }),
    runWithBackend: ({ context, selection }) => selection.backend.statusSnapshot({ context, request: {} }),
  });

  const parsedSnapshot = ScmStatusSnapshotResponseSchema.safeParse(snapshotRes);
  if (!parsedSnapshot.success || !parsedSnapshot.data.success || !parsedSnapshot.data.snapshot?.repo?.isRepo) {
    throw Object.assign(new Error('Working-tree diff is unavailable'), { code: 'DIFF_UNAVAILABLE' });
  }

  const snapshot = parsedSnapshot.data.snapshot;
  const candidatePaths = (snapshot.entries ?? [])
    .filter(isScmSnapshotEntry)
    .filter((entry) => Boolean(entry.hasIncludedDelta || entry.hasPendingDelta || entry.pendingStatus || entry.includeStatus))
    .map((entry) => entry.path.trim())
    .slice(0, typeof params.input.maxFiles === 'number' ? params.input.maxFiles : 40);

  const files: ScmDiffSummaryPromptFile[] = [];
  let remaining = typeof params.input.maxTotalDiffChars === 'number' ? params.input.maxTotalDiffChars : 120_000;

  for (const path of candidatePaths) {
    if (remaining <= 0) break;
    const diffRes = await runScmRoute<ScmDiffFileRequest, ScmDiffFileResponse>({
      request: { path, area: 'both' },
      workingDirectory: params.workingDirectory,
      onNonRepository: async () => notRepositoryResponse<ScmDiffFileResponse>(),
      runWithBackend: ({ context, selection }) => selection.backend.diffFile({ context, request: { path, area: 'both' } }),
    });
    const diff = diffRes && typeof diffRes === 'object' && (diffRes as { success?: unknown }).success
      ? String((diffRes as { diff?: unknown }).diff ?? '')
      : '';
    const slicedDiff = diff.length > remaining ? diff.slice(0, remaining) : diff;
    remaining -= slicedDiff.length;
    files.push({
      path,
      changeKind: 'unknown',
      source: 'workingTree',
      confidence: 'best_effort',
      unifiedDiff: slicedDiff,
    });
  }

  return {
    metadata: {
      source: params.input.source,
      sourceKey: `workingTree:${snapshot.repo.rootPath || params.workingDirectory}`,
    },
    files,
    ...(deriveTruncation({
      originalFileCount: candidatePaths.length,
      emittedFileCount: files.length,
      remainingChars: remaining,
    }) ? {
      truncation: deriveTruncation({
        originalFileCount: candidatePaths.length,
        emittedFileCount: files.length,
        remainingChars: remaining,
      }),
    } : {}),
  };
}
