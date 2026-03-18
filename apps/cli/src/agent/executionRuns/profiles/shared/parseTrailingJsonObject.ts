function stripTrailingCommas(candidate: string): string {
  let inString = false;
  let escaped = false;
  let result = '';

  for (let index = 0; index < candidate.length; index += 1) {
    const ch = candidate[index]!;

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
      let nextIndex = index + 1;
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
}

function parseCandidate(candidate: string): unknown | null {
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
}

function parseBalancedTailObject(trimmed: string): unknown | null {
  const endIndex = trimmed.lastIndexOf('}');
  if (endIndex < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = endIndex; index >= 0; index -= 1) {
    const ch = trimmed[index]!;

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
        return parseCandidate(trimmed.slice(index, endIndex + 1));
      }
    }
  }

  return null;
}

export function parseTrailingJsonObject(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const balanced = parseBalancedTailObject(trimmed);
  if (balanced !== null) return balanced;

  // Many models prepend prose or wrap JSON in fences before the final JSON object.
  for (let index = trimmed.length - 1; index >= 0; index -= 1) {
    if (trimmed[index] !== '{') continue;
    const parsed = parseCandidate(trimmed.slice(index));
    if (parsed !== null) return parsed;
  }

  return parseCandidate(trimmed);
}
