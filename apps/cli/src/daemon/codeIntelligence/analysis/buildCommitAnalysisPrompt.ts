import type { CodeIntelligenceCommitV1 } from '@happier-dev/protocol';

import { isChangedFileExcluded } from '../commits/pathExclusion';
import { readFileDiff } from '../git/observedGit';

/**
 * Upper bound on diff text sent to a remote model per commit. Small enough for the context window
 * of inexpensive fast models and to keep a single review cheap; files past it are listed by name
 * only and the prompt says the diff is partial.
 */
const MAX_PROMPT_DIFF_BYTES = 48 * 1024;
const MAX_FILE_DIFF_BYTES = 256 * 1024;

const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bgsk_[A-Za-z0-9]{20,}\b/g,
  /\bgl(?:pat|ptt|dt|rt|cbt|oas)-[A-Za-z0-9_-]{20,}\b/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\bhf_[A-Za-z0-9]{30,}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\b[rs]k_(?:live|test)_[A-Za-z0-9]{20,}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g,
  /((?:api[_-]?key|secret|token|password|passwd|auth)[\w-]*\s*[:=]\s*)(['"]?)[^'"\s]{8,}\2/gi,
];

/** Replaces likely credentials with a marker before any text can leave the machine. */
export function redactSecrets(text: string): Readonly<{ text: string; redactions: number }> {
  let redactions = 0;
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, (match, prefix: unknown) => {
      redactions += 1;
      return typeof prefix === 'string' && /[:=]\s*$/.test(prefix) ? `${prefix}[REDACTED]` : '[REDACTED]';
    });
  }
  return { text: result, redactions };
}

export const COMMIT_ANALYSIS_SYSTEM_PROMPT = [
  'You review one git commit for likely bugs and regressions.',
  'Only report problems supported by the diff and the provided structural facts. Do not invent code you cannot see.',
  'Respond with a single JSON object: {"summary": string, "riskLevel": "low"|"medium"|"high"|"critical",',
  '"findings": [{"filePath": string|null, "line": number|null, "symbol": string|null, "category": string,',
  '"severity": "info"|"low"|"medium"|"high"|"critical", "confidence": number between 0 and 1,',
  '"explanation": string, "evidence": string|null, "suggestedCorrection": string|null}]}.',
  'Use an empty findings array when nothing is wrong.',
].join(' ');

export type CommitAnalysisPrompt = Readonly<{
  user: string;
  diffBytes: number;
  partial: boolean;
  redactions: number;
}>;

export async function buildCommitAnalysisPrompt(input: Readonly<{
  commit: CodeIntelligenceCommitV1;
  worktreePath: string;
  baseSha: string | null;
  excludedPathPrefixes: readonly string[];
}>): Promise<CommitAnalysisPrompt> {
  const { commit } = input;
  const diffs: string[] = [];
  const omitted: string[] = [];
  let diffBytes = 0;
  for (const file of commit.changedFiles) {
    // A rename carries the old side's content too, so either path being excluded excludes the file.
    const excluded = file.binary
      || isChangedFileExcluded(file, input.excludedPathPrefixes);
    // Once the budget is spent no more diffs are read: one git process per remaining file is waste.
    if (excluded || diffBytes >= MAX_PROMPT_DIFF_BYTES) {
      omitted.push(file.path);
      continue;
    }
    const diff = await readFileDiff({
      worktreePath: input.worktreePath,
      baseSha: input.baseSha,
      sha: commit.sha,
      path: file.path,
      previousPath: file.previousPath,
      contextLines: 3,
      maxOutputBytes: MAX_FILE_DIFF_BYTES,
    });
    const size = diff === null ? 0 : Buffer.byteLength(diff, 'utf8');
    if (diff === null || diffBytes + size > MAX_PROMPT_DIFF_BYTES) {
      omitted.push(file.path);
      continue;
    }
    diffs.push(diff);
    diffBytes += size;
  }

  const symbols = commit.changedSymbols.map((symbol) => `- ${symbol.changeKind} ${symbol.kind} ${symbol.name} (${symbol.filePath}:${symbol.startLine}-${symbol.endLine})`);
  const impact = commit.impactedReferences.map((reference) => `- ${reference.symbolName} is referenced in ${reference.filePath}`);
  const sections = [
    `Commit: ${commit.subject}`,
    `Files changed: ${commit.changedFileCount ?? commit.changedFiles.length}`,
    symbols.length > 0 ? `Changed symbols (declaration scan, may be incomplete):\n${symbols.join('\n')}` : 'Changed symbols: none recognized',
    impact.length > 0 ? `Other files that textually reference changed symbols:\n${impact.join('\n')}` : '',
    omitted.length > 0 ? `Diff omitted for: ${omitted.join(', ')}` : '',
    `Diff:\n${diffs.join('\n')}`,
  ].filter(Boolean);
  const redacted = redactSecrets(sections.join('\n\n'));
  return { user: redacted.text, diffBytes, partial: omitted.length > 0, redactions: redacted.redactions };
}
