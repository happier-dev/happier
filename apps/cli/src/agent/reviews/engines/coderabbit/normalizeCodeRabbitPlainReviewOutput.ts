import type { ExecutionRunProfileBoundedCompleteResult } from '@/agent/executionRuns/profiles/ExecutionRunIntentProfile';
import type { ExecutionRunStructuredMeta } from '@/agent/executionRuns/profiles/ExecutionRunIntentProfile';

type ParsedFinding = {
  filePath?: string;
  startLine?: number;
  endLine?: number;
  type?: string;
  comment?: string;
  suggestion?: string;
};

function isDelimiter(line: string): boolean {
  const t = line.trim();
  return t.length >= 20 && /^=+$/.test(t);
}

function parseLineRange(raw: string): Readonly<{ startLine?: number; endLine?: number }> {
  const s = raw.trim();
  const m = s.match(/(\d+)\s*(?:to|-)\s*(\d+)/i);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (Number.isFinite(a) && Number.isFinite(b)) {
      return { startLine: a, endLine: b };
    }
  }
  const n = s.match(/(\d+)/);
  if (n) {
    const a = Number(n[1]);
    if (Number.isFinite(a)) return { startLine: a, endLine: a };
  }
  return {};
}

function mapSeverity(typeRaw: string | undefined): 'blocker' | 'high' | 'medium' | 'low' | 'nit' {
  const t = String(typeRaw ?? '').trim().toLowerCase();
  if (t === 'security' || t === 'vulnerability') return 'blocker';
  if (t === 'bug' || t === 'defect') return 'high';
  if (t === 'performance') return 'high';
  if (t === 'refactor' || t === 'enhancement') return 'medium';
  if (t === 'docs') return 'low';
  if (t === 'style' || t === 'nit') return 'nit';
  return 'low';
}

function mapCategory(typeRaw: string | undefined): 'correctness' | 'security' | 'performance' | 'maintainability' | 'testing' | 'style' | 'docs' {
  const t = String(typeRaw ?? '').trim().toLowerCase();
  if (t === 'security' || t === 'vulnerability') return 'security';
  if (t === 'performance') return 'performance';
  if (t === 'docs') return 'docs';
  if (t === 'style' || t === 'nit') return 'style';
  if (t === 'refactor' || t === 'enhancement') return 'maintainability';
  return 'correctness';
}

function titleFromComment(comment?: string): string {
  const t = String(comment ?? '').trim();
  if (!t) return 'Finding';
  const firstLine = t.split('\n')[0]?.trim() ?? t;
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
}

function parseCodeRabbitPlainFindings(rawText: string): ReadonlyArray<ParsedFinding> {
  const lines = rawText.split('\n');
  const findings: ParsedFinding[] = [];

  let current: Partial<ParsedFinding> | null = null;
  let mode: 'none' | 'comment' | 'suggestion' = 'none';
  let commentLines: string[] = [];
  let suggestionLines: string[] = [];

  const flush = () => {
    if (!current) return;
    const comment = commentLines.join('\n').trim();
    const suggestion = suggestionLines.join('\n').trim();
    const next: ParsedFinding = {
      ...(current.filePath ? { filePath: current.filePath } : {}),
      ...(typeof current.startLine === 'number' ? { startLine: current.startLine } : {}),
      ...(typeof current.endLine === 'number' ? { endLine: current.endLine } : {}),
      ...(current.type ? { type: current.type } : {}),
      ...(comment ? { comment } : {}),
      ...(suggestion ? { suggestion } : {}),
    };
    // Only keep blocks that at least identify a file or contain comment/suggestion text.
    if (next.filePath || next.comment || next.suggestion) findings.push(next);
    current = null;
    mode = 'none';
    commentLines = [];
    suggestionLines = [];
  };

  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    const trimmed = line.trim();

    if (isDelimiter(trimmed)) {
      flush();
      continue;
    }

    if (trimmed.startsWith('File:')) {
      flush();
      current = {};
      mode = 'none';
      const filePath = trimmed.slice('File:'.length).trim();
      if (filePath) current.filePath = filePath;
      continue;
    }

    if (!current) {
      continue;
    }

    if (trimmed.startsWith('Line:')) {
      const rangeRaw = trimmed.slice('Line:'.length).trim();
      const { startLine, endLine } = parseLineRange(rangeRaw);
      if (typeof startLine === 'number') current.startLine = startLine;
      if (typeof endLine === 'number') current.endLine = endLine;
      continue;
    }

    if (trimmed.startsWith('Type:')) {
      const t = trimmed.slice('Type:'.length).trim();
      if (t) current.type = t;
      continue;
    }

    if (trimmed === 'Comment:' || trimmed.startsWith('Comment:')) {
      mode = 'comment';
      const after = trimmed.includes(':') ? trimmed.slice(trimmed.indexOf(':') + 1).trim() : '';
      if (after) commentLines.push(after);
      continue;
    }

    if (trimmed === 'Prompt for AI Agent:' || trimmed.startsWith('Prompt for AI Agent:')) {
      mode = 'suggestion';
      const after = trimmed.includes(':') ? trimmed.slice(trimmed.indexOf(':') + 1).trim() : '';
      if (after) suggestionLines.push(after);
      continue;
    }

    if (mode === 'comment') {
      // Preserve blank lines inside comment block only if we already started.
      if (trimmed.length === 0) {
        if (commentLines.length > 0) commentLines.push('');
        continue;
      }
      commentLines.push(line);
      continue;
    }

    if (mode === 'suggestion') {
      if (trimmed.length === 0) {
        if (suggestionLines.length > 0) suggestionLines.push('');
        continue;
      }
      suggestionLines.push(line);
      continue;
    }
  }

  flush();
  return findings;
}

export function normalizeCodeRabbitPlainReviewOutput(params: Readonly<{
  runId: string;
  callId: string;
  sidechainId: string;
  backendId: string;
  startedAtMs: number;
  finishedAtMs: number;
  rawText: string;
}>): ExecutionRunProfileBoundedCompleteResult {
  const parsed = parseCodeRabbitPlainFindings(params.rawText);
  const findings = parsed.map((f, idx) => {
    const severity = mapSeverity(f.type);
    const category = mapCategory(f.type);
    const summary = String(f.comment ?? '').trim() || String(f.suggestion ?? '').trim() || 'Finding';
    return {
      id: `coderabbit_${idx + 1}`,
      title: titleFromComment(summary),
      severity,
      category,
      summary,
      ...(f.filePath ? { filePath: f.filePath } : {}),
      ...(typeof f.startLine === 'number' ? { startLine: f.startLine } : {}),
      ...(typeof f.endLine === 'number' ? { endLine: f.endLine } : {}),
      ...(f.suggestion ? { suggestion: f.suggestion } : {}),
    };
  });

  const summary =
    findings.length === 0 ? 'CodeRabbit review: no findings.' : `CodeRabbit review: ${findings.length} finding(s).`;

  const structuredMeta: ExecutionRunStructuredMeta = {
    kind: 'review_findings.v1',
    payload: {
      runId: params.runId,
      callId: params.callId,
      sidechainId: params.sidechainId,
      backendId: params.backendId,
      intent: 'review',
      startedAtMs: params.startedAtMs,
      finishedAtMs: params.finishedAtMs,
      summary,
      findings,
    },
  };

  return {
    status: 'succeeded',
    summary,
    toolResultOutput: { ok: true, actionId: 'review.complete', summary, findingCount: findings.length },
    toolResultMeta: { happier: structuredMeta } as any,
    structuredMeta,
  };
}
