import { runCaptureResult } from '../../proc/proc.mjs';

export function detectAugmentAuthError({ stdout, stderr }) {
  const combined = `${stdout ?? ''}\n${stderr ?? ''}`;
  return combined.includes('Authentication failed') && combined.includes("Run 'auggie login'");
}

function parsePositiveInt(raw) {
  const n = Number(String(raw ?? '').trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function resolveAugmentKeepaliveMs(env) {
  const specific = parsePositiveInt(env?.HAPPIER_STACK_REVIEW_AUGMENT_KEEPALIVE_MS);
  if (specific !== null) return specific;
  const global = parsePositiveInt(env?.HAPPIER_STACK_REVIEW_KEEPALIVE_MS);
  if (global !== null) return global;
  return 30_000;
}

export function buildAugmentReviewArgs({
  prompt,
  workspaceRoot,
  cacheDir,
  model,
  rulesFiles = [],
  retryTimeoutSec,
  maxTurns,
} = {}) {
  const args = ['--print', '--quiet', '--dont-save-session', '--ask', '--output-format', 'text'];

  const wr = String(workspaceRoot ?? '').trim();
  if (wr) args.push('--workspace-root', wr);

  const cd = String(cacheDir ?? '').trim();
  if (cd) args.push('--augment-cache-dir', cd);

  const m = String(model ?? '').trim();
  if (m) args.push('--model', m);

  const rt = String(retryTimeoutSec ?? '').trim();
  if (rt) args.push('--retry-timeout', rt);

  const mt = String(maxTurns ?? '').trim();
  if (mt) args.push('--max-turns', mt);

  for (const rf of Array.isArray(rulesFiles) ? rulesFiles : []) {
    const p = String(rf ?? '').trim();
    if (!p) continue;
    args.push('--rules', p);
  }

  const p = String(prompt ?? '').trim();
  if (!p) throw new Error('[review] augment: missing prompt');
  args.push(p);
  return args;
}

export async function runAugmentReview({
  repoDir,
  prompt,
  env,
  streamLabel,
  teeFile,
  teeLabel,
  cacheDir,
  model,
  rulesFiles = [],
  retryTimeoutSec = 60 * 60 * 2,
  maxTurns,
} = {}) {
  const args = buildAugmentReviewArgs({
    prompt,
    workspaceRoot: repoDir,
    cacheDir,
    model,
    rulesFiles,
    retryTimeoutSec,
    maxTurns,
  });
  const heartbeatMs = resolveAugmentKeepaliveMs(env ?? {});
  const res = await runCaptureResult('auggie', args, {
    cwd: repoDir,
    env: env ?? {},
    streamLabel,
    teeFile,
    teeLabel,
    heartbeatMs,
  });
  return { ...res, stdout: res.out, stderr: res.err };
}
