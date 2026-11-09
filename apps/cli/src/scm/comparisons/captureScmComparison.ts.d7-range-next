import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rename, rm, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod/mini';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { ScmComparisonSchema, ScmComparisonSourceSchema, buildScmComparisonIdentity, classifyScmChangePath } from '@happier-dev/protocol/scm/comparison';
import { ScmDiffSummaryMetadataSchema } from '@happier-dev/protocol/scm/diffSummary';
import type { ScmComparison, ScmComparisonFile, ScmComparisonSource, ScmDiffSummaryMetadata } from '@happier-dev/protocol';
import type { ScmDiffSummaryTurnEvidenceMode } from '@happier-dev/protocol/scm';
import { configuration } from '@/configuration';
import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';
import { gitCheckpointAdapter, resolveGitCheckpointBackendContext } from '../checkpoints/gitCheckpointAdapter';
import { runGitCheckpointCommand } from '../checkpoints/gitCheckpointCommands';
import { buildRepositoryCheckpointRefs, encodeRepositoryCheckpointScope, parseRepositoryCheckpointRef } from '../checkpoints/refs';
import { findRepositoryCheckpointTurnEvidenceByReceipt, readRepositoryCheckpointInitialEvidence, readRepositoryCheckpointTurnEvidence } from '../checkpoints/sessionEvidence';
import { readGitComparisonFiles, type GitComparisonFile } from './readGitComparisonFiles';
import { disposeOwnedRepositoryCheckpointRef } from '../checkpoints/cleanup';
import type { RepositoryCheckpointRef } from '../checkpoints/types';
import { runScmRoute } from '../rpc/dispatch';
import type { ScmBackendRegistry } from '../registry';
import type { ScmCommitTargetCaptureResponse } from '../types';
import type { ReadRepositoryCheckpointTranscriptPage } from '../checkpoints/readRepositoryCheckpointTranscriptPage';
import { recoverRepositoryCheckpointEvidence } from '../checkpoints/recoverRepositoryCheckpointEvidence';
import { readPullRequestComparison, type ReadPullRequestComparisonPage } from './readPullRequestComparisonPage';
import type { ScmDiffSummaryPromptFile } from '@/agent/runtime/bridges/executionRun/kinds/scmDiffSummary/buildDiffSummaryPrompt';
import { materializeGitRepositoryCheckpoint } from '../checkpoints/materializeGitRepositoryCheckpoint';
import { createGitTemporaryIndex } from '@happier-dev/cli-common/scm/gitTemporaryIndex';
import { splitUnifiedDiffByFile } from '@happier-dev/protocol/diff/splitUnifiedDiffByFile';
import { parseUnifiedDiffHunks } from '@happier-dev/protocol/diff/hunks';

export type CapturedScmComparison = Readonly<{
  metadata: ScmDiffSummaryMetadata;
  files: readonly ScmDiffSummaryPromptFile[];
  comparison: ScmComparison;
}>;
export type CaptureScmComparisonInput = Readonly<{
  cwd: string; source: ScmComparisonSource; sessionId?: string; turnId?: string;
  registry?: ScmBackendRegistry;
  captureCommitTarget?: (cwd: string) => Promise<ScmCommitTargetCaptureResponse>;
  checkpointReceiptId?: string; turnEvidenceMode?: ScmDiffSummaryTurnEvidenceMode;
  readTranscriptPage?: ReadRepositoryCheckpointTranscriptPage;
  readPullRequestComparisonPage?: ReadPullRequestComparisonPage;
}>;

/** Capture publication authority through the SCM backend that owns the repository. */
export function captureScmComparisonCommitTarget(input: Readonly<{ cwd: string; registry?: ScmBackendRegistry }>): Promise<ScmCommitTargetCaptureResponse> {
  return runScmRoute<{ cwd: string }, ScmCommitTargetCaptureResponse>({
    request: { cwd: input.cwd }, workingDirectory: input.cwd, registry: input.registry,
    onNonRepository: () => ({ success: false, errorCode: 'NOT_REPOSITORY' }),
    runWithBackend: async ({ context, selection }) => selection.backend.commitCaptureTarget
      ? selection.backend.commitCaptureTarget({ context })
      : { success: false, errorCode: 'FEATURE_UNSUPPORTED' },
  });
}

const StoredComparisonSchema = z.strictObject({
  sessionId: z.optional(z.string()), metadata: ScmDiffSummaryMetadataSchema, comparison: ScmComparisonSchema,
  retainedRefs: z.array(z.strictObject({ ref: z.string(), oid: z.string() })),
});
const StoredComparisonReadSchema = createStoredReadSchema(StoredComparisonSchema);

function comparisonNamespace(sessionId?: string): string {
  return sessionId ? encodeRepositoryCheckpointScope(sessionId) : 'repository';
}

