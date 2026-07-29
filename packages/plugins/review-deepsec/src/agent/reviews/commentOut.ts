import type { ReviewCommentAnchorV1 } from '@happier-dev/plugin-sdk/experimental/reviews';

export type ParsedDeepSecCommentOutEntry = Readonly<{
  anchor: ReviewCommentAnchorV1;
  severity?: string;
  ruleId?: string;
  category?: string;
  body: string;
  confidence: 'high' | 'low';
  tags: readonly string[];
}>;

type ParsedDeepSecHeading = Readonly<{
  filePath: string;
  startLine: number | null;
  endLine: number | null;
}>;

function normalizeSafeOutputPath(filePath: string): string | null {
  const slashNormalized = filePath.trim().replace(/\\/g, '/');
  if (
    !slashNormalized
    || /[\0\r\n]/.test(slashNormalized)
    || slashNormalized.startsWith('/')
    || slashNormalized.startsWith('~')
    || /^[A-Za-z]:/.test(slashNormalized)
  ) {
    return null;
  }
  const segments = slashNormalized.split('/').filter((segment) => segment && segment !== '.');
  if (segments.length === 0 || segments.includes('..')) return null;
  return segments.join('/');
}

function parseHeading(line: string): ParsedDeepSecHeading | null {
  const headingMatch = line.trim().match(/^#{2,6}\s+(.+?)\s*$/);
  const content = headingMatch?.[1]?.trim();
  if (!content) return null;
  const locationMatch = content.match(/^(.*):(\d+)(?:-(\d+))?$/);
  const filePath = normalizeSafeOutputPath(locationMatch?.[1] ?? content);
  if (!filePath) return null;
  const startLine = locationMatch?.[2] ? Number(locationMatch[2]) : null;
  const endLine = locationMatch?.[3] ? Number(locationMatch[3]) : startLine;
  if (
    startLine !== null
    && (!Number.isInteger(startLine) || startLine < 1)
  ) {
    return null;
  }
  if (
    endLine !== null
    && (!Number.isInteger(endLine) || endLine < 1 || (startLine !== null && endLine < startLine))
  ) {
    return null;
  }
  return {
    filePath,
    startLine,
    endLine,
  };
}

function readMetadata(line: string): Readonly<{ key: string; value: string }> | null {
  const match = line.trim().match(/^\*\*([^*]+):\*\*\s*(.+)$/);
  if (!match?.[1] || !match[2]) return null;
  return { key: match[1].trim().toLowerCase(), value: match[2].trim() };
}

export function parseDeepSecCommentOutMarkdown(markdown: string): readonly ParsedDeepSecCommentOutEntry[] {
  const entries: ParsedDeepSecCommentOutEntry[] = [];
  let current: {
    filePath: string;
    startLine: number | null;
    endLine: number | null;
    metadata: Record<string, string>;
    body: string[];
  } | null = null;

  const flush = () => {
    if (!current) return;
    const body = current.body.join('\n').trim();
    if (body) {
      const hasRange = typeof current.startLine === 'number'
        && typeof current.endLine === 'number'
        && current.endLine > current.startLine;
      const hasLine = typeof current.startLine === 'number';
      const anchor: ReviewCommentAnchorV1 = hasRange
        ? {
            kind: 'range',
            filePath: current.filePath,
            startLine: current.startLine as number,
            endLine: current.endLine as number,
          }
        : hasLine
          ? { kind: 'line', filePath: current.filePath, line: current.startLine as number }
          : { kind: 'file', filePath: current.filePath };
      entries.push({
        anchor,
        ...(current.metadata.severity ? { severity: current.metadata.severity } : {}),
        ...(current.metadata.rule ? { ruleId: current.metadata.rule } : {}),
        ...(current.metadata.category ? { category: current.metadata.category } : {}),
        body,
        confidence: hasLine ? 'high' : 'low',
        tags: hasLine ? [] : ['deepsec.low_confidence_anchor'],
      });
    }
    current = null;
  };

  for (const rawLine of markdown.split('\n')) {
    const heading = parseHeading(rawLine);
    if (heading) {
      flush();
      current = {
        filePath: heading.filePath,
        startLine: heading.startLine,
        endLine: heading.endLine,
        metadata: {},
        body: [],
      };
      continue;
    }
    if (!current) continue;
    const metadata = readMetadata(rawLine);
    if (metadata) {
      current.metadata[metadata.key] = metadata.value;
      continue;
    }
    current.body.push(rawLine);
  }
  flush();
  return entries;
}
