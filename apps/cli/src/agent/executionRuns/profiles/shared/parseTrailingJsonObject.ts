export function parseTrailingJsonObject(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const stripTrailingCommas = (candidate: string): string => {
    let inString = false;
    let escaped = false;
    let result = '';

    for (let i = 0; i < candidate.length; i += 1) {
      const ch = candidate[i]!;

      if (inString) {
        result += ch;

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
        result += ch;
        continue;
      }

      if (ch === ',') {
        let nextIndex = i + 1;
        while (nextIndex < candidate.length && /\s/.test(candidate[nextIndex]!)) {
          nextIndex += 1;
        }
        const next = candidate[nextIndex];
        if (next === '}' || next === ']') {
          continue;
        }
      }

      result += ch;
    }

    return result;
  };

  const parse = (candidate: string): unknown | null => {
    try {
      return JSON.parse(candidate);
    } catch {
      // fallthrough
    }

    if (!candidate.includes(',')) return null;

    try {
      return JSON.parse(stripTrailingCommas(candidate));
    } catch {
      return null;
    }
  };

  const tryParseBalancedTailObject = (): unknown | null => {
    const endIndex = trimmed.lastIndexOf('}');
    if (endIndex < 0) return null;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = endIndex; i >= 0; i -= 1) {
      const ch = trimmed[i]!;

      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (ch === '\\') {
          escaped = true;
          continue;
        }
        if (ch === '\"') {
          inString = false;
        }
        continue;
      }

      if (ch === '\"') {
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
          return parse(trimmed.slice(i, endIndex + 1));
        }
      }
    }

    return null;
  };

  const balanced = tryParseBalancedTailObject();
  if (balanced !== null) return balanced;

  // Many models prepend prose (or wrap JSON in fences) before the final JSON. Prefer parsing the last JSON object.
  for (let index = trimmed.length - 1; index >= 0; index -= 1) {
    if (trimmed[index] !== '{') continue;
    const candidate = trimmed.slice(index);
    const parsed = parse(candidate);
    if (parsed !== null) return parsed;
  }

  return parse(trimmed);
}
