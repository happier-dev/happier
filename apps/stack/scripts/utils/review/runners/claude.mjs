import { runCaptureResult } from '../../proc/proc.mjs';

export function detectClaudeAuthError({ stdout, stderr }) {
  const combined = `${stdout ?? ''}\n${stderr ?? ''}`.toLowerCase();
  const hasAuthHint =
    combined.includes('authentication required') ||
    combined.includes('authentication failed') ||
    combined.includes('invalid api key') ||
    combined.includes('permission denied') ||
    combined.includes('claude auth login') ||
    combined.includes('claude login');
  const hasRateLimitHint =
    combined.includes('status code: 429') ||
    combined.includes('http 429') ||
    combined.includes('429 too many requests') ||
    combined.includes('rate_limit_exceeded') ||
    combined.includes('ratelimiterror');
  return hasAuthHint || hasRateLimitHint;
}

function parsePositiveInt(raw) {
  const n = Number(String(raw ?? '').trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function resolveClaudeKeepaliveMs(env) {
  const specific = parsePositiveInt(env?.HAPPIER_STACK_REVIEW_CLAUDE_KEEPALIVE_MS);
  if (specific !== null) return specific;
  const global = parsePositiveInt(env?.HAPPIER_STACK_REVIEW_KEEPALIVE_MS);
  if (global !== null) return global;
  return 30_000;
}

export function buildClaudeReviewArgs({ model, allowedTools } = {}) {
  const args = [
    '--print',
    '--input-format',
    'text',
    '--output-format',
    'text',
    '--no-session-persistence',
    '--disable-slash-commands',
    '--permission-mode',
    'bypassPermissions',
  ];

  const m = String(model ?? '').trim();
  if (m) args.push('--model', m);

  const tools =
    allowedTools === undefined ? 'Bash(git:*)' : String(allowedTools ?? '').trim();
  if (tools) args.push('--allowed-tools', tools);
  return args;
}

export async function runClaudeReview({
  repoDir,
  prompt,
  env,
  streamLabel,
  teeFile,
  teeLabel,
  model,
  allowedTools = 'Bash(git:*)',
} = {}) {
  const p = String(prompt ?? '').trim();
  if (!p) throw new Error('[review] claude: missing prompt');

  const args = buildClaudeReviewArgs({ model, allowedTools });
  const heartbeatMs = resolveClaudeKeepaliveMs(env ?? {});
  const res = await runCaptureResult('claude', args, {
    cwd: repoDir,
    env: env ?? {},
    streamLabel,
    teeFile,
    teeLabel,
    input: p,
    heartbeatMs,
  });
  return { ...res, stdout: res.out, stderr: res.err };
}
