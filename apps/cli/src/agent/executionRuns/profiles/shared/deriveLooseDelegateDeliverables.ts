export type LooseDelegateDeliverable = Readonly<{
  id: string;
  title: string;
  details?: string;
}>;

export type LooseDelegateDerivation = Readonly<{
  summary: string;
  deliverables: readonly LooseDelegateDeliverable[];
}>;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function clampString(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return value.slice(0, maxLength);
}

const BULLET_RE = /^(?:[-*•]|\(\d+\)|\d+(?:[.)]|:))\s*(?<content>.+)$/u;
const ID_TITLE_RE = /^(?<id>[A-Za-z0-9][A-Za-z0-9_-]{0,199})\s*:\s*(?<title>.+)$/u;

export function deriveLooseDelegateDeliverables(text: string): LooseDelegateDerivation | null {
  const lines = String(text ?? '').split(/\r?\n/);
  const deliverables: LooseDelegateDeliverable[] = [];

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

    const idTitleMatch = ID_TITLE_RE.exec(content);
    if (idTitleMatch && isNonEmptyString(idTitleMatch.groups?.id) && isNonEmptyString(idTitleMatch.groups?.title)) {
      deliverables.push({
        id: clampString(idTitleMatch.groups.id.trim(), 200),
        title: clampString(idTitleMatch.groups.title.trim(), 400),
      });
      continue;
    }

    deliverables.push({
      id: `d${deliverables.length + 1}`,
      title: clampString(content, 400),
    });
  }

  if (deliverables.length === 0) return null;

  const summary = clampString(String(summaryCandidate ?? deliverables[0]!.title).trim(), 20_000);
  return { summary, deliverables };
}
