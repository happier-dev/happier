import { createHash } from 'node:crypto';
import { realpath } from 'node:fs';
import { promisify } from 'node:util';
import { basename, dirname } from 'node:path';

import type { CodeIntelligenceChangedFileV1 } from '@happier-dev/protocol';

import { runScmCommand, type ScmExecResult } from '@/scm/runtime';
import { inspectGitCheckoutIdentity } from '@/scm/backends/git/checkoutIdentity';
import { toRepoRootLiteralPathspec } from '@/scm/backends/git/literalPathspec';
import { buildScmNonInteractiveEnv } from '@/scm/backends/shared/nonInteractiveEnv';

/**
 * Read-only git access for background observation. `GIT_OPTIONAL_LOCKS=0` keeps every command from
 * taking optional index locks, so observing a checkout never contends with an agent writing to it.
 */
export async function runObserverGit(input: Readonly<{
  cwd: string;
  args: string[];
  maxOutputBytes?: number;
}>): Promise<ScmExecResult> {
  return await runScmCommand({
    bin: 'git',
    cwd: input.cwd,
    args: ['-c', 'core.quotePath=false', ...input.args],
    timeoutMs: 15_000,
    maxOutputBytes: input.maxOutputBytes,
    env: buildScmNonInteractiveEnv({ GIT_OPTIONAL_LOCKS: '0' }),
  });
}

export type ObservedCheckout = Readonly<{
  repositoryId: string;
  displayName: string;
  commonDirPath: string;
  worktreePath: string;
  gitDirPath: string;
  isLinkedWorktree: boolean;
  branch: string | null;
  headCommit: string | null;
}>;

const realpathNative = promisify(realpath.native);

async function canonicalIdentityPath(path: string): Promise<string> {
  // The native realpath returns the on-disk casing on case-insensitive volumes, so one repository
  // gets one id without folding case (which would merge distinct repositories on case-sensitive
  // volumes, and with them their remote-review consent).
  const resolved = await realpathNative(path).catch(() => path);
  return resolved.replace(/\\/g, '/').replace(/\/+$/, '');
}

function repositoryDisplayName(commonDirPath: string): string {
  const name = basename(commonDirPath);
  if (name === '.git') return basename(dirname(commonDirPath)) || name;
  return name.replace(/\.git$/, '') || name;
}

/**
 * Resolves a working directory to its repository (keyed by the shared git common dir) and its
 * specific worktree. Linked worktrees of one repository share a `repositoryId`.
 */
export async function resolveObservedCheckout(input: Readonly<{ cwd: string }>): Promise<ObservedCheckout | null> {
  const identity = await inspectGitCheckoutIdentity({ cwd: input.cwd });
  if (!identity) return null;
  const commonDirKey = await canonicalIdentityPath(identity.commonDirPath);
  return {
    repositoryId: `repo_${createHash('sha256').update(commonDirKey).digest('hex').slice(0, 24)}`,
    displayName: repositoryDisplayName(identity.commonDirPath),
    commonDirPath: identity.commonDirPath,
    worktreePath: identity.worktreePath,
    gitDirPath: identity.gitDirPath,
    isLinkedWorktree: identity.gitDirPath !== identity.commonDirPath,
    branch: identity.branchName,
    headCommit: identity.headRevision,
  };
}

export type NewCommitRange = Readonly<{
  /** Oldest first, at most `maxCommits` of the newest commits. */
  shas: string[];
  omittedCount: number;
}>;

async function commitExists(worktreePath: string, sha: string): Promise<boolean | null> {
  const result = await runObserverGit({ cwd: worktreePath, args: ['cat-file', '-e', `${sha}^{commit}`] });
  if (result.success) return true;
  // `cat-file -e` exits 1 for a missing object; anything else (timeout, spawn failure) is unknown.
  return result.exitCode === 1 && !result.timedOut ? false : null;
}

/**
 * Lists commits reachable from `currentHead` but not from `previousHead` (all of them when the
 * previous HEAD was unborn). Works for fast-forwards, merges and rebases alike; commits already
 * known are deduplicated by the store, so a branch pointer moving to an existing commit produces no
 * new commit observation. Returns null when git could not answer, so the caller retries later.
 */
