function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, '\n');
}

function splitByGitHeaders(lines: string[]): number[] {
  const boundaries: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]?.startsWith('diff --git ')) boundaries.push(i);
  }
  return boundaries;
}

function splitByUnifiedFileHeaders(lines: string[]): number[] {
  const boundaries: number[] = [];
  for (let i = 0; i < lines.length - 1; i += 1) {
    if (lines[i]?.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) boundaries.push(i);
  }
  return boundaries;
}

export function splitUnifiedDiffByFile(unifiedDiff: string): string[] {
  const normalized = normalizeNewlines(unifiedDiff);
  if (!normalized.trim()) return [];

  const lines = normalized.split('\n');
  const gitHeaderBoundaries = splitByGitHeaders(lines);
  const boundaries = gitHeaderBoundaries.length > 0 ? gitHeaderBoundaries : splitByUnifiedFileHeaders(lines);

  if (boundaries.length === 0) return [normalized.trimEnd()];

  const blocks: string[] = [];
  for (let i = 0; i < boundaries.length; i += 1) {
    const start = boundaries[i] ?? 0;
    const end = boundaries[i + 1] ?? lines.length;
    const slice = lines.slice(start, end).join('\n').trimEnd();
    if (slice) blocks.push(slice);
  }

  return blocks;
}

