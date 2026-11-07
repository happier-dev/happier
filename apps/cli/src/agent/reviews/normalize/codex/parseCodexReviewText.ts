import { createHash } from 'node:crypto';
import { z } from 'zod';

import { lazySchema, type ReviewFinding } from '@happier-dev/protocol';

import { parseJsonWithTrailingCommas } from '@/agent/executionRuns/profiles/shared/parseTrailingJsonObject';

export type ParsedCodexNativeReview = {
  summary: string;
  overviewMarkdown: string;
  findings: ReviewFinding[];
};

type ParsedCodexReview =
  | { format: 'native'; review: ParsedCodexNativeReview }
  | { format: 'strict-json'; rawText: string };

type FindingDraft = {
  title: string;
  filePath: string;
  startLine: number;
  endLine: number;
  bodyLines: string[];
};

type TextSpan = { start: number; end: number };
type JsonSpan = TextSpan & { text: string; terminated: boolean };

const REVIEW_COMMENTS_HEADER_PATTERN = /^(?:Full review comments|Review comment):\s*$/i;
const FINDING_BULLET_PATTERN = /^\s*-\s+(.+?)\s+(?:--|[-\u2013\u2014])\s+(.+):(\d+)(?:-(\d+))?\s*$/u;
const INDENTED_BODY_LINE_PATTERN = /^(?: {2,}|\t)(.*)$/;
const CODEX_JSON_REVIEW_SCHEMA = lazySchema(() => z.object({
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
}));
const SEVERITY_BY_PRIORITY = ['blocker', 'high', 'medium', 'low'] as const;
function isReviewJsonField(field: string): boolean {
  return Object.prototype.hasOwnProperty.call(CODEX_JSON_REVIEW_SCHEMA.shape, field)
    || field === 'overall_correctness'
    || field === 'overall_confidence_score';
}

function hasReviewFields(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.getOwnPropertyNames(value).some(isReviewJsonField);
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
    if (token && isReviewJsonField(token.name)) return true;
  }
  return false;
}

