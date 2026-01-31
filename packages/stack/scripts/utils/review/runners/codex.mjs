import { runCaptureResult } from '../../proc/proc.mjs';

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

export function buildCodexReviewArgs({ baseRef, jsonMode, prompt }) {
  const args = ['exec', 'review', '--dangerously-bypass-approvals-and-sandbox'];

  // Codex review targets are mutually exclusive:
  // - --base / --commit / --uncommitted are distinct "targets"
  // - Providing a PROMPT switches to the "custom instructions" target and cannot be combined with the above.
  // Therefore, when reviewing a target (base/commit/uncommitted), we do not pass a prompt.
  if (baseRef) args.push('--base', baseRef);

  if (jsonMode) {
    args.push('--json');
  }

  const p = String(prompt ?? '').trim();
  if (!baseRef && p) args.push(p);
  if (!baseRef && !p) args.push('--uncommitted');
  return args;
}

export async function runCodexReview({ repoDir, baseRef, env, jsonMode, streamLabel, teeFile, teeLabel, prompt }) {
  const merged = { ...(env ?? {}) };
  const codexHome =
    (merged.HAPPY_STACKS_CODEX_HOME_DIR ?? merged.HAPPY_LOCAL_CODEX_HOME_DIR ?? merged.CODEX_HOME ?? '').toString().trim();
  if (codexHome) merged.CODEX_HOME = codexHome;

  const args = buildCodexReviewArgs({ baseRef, jsonMode, prompt });
  const res = await runCaptureResult('codex', args, { cwd: repoDir, env: merged, streamLabel, teeFile, teeLabel });
  return { ...res, stdout: res.out, stderr: res.err };
}
