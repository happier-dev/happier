import { createHash } from 'node:crypto';

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

  return {
    summary: firstNonEmptyParagraph(overviewMarkdown),
    overviewMarkdown,
    findings: parseNativeFindings(overviewMarkdown),
  };
}
