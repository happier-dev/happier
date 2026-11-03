import { createHash } from 'node:crypto';
import { z } from 'zod';

import type { ReviewFinding } from '@happier-dev/protocol';

type ParsedCodexNativeReview = {
  summary: string;
  overviewMarkdown: string;
  findings: ReviewFinding[];
};

type FindingDraft = {
  title: string;
  filePath: string;
  startLine: number;
  endLine: number;
  bodyLines: string[];
};

const REVIEW_COMMENTS_HEADER_PATTERN = /^(?:Full review comments|Review comment):\s*$/i;
const FINDING_BULLET_PATTERN = /^\s*-\s+(.+?)\s+(?:--|[-\u2013\u2014])\s+(.+):(\d+)(?:-(\d+))?\s*$/u;
const INDENTED_BODY_LINE_PATTERN = /^(?: {2,}|\t)(.*)$/;
const CODEX_JSON_REVIEW_SCHEMA = z.object({
  findings: z.array(z.object({
    title: z.string().trim().min(1),
    body: z.string().trim().min(1),
    priority: z.number().int().min(0).max(3).optional(),
    confidence_score: z.number().min(0).max(1).optional(),
    code_location: z.object({
      absolute_file_path: z.string().trim().min(1),
      line_range: z.object({
        start: z.number().int().min(1),
        end: z.number().int().min(1),
      }).refine((range) => range.end >= range.start),
    }),
  })),
  overall_explanation: z.string().trim(),
});
const SEVERITY_BY_PRIORITY = ['blocker', 'high', 'medium', 'low'] as const;
const REVIEW_JSON_FIELDS = new Set([
  ...Object.keys(CODEX_JSON_REVIEW_SCHEMA.shape),
  'overall_correctness',
  'overall_confidence_score',
]);

function hasReviewFields(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return [...REVIEW_JSON_FIELDS]
    .some((field) => Object.prototype.hasOwnProperty.call(value, field));
}

function containsReviewFields(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  return hasReviewFields(value) || Object.values(value).some(containsReviewFields);
}

function readJsonFieldToken(text: string): { name: string; rest: string; complete: boolean } | null {
  const match = /^\s*("(?:\\.|[^"\\\r\n])*"?|[A-Za-z_]\w*)/.exec(text);
  if (!match) return null;
  const token = match[1];
  const quoted = token.startsWith('"');
  const complete = !quoted || token.endsWith('"');
  try {
    const name: unknown = quoted ? JSON.parse(complete ? token : `${token}"`) : token;
    return typeof name === 'string' ? { name, rest: text.slice(match[0].length), complete } : null;
  } catch {
    return null;
  }
}

