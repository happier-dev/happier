import { runCapture } from '../proc/proc.mjs';

function normalizePath(p) {
  return String(p ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function parseNameStatusZ(buf) {
  const raw = String(buf ?? '');
  if (!raw) return [];
  const parts = raw.split('\0').filter((x) => x.length);
  const entries = [];
  let i = 0;
  while (i < parts.length) {
    const status = parts[i++];
    const code = status[0] ?? '';
    if (!code) break;
    if (code === 'R' || code === 'C') {
      const from = parts[i++] ?? '';
      const to = parts[i++] ?? '';
      entries.push({ code, status, from, to });
      continue;
    }
    const path = parts[i++] ?? '';
    entries.push({ code, status, path });
  }
  return entries;
}

export async function getChangedOps({ cwd, baseRef, headRef = 'HEAD', env = process.env } = {}) {
  const out = await runCapture('git', ['diff', '--name-status', '--find-renames', '-z', `${baseRef}...${headRef}`], { cwd, env });
  const entries = parseNameStatusZ(out);
  const checkout = new Set();
  const remove = new Set();
  for (const e of entries) {
    if (e.code === 'A' || e.code === 'M' || e.code === 'T') {
      checkout.add(normalizePath(e.path));
      continue;
    }
    if (e.code === 'D') {
      remove.add(normalizePath(e.path));
      continue;
    }
    if (e.code === 'R' || e.code === 'C') {
      if (e.from) remove.add(normalizePath(e.from));
      if (e.to) checkout.add(normalizePath(e.to));
      continue;
    }
  }
  const all = new Set([...checkout, ...remove]);
  return { checkout, remove, all };
}

function subset(set, allowed) {
  const out = new Set();
  for (const v of set) {
    if (allowed.has(v)) out.add(v);
  }
  return out;
}

function difference(set, blocked) {
  const out = new Set();
  for (const v of set) {
    if (!blocked.has(v)) out.add(v);
  }
  return out;
}

async function batched(args, batchSize, fn) {
  const list = Array.from(args);
  for (let i = 0; i < list.length; i += batchSize) {
    // eslint-disable-next-line no-await-in-loop
    await fn(list.slice(i, i + batchSize));
  }
}

async function gitCommit({ cwd, env, message }) {
  await runCapture(
    'git',
    [
      '-c',
      'user.name=Happy Review',
      '-c',
      'user.email=review@happy.local',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-q',
      '--no-verify',
      '-m',
      message,
    ],
    { cwd, env }
  );
  const sha = (await runCapture('git', ['rev-parse', 'HEAD'], { cwd, env })).trim();
  return sha;
}

async function applyOpsFromHead({ cwd, env, headCommit, checkoutPaths, removePaths }) {
  if (removePaths.size) {
    await batched(Array.from(removePaths), 200, async (batch) => {
      await runCapture('git', ['rm', '-q', '--ignore-unmatch', '--', ...batch], { cwd, env });
    });
  }
  if (checkoutPaths.size) {
    // Prefer batching over pathspec-from-file to maximize compatibility.
    await batched(Array.from(checkoutPaths), 100, async (batch) => {
      await runCapture('git', ['checkout', headCommit, '--', ...batch], { cwd, env });
    });
  }
  // Stage all changes introduced by the operations.
  await runCapture('git', ['add', '-A'], { cwd, env });
}

/**
 * Create two local commits inside an ephemeral worktree:
 * - baseSliceCommit: baseRef plus all NON-slice changes from headCommit
 * - headSliceCommit: baseSliceCommit plus slice changes from headCommit (resulting tree equals headCommit)
 *
 * These commits are intended solely for review tooling (CodeRabbit/Codex) so the reviewer sees:
 * - full, final code at HEAD
 * - a focused diff for the slice (baseSliceCommit..headSliceCommit)
 */
export async function createHeadSliceCommits({
  cwd,
  env = process.env,
  baseRef,
  headCommit,
  ops,
  slicePaths,
  label = 'slice',
} = {}) {
  const sliceSet = new Set((Array.isArray(slicePaths) ? slicePaths : []).map(normalizePath).filter(Boolean));
  const sliceCheckout = subset(ops.checkout, sliceSet);
  const sliceRemove = subset(ops.remove, sliceSet);
  const nonSliceCheckout = difference(ops.checkout, sliceSet);
  const nonSliceRemove = difference(ops.remove, sliceSet);

  // Start from baseRef.
  await runCapture('git', ['checkout', '-q', '--detach', baseRef], { cwd, env });

  // Commit non-slice changes.
  await applyOpsFromHead({ cwd, env, headCommit, checkoutPaths: nonSliceCheckout, removePaths: nonSliceRemove });
  const baseSliceCommit = await gitCommit({ cwd, env, message: `chore(review): base for ${label}` });

  // Commit slice changes.
  await applyOpsFromHead({ cwd, env, headCommit, checkoutPaths: sliceCheckout, removePaths: sliceRemove });
  const headSliceCommit = await gitCommit({ cwd, env, message: `chore(review): ${label}` });

  // Ensure working tree is at the head slice commit for downstream tools.
  await runCapture('git', ['checkout', '-q', headSliceCommit], { cwd, env });
  return { baseSliceCommit, headSliceCommit };
}