export async function listNewCommits(input: Readonly<{
  worktreePath: string;
  previousHead: string | null;
  currentHead: string;
  maxCommits: number;
}>): Promise<NewCommitRange | null> {
  if (input.previousHead === input.currentHead) return { shas: [], omittedCount: 0 };
  const exclusion = input.previousHead ? [`^${input.previousHead}`] : [];
  // Listing only the kept commits keeps the output bounded however large the range is.
  const result = await runObserverGit({
    cwd: input.worktreePath,
    args: ['rev-list', `--max-count=${input.maxCommits}`, input.currentHead, ...exclusion, '--'],
  });
  if (!result.success) {
    // Only a previous head that no longer exists (gc after a rewrite) falls back to the new head
    // alone; any other failure is retried rather than silently skipping commits.
    const previousExists = input.previousHead ? await commitExists(input.worktreePath, input.previousHead) : null;
    return previousExists === false ? { shas: [input.currentHead], omittedCount: 0 } : null;
  }
  const kept = result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  let omittedCount = 0;
  if (kept.length === input.maxCommits) {
    const counted = await runObserverGit({ cwd: input.worktreePath, args: ['rev-list', '--count', input.currentHead, ...exclusion, '--'] });
    if (!counted.success) return null;
    omittedCount = Math.max(0, Number.parseInt(counted.stdout.trim(), 10) - kept.length);
  }
  return { shas: kept.reverse(), omittedCount };
}

export type CommitHeader = Readonly<{
  sha: string;
  parents: string[];
  authorName: string;
  committedAtMs: number;
  subject: string;
}>;

export async function readCommitHeader(input: Readonly<{ worktreePath: string; sha: string }>): Promise<CommitHeader | null> {
  const result = await runObserverGit({
    cwd: input.worktreePath,
    args: ['show', '-s', '--format=%H%x00%P%x00%an%x00%ct%x00%s', input.sha, '--'],
  });
  if (!result.success) return null;
  const [sha, parents, authorName, committedAt, subject] = result.stdout.replace(/\n$/, '').split('\0');
  if (!sha) return null;
  return {
    sha,
    parents: (parents ?? '').split(' ').filter(Boolean),
    authorName: authorName ?? '',
    committedAtMs: Number(committedAt ?? 0) * 1000,
    subject: subject ?? '',
  };
}

const STATUS_BY_LETTER: Record<string, CodeIntelligenceChangedFileV1['status']> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'type_changed',
};

/** Parses `git diff-tree -r -M -z --name-status` output. */
export function parseNameStatusZ(output: string): Array<Readonly<{ status: CodeIntelligenceChangedFileV1['status']; path: string; previousPath: string | null }>> {
  const tokens = output.split('\0');
  const entries: Array<Readonly<{ status: CodeIntelligenceChangedFileV1['status']; path: string; previousPath: string | null }>> = [];
  let index = 0;
  while (index < tokens.length) {
    const code = tokens[index]?.trim();
    if (!code) {
      index += 1;
      continue;
    }
    const status = STATUS_BY_LETTER[code[0] ?? ''] ?? 'unknown';
    if (status === 'renamed' || status === 'copied') {
      const previousPath = tokens[index + 1] ?? '';
      const path = tokens[index + 2] ?? '';
      if (path) entries.push({ status, path, previousPath: previousPath || null });
      index += 3;
      continue;
    }
    const path = tokens[index + 1] ?? '';
    if (path) entries.push({ status, path, previousPath: null });
    index += 2;
  }
  return entries;
}

/** Parses `git diff-tree -r -M -z --numstat` output into per-path line counts (null for binary). */
export function parseNumstatZ(output: string): Map<string, Readonly<{ insertions: number | null; deletions: number | null }>> {
  const tokens = output.split('\0');
  const stats = new Map<string, Readonly<{ insertions: number | null; deletions: number | null }>>();
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index] ?? '';
    if (!token.trim()) {
      index += 1;
      continue;
    }
    // With -z the path is written unquoted, so it may itself contain tabs.
    const [rawInsertions, rawDeletions, ...pathParts] = token.split('\t');
    const inlinePath = pathParts.join('\t');
    const toCount = (raw: string | undefined) => (raw === '-' || raw === undefined ? null : Number(raw));
    const counts = { insertions: toCount(rawInsertions), deletions: toCount(rawDeletions) };
    if (inlinePath) {
      stats.set(inlinePath, counts);
      index += 1;
      continue;
    }
    // Rename/copy: the record is followed by the old and new path tokens.
    const newPath = tokens[index + 2] ?? '';
    if (newPath) stats.set(newPath, counts);
    index += 3;
  }
  return stats;
}

/** Null when git could not list the changes; an empty commit yields an empty list. */
/**
 * The first `maxFiles` files a commit changed, and how many it changed in all. A listing larger
 * than git's output cap is still usable: its leading entries are complete, and the total comes from
 * `--shortstat`, whose output stays small. Null only when git could not answer.
 */
