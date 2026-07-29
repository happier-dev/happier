import type { ReviewFinding } from '@happier-dev/plugin-sdk/experimental/reviews';

type ParsedCodeRabbitFinding = {
  filePath?: string;
  startLine?: number;
  endLine?: number;
  type?: string;
  comment?: string;
  suggestion?: string;
};

const SECURITY_TEXT_PATTERNS = [
  /\bsecurity\b/i,
  /\bvulnerab/i,
  /\bcode injection\b/i,
  /\barbitrary code execution\b/i,
  /\brce\b/i,
  /\bpath traversal\b/i,
  /\bdirectory traversal\b/i,
  /\bdirectory escape\b/i,
  /\bcommand injection\b/i,
  /\bsql injection\b/i,
  /\bxss\b/i,
  /\bcsrf\b/i,
  /\bssrf\b/i,
];

function isDelimiter(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length >= 20 && /^=+$/.test(trimmed);
}

function parseLineRange(raw: string): Readonly<{ startLine?: number; endLine?: number }> {
  const range = raw.trim().match(/(\d+)\s*(?:to|-)\s*(\d+)/i);
  if (range?.[1] && range[2]) {
    const startLine = Number(range[1]);
    const endLine = Number(range[2]);
    if (Number.isFinite(startLine) && Number.isFinite(endLine)) return { startLine, endLine };
  }
  const single = raw.trim().match(/(\d+)/);
  if (single?.[1]) {
    const line = Number(single[1]);
    if (Number.isFinite(line)) return { startLine: line, endLine: line };
  }
  return {};
}

function parseCodeRabbitPlainFindings(rawText: string): readonly ParsedCodeRabbitFinding[] {
  const findings: ParsedCodeRabbitFinding[] = [];
  let current: Partial<ParsedCodeRabbitFinding> | null = null;
  let mode: 'none' | 'comment' | 'suggestion' = 'none';
  let commentLines: string[] = [];
  let suggestionLines: string[] = [];

  const flush = () => {
    if (!current) return;
    const comment = commentLines.join('\n').trim();
    const suggestion = suggestionLines.join('\n').trim();
    const next: ParsedCodeRabbitFinding = {
      ...(current.filePath ? { filePath: current.filePath } : {}),
      ...(typeof current.startLine === 'number' ? { startLine: current.startLine } : {}),
      ...(typeof current.endLine === 'number' ? { endLine: current.endLine } : {}),
      ...(current.type ? { type: current.type } : {}),
      ...(comment ? { comment } : {}),
      ...(suggestion ? { suggestion } : {}),
    };
    if (next.filePath || next.comment || next.suggestion) findings.push(next);
    current = null;
    mode = 'none';
    commentLines = [];
    suggestionLines = [];
  };

  for (const rawLine of rawText.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const trimmed = line.trim();

    if (isDelimiter(trimmed)) {
      flush();
      continue;
    }
    if (trimmed.startsWith('File:')) {
      flush();
      current = {};
      const filePath = trimmed.slice('File:'.length).trim();
      if (filePath) current.filePath = filePath;
      continue;
    }
    if (!current) continue;
    if (trimmed.startsWith('Line:')) {
      const range = parseLineRange(trimmed.slice('Line:'.length));
      if (typeof range.startLine === 'number') current.startLine = range.startLine;
      if (typeof range.endLine === 'number') current.endLine = range.endLine;
      continue;
    }
    if (trimmed.startsWith('Type:')) {
      const type = trimmed.slice('Type:'.length).trim();
      if (type) current.type = type;
      continue;
    }
    if (trimmed === 'Comment:' || trimmed.startsWith('Comment:')) {
      mode = 'comment';
      const after = trimmed.slice('Comment:'.length).trim();
      if (after) commentLines.push(after);
      continue;
    }
    if (trimmed === 'Prompt for AI Agent:' || trimmed.startsWith('Prompt for AI Agent:')) {
      mode = 'suggestion';
      const after = trimmed.slice('Prompt for AI Agent:'.length).trim();
      if (after) suggestionLines.push(after);
      continue;
    }
    if (mode === 'comment') {
      if (trimmed || commentLines.length > 0) commentLines.push(line);
      continue;
    }
    if (mode === 'suggestion' && (trimmed || suggestionLines.length > 0)) {
      suggestionLines.push(line);
    }
  }
  flush();
  return findings;
}

