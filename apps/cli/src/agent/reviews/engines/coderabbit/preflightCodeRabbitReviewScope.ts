import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { ReviewStartInput } from '@happier-dev/protocol';
import { normalizeCodeRabbitReviewStartInput } from './normalizeCodeRabbitReviewStartInput.js';

const execFileAsync = promisify(execFile);

type PreflightResult =
  | Readonly<{ ok: true; eligibleFileCount: number }>
  | Readonly<{ ok: false; error: string }>;

async function runGit(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 4,
    windowsHide: true,
  });
  return String(result.stdout ?? '');
}

async function tryRunGit(cwd: string, args: string[]): Promise<string | null> {
  try {
    return await runGit(cwd, args);
  } catch {
    return null;
  }
}

function parsePathsZ(raw: string | null): string[] {
  return String(raw ?? '')
    .split('\0')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

async function ensureGitWorktree(cwd: string): Promise<boolean> {
  const raw = await tryRunGit(cwd, ['rev-parse', '--is-inside-work-tree']);
  return String(raw ?? '').trim() === 'true';
}

async function currentBranchName(cwd: string): Promise<string> {
  return String(await tryRunGit(cwd, ['branch', '--show-current']) ?? '').trim();
}

function branchOwnerPrefix(branch: string): string {
  const normalized = String(branch ?? '').trim();
  if (!normalized.includes('/')) return '';
  return normalized.split('/')[0] ?? '';
}

function parseGithubOwner(remoteUrl: string): string {
  const normalized = String(remoteUrl ?? '').trim();
  if (!normalized) return '';

  const sshMatch = normalized.match(/^[^@]+@[^:]+:([^/]+)\/[^/]+(?:\.git)?$/);
  if (sshMatch?.[1]) return sshMatch[1];

  try {
    const url = new URL(normalized);
    const segments = url.pathname.split('/').filter(Boolean);
    return segments[0] ?? '';
  } catch {
    return '';
  }
}

async function inferRemoteFromBranchOwner(cwd: string): Promise<string> {
  const owner = branchOwnerPrefix(await currentBranchName(cwd));
  if (!owner) return '';

  for (const remoteName of ['upstream', 'origin', 'fork']) {
    const remoteUrl = await tryRunGit(cwd, ['remote', 'get-url', remoteName]);
    if (parseGithubOwner(String(remoteUrl ?? '')) === owner) {
      return remoteName;
    }
  }

  return '';
}

async function resolveRemoteDefaultBranch(cwd: string, remote: string): Promise<string> {
  const symbolic = await tryRunGit(cwd, ['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`]);
  const trimmed = String(symbolic ?? '').trim();
  if (trimmed.includes('/')) {
    return trimmed.split('/').slice(1).join('/');
  }
  return '';
}

async function ensureRemoteRefAvailable(cwd: string, remote: string, branch: string): Promise<boolean> {
  const ref = `refs/remotes/${remote}/${branch}`;
  return (await tryRunGit(cwd, ['rev-parse', '--verify', ref])) !== null;
}

async function resolveDefaultBaseRef(cwd: string): Promise<string> {
  const upstream = String(
    await tryRunGit(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']) ?? '',
  ).trim();
  if (upstream.includes('/')) {
    return upstream;
  }

  const inferredRemote = await inferRemoteFromBranchOwner(cwd);
  const remoteCandidates = new Set<string>();
  for (const candidate of [inferredRemote, 'upstream', 'origin', 'fork']) {
    const trimmed = String(candidate ?? '').trim();
    if (trimmed) remoteCandidates.add(trimmed);
  }

  for (const remote of remoteCandidates) {
    const branch = await resolveRemoteDefaultBranch(cwd, remote);
    if (!branch) continue;
    if (await ensureRemoteRefAvailable(cwd, remote, branch)) {
      return `${remote}/${branch}`;
    }
  }

  throw new Error('Unable to resolve a default base branch for CodeRabbit review.');
}

async function listCommittedPaths(cwd: string, baseRef: string): Promise<string[]> {
  const raw = await runGit(cwd, ['diff', '--name-only', `${baseRef}...HEAD`]);
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function listUncommittedPaths(cwd: string): Promise<string[]> {
  const tracked = await tryRunGit(cwd, ['diff', '--name-only', '--find-renames', '-z', 'HEAD']);
  const untracked = await runGit(cwd, ['ls-files', '--others', '--exclude-standard', '-z']);
  return Array.from(new Set([...parsePathsZ(tracked), ...parsePathsZ(untracked)]));
}

export async function resolveCodeRabbitBaseRef(params: Readonly<{
  cwd: string;
  reviewInput: ReviewStartInput;
}>): Promise<string | null> {
  if (params.reviewInput.changeType !== 'committed' && params.reviewInput.changeType !== 'all') {
    return null;
  }

  if (params.reviewInput.base.kind === 'branch') {
    return params.reviewInput.base.baseBranch;
  }
  if (params.reviewInput.base.kind === 'commit') {
    return params.reviewInput.base.baseCommit;
  }
  return await resolveDefaultBaseRef(params.cwd);
}

export async function preflightCodeRabbitReviewScope(params: Readonly<{
  cwd: string;
  intentInput: unknown;
  maxEligibleFiles?: number | null;
}>): Promise<PreflightResult> {
  const cwd = String(params.cwd ?? '').trim();
  if (!cwd) {
    return { ok: false, error: 'CodeRabbit review requires a session working directory.' };
  }

  if (!(await ensureGitWorktree(cwd))) {
    return { ok: false, error: 'CodeRabbit review requires a git worktree in the current session scope.' };
  }

  let reviewInput: ReviewStartInput;
  try {
    reviewInput = normalizeCodeRabbitReviewStartInput({
      intentInput: params.intentInput ?? {},
      fallbackInstructions: 'Review.',
    });
  } catch {
    return { ok: false, error: 'Invalid CodeRabbit review input.' };
  }

  const changeType = reviewInput.changeType;

  let committedPaths: string[] = [];
  if (changeType === 'committed' || changeType === 'all') {
    const baseRef = await resolveCodeRabbitBaseRef({ cwd, reviewInput });
    if (!baseRef) {
      throw new Error('CodeRabbit review base ref is required for committed scopes.');
    }
    committedPaths = await listCommittedPaths(cwd, baseRef);
  }

  let uncommittedPaths: string[] = [];
  if (changeType === 'uncommitted' || changeType === 'all') {
    uncommittedPaths = await listUncommittedPaths(cwd);
  }

  const eligibleFileCount = new Set([...committedPaths, ...uncommittedPaths]).size;
  if (eligibleFileCount <= 0) {
    return {
      ok: false,
      error:
        'No reviewable files found in the current session scope. Change the review scope, choose another change type, or start the review from a session rooted at the files you want reviewed.',
    };
  }

  const maxEligibleFiles =
    typeof params.maxEligibleFiles === 'number' && Number.isFinite(params.maxEligibleFiles)
      ? Math.max(1, Math.trunc(params.maxEligibleFiles))
      : null;
  if (maxEligibleFiles !== null && eligibleFileCount > maxEligibleFiles) {
    return {
      ok: false,
      error:
        `Too many reviewable files found in the current session scope for CodeRabbit (${eligibleFileCount} > ${maxEligibleFiles}). Narrow the review scope, choose another change type, or increase HAPPIER_CODERABBIT_REVIEW_MAX_ELIGIBLE_FILES if the provider limit has changed.`,
    };
  }

  return { ok: true, eligibleFileCount };
}