function hasReviewFieldText(text: string): boolean {
  for (const match of text.matchAll(/[{,]/g)) {
    const token = readJsonFieldToken(text.slice(match.index + 1));
    if (token && REVIEW_JSON_FIELDS.has(token.name)) return true;
  }
  return false;
}

function canStartJsonValue(text: string, start: number): boolean {
  const tail = text.slice(start + 1).trimStart();
  if (text[start] === '[') return /^(?:[\[\]{}"]|-?\d|true\b|false\b|null\b)/.test(tail);
  if (tail.startsWith('}')) return true;
  const key = readJsonFieldToken(tail);
  if (!key) return false;
  if (REVIEW_JSON_FIELDS.has(key.name)) return true;
  return tail.startsWith('"') && key.complete && /^\s*:/.test(key.rest);
}

function extractJsonSpans(text: string): string[] {
  // Keep outer JSON values whole; JSON.parse owns syntax validation.
  const spans: string[] = [];
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== '{' && text[start] !== '[') continue;
    if (!canStartJsonValue(text, start)) continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = start;
    for (; end < text.length; end += 1) {
      const char = text[end];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '{' || char === '[') depth += 1;
      else if (char === '}' || char === ']') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    spans.push(text.slice(start, end + 1));
    start = end;
  }
  return spans;
}

function firstNonEmptyParagraph(text: string): string {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
  return paragraphs[0] ?? 'Codex review completed.';
}

function stableFindingId(finding: Readonly<{
  title: string;
  filePath: string;
  startLine: number;
  endLine: number;
  summary: string;
}>): string {
  const normalized = [
    finding.title.trim(),
    finding.filePath.trim(),
    String(finding.startLine),
    String(finding.endLine),
    finding.summary.trim(),
  ].join('\n');
  return `codex_${createHash('sha256').update(normalized).digest('hex').slice(0, 16)}`;
}

function toFinding(draft: FindingDraft): ReviewFinding {
  const summary = draft.bodyLines.join('\n').trim() || draft.title;
  return {
    id: stableFindingId({
      title: draft.title,
      filePath: draft.filePath,
      startLine: draft.startLine,
      endLine: draft.endLine,
      summary,
    }),
    title: draft.title,
    severity: 'medium',
    category: 'correctness',
    summary,
    filePath: draft.filePath,
    startLine: draft.startLine,
    endLine: draft.endLine,
  };
}

function parseNativeFindings(text: string): { findings: ReviewFinding[]; textOutsideFindings: string } {
  const lines = text.split('\n');
  const outsideLines = [...lines];
  const findings: ReviewFinding[] = [];
  let inComments = false;
  let current: FindingDraft | null = null;

  const flush = () => {
    if (!current) return;
    findings.push(toFinding(current));
    current = null;
  };

  for (const [lineIndex, rawLine] of lines.entries()) {
    const line = rawLine.replace(/\r$/, '');
    const trimmed = line.trim();

    if (!inComments) {
      if (REVIEW_COMMENTS_HEADER_PATTERN.test(trimmed)) {
        inComments = true;
        outsideLines[lineIndex] = '';
      }
      continue;
    }

    const bullet = line.match(FINDING_BULLET_PATTERN);
    if (bullet) {
      flush();
      outsideLines[lineIndex] = '';
      const startLine = Number(bullet[3]);
      const endLine = bullet[4] ? Number(bullet[4]) : startLine;
      current = {
        title: bullet[1]?.trim() || 'Finding',
        filePath: bullet[2]?.trim() || '',
        startLine,
        endLine,
        bodyLines: [],
      };
      continue;
    }

    if (!current) continue;
    if (trimmed.length === 0) {
      if (current.bodyLines.length > 0) current.bodyLines.push('');
      continue;
    }

    const bodyLine = line.match(INDENTED_BODY_LINE_PATTERN);
    if (!bodyLine) {
      flush();
      continue;
    }
    outsideLines[lineIndex] = '';
    current.bodyLines.push(bodyLine[1] ?? '');
  }

  flush();
  return { findings, textOutsideFindings: outsideLines.join('\n') };
}

export function parseCodexNativeReviewText(rawText: string): ParsedCodexNativeReview | null {
  const overviewMarkdown = rawText.trim();
  if (overviewMarkdown.length === 0) return null;

  const prose = parseNativeFindings(overviewMarkdown);
  const textFindings = prose.findings;
  let jsonReview: z.infer<typeof CODEX_JSON_REVIEW_SCHEMA> | null = null;
  // Native prose can quote JSON examples that are unrelated to review output.
  for (const span of extractJsonSpans(prose.textOutsideFindings)) {
    let json: unknown;
    try {
      json = JSON.parse(span);
    } catch {
      if (hasReviewFieldText(span)) return null;
      continue;
    }
    if (!hasReviewFields(json)) {
      if (containsReviewFields(json)) return null;
      continue;
    }
    const parsed = CODEX_JSON_REVIEW_SCHEMA.safeParse(json);
    if (!parsed.success || jsonReview || textFindings.length > 0) return null;
    jsonReview = parsed.data;
  }

  if (jsonReview) {
    return {
      summary: firstNonEmptyParagraph(jsonReview.overall_explanation),
      overviewMarkdown: jsonReview.overall_explanation,
      findings: jsonReview.findings.map((finding) => ({
        ...toFinding({
          title: finding.title,
          filePath: finding.code_location.absolute_file_path,
          startLine: finding.code_location.line_range.start,
          endLine: finding.code_location.line_range.end,
          bodyLines: [finding.body],
        }),
        severity: SEVERITY_BY_PRIORITY[finding.priority ?? 2] ?? 'medium',
        ...(finding.confidence_score !== undefined ? { confidence: finding.confidence_score } : {}),
      })),
    };
  }

  return {
    summary: firstNonEmptyParagraph(overviewMarkdown),
    overviewMarkdown,
    findings: textFindings,
  };
}