function hasSecuritySignal(text: string): boolean {
  return SECURITY_TEXT_PATTERNS.some((pattern) => pattern.test(text));
}

function mapSeverity(type: string | undefined, text: string): ReviewFinding['severity'] {
  const normalized = String(type ?? '').toLowerCase();
  if (normalized === 'security' || normalized === 'vulnerability') return 'blocker';
  if (normalized === 'bug' || normalized === 'defect') return 'high';
  if (normalized === 'performance') return 'high';
  if (normalized === 'refactor' || normalized === 'enhancement') return 'medium';
  if (normalized === 'style' || normalized === 'nit') return 'nit';
  if (/\b(blocker|critical)\b/i.test(text)) return 'blocker';
  if (hasSecuritySignal(text)) return 'high';
  if (/\bmedium\b/i.test(text)) return 'medium';
  return 'low';
}

function mapCategory(type: string | undefined, text: string): ReviewFinding['category'] {
  const normalized = String(type ?? '').toLowerCase();
  if (normalized === 'security' || normalized === 'vulnerability') return 'security';
  if (normalized === 'performance') return 'performance';
  if (normalized === 'docs') return 'docs';
  if (normalized === 'style' || normalized === 'nit') return 'style';
  if (normalized === 'refactor' || normalized === 'enhancement') return 'maintainability';
  if (hasSecuritySignal(text)) return 'security';
  return 'correctness';
}

function titleFromComment(comment: string | undefined): string {
  const firstLine = String(comment ?? 'Finding').trim().split('\n')[0]?.trim() || 'Finding';
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
}

export function normalizeCodeRabbitPlainReviewOutput(rawText: string): readonly ReviewFinding[] {
  return parseCodeRabbitPlainFindings(rawText).map((finding, index): ReviewFinding => {
    const text = [finding.type, finding.comment, finding.suggestion].filter(Boolean).join('\n');
    const summary = finding.comment?.trim() || finding.suggestion?.trim() || 'Review finding';
    return {
      id: `coderabbit-${index + 1}`,
      title: titleFromComment(summary),
      severity: mapSeverity(finding.type, text),
      category: mapCategory(finding.type, text),
      ...(finding.filePath ? { filePath: finding.filePath } : {}),
      ...(typeof finding.startLine === 'number' ? { startLine: finding.startLine } : {}),
      ...(typeof finding.endLine === 'number' ? { endLine: finding.endLine } : {}),
      summary,
      ...(finding.suggestion ? { suggestion: finding.suggestion } : {}),
      confidence: 0.8,
    };
  });
}

export function buildCodeRabbitReviewJsonOutput(rawText: string): string {
  const findings = normalizeCodeRabbitPlainReviewOutput(rawText);
  const summary =
    findings.length === 0
      ? 'CodeRabbit review: no findings.'
      : `CodeRabbit review: ${findings.length} finding(s).`;

  return JSON.stringify({
    summary,
    overviewMarkdown: `${summary}\n\nParsed ${findings.length} finding(s) from CodeRabbit plain output.`,
    findings,
    questions: [],
    assumptions: [],
    proposedComments: findings.flatMap((finding) => {
      const filePath = finding.filePath?.trim();
      const body = finding.summary.trim();
      if (!filePath || !body) return [];
      const anchor = typeof finding.startLine === 'number'
        ? typeof finding.endLine === 'number' && finding.endLine > finding.startLine
          ? { kind: 'range' as const, filePath, startLine: finding.startLine, endLine: finding.endLine }
          : { kind: 'line' as const, filePath, line: finding.startLine }
        : { kind: 'file' as const, filePath };
      const severity = finding.severity === 'blocker'
        ? 'critical' as const
        : finding.severity === 'high'
          ? 'error' as const
          : finding.severity === 'medium'
            ? 'warning' as const
            : 'info' as const;
      return [{
        findingId: finding.id,
        body,
        anchor,
        severity,
        taxonomyIds: [`coderabbit.${finding.category}`],
        tags: ['coderabbit'],
      }];
    }),
  });
}
