import { runCaptureResult } from '../../proc/proc.mjs';
import { join } from 'node:path';
import { appendFile } from 'node:fs/promises';

function normalizeType(raw) {
  const t = String(raw ?? '').trim().toLowerCase();
  if (!t) return 'committed';
  if (t === 'all' || t === 'committed' || t === 'uncommitted') return t;
  throw new Error(`[review] invalid coderabbit type: ${raw} (expected: all|committed|uncommitted)`);
}

export function parseCodeRabbitRateLimitRetryMs(text) {
  const s = String(text ?? '');
  const m = s.match(/Rate limit exceeded,\s*please try after\s+(\d+)\s+minutes?\s+and\s+(\d+)\s+seconds?/i);
  if (!m) return null;
  const minutes = Number(m[1]);
  const seconds = Number(m[2]);
  if (!Number.isFinite(minutes) || minutes < 0) return null;
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  // Add +1s padding to avoid retrying too early.
  const totalSeconds = minutes * 60 + seconds + 1;
  return Math.max(1000, totalSeconds * 1000);
}

export function buildCodeRabbitReviewArgs({ repoDir, baseRef, baseCommit, type, configFiles }) {
  const args = ['review', '--plain', '--no-color', '--type', normalizeType(type), '--cwd', repoDir];
  const base = String(baseRef ?? '').trim();
  const bc = String(baseCommit ?? '').trim();
  if (base && bc) {
    throw new Error('[review] coderabbit: baseRef and baseCommit are mutually exclusive');
  }
  if (base) args.push('--base', base);
  if (bc) args.push('--base-commit', bc);
  const files = Array.isArray(configFiles) ? configFiles.filter(Boolean) : [];
  if (files.length) args.push('--config', ...files);
  return args;
}

export function buildCodeRabbitEnv({ env, homeDir }) {
  const merged = { ...(env ?? {}) };
  const dir = String(homeDir ?? '').trim();
  if (!dir) return merged;

  // IMPORTANT:
  // Do not override HOME/USERPROFILE here.
  //
  // CodeRabbit uses OS credential storage (e.g. macOS Keychain). If HOME is pointed at
  // an isolated directory (like .project/coderabbit-home), the underlying keychain
  // lookup can fail with "Keychain Not Found" and auth will not work in the wrapper.
  //
  // We still isolate CodeRabbit's on-disk config/cache under the provided homeDir via
  // CODERABBIT_HOME + XDG dirs.
  merged.CODERABBIT_HOME = join(dir, '.coderabbit');
  merged.XDG_CONFIG_HOME = join(dir, '.config');
  merged.XDG_CACHE_HOME = join(dir, '.cache');
  merged.XDG_STATE_HOME = join(dir, '.local', 'state');
  merged.XDG_DATA_HOME = join(dir, '.local', 'share');
  return merged;
}

export async function runCodeRabbitReview({
  repoDir,
  baseRef,
  baseCommit,
  env,
  type = 'committed',
  configFiles = [],
  streamLabel,
  teeFile,
  teeLabel,
}) {
  const homeDir = (env?.HAPPY_STACKS_CODERABBIT_HOME_DIR ?? '').toString().trim();
  const args = buildCodeRabbitReviewArgs({ repoDir, baseRef, baseCommit, type, configFiles });
  const maxAttempts = 50;
  let last = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const res = await runCaptureResult('coderabbit', args, {
      cwd: repoDir,
      env: buildCodeRabbitEnv({ env, homeDir }),
      streamLabel,
      teeFile,
      teeLabel,
    });
    last = res;
    if (res.ok) return { ...res, stdout: res.out, stderr: res.err };

    const retryMs = parseCodeRabbitRateLimitRetryMs(`${res.out ?? ''}\n${res.err ?? ''}`);
    if (!retryMs) return { ...res, stdout: res.out, stderr: res.err };

    const seconds = Math.ceil(retryMs / 1000);
    const msg = `[review] coderabbit rate limited; retrying in ${seconds}s (attempt ${attempt}/${maxAttempts})\n`;
    try {
      if (teeFile) await appendFile(teeFile, msg);
    } catch {
      // ignore
    }
    // eslint-disable-next-line no-console
    console.warn(msg.trimEnd());
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, retryMs));
  }

  return { ...last, stdout: last?.out ?? '', stderr: last?.err ?? '' };
}
