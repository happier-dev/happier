function parseLineRange(raw) {
  const s = String(raw ?? '').trim();
  // Common CodeRabbit format: "17 to 31"
  const m = s.match(/^(\d+)\s+to\s+(\d+)$/i);
  if (m) return { start: Number(m[1]), end: Number(m[2]) };
  const n = s.match(/^(\d+)$/);
  if (n) {
    const v = Number(n[1]);
    return { start: v, end: v };
  }
  return null;
}

export function parseCodeRabbitPlainOutput(text) {
  const lines = String(text ?? '').split('\n');
  const findings = [];

  let current = null;
  let mode = null; // 'comment' | 'prompt' | null

  function flush() {
    if (!current) return;
    const comment = (current._commentLines ?? []).join('\n').trim();
    const prompt = (current._promptLines ?? []).join('\n').trim();
    const title =
      current.title ??
      comment
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)[0] ??
      '';

    findings.push({
      reviewer: 'coderabbit',
      file: current.file ?? '',
      lines: current.lines ?? null,
      type: current.type ?? '',
      title,
      comment,
      prompt: prompt || null,
    });
    current = null;
    mode = null;
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    // The raw log files written by the review runner prefix each line with "[label] ".
    // Strip that prefix so we can parse both prefixed logs and unprefixed stdout.
    const trimmed = line.trimEnd().replace(/^\[[^\]]+\]\s*/g, '');

    if (trimmed.startsWith('============================================================================')) {
      flush();
      continue;
    }
    if (trimmed.startsWith('File: ')) {
      flush();
      current = { _commentLines: [], _promptLines: [] };
      current.file = trimmed.slice('File: '.length).trim();
      continue;
    }
    if (!current) continue;

    if (trimmed.startsWith('Line: ')) {
      const range = parseLineRange(trimmed.slice('Line: '.length).trim());
      current.lines = range;
      continue;
    }
    if (trimmed.startsWith('Type: ')) {
      current.type = trimmed.slice('Type: '.length).trim();
      continue;
    }
    if (trimmed === 'Comment:') {
      mode = 'comment';
      continue;
    }
    if (trimmed === 'Prompt for AI Agent:') {
      mode = 'prompt';
      continue;
    }

    if (mode === 'comment') {
      // Title is first non-empty comment line.
      if (!current.title && trimmed.trim()) current.title = trimmed.trim();
      current._commentLines.push(trimmed);
    } else if (mode === 'prompt') {
      current._promptLines.push(trimmed);
    }
  }

  flush();
  // Drop empty placeholders
  return findings.filter((f) => f.file && f.title);
}

