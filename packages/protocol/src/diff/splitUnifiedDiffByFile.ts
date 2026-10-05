function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, '\n');
}

function collectBoundaryOffsets(normalized: string): number[] {
  const boundaries: number[] = [];

  // Prefer Git diff headers when available (most diffs).
  // Scan without splitting into a full lines array to avoid large allocations on big diffs.
  if (normalized.startsWith('diff --git ')) boundaries.push(0);
  let cursor = 0;
  while (cursor < normalized.length) {
    const idx = normalized.indexOf('\ndiff --git ', cursor);
    if (idx === -1) break;
    boundaries.push(idx + 1);
    cursor = idx + 1;
  }
  if (boundaries.length > 0) return boundaries;

  // Fallback: unified diff without `diff --git` lines (e.g. some patch formats).
  // Boundary starts at a `--- ` line that is immediately followed by a `+++ ` line.
  let prevLineStart = 0;
  let prevLine = '';
  cursor = 0;
  while (cursor <= normalized.length) {
    const nextNewline = normalized.indexOf('\n', cursor);
    const lineEnd = nextNewline === -1 ? normalized.length : nextNewline;
    const line = normalized.slice(cursor, lineEnd);

    if (prevLine.startsWith('--- ') && line.startsWith('+++ ')) {
      boundaries.push(prevLineStart);
    }

    prevLineStart = cursor;
    prevLine = line;
    if (nextNewline === -1) break;
    cursor = lineEnd + 1;
  }

  return boundaries;
}

export function splitUnifiedDiffByFile(unifiedDiff: string, options?: Readonly<{ preserveText?: boolean }>): string[] {
  const normalized = options?.preserveText ? unifiedDiff : normalizeNewlines(unifiedDiff);
  if (!normalized.trim()) return [];

  const boundaries = collectBoundaryOffsets(normalized);

  if (boundaries.length === 0) return [options?.preserveText ? normalized : normalized.trimEnd()];

  const blocks: string[] = [];
  for (let i = 0; i < boundaries.length; i += 1) {
    const start = boundaries[i] ?? 0;
    const end = boundaries[i + 1] ?? normalized.length;
    const content = normalized.slice(start, end);
    const slice = options?.preserveText ? content : content.trimEnd();
    if (slice) blocks.push(slice);
  }

  return blocks;
}
