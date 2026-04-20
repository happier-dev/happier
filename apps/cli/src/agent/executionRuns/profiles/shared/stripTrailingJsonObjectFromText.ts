import { parseTrailingJsonObject } from './parseTrailingJsonObject';

function findTrailingJsonObjectSpan(text: string): Readonly<{ startIndex: number; endIndex: number }> | null {
  const endIndex = text.lastIndexOf('}');
  if (endIndex < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = endIndex; index >= 0; index -= 1) {
    const ch = text[index]!;

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (ch === '\\') {
        escaped = true;
        continue;
      }

      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '}') {
      depth += 1;
      continue;
    }

    if (ch === '{') {
      depth -= 1;
      if (depth === 0) {
        return { startIndex: index, endIndex };
      }
    }
  }

  return null;
}

export function stripTrailingJsonObjectFromText(text: string): string {
  const trimmed = String(text ?? '');
  if (!trimmed.trim()) return '';

  const t = trimmed.trimEnd();
  const fencedTailPattern = /^(?<prefix>[\s\S]*?)(?:\r?\n)?```(?:json)?\s*\r?\n(?<body>[\s\S]*?)\r?\n```\s*$/u;
  const fencedMatch = fencedTailPattern.exec(t);
  if (fencedMatch?.groups) {
    const body = String(fencedMatch.groups.body ?? '').trim();
    if (parseTrailingJsonObject(body) !== null) {
      return String(fencedMatch.groups.prefix ?? '').trimEnd();
    }
  }

  const span = findTrailingJsonObjectSpan(t);
  if (span) {
    const candidate = t.slice(span.startIndex, span.endIndex + 1);
    if (parseTrailingJsonObject(candidate) !== null) {
      return t.slice(0, span.startIndex).trimEnd();
    }
  }

  return trimmed;
}
