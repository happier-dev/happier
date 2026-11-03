import { createHash } from 'node:crypto';
import { z } from 'zod';

import type { ReviewFinding } from '@happier-dev/protocol';
import { parseTrailingJsonObject } from '@/agent/executionRuns/profiles/shared/parseTrailingJsonObject';

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

function parseNativeFindings(text: string): ReviewFinding[] {
  const lines = text.split('\n');
  const findings: ReviewFinding[] = [];
  let inComments = false;
  let current: FindingDraft | null = null;

  const flush = () => {
    if (!current) return;
    findings.push(toFinding(current));
    current = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    const trimmed = line.trim();

    if (!inComments) {
      if (REVIEW_COMMENTS_HEADER_PATTERN.test(trimmed)) inComments = true;
      continue;
    }

    const bullet = line.match(FINDING_BULLET_PATTERN);
    if (bullet) {
      flush();
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
    if (!bodyLine) continue;
    current.bodyLines.push(bodyLine[1] ?? '');
  }

  flush();
  return findings;
}

export function parseCodexNativeReviewText(rawText: string): ParsedCodexNativeReview | null {
  const overviewMarkdown = rawText.trim();
  if (overviewMarkdown.length === 0) return null;

  const textFindings = parseNativeFindings(overviewMarkdown);
  if (textFindings.length > 0) {
    return {
      summary: firstNonEmptyParagraph(overviewMarkdown),
      overviewMarkdown,
      findings: textFindings,
    };
  }

  const json = parseTrailingJsonObject(overviewMarkdown);
  if (json !== null) {
    const parsed = CODEX_JSON_REVIEW_SCHEMA.safeParse(json);
    if (!parsed.success) return null;

    return {
      summary: firstNonEmptyParagraph(parsed.data.overall_explanation),
      overviewMarkdown: parsed.data.overall_explanation,
      findings: parsed.data.findings.map((finding) => ({
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
  if (/^\s*(?:\{|\[|```(?:json\b|\s*[\r\n]+\s*[\[{]))/im.test(overviewMarkdown)) return null;

  return {
    summary: firstNonEmptyParagraph(overviewMarkdown),
    overviewMarkdown,
    findings: textFindings,
  };
}