function canStartJsonValue(text: string, start: number): boolean {
  // A quoted single delimiter in prose is not the start of a JSON container.
  if (text[start - 1] === '"' && text[start + 1] === '"') return false;
  const tail = text.slice(start + 1).trimStart();
  if (text[start] === '[') return /^(?:[\[\]{}"]|-?\d|true\b|false\b|null\b)/.test(tail);
  if (tail.startsWith('}')) return true;
  const key = readJsonFieldToken(tail);
  if (!key) return false;
  if (isReviewJsonField(key.name)) return true;
  return tail.startsWith('"') && key.complete && /^\s*:/.test(key.rest);
}

function extractJsonSpans(text: string, examples: readonly TextSpan[]): JsonSpan[] {
  // Keep outer JSON values whole; The shared JSON decoder owns syntax validation.
  const spans: JsonSpan[] = [];
  let exampleIndex = 0;
  for (let start = 0; start < text.length; start += 1) {
    while (exampleIndex < examples.length && examples[exampleIndex].start < start) exampleIndex += 1;
    const example = examples[exampleIndex];
    if (example?.start === start) {
      start = example.end - 1;
      continue;
    }
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
    spans.push({ text: text.slice(start, end + 1), start, end: Math.min(end + 1, text.length), terminated: end < text.length });
    start = end;
  }
  return spans;
}

function hasExampleIntroduction(prefix: string): boolean {
  const introduction = prefix.trim();
  // Evidence must be introduced immediately as an example, source behavior,
  // or an input/response under discussion. Earlier prose is not a signal.
  return /\bexamples?\s*:?$/i.test(introduction)
    || /\be\.g\.\s*:?$/i.test(introduction)
    || /\b(?:inputs?|responses?|payloads?)\s+(?:like|such as)\s*:?$/i.test(introduction)
    || /(?:^|[.!?;:]\s*)(?:the\s+)?(?:code|api|function|implementation|bug)\s+(?:(?:currently|wrongly)\s+)?(?:returns?|emits?|produces?|turns?)(?:\s+[^.!?;]*\binto)?\s*:?$/i.test(introduction)
    || /\b(?:invalid|malformed|truncated|previous)\s+(?:inputs?|responses?|payloads?)\s*:?$/i.test(introduction);
}

function isInlineOverviewExample(text: string, span: JsonSpan, overviewEnd: number): boolean {
  // An unclosed value owns the remaining text, which may include the actual
  // review. Never discard that remainder merely because it starts as evidence.
  if (!span.terminated || span.end > overviewEnd) return false;
  const lineStart = text.lastIndexOf('\n', span.start - 1) + 1;
  const prefix = text.slice(lineStart, span.start).replace(/`+$/, '').trim();
  return hasExampleIntroduction(prefix);
}

function findQuotedOverviewExamples(text: string, overviewEnd: number): TextSpan[] {
  const overview = text.slice(0, overviewEnd);
  const examples: TextSpan[] = [];
  for (const block of overview.matchAll(/(^|\n)[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n[ \t]{0,3}\2[ \t]*\r?(?=\n|$)/g)) {
    const introduction = overview.slice(0, block.index).trimEnd().split('\n').at(-1) ?? '';
    // Fences alone also wrap native review envelopes. Only an explicit
    // example introduction makes their contents evidence instead.
    if (hasExampleIntroduction(introduction)) {
      examples.push({ start: block.index, end: block.index + block[0].length });
    }
  }
  for (const quoted of overview.matchAll(/(`+)([^`\r\n]+)\1/g)) {
    const lineStart = overview.lastIndexOf('\n', quoted.index - 1) + 1;
    const prefix = overview.slice(lineStart, quoted.index).trim();
    if (hasExampleIntroduction(prefix)) {
      examples.push({ start: quoted.index, end: quoted.index + quoted[0].length });
    }
  }
  return examples.sort((left, right) => left.start - right.start || right.end - left.end);
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

function parseNativeFindings(text: string): {
  findings: ReviewFinding[];
  textOutsideFindings: string;
  overviewEnd: number;
} {
  const lines = text.split('\n');
  const outsideLines = [...lines];
  const findings: ReviewFinding[] = [];
  let inComments = false;
  let overviewEnd = text.length;
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
        overviewEnd = lines.slice(0, lineIndex).join('\n').length;
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
  return { findings, textOutsideFindings: outsideLines.join('\n'), overviewEnd };
}

/**
 * Selects one review from Codex prose, native JSON, or Happier JSON output.
 * Explicitly introduced examples remain prose evidence. An unintroduced JSON
 * review candidate cannot safely be distinguished from the actual result, even
 * inside a fence: malformed candidates or competing prose/JSON reviews return
 * null so callers report invalid output instead of claiming a clean review.
 */
export function parseCodexReviewText(rawText: string): ParsedCodexReview | null {
  const overviewMarkdown = rawText.trim();
  if (overviewMarkdown.length === 0) return null;

  const prose = parseNativeFindings(overviewMarkdown);
  const textFindings = prose.findings;
  let jsonReview: z.infer<typeof CODEX_JSON_REVIEW_SCHEMA> | null = null;
  let strictJsonText: string | null = null;
  // Native prose can quote JSON examples that are unrelated to review output.
  // Skip delimited evidence only outside JSON values: an envelope owns all
  // of its strings, while a truncated example cannot consume a later envelope.
  const examples = findQuotedOverviewExamples(prose.textOutsideFindings, prose.overviewEnd);
  for (const span of extractJsonSpans(prose.textOutsideFindings, examples)) {
    if (isInlineOverviewExample(prose.textOutsideFindings, span, prose.overviewEnd)) continue;
    const json = parseJsonWithTrailingCommas(span.text);
    if (json === null) {
      if (hasReviewFieldText(span.text)) return null;
      continue;
    }
    if (!hasReviewFields(json)) {
      if (containsReviewFields(json)) return null;
      continue;
    }
    if (jsonReview || strictJsonText || textFindings.length > 0) return null;
    // A findings object without native Codex envelope fields belongs to the
    // existing Happier JSON validator. Do not let its trailing-object parser
    // select a different review from the complete output.
    const hasNativeEnvelope = Object.getOwnPropertyNames(json).some((field) => (
      field !== 'findings' && isReviewJsonField(field)
    ));
    if (!hasNativeEnvelope) {
      strictJsonText = span.text;
      continue;
    }
    const parsed = CODEX_JSON_REVIEW_SCHEMA.safeParse(json);
    if (!parsed.success) return null;
    jsonReview = parsed.data;
  }

  if (strictJsonText) return { format: 'strict-json', rawText: strictJsonText };

  if (jsonReview) {
    return {
      format: 'native',
      review: {
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
      },
    };
  }

  return {
    format: 'native',
    review: {
      summary: firstNonEmptyParagraph(overviewMarkdown),
      overviewMarkdown,
      findings: textFindings,
    },
  };
}
