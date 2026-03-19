export function tryParseJsonlLine(lineBytes: Buffer): unknown | null {
  const text = lineBytes.toString('utf8').trim();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

