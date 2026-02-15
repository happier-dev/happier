export function parseTrailingJsonObject(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // Many models prepend prose before the final JSON. Prefer parsing the last JSON object.
  for (let index = trimmed.length - 1; index >= 0; index -= 1) {
    if (trimmed[index] !== '{') continue;
    const candidate = trimmed.slice(index);
    try {
      return JSON.parse(candidate);
    } catch {
      // keep scanning
    }
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