export async function readCommitChangedFiles(input: Readonly<{
  worktreePath: string;
  header: CommitHeader;
  maxFiles: number;
}>): Promise<Readonly<{ files: CodeIntelligenceChangedFileV1[]; totalCount: number }> | null> {
  // Merges are compared with their first parent: the changes the merge brought onto the branch.
  const range = input.header.parents.length === 0
    ? ['--root', input.header.sha]
    : [input.header.parents[0]!, input.header.sha];
  const [nameStatus, numstat] = await Promise.all([
    runObserverGit({ cwd: input.worktreePath, args: ['diff-tree', '-r', '-M', '-z', '--no-commit-id', '--name-status', ...range, '--'] }),
    runObserverGit({ cwd: input.worktreePath, args: ['diff-tree', '-r', '-M', '-z', '--no-commit-id', '--numstat', ...range, '--'] }),
  ]);
  if (!nameStatus.success && !nameStatus.outputLimitExceeded) return null;
  const entries = parseNameStatusZ(nameStatus.stdout);
  let totalCount = entries.length;
  if (nameStatus.outputLimitExceeded) {
    const shortstat = await runObserverGit({ cwd: input.worktreePath, args: ['diff-tree', '-r', '-M', '--no-commit-id', '--shortstat', ...range, '--'] });
    const counted = shortstat.success ? /(\d+) files? changed/.exec(shortstat.stdout) : null;
    if (!counted) return null;
    totalCount = Number.parseInt(counted[1]!, 10);
  }
  const stats = numstat.success || numstat.outputLimitExceeded ? parseNumstatZ(numstat.stdout) : new Map();
  const files = entries.slice(0, input.maxFiles).map((entry) => {
    const counts = stats.get(entry.path);
    return {
      path: entry.path,
      previousPath: entry.previousPath,
      status: entry.status,
      insertions: counts?.insertions ?? null,
      deletions: counts?.deletions ?? null,
      binary: counts !== undefined && counts.insertions === null && counts.deletions === null,
    };
  });
  return { files, totalCount };
}

export type LineRange = Readonly<{ start: number; end: number }>;
export type FileHunks = Readonly<{ oldRanges: LineRange[]; newRanges: LineRange[] }>;

/** Parses zero-context unified diff hunk headers into changed line ranges on each side. */
export function parseZeroContextHunks(diff: string): FileHunks {
  const oldRanges: LineRange[] = [];
  const newRanges: LineRange[] = [];
  for (const line of diff.split('\n')) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!match) continue;
    const oldStart = Number(match[1]);
    const oldCount = match[2] === undefined ? 1 : Number(match[2]);
    const newStart = Number(match[3]);
    const newCount = match[4] === undefined ? 1 : Number(match[4]);
    if (oldCount > 0) oldRanges.push({ start: oldStart, end: oldStart + oldCount - 1 });
    if (newCount > 0) newRanges.push({ start: newStart, end: newStart + newCount - 1 });
  }
  return { oldRanges, newRanges };
}

export async function readFileDiff(input: Readonly<{
  worktreePath: string;
  baseSha: string | null;
  sha: string;
  path: string;
  previousPath: string | null;
  contextLines: number;
  maxOutputBytes: number;
}>): Promise<string | null> {
  const pathspecs = [toRepoRootLiteralPathspec(input.path)];
  if (input.previousPath) pathspecs.push(toRepoRootLiteralPathspec(input.previousPath));
  const range = input.baseSha ? [input.baseSha, input.sha] : ['--root', input.sha];
  // `diff-tree` (root commits) only recurses into subdirectories with `-r`.
  const command = input.baseSha ? ['diff'] : ['diff-tree', '-r'];
  const result = await runObserverGit({
    cwd: input.worktreePath,
    args: [...command, '-M', '-p', `-U${input.contextLines}`, '--no-color', '--no-ext-diff', ...range, '--', ...pathspecs],
    maxOutputBytes: input.maxOutputBytes,
  });
  return result.success ? result.stdout : null;
}

export async function readFileAtRevision(input: Readonly<{
  worktreePath: string;
  sha: string;
  path: string;
  maxOutputBytes: number;
}>): Promise<string | null> {
  const result = await runObserverGit({
    cwd: input.worktreePath,
    args: ['show', `${input.sha}:${input.path}`],
    maxOutputBytes: input.maxOutputBytes,
  });
  return result.success ? result.stdout : null;
}

/** Files at `sha` containing `word` as a whole word; bounded by `maxFiles`. */
export async function grepFilesForWord(input: Readonly<{
  worktreePath: string;
  sha: string;
  word: string;
  maxFiles: number;
}>): Promise<string[]> {
  const result = await runObserverGit({
    cwd: input.worktreePath,
    args: ['grep', '-l', '-w', '-F', '-I', '-e', input.word, input.sha, '--'],
    maxOutputBytes: 256 * 1024,
  });
  // Exit code 1 means "no matches".
  if (!result.success) return [];
  const prefix = `${input.sha}:`;
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => (line.startsWith(prefix) ? line.slice(prefix.length) : line))
    .slice(0, input.maxFiles);
}
