import { runCaptureResult } from '../../proc/proc.mjs';

const unsupportedModels = new Set();

function parsePositiveInt(raw) {
  const n = Number(String(raw ?? '').trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function resolveCodexKeepaliveMs(env) {
  const specific = parsePositiveInt(env?.HAPPIER_STACK_REVIEW_CODEX_KEEPALIVE_MS);
  if (specific !== null) return specific;
  const global = parsePositiveInt(env?.HAPPIER_STACK_REVIEW_KEEPALIVE_MS);
  if (global !== null) return global;
  return 30_000;
}

export function detectCodexUnsupportedModelError({ stdout, stderr }) {
  const combined = `${stdout ?? ''}\n${stderr ?? ''}`;
  return combined.includes('model is not supported when using Codex with a ChatGPT account');
}

export function markCodexModelUnsupported(model) {
  const m = String(model ?? '').trim();
  if (m) unsupportedModels.add(m);
}

export function isCodexModelKnownUnsupported(model) {
  const m = String(model ?? '').trim();
  if (!m) return false;
  return unsupportedModels.has(m);
}

export function extractCodexReviewFromJsonl(jsonlText) {
  const lines = String(jsonlText ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  // JSONL events typically look like: { "type": "...", "payload": {...} } or similar.
  // We keep this resilient by searching for keys matching the exec output format.
  for (const line of lines) {
    let obj = null;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const candidates = [obj, obj?.msg, obj?.payload, obj?.event, obj?.data, obj?.result].filter(Boolean);
    for (const c of candidates) {
      const exited =
        c?.ExitedReviewMode ??
        (c?.type === 'ExitedReviewMode' ? c : null) ??
        (c?.event?.type === 'ExitedReviewMode' ? c.event : null) ??
        (c?.payload?.type === 'ExitedReviewMode' ? c.payload : null);

      const reviewOutput = exited?.review_output ?? exited?.reviewOutput ?? null;
      if (reviewOutput) return reviewOutput;
    }
  }
  return null;
}

export function buildCodexReviewArgs({ baseRef, jsonMode, prompt, model }) {
  const args = ['exec', 'review', '--dangerously-bypass-approvals-and-sandbox'];
  // Review runs should be deterministic and lightweight; disable user-configured MCP servers.
  args.push('-c', 'mcp_servers={}');

  // Codex review targets are mutually exclusive:
  // - --base / --commit / --uncommitted are distinct "targets"
  // - Providing a PROMPT switches to the "custom instructions" target and cannot be combined with the above.
  // Therefore, when reviewing a target (base/commit/uncommitted), we do not pass a prompt.
  if (baseRef) args.push('--base', baseRef);

  if (jsonMode) {
    args.push('--json');
  }

  const m = String(model ?? '').trim();
  if (m) args.push('--model', m);

  const p = String(prompt ?? '').trim();
  if (!baseRef && p) args.push(p);
  if (!baseRef && !p) args.push('--uncommitted');
  return args;
}

export async function runCodexReview({ repoDir, baseRef, env, jsonMode, streamLabel, teeFile, teeLabel, prompt, model }) {
  const merged = { ...(env ?? {}) };
  const codexHome =
    (merged.HAPPIER_STACK_CODEX_HOME_DIR ?? merged.CODEX_HOME ?? '').toString().trim();
  if (codexHome) merged.CODEX_HOME = codexHome;

  const effectiveModel = isCodexModelKnownUnsupported(model) ? '' : model;
  const args = buildCodexReviewArgs({ baseRef, jsonMode, prompt, model: effectiveModel });
  const heartbeatMs = resolveCodexKeepaliveMs(merged);
  const res = await runCaptureResult('codex', args, {
    cwd: repoDir,
    env: merged,
    streamLabel,
    teeFile,
    teeLabel,
    heartbeatMs,
  });

  const out = { ...res, stdout: res.out, stderr: res.err };
  if (out.ok) return out;

  const m = String(model ?? '').trim();
  if (m && detectCodexUnsupportedModelError({ stdout: out.stdout, stderr: out.stderr })) {
    markCodexModelUnsupported(m);
    // eslint-disable-next-line no-console
    console.warn(`[review] codex model '${m}' not supported; retrying without --model`);
    // In some environments, Codex running under a ChatGPT account rejects certain model IDs.
    // If that happens, fall back to the user's configured default model by omitting --model.
    const retryArgs = buildCodexReviewArgs({ baseRef, jsonMode, prompt, model: '' });
    const retry = await runCaptureResult('codex', retryArgs, {
      cwd: repoDir,
      env: merged,
      streamLabel,
      teeFile,
      teeLabel,
      heartbeatMs,
    });
    return { ...retry, stdout: retry.out, stderr: retry.err };
  }

  return out;
}
