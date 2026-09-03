// @ts-check

import { execFileSync, spawnSync } from 'node:child_process';

/** @param {string} token */
export function buildGitHubGitAuthorizationHeader(token) {
  const value = String(token ?? '').trim();
  if (!value) return '';
  const credentials = Buffer.from(`x-access-token:${value}`, 'utf8').toString('base64');
  return `AUTHORIZATION: basic ${credentials}`;
}

/** @param {unknown} raw @param {string} name */
export function readCommitSha(raw, name) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(value)) throw new Error(`${name} must be a full 40-character Git commit SHA.`);
  return value;
}

/** @param {string} remote */
function readRemote(remote) {
  const value = String(remote ?? '').trim();
  if (!/^[A-Za-z0-9._-]+$/.test(value)) throw new Error('remote must be a simple configured Git remote name.');
  return value;
}

/** @param {string} targetRef */
function readTargetRef(targetRef) {
  const value = String(targetRef ?? '').trim();
  if (!/^refs\/heads\/deploy\/(?:preview|production)\/(?:ui|server|website|docs)$/.test(value)) {
    throw new Error('targetRef must be an allowed deploy branch ref.');
  }
  return value;
}

/** @param {string} authorizationHeader */
function authArgs(authorizationHeader) {
  return authorizationHeader ? ['-c', `http.extraHeader=${authorizationHeader}`] : [];
}

/**
 * @param {string} remote
 * @param {string} targetRef
 * @param {string} authorizationHeader
 * @returns {string | null}
 */
export function readRemoteRef(remote, targetRef, authorizationHeader = '') {
  const result = spawnSync('git', [...authArgs(authorizationHeader), 'ls-remote', '--refs', remote, targetRef], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `Unable to read ${targetRef} from ${remote}.`);
  const output = result.stdout.trim();
  if (!output) return null;
  const rows = output.split(/\r?\n/).filter(Boolean);
  if (rows.length !== 1) throw new Error(`Remote returned multiple rows for exact ref ${targetRef}.`);
  const [sha, resolvedRef] = rows[0].split(/\s+/, 2);
  if (resolvedRef !== targetRef) throw new Error(`Remote returned unexpected ref ${resolvedRef || '<missing>'}.`);
  return readCommitSha(sha, 'remote ref SHA');
}

/** @param {string} candidateSha @param {string} remote @param {string} authorizationHeader */
function ensureCandidateCommit(candidateSha, remote, authorizationHeader) {
  const fetch = spawnSync(
    'git',
    [...authArgs(authorizationHeader), 'fetch', '--no-tags', '--depth=1', remote, candidateSha],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 },
  );
  if (fetch.status !== 0) throw new Error(fetch.stderr.trim() || `Unable to fetch candidate ${candidateSha} from ${remote}.`);

  try {
    execFileSync('git', ['cat-file', '-e', `${candidateSha}^{commit}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    });
  } catch {
    throw new Error(`Candidate ${candidateSha} is not available as a commit after fetch.`);
  }
}

/**
 * Atomically projects one validated commit onto one deploy branch.
 *
 * The observed ref is the compare side of the force-with-lease mutation. A
 * failed push is never retried: the exact ref is observed once afterward so a
 * response lost after an applied write can be reconciled without a duplicate
 * mutation.
 *
 * @param {{
 *   candidateSha: string;
 *   targetRef: string;
 *   remote?: string;
 *   authorizationHeader?: string;
 *   expectedCurrentSha?: string | null;
 *   dryRun?: boolean;
 * }} input
 */
export function promoteDeployRef(input) {
  const candidateSha = readCommitSha(input.candidateSha, 'candidateSha');
  const targetRef = readTargetRef(input.targetRef);
  const remote = readRemote(input.remote ?? 'origin');
  const authorizationHeader = String(input.authorizationHeader ?? '');

  if (input.dryRun === true) {
    const illustrativeObserved = '0000000000000000000000000000000000000000';
    console.log(`[dry-run] git ls-remote --refs ${remote} ${targetRef}`);
    console.log(`[dry-run] git push --force-with-lease=${targetRef}:${illustrativeObserved} ${remote} ${candidateSha}:${targetRef}`);
    return { oldSha: null, newSha: candidateSha, changed: true };
  }

  ensureCandidateCommit(candidateSha, remote, authorizationHeader);
  const observedCurrentSha = readRemoteRef(remote, targetRef, authorizationHeader);
  if (input.expectedCurrentSha !== undefined && observedCurrentSha !== input.expectedCurrentSha) {
    throw new Error(
      `Deploy ref changed concurrently or did not match expected current SHA: expected ${input.expectedCurrentSha ?? 'missing'}, observed ${observedCurrentSha ?? 'missing'}.`,
    );
  }

  const changed = observedCurrentSha !== candidateSha;
  let mutationError = '';
  if (changed) {
    const lease = `${targetRef}:${observedCurrentSha ?? ''}`;
    const push = spawnSync(
      'git',
      [...authArgs(authorizationHeader), 'push', `--force-with-lease=${lease}`, remote, `${candidateSha}:${targetRef}`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 },
    );
    if (push.status !== 0) mutationError = push.stderr.trim() || `Atomic promotion of ${targetRef} failed.`;
  }

  const finalSha = readRemoteRef(remote, targetRef, authorizationHeader);
  if (finalSha !== candidateSha) {
    const prefix = mutationError ? `${mutationError}\n` : '';
    throw new Error(`${prefix}Deploy ref verification failed: expected ${candidateSha}, observed ${finalSha ?? 'missing'}.`);
  }

  return { oldSha: observedCurrentSha, newSha: candidateSha, changed };
}
