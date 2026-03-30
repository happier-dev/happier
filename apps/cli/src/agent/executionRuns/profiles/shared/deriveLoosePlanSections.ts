export type LoosePlanDerivation = Readonly<{
  summary: string;
  sections: readonly Readonly<{ title: string; items: readonly string[] }>[];
}>;

function clampString(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return value.slice(0, maxLength);
}

const BULLET_RE = /^(?:[-*•]|\d+\.)\s+(?<content>.+)$/u;

export function deriveLoosePlanSections(text: string): LoosePlanDerivation | null {
  const lines = String(text ?? '').split(/\r?\n/);
  const items: string[] = [];

  let summaryCandidate: string | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const bulletMatch = BULLET_RE.exec(line);
    if (!bulletMatch) {
      if (!summaryCandidate) summaryCandidate = line;
      continue;
    }

    const content = String(bulletMatch.groups?.content ?? '').trim();
    if (!content) continue;
    items.push(clampString(content, 2_000));
    if (items.length >= 50) break;
  }

  if (items.length === 0) return null;

  const summary = clampString(String(summaryCandidate ?? items[0]!).trim(), 20_000);
  return {
    summary,
    sections: [{ title: 'Plan', items }],
  };
}

