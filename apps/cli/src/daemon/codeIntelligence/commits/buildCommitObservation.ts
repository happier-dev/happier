import type {
  CodeIntelligenceChangedFileV1,
  CodeIntelligenceChangedSymbolV1,
  CodeIntelligenceCommitV1,
  CodeIntelligenceImpactReferenceV1,
} from '@happier-dev/protocol';

import {
  grepFilesForWord,
  parseZeroContextHunks,
  readCommitChangedFiles,
  readCommitHeader,
  readFileAtRevision,
  readFileDiff,
} from '../git/observedGit';
import { resolveScannableLanguage } from '../symbols/declarationScan';
import { detectChangedSymbols } from '../symbols/detectChangedSymbols';
import { isChangedFileExcluded, isPathExcludedFromIntelligence } from './pathExclusion';

/**
 * Per-commit work bounds. Each keeps one commit observation to a small, predictable number of
 * git processes so a huge merge or vendored drop cannot stall the observer; anything skipped is
 * simply absent from the deterministic facts (never guessed).
 */
const MAX_SCANNED_FILES_PER_COMMIT = 40;
/**
 * Files recorded per commit. Snapshots resend the recent commits on every poll, so a vendored drop
 * must not carry its whole listing; 500 entries (~50 KB) is also more than the review prompt's
 * 48 KiB diff budget can use. The full count is kept in `changedFileCount`.
 */
const MAX_RECORDED_FILES_PER_COMMIT = 500;
/** Larger sources are almost always generated or vendored; declaration scanning them is noise. */
const MAX_SCANNED_FILE_BYTES = 512 * 1024;
const MAX_IMPACT_SYMBOLS_PER_COMMIT = 15;
const MAX_IMPACT_FILES_PER_SYMBOL = 10;
/** Short names (`run`, `get`) match everywhere textually and carry no impact signal. */
const MIN_IMPACT_SYMBOL_NAME_LENGTH = 4;

export async function buildCommitObservation(input: Readonly<{
  repositoryId: string;
  worktreePath: string;
  branch: string | null;
  sha: string;
  excludedPathPrefixes: readonly string[];
  plausibleSessionIds: readonly string[];
  nowMs: number;
}>): Promise<CodeIntelligenceCommitV1 | null> {
  // Null means git could not read the commit; the caller keeps its HEAD checkpoint and retries.
  const header = await readCommitHeader({ worktreePath: input.worktreePath, sha: input.sha });
  if (!header) return null;
  const listing = await readCommitChangedFiles({ worktreePath: input.worktreePath, header, maxFiles: MAX_RECORDED_FILES_PER_COMMIT });
  // A failed read is retried on the next observation instead of storing an empty commit.
  if (!listing) return null;
  const changedFiles = listing.files;
  const baseSha = header.parents[0] ?? null;

  const scannable = changedFiles
    .filter((file) => !file.binary && resolveScannableLanguage(file.path) !== null)
    .filter((file) => !isChangedFileExcluded(file, input.excludedPathPrefixes))
    .slice(0, MAX_SCANNED_FILES_PER_COMMIT);

  const changedSymbols: CodeIntelligenceChangedSymbolV1[] = [];
  for (const file of scannable) {
    changedSymbols.push(...await detectFileChangedSymbols({ worktreePath: input.worktreePath, baseSha, sha: header.sha, file }));
  }

  const impactedReferences = await findImpactedReferences({
    worktreePath: input.worktreePath,
    sha: header.sha,
    changedSymbols,
    changedPaths: new Set(changedFiles.map((file) => file.path)),
    excludedPathPrefixes: input.excludedPathPrefixes,
  });

  return {
    repositoryId: input.repositoryId,
    sha: header.sha,
    observedInWorktreePath: input.worktreePath,
    branch: input.branch,
    subject: header.subject,
    authorName: header.authorName,
    committedAtMs: header.committedAtMs,
    observedAtMs: input.nowMs,
    parentCount: header.parents.length,
    changedFiles,
    ...(listing.totalCount > changedFiles.length ? { changedFileCount: listing.totalCount } : {}),
    changedSymbols,
    impactedReferences,
    plausibleSessionIds: [...input.plausibleSessionIds],
    analysis: {
      status: 'queued',
      reason: null,
      summary: null,
      riskLevel: 'unknown',
      findings: [],
      providerId: null,
      modelId: null,
      billing: null,
      inputTokens: null,
      outputTokens: null,
      estimatedCostUsd: null,
      retryAfterMs: null,
      attempts: 0,
      updatedAtMs: input.nowMs,
    },
  };
}

async function detectFileChangedSymbols(input: Readonly<{
  worktreePath: string;
  baseSha: string | null;
  sha: string;
  file: CodeIntelligenceChangedFileV1;
}>): Promise<CodeIntelligenceChangedSymbolV1[]> {
  const { file } = input;
  const diff = await readFileDiff({
    worktreePath: input.worktreePath,
    baseSha: input.baseSha,
    sha: input.sha,
    path: file.path,
    previousPath: file.previousPath,
    contextLines: 0,
    maxOutputBytes: MAX_SCANNED_FILE_BYTES,
  });
  if (diff === null) return [];
  const oldPath = file.previousPath ?? file.path;
  const [oldContent, newContent] = await Promise.all([
    file.status === 'added' || !input.baseSha
      ? Promise.resolve(null)
      : readFileAtRevision({ worktreePath: input.worktreePath, sha: input.baseSha, path: oldPath, maxOutputBytes: MAX_SCANNED_FILE_BYTES }),
    file.status === 'deleted'
      ? Promise.resolve(null)
      : readFileAtRevision({ worktreePath: input.worktreePath, sha: input.sha, path: file.path, maxOutputBytes: MAX_SCANNED_FILE_BYTES }),
  ]);
  return detectChangedSymbols({ path: file.path, oldContent, newContent, hunks: parseZeroContextHunks(diff) });
}

async function findImpactedReferences(input: Readonly<{
  worktreePath: string;
  sha: string;
  changedSymbols: readonly CodeIntelligenceChangedSymbolV1[];
  changedPaths: ReadonlySet<string>;
  excludedPathPrefixes: readonly string[];
}>): Promise<CodeIntelligenceImpactReferenceV1[]> {
  const names = [...new Set(
    input.changedSymbols
      .filter((symbol) => symbol.changeKind !== 'added' && symbol.name.length >= MIN_IMPACT_SYMBOL_NAME_LENGTH)
      .map((symbol) => symbol.name),
  )].slice(0, MAX_IMPACT_SYMBOLS_PER_COMMIT);

  const references: CodeIntelligenceImpactReferenceV1[] = [];
  for (const name of names) {
    const files = await grepFilesForWord({
      worktreePath: input.worktreePath,
      sha: input.sha,
      word: name,
      maxFiles: MAX_IMPACT_FILES_PER_SYMBOL + input.changedPaths.size,
    });
    const outside = files
      .filter((path) => !input.changedPaths.has(path))
      .filter((path) => !isPathExcludedFromIntelligence(path, input.excludedPathPrefixes))
      .slice(0, MAX_IMPACT_FILES_PER_SYMBOL);
    for (const filePath of outside) references.push({ symbolName: name, filePath, evidence: 'textual_reference' });
  }
  return references;
}