function comparisonPath(id: string, sessionId?: string): string {
  if (!/^[a-f0-9]{64}$/.test(id)) {
    throw Object.assign(new Error('Captured comparison identity is invalid'), { code: 'DIFF_UNAVAILABLE' });
  }
  return join(configuration.activeServerDir, 'runtime', 'scm', 'comparisons', comparisonNamespace(sessionId), `${id}.json`);
}

async function readStoredComparison(input: Readonly<{ comparisonId: string; sessionId?: string }>) {
  let content: string;
  try { content = await readFile(comparisonPath(input.comparisonId, input.sessionId), 'utf8'); }
  catch (error) {
    // A repository capture belongs to this Machine/Home, rather than one Session.
    // Never search other Session namespaces or hide a corrupt/private capture.
    if (!input.sessionId || !(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    content = await readFile(comparisonPath(input.comparisonId), 'utf8');
    const stored = StoredComparisonReadSchema.parse(JSON.parse(content));
    if (stored.sessionId !== undefined || stored.comparison.source.kind === 'session'
      || stored.comparison.source.kind === 'turnCheckpoint') throw new Error('Repository capture has Session-only scope');
    return { stored, sessionId: undefined };
  }
  return { stored: StoredComparisonReadSchema.parse(JSON.parse(content)), sessionId: input.sessionId };
}

/** The capture owner supplies both immutable surrounding-file endpoints to an analysis Run. */
export async function prepareCapturedScmComparisonInvestigation(input: Readonly<{
  cwd: string; comparisonId: string; sessionId?: string; directory: string;
}>): Promise<Readonly<{ beforeDirectory: string; afterDirectory: string }>> {
  const captured = await readCapturedScmComparison(input);
  const endpoints = captured.comparison.endpoints;
  if (!endpoints.before || !endpoints.after) throw Object.assign(new Error('Captured endpoint objects are unavailable for surrounding-file investigation'), { code: 'DIFF_UNAVAILABLE' });
  // Retained pre-fix captures may contain replacement-influenced patches under
  // original object IDs. The canonical raw reader must agree with their supplied
  // evidence before a Run combines that evidence with raw surrounding files.
  if (captured.comparison.source.kind !== 'pullRequest') {
    try {
      const repository = captured.comparison.repository.rootPath;
      let index: string | undefined;
      if (captured.comparison.source.kind === 'workingTree') {
        const { stored } = await readStoredComparison(input);
        const indexRef = `refs/happier/comparisons/${comparisonNamespace(stored.sessionId)}/${input.comparisonId}/index`;
        index = stored.retainedRefs.find(ref => ref.ref === indexRef)?.oid;
        if (!index) throw new Error('Captured staged lineage is unavailable');
      }
      const created = await createGitTemporaryIndex({ cwd: repository, seed: { kind: 'tree', treeOid: endpoints.before }, runGit: runGitCheckpointCommand });
      if (!created.success) throw new Error(created.error);
      try {
        for (const file of captured.comparison.inventory.files) {
          if (file.evidence.state !== 'available') continue;
          const sections = splitUnifiedDiffByFile(file.evidence.unifiedDiff ?? '', { preserveText: true });
          const layers = [...new Set(file.occurrences.map(change => change.layer ?? 'combined'))];
          if (sections.length !== layers.length) throw new Error('Captured file lineage is unavailable');
          for (const [position, section] of sections.entries()) {
            const layer = layers[position];
            const before = index && layer !== 'staged' ? index : endpoints.before;
            const after = index && layer === 'staged' ? index : endpoints.after;
            const restored = await runGitCheckpointCommand({ cwd: repository, args: ['read-tree', before], env: created.tempIndex.env });
            if (!restored.success) throw new Error(restored.stderr);
            const applied = await runGitCheckpointCommand({ cwd: repository,
              args: ['apply', '--cached', '--binary', '--unidiff-zero', '--whitespace=nowarn'], stdin: section, env: created.tempIndex.env });
            if (!applied.success) throw new Error(applied.stderr);
            const paths = file.changeKind === 'renamed' && file.previousPath ? [file.previousPath, file.path] : [file.path];
            // Native Git proves resulting object bytes/modes and rename/deletion
            // membership. Current diff context/formatting is not a data witness.
            const witness = await runGitCheckpointCommand({ cwd: repository,
              args: ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--raw', '--no-abbrev', '-z', after,
                '--', ...paths.map(path => `:(literal)${path}`)], env: created.tempIndex.env });
            if (!witness.success || witness.stdout !== '') throw new Error('Captured comparison evidence does not agree with its raw endpoint lineage');
          }
        }
      } finally { created.tempIndex.cleanup(); }
    } catch (error) {
      throw Object.assign(new Error('Captured comparison evidence is unavailable for surrounding-file investigation', { cause: error }), { code: 'DIFF_UNAVAILABLE' });
    }
  }
  const root = input.directory;
  await mkdir(root, { recursive: true });
  if (!(await lstat(root)).isDirectory()) throw Object.assign(new Error('The pinned investigation root is unavailable'), { code: 'DIFF_UNAVAILABLE' });
  const pinned = join(root, 'pinned');
  const existing = await lstat(pinned).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
  if (existing) {
    const before = await lstat(join(pinned, 'before')).catch(() => null);
    const after = await lstat(join(pinned, 'after')).catch(() => null);
    if (!existing.isDirectory() || !before?.isDirectory() || !after?.isDirectory()) {
      throw Object.assign(new Error('The pinned investigation directory is unavailable'), { code: 'DIFF_UNAVAILABLE' });
    }
    return { beforeDirectory: join(pinned, 'before'), afterDirectory: join(pinned, 'after') };
  }
  const directory = await mkdtemp(join(root, 'preparing-'));
  const beforeDirectory = join(directory, 'before');
  const afterDirectory = join(directory, 'after');
  try {
    for (const [endpoint, target] of [[endpoints.before, beforeDirectory], [endpoints.after, afterDirectory]] as const) {
      await materializeGitRepositoryCheckpoint({ cwd: captured.comparison.repository.rootPath, endpoint, directory: target });
    }
    await rename(directory, pinned);
    return { beforeDirectory: join(pinned, 'before'), afterDirectory: join(pinned, 'after') };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw Object.assign(new Error('Captured endpoint objects are unavailable for surrounding-file investigation', { cause: error }), { code: 'DIFF_UNAVAILABLE' });
  }
}

function promptFiles(comparison: ScmComparison): ScmDiffSummaryPromptFile[] {
  return comparison.inventory.files.map((file) => ({ path: file.path, changeKind: file.changeKind,
    source: comparison.source.kind, confidence: file.evidence.state === 'available'
      && comparison.inventory.state === 'complete' ? 'exact' : 'best_effort',
    ...(file.binary !== null ? { binary: file.binary } : {}), ...(file.evidence.unifiedDiff !== undefined ? { unifiedDiff: file.evidence.unifiedDiff } : {}),
    ...(file.evidence.state === 'unavailable' ? { description: file.evidence.reason } : {}) }));
}

/** The capture owner resolves contextual turn selectors before publishing or reading evidence. */
export function resolveCapturedScmComparisonSource(source: ScmComparisonSource, context: Readonly<{
  sessionId?: string; turnId?: string; checkpointReceiptId?: string; turnEvidenceMode?: ScmDiffSummaryTurnEvidenceMode;
}>): ScmComparisonSource {
  if (source.kind !== 'turnCheckpoint') return source;
  const sessionId = source.sessionId ?? context.sessionId;
  const turnId = source.turnId ?? context.turnId;
  const checkpointReceiptId = source.checkpointReceiptId ?? context.checkpointReceiptId;
  return { ...source, ...(sessionId ? { sessionId } : {}), ...(turnId ? { turnId } : {}),
    ...(checkpointReceiptId ? { checkpointReceiptId } : {}), evidenceMode: source.evidenceMode ?? context.turnEvidenceMode ?? 'checkpoint' };
}

export async function readCapturedScmComparison(input: Readonly<{
  cwd: string; comparisonId: string; sessionId?: string; source?: ScmComparisonSource;
  turnId?: string; checkpointReceiptId?: string; turnEvidenceMode?: ScmDiffSummaryTurnEvidenceMode;
}>): Promise<CapturedScmComparison> {
  let stored: z.infer<typeof StoredComparisonSchema>;
  let storageSessionId: string | undefined;
  try {
    const captured = await readStoredComparison(input);
    stored = captured.stored;
    storageSessionId = captured.sessionId;
  }
  catch (error) { throw Object.assign(new Error('Captured comparison evidence is unavailable', { cause: error }), { code: 'DIFF_UNAVAILABLE' }); }
  const projectedSourceIdentity = (source: ScmComparisonSource) => buildScmComparisonIdentity({ source,
    repositoryRootPath: stored.comparison.repository.rootPath, beforeOid: stored.comparison.endpoints.before,
    afterOid: stored.comparison.endpoints.after, sessionId: stored.sessionId, turnId: stored.metadata.turnId,
    checkpointReceiptId: stored.metadata.checkpointReceiptId, turnEvidenceMode: stored.metadata.turnEvidenceMode });
  const requestedSource = input.source ? ScmComparisonSourceSchema.parse(input.source) : undefined;
  const context = await resolveGitCheckpointBackendContext({ cwd: input.cwd });
  if ((context?.detection.rootPath ?? resolve(input.cwd)) !== stored.comparison.repository.rootPath
    || stored.comparison.id !== input.comparisonId || stored.metadata.sourceKey !== input.comparisonId
    || stored.sessionId !== storageSessionId
    || ((requestedSource?.kind === 'session' || requestedSource?.kind === 'turnCheckpoint')
      && requestedSource.sessionId !== undefined && requestedSource.sessionId !== stored.sessionId)
    || (requestedSource && projectedSourceIdentity(requestedSource) !== projectedSourceIdentity(stored.comparison.source))
    || (requestedSource?.kind === 'pullRequest' && (
      (requestedSource.locator.baseOid !== undefined && requestedSource.locator.baseOid !== stored.comparison.pullRequest?.baseOid)
      || (requestedSource.locator.headOid !== undefined && requestedSource.locator.headOid !== stored.comparison.endpoints.after)))
    || (input.turnId && input.turnId !== stored.metadata.turnId)
    || (input.checkpointReceiptId && input.checkpointReceiptId !== stored.metadata.checkpointReceiptId)
    || (input.turnEvidenceMode && input.turnEvidenceMode !== stored.metadata.turnEvidenceMode)) {
    throw Object.assign(new Error('Captured comparison does not belong to this repository, session and source'), { code: 'DIFF_UNAVAILABLE' });
  }
  // Older captures retained these resolved selectors beside a bare source. Qualify their
  // read projection without changing comparison/occurrence identities or persisted marks.
  const source = resolveCapturedScmComparisonSource(stored.comparison.source, { sessionId: stored.sessionId,
    turnId: stored.metadata.turnId, checkpointReceiptId: stored.metadata.checkpointReceiptId,
    turnEvidenceMode: stored.metadata.turnEvidenceMode });
  const comparison = { ...stored.comparison, source };
  return { metadata: { ...stored.metadata, source }, comparison, files: promptFiles(comparison) };
}

/** Explicit captured-comparison deletion disposes only pins recorded by this owner. */
export async function deleteCapturedScmComparison(input: Readonly<{
  cwd: string; comparisonId: string; sessionId?: string;
}>): Promise<void> {
  await readCapturedScmComparison(input);
  const path = comparisonPath(input.comparisonId, input.sessionId);
  const stored = StoredComparisonReadSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  const prefix = `refs/happier/comparisons/${comparisonNamespace(input.sessionId)}/${input.comparisonId}/`;
  // Validate every target before deleting any of them; session checkpoint pins are never targets.
  for (const retained of stored.retainedRefs) {
    if (['before', 'after', 'index'].some((role) => retained.ref === `${prefix}${role}`)) continue;
    const captureId = retained.ref.split('/')[5];
    const temporary = captureId && /^[a-f0-9-]{36}$/.test(captureId)
      ? buildRepositoryCheckpointRefs({ scopeId: `comparison:${captureId}:${stored.comparison.repository.rootPath}`, turnId: captureId }).turnFinal : undefined;
    if (!temporary || temporary.ref !== retained.ref) throw new Error('Saved comparison pin is outside its owned namespace');
  }
  for (const retained of stored.retainedRefs) {
    const removed = await runGitCheckpointCommand({ cwd: stored.comparison.repository.rootPath,
      args: ['update-ref', '-d', retained.ref, retained.oid] });
    if (!removed.success) throw new Error(removed.stderr || 'Saved comparison pin could not be deleted');
  }
  await unlink(path);
}

type Layer = 'staged' | 'unstaged' | 'untracked' | 'combined';
type ComparisonFileEvidence = GitComparisonFile & Readonly<{ layer?: Layer }>;
function inventoryFiles(id: string, files: readonly ComparisonFileEvidence[]): ScmComparisonFile[] {
  let alias = 0;
  const positions = new Map<string, number>();
  const layeredFiles = files.map((file) => {
    const hunks = parseUnifiedDiffHunks(file.unifiedDiff ?? '');
    const occurrenceScope = JSON.stringify([file.path, file.previousPath ?? null, file.layer ?? 'combined']);
    const occurrences = (hunks.length ? hunks : [null]).map((hunk) => {
      const position = positions.get(occurrenceScope) ?? 0;
      positions.set(occurrenceScope, position + 1);
      const before = { startLine: hunk?.oldStart ?? 0, lineCount: hunk?.oldLines ?? 0 };
      const after = { startLine: hunk?.newStart ?? 0, lineCount: hunk?.newLines ?? 0 };
      return {
      id: `${id}:${JSON.stringify([file.path, file.previousPath ?? null, file.layer ?? 'combined',
        hunk ? 'hunk' : 'metadata', file.unavailableReason ? 'unavailable' : 'available', before, after, position])}`,
      alias: `c${++alias}`, path: file.path,
      ...(file.previousPath ? { previousPath: file.previousPath } : {}),
      ...(file.beforeBlobId ? { beforeBlobId: file.beforeBlobId } : {}),
      ...(file.afterBlobId ? { afterBlobId: file.afterBlobId } : {}),
      before, after,
      position, ...(file.layer ? { layer: file.layer } : {}),
      evidence: file.unavailableReason ? { state: 'unavailable' as const, reason: file.unavailableReason } : { state: 'available' as const },
    }; });
    return { path: file.path, ...(file.previousPath ? { previousPath: file.previousPath } : {}), changeKind: file.changeKind,
      binary: file.binary, ...classifyScmChangePath(file.path),
      ...(file.beforeBlobId ? { beforeBlobId: file.beforeBlobId } : {}), ...(file.afterBlobId ? { afterBlobId: file.afterBlobId } : {}),
      evidence: file.unavailableReason ? { state: 'unavailable' as const, reason: file.unavailableReason,
        ...(file.unifiedDiff ? { unifiedDiff: file.unifiedDiff } : {}) }
        : { state: 'available' as const, unifiedDiff: file.unifiedDiff ?? '' }, occurrences };
  });
  const byPath = new Map<string, ScmComparisonFile>();
  for (const file of layeredFiles) {
    const previous = byPath.get(file.path);
    if (!previous) { byPath.set(file.path, file); continue; }
    const reasons = [previous.evidence, file.evidence].flatMap((evidence) => evidence.state === 'unavailable' ? [evidence.reason] : []);
    const unifiedDiff = [previous.evidence, file.evidence].map((evidence) => evidence.unifiedDiff ?? '').join('');
    byPath.set(file.path, { ...previous, afterBlobId: file.afterBlobId,
      binary: previous.binary === true || file.binary === true ? true : previous.binary === null || file.binary === null ? null : false,
      changeKind: previous.changeKind === 'deleted' && file.changeKind === 'added' ? 'modified' : previous.changeKind,
      evidence: reasons.length ? { state: 'unavailable', reason: reasons.join('\n'), ...(unifiedDiff ? { unifiedDiff } : {}) }
        : { state: 'available', unifiedDiff },
      occurrences: [...previous.occurrences, ...file.occurrences] });
  }
  return [...byPath.values()];
}

async function revision(cwd: string, selector: string, env?: Parameters<typeof runGitCheckpointCommand>[0]['env']): Promise<string> {
  const result = await runGitCheckpointCommand({ cwd, env, args: ['rev-parse', '--verify', '--end-of-options', `${selector}^{commit}`] });
  if (!result.success || !result.stdout.trim()) throw new Error(result.stderr || 'Comparison endpoint is unavailable');
  return result.stdout.trim();
}
async function emptyTree(cwd: string): Promise<string> {
  const result = await runGitCheckpointCommand({ cwd, args: ['hash-object', '-w', '-t', 'tree', '--stdin'], stdin: '' });
  if (!result.success) throw new Error(result.stderr || 'Empty-tree comparison is unavailable');
  return result.stdout.trim();
}

/** Transient pending evidence for accepted-step validation, through the same checkpoint capture owner. */
export async function captureScmPendingTree(cwd: string): Promise<string> {
  const context = await resolveGitCheckpointBackendContext({ cwd });
  if (!context?.detection.rootPath) throw new Error('Pending evidence requires a Git repository');
  const captureId = randomUUID();
  const checkpointRef = buildRepositoryCheckpointRefs({ scopeId: `comparison:${captureId}:${context.detection.rootPath}`, turnId: captureId }).turnFinal;
  if (!checkpointRef) throw new Error('Pending checkpoint ref is unavailable');
  const captured = await gitCheckpointAdapter.capture({ context, checkpointRef });
  if (!captured.success) throw new Error(captured.error);
  try { return captured.treeSha; }
  finally { await disposeOwnedRepositoryCheckpointRef({ cwd: context.detection.rootPath, checkpointRef, expectedOid: captured.commitSha }); }
}

export async function captureScmComparison(input: CaptureScmComparisonInput): Promise<CapturedScmComparison> {
  const source = ScmComparisonSourceSchema.parse(input.source);
  // Exact ranges attest existing objects; promisor fallback is not fetch authority.
  const rangeEnvironment = source.kind === 'revisionRange' ? { GIT_NO_LAZY_FETCH: '1' } : undefined;
  if ((source.kind === 'session' || source.kind === 'turnCheckpoint') && input.sessionId && source.sessionId && source.sessionId !== input.sessionId) {
    throw Object.assign(new Error('Comparison session does not match the authenticated session'), { code: 'CHECKPOINT_NOT_FOUND' });
  }
  const context = await resolveGitCheckpointBackendContext({ cwd: input.cwd });
  const rootPath = context?.detection.rootPath ?? resolve(input.cwd);
  const sessionId = source.kind === 'session' || source.kind === 'turnCheckpoint' ? input.sessionId ?? source.sessionId : input.sessionId;
  const captureId = randomUUID();
  const reasons: string[] = [];
  let state: ScmComparison['inventory']['state'] = 'complete';
  let before: string | undefined;
  let after: string | undefined;
  let indexOid: string | undefined;
  let commitTarget: ScmComparison['commitTarget'];
  let pullRequest: ScmComparison['pullRequest'];
  let evidenceIdentity: string | undefined;
  let files: ComparisonFileEvidence[] = [];
  let attributionScope: ScmComparison['attributionScope'] = 'unknown';
  let freshness: ScmComparison['freshness'] = 'current';
  const temporaryRefs: Array<{ checkpointRef: RepositoryCheckpointRef; expectedOid: string }> = [];
  let turnId = source.kind === 'turnCheckpoint' ? source.turnId ?? input.turnId : undefined;
  const receiptId = source.kind === 'turnCheckpoint' ? source.checkpointReceiptId ?? input.checkpointReceiptId : undefined;
  const evidenceMode = source.kind === 'turnCheckpoint' ? source.evidenceMode ?? input.turnEvidenceMode ?? 'checkpoint' : undefined;
  try {
    if (source.kind !== 'pullRequest' && !context?.detection.rootPath) throw new Error('Git comparison evidence is unavailable outside a Git repository');
    const snapshot = async (): Promise<string> => {
      const checkpointRef = buildRepositoryCheckpointRefs({ scopeId: `comparison:${captureId}:${rootPath}`, turnId: captureId }).turnFinal;
      if (!checkpointRef) throw new Error('Comparison checkpoint ref is unavailable');
      if (!context) throw new Error('Git comparison capture is unavailable');
      const captured = await gitCheckpointAdapter.capture({ context, checkpointRef });
      if (!captured.success) throw new Error(captured.error);
      temporaryRefs.push({ checkpointRef, expectedOid: captured.commitSha });
      return captured.treeSha;
    };
    if (source.kind === 'pullRequest') {
      const hosted = await readPullRequestComparison({ source, readPage: input.readPullRequestComparisonPage });
      before = hosted.before; after = hosted.after; files = [...hosted.files];
      pullRequest = hosted.pullRequest;
      reasons.push(...hosted.reasons); state = hosted.state; freshness = hosted.freshness;
    } else if (source.kind === 'session') {
      if (!sessionId) throw new Error('Session comparison requires an authenticated session');
      const scopeId = `${sessionId}:${rootPath}`;
      let initial = await readRepositoryCheckpointInitialEvidence({ cwd: rootPath, scopeId });
      if ((!initial || (initial.state === 'unavailable' && initial.recoverable)) && input.readTranscriptPage) {
        await recoverRepositoryCheckpointEvidence({ cwd: rootPath, scopeId, sessionId, readTranscriptPage: input.readTranscriptPage });
        initial = await readRepositoryCheckpointInitialEvidence({ cwd: rootPath, scopeId });
      }
      if (!initial || initial.state !== 'available') throw new Error(initial?.reason ?? 'Initial pre-dispatch checkpoint is unavailable; inspect individual turns');
      before = await revision(rootPath, initial.ref);
      if (before !== initial.commitSha) throw new Error('Initial checkpoint no longer matches its retained receipt');
      after = await snapshot();
    } else if (source.kind === 'turnCheckpoint') {
      if (!sessionId || (!turnId && !receiptId)) throw new Error('Turn comparison requires authenticated session and turn or receipt selectors');
      const scopeId = `${sessionId}:${rootPath}`;
      const readTurn = () => turnId ? readRepositoryCheckpointTurnEvidence({ cwd: rootPath, scopeId, turnId })
        : findRepositoryCheckpointTurnEvidenceByReceipt({ cwd: rootPath, scopeId, receiptId: receiptId! });
      let turn = await readTurn();
      if ((!turn || evidenceMode === 'agent_reported') && input.readTranscriptPage) {
        await recoverRepositoryCheckpointEvidence({ cwd: rootPath, scopeId, sessionId, readTranscriptPage: input.readTranscriptPage });
        turn = await readTurn();
      }
      turnId ??= turn?.turnId;
      if (!turn || turn.sessionId !== sessionId || turn.turnId !== turnId) throw new Error('Canonical turn evidence is unavailable');
      const checkpoint = turn.repositoryCheckpoint;
      if (receiptId && !checkpoint?.receipts.some((receipt) => receipt.id === receiptId || receipt.ref === receiptId)) throw new Error('Canonical turn checkpoint receipt was not found');
      attributionScope = checkpoint?.attributionScope ?? 'unknown';
      if (evidenceMode === 'agent_reported') {
        const reported = turn.files.filter((file) => ['provider_native', 'provider_tool', 'canonical_diff_tool', 'canonical_patch_tool'].includes(file.source));
        evidenceIdentity = JSON.stringify([turn.provider, turn.seqRange, reported]);
        files = reported.map((file) => ({ path: file.filePath,
          ...(file.previousFilePath ? { previousPath: file.previousFilePath } : {}), changeKind: file.changeKind,
          binary: file.binary ?? false, ...(file.unifiedDiff ? { unifiedDiff: file.unifiedDiff } : {}),
          ...(file.truncated ? { unavailableReason: 'Canonical agent-reported fragment was truncated before capture' }
            : !file.unifiedDiff ? { unavailableReason: 'Canonical agent-reported tool did not retain textual diff evidence' } : {}) }));
        if (!files.length) throw new Error('Canonical agent-reported evidence for this turn is unavailable');
        reasons.push('Agent-reported tool fragments do not establish complete repository endpoints');
        reasons.push(...files.flatMap((file) => file.unavailableReason ? [`${file.path}: ${file.unavailableReason}`] : []));
        state = 'incomplete';
      } else {
      if (!checkpoint || checkpoint.scopeId !== scopeId) throw new Error('Canonical turn checkpoint receipt is unavailable');
      if (checkpoint.unavailableReason) throw new Error(`Canonical turn checkpoint is unavailable (${checkpoint.unavailableReason})`);
      if (!checkpoint.startRef || !checkpoint.finalRef
        || !parseRepositoryCheckpointRef({ scopeId, ref: checkpoint.startRef })
        || !parseRepositoryCheckpointRef({ scopeId, ref: checkpoint.finalRef })) throw new Error('Canonical turn checkpoint endpoints are unavailable');
      before = await revision(rootPath, checkpoint.startRef); after = await revision(rootPath, checkpoint.finalRef);
      for (const [ref, oid] of [[checkpoint.startRef, before], [checkpoint.finalRef, after]] as const) {
        const receipt = checkpoint.receipts.find((item) => item.ref === ref && item.commitSha);
        if (!receipt || receipt.commitSha !== oid) throw new Error('Turn checkpoint object does not match its canonical receipt');
      }
      }
    } else if (source.kind === 'revisionRange') {
      before = await revision(rootPath, source.baseOid, rangeEnvironment);
      after = await revision(rootPath, source.headOid, rangeEnvironment);
      if (before !== source.baseOid || after !== source.headOid) throw new Error('Immutable comparison endpoints did not match the requested range');
    } else if (source.kind === 'branch') {
      after = await revision(rootPath, source.head);
      const base = await revision(rootPath, source.base);
      const mergeBase = await runGitCheckpointCommand({ cwd: rootPath, args: ['merge-base', base, after] });
      if (!mergeBase.success || !mergeBase.stdout.trim()) throw new Error(mergeBase.stderr || 'Branch merge base is unavailable');
      before = mergeBase.stdout.trim();
    } else if (source.kind === 'commit') {
      after = await revision(rootPath, source.commit);
      const parents = await runGitCheckpointCommand({ cwd: rootPath, args: ['rev-list', '--parents', '-n', '1', after] });
      if (!parents.success) throw new Error(parents.stderr || 'Commit parent evidence is unavailable');
      const parentOids = parents.stdout.trim().split(/\s+/).slice(1);
      if (source.parent) {
        before = /^\d+$/.test(source.parent) ? parentOids[Number(source.parent) - 1] : await revision(rootPath, source.parent);
        if (!before || !parentOids.includes(before)) throw new Error('Selected commit parent does not belong to this commit');
      } else {
        if (parentOids.length > 1) throw new Error('Merge commits require an explicitly selected parent');
        before = parentOids[0] ?? await emptyTree(rootPath);
      }
    } else {
      const capturedTarget = input.captureCommitTarget
        ? await input.captureCommitTarget(rootPath)
        : await captureScmComparisonCommitTarget({ cwd: rootPath, registry: input.registry });
      if (capturedTarget.success) commitTarget = { headOid: capturedTarget.target.headOid, ref: capturedTarget.target.ref };
      if (capturedTarget.success) before = capturedTarget.target.headOid ?? capturedTarget.target.baseTreeOid;
      else {
        // Read-only evidence remains available without a commit-capable backend.
        const head = await runGitCheckpointCommand({ cwd: rootPath, args: ['rev-parse', '--verify', 'HEAD^{commit}'] });
        before = head.success ? head.stdout.trim() : await emptyTree(rootPath);
      }
      const index = await runGitCheckpointCommand({ cwd: rootPath, args: ['write-tree'] });
      if (!index.success || !index.stdout.trim()) throw new Error(index.stderr || 'Staged comparison endpoint is unavailable');
      indexOid = index.stdout.trim();
      after = await snapshot();
      const staged = await readGitComparisonFiles({ cwd: rootPath, before, after: index.stdout.trim() });
      const unstaged = await readGitComparisonFiles({ cwd: rootPath, before: index.stdout.trim(), after });
      files = [...staged.files.map((file) => ({ ...file, layer: 'staged' as const })),
        ...unstaged.files.map((file) => ({ ...file, layer: file.beforeBlobId ? 'unstaged' as const : 'untracked' as const }))];
      reasons.push(...staged.reasons, ...unstaged.reasons);
      if (!staged.enumerationComplete || !unstaged.enumerationComplete) state = files.length ? 'incomplete' : 'unavailable';
    }
    if (source.kind !== 'workingTree' && source.kind !== 'pullRequest' && before && after) {
      const read = await readGitComparisonFiles({ cwd: rootPath, before, after, env: rangeEnvironment });
      files = [...read.files]; reasons.push(...read.reasons);
      if (!read.enumerationComplete) state = files.length ? 'incomplete' : 'unavailable';
    }
    if (reasons.length && state === 'complete') state = 'incomplete';
  } catch (error) {
    reasons.push(error instanceof Error ? error.message : 'Comparison evidence is unavailable'); state = files.length ? 'incomplete' : 'unavailable';
  }
  const id = buildScmComparisonIdentity({ source, repositoryRootPath: rootPath, beforeOid: before, afterOid: after, indexOid,
    ...((source.kind === 'session' || source.kind === 'turnCheckpoint') && sessionId ? { sessionId } : {}),
    turnId, checkpointReceiptId: receiptId, turnEvidenceMode: evidenceMode, evidenceIdentity });
  const capturedSource = resolveCapturedScmComparisonSource(source, { sessionId, turnId, checkpointReceiptId: receiptId, turnEvidenceMode: evidenceMode });
  const comparison = ScmComparisonSchema.parse({ id, source: capturedSource, repository: { rootPath },
    ...(commitTarget ? { commitTarget } : {}),
    endpoints: { ...(before ? { before } : {}), ...(after ? { after } : {}) },
    ...(pullRequest ? { pullRequest } : {}),
    inventory: { state, files: inventoryFiles(id, files), reasons }, freshness, attributionScope });
  const metadata: ScmDiffSummaryMetadata = { source: capturedSource,
    sourceKey: comparison.id,
    ...(turnId ? { turnId } : {}), ...(receiptId ? { checkpointReceiptId: receiptId } : {}),
    ...(evidenceMode ? { turnEvidenceMode: evidenceMode } : {}), contentConfidence: state === 'complete' ? 'exact' : 'unavailable', attributionScope };
  const retainedRefs: Array<{ ref: string; oid: string }> = [];
  try {
  for (const [role, oid] of [['before', before], ['after', after], ['index', indexOid]] as const) {
    if (!oid || source.kind === 'pullRequest') continue;
    const ref = `refs/happier/comparisons/${comparisonNamespace(sessionId)}/${id}/${role}`;
    const previous = await runGitCheckpointCommand({ cwd: rootPath, env: rangeEnvironment, args: ['rev-parse', '--verify', ref] });
    if (previous.success && previous.stdout.trim() !== oid) throw new Error('Retained comparison endpoint conflicts with its exact identity');
    if (!previous.success) {
      const pinned = await runGitCheckpointCommand({ cwd: rootPath, env: rangeEnvironment, args: ['update-ref', ref, oid, ''] });
      if (!pinned.success) {
        const existing = await runGitCheckpointCommand({ cwd: rootPath, env: rangeEnvironment, args: ['rev-parse', '--verify', ref] });
        if (!existing.success || existing.stdout.trim() !== oid) throw new Error(pinned.stderr || 'Comparison endpoint could not be retained');
      }
    }
    retainedRefs.push({ ref, oid });
  }
  await writeJsonAtomic(comparisonPath(id, sessionId), StoredComparisonSchema.parse({
    ...(sessionId ? { sessionId } : {}), comparison, metadata, retainedRefs }));
  let retainedTemporary = false;
  for (const temporary of temporaryRefs) {
    try { await disposeOwnedRepositoryCheckpointRef({ cwd: rootPath, ...temporary }); }
    catch {
      // Retain ownership for explicit deletion if Git refuses to dispose this exact temporary ref.
      retainedRefs.push({ ref: temporary.checkpointRef.ref, oid: temporary.expectedOid }); retainedTemporary = true;
    }
  }
  if (retainedTemporary) await writeJsonAtomic(comparisonPath(id, sessionId), StoredComparisonSchema.parse({
    ...(sessionId ? { sessionId } : {}), comparison, metadata, retainedRefs }));
  } catch (error) {
    const cleanupFailures: unknown[] = [];
    for (const temporary of temporaryRefs) {
      try { await disposeOwnedRepositoryCheckpointRef({ cwd: rootPath, ...temporary }); }
      catch (cleanupError) { cleanupFailures.push(cleanupError); }
    }
    if (cleanupFailures.length) throw new AggregateError([error, ...cleanupFailures], 'Comparison capture failed and its temporary checkpoint could not be disposed');
    throw error;
  }
  return { metadata, comparison, files: promptFiles(comparison) };
}