export function parseCodexReviewText(reviewText) {
  const s = String(reviewText ?? '');
  const marker = '===FINDINGS_JSON===';
  const idx = s.indexOf(marker);
  if (idx >= 0) {
    let jsonText = s.slice(idx + marker.length).trim();
    if (!jsonText) return [];

    // The raw log files written by the review runner prefix each line with "[label] ".
    // Strip that prefix so we can parse both prefixed logs and unprefixed stdout.
    jsonText = jsonText
      .split('\n')
      .map((line) => String(line ?? '').replace(/^\[[^\]]+\]\s*/g, ''))
      .join('\n')
      .trim();

    // Some reviewers wrap the JSON in a fenced code block:
    // ===FINDINGS_JSON===
    // ```json
    // [...]
    // ```
    //
    // Strip the outer fence so JSON.parse can succeed.
    const fence = jsonText.match(/^```[a-z0-9_-]*\s*\n([\s\S]*?)\n```/i);
    if (fence?.[1]) jsonText = fence[1].trim();

    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      parsed = null;
    }

    // Some tools append non-JSON metadata after the array (e.g. "Request ID: ...").
    // As a last resort, try to parse the first top-level JSON array substring.
    if (!Array.isArray(parsed)) {
      const firstBracket = jsonText.indexOf('[');
      const lastBracket = jsonText.lastIndexOf(']');
      if (firstBracket >= 0 && lastBracket > firstBracket) {
        try {
          parsed = JSON.parse(jsonText.slice(firstBracket, lastBracket + 1));
        } catch {
          // ignore
        }
      }
    }
    if (Array.isArray(parsed)) {
      return parsed
        .map((x) => ({
          reviewer: 'codex',
          severity: x?.severity ?? null,
          file: x?.file ?? null,
          lines: x?.lines ?? null,
          title: x?.title ?? null,
          recommendation: x?.recommendation ?? null,
          needsDiscussion: Boolean(x?.needsDiscussion),
        }))
        .filter((x) => x.file && x.title);
    }
  }

  // Fallback: Codex sometimes returns a human-readable list like:
  // - [P2] Thing — /abs/path/.project/review-worktrees/codex-.../cli/src/foo.ts:10-12
  //
  // Parse these into structured findings so they appear in triage even when the
  // JSON trailer is missing.
  const priorityToSeverity = { 1: 'blocker', 2: 'major', 3: 'minor', 4: 'nit' };
  const lines = s.split('\n');
  const findings = [];
  const seen = new Set();

  function stripPrefix(line) {
    return String(line ?? '').replace(/^\[[^\]]+\]\s*/g, '').trim();
  }

  function normalizePath(rawPath) {
    const p = String(rawPath ?? '').trim();
    const marker2 = '/.project/review-worktrees/';
    const i = p.indexOf(marker2);
    if (i < 0) return p;
    const rest = p.slice(i + marker2.length);
    const slash = rest.indexOf('/');
    if (slash < 0) return p;
    return rest.slice(slash + 1);
  }

  for (const rawLine of lines) {
    const line = stripPrefix(rawLine);
    const m = line.match(/^- \[P([1-4])\]\s+(.+?)\s+—\s+(.+)$/);
    if (!m) continue;

    const priority = Number(m[1]);
    const title = String(m[2]).trim();
    const pathPart = String(m[3]).trim();

    let file = pathPart;
    let range = null;

    const lastColon = pathPart.lastIndexOf(':');
    if (lastColon > 0) {
      const suffix = pathPart.slice(lastColon + 1).trim();
      const rm = suffix.match(/^(\d+)(?:-(\d+))?$/);
      if (rm) {
        const start = Number(rm[1]);
        const end = Number(rm[2] ?? rm[1]);
        range = { start, end };
        file = pathPart.slice(0, lastColon);
      }
    }

    const normalizedFile = normalizePath(file);
    const severity = priorityToSeverity[priority] ?? null;
    const key = `${normalizedFile}:${range?.start ?? ''}-${range?.end ?? ''}:${title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({
      reviewer: 'codex',
      severity,
      file: normalizedFile,
      lines: range,
      title,
      recommendation: null,
      needsDiscussion: false,
    });
  }

  return findings.filter((x) => x.file && x.title);
}

export function formatTriageMarkdown({ runLabel, baseRef, findings }) {
  const items = Array.isArray(findings) ? findings : [];
  const header = [
    `# Review triage: ${runLabel}`,
    '',
    `- Base ref: ${baseRef ?? ''}`,
    `- Findings: ${items.length}`,
    '',
    '## Trust checklist (READ THIS FIRST)',
    '',
    'Before you act on reviewer output:',
    '1) Load this file into your context (human/LLM) so you follow the workflow end-to-end.',
    '2) Treat every suggestion as a suggestion: verify against best practices + project invariants.',
    '3) If you are unsure, do not apply; mark **Needs discussion** and capture rationale.',
    '4) Do not skip nits by default: apply them when they improve long-term maintainability without risk.',
    '5) Use web search sparingly when needed to validate best practices, but prefer primary sources/docs.',
    '',
    '## Mandatory workflow',
    '',
    'For each finding below:',
    '1) Open the referenced file/lines in the *validation worktree* (committed-only).',
    '2) Decide if it is a real bug/risk/correctness gap, already fixed, expected behavior, or style preference.',
    '3) Record a final decision + rationale here (`apply` / `adjust` / `defer`).',
    '4) If `apply/adjust`: implement in the main worktree as a clean commit (no unrelated changes), then sync that commit to validation.',
    '',
    'Notes:',
    '- Treat reviewer output as suggestions; verify against best practices and codebase invariants before applying.',
    '- Avoid brittle tests that assert on wording/phrasing/config; test observable behavior.',
    '',
  ].join('\n');

  const body = items
    .map((f) => {
      const lines = f.lines?.start ? `${f.lines.start}-${f.lines.end ?? f.lines.start}` : '';
      const meta = [
        `- [ ] \`${f.id ?? ''}\` reviewer=\`${f.reviewer ?? ''}\`${f.severity ? ` severity=\`${f.severity}\`` : ''}${
          f.type ? ` type=\`${f.type}\`` : ''
        } \`${f.file ?? ''}\`${lines ? ` (lines ${lines})` : ''}: ${f.title ?? ''}`,
        f.sourceLog ? `  - Source log: \`${f.sourceLog}\`` : null,
        '  - Final decision: **TBD** (apply|adjust|defer)',
        '  - Verified in validation worktree: **TBD**',
        '  - Rationale: **TBD**',
        '  - Action taken: **TBD**',
        '  - Commit: **TBD**',
        '  - Needs discussion: **TBD**',
      ];
      if (f.comment) meta.push(`  - Reviewer detail: ${String(f.comment).split('\n')[0].trim()}`);
      if (f.recommendation) meta.push(`  - Reviewer suggested fix: ${String(f.recommendation).split('\n')[0].trim()}`);
      return meta.filter(Boolean).join('\n');
    })
    .join('\n\n');

  return `${header}${body ? `${body}\n` : ''}`;
}
