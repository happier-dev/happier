function stripTrailingJsonObjectFromText(text: string): string {
  const trimmed = String(text ?? '');
  if (!trimmed.trim()) return '';

  // Best-effort: remove the last parseable JSON object from the end of the text.
  // This is intended for intents (plan/delegate) where we want to show human-readable
  // prose in the transcript but keep strict JSON for structured meta extraction.
  const t = trimmed.trimEnd();
  for (let index = t.length - 1; index >= 0; index -= 1) {
    if (t[index] !== '{') continue;
    const candidate = t.slice(index);
    try {
      JSON.parse(candidate);
      return t.slice(0, index).trimEnd();
    } catch {
      // keep scanning
    }
  }
  return trimmed;
}

export function computeSidechainStreamText(intent: string, fullText: string): string | null {
  // Review runs end with strict trailing JSON for structured findings. We still want to stream
  // best-effort human-readable progress into the sidechain thread, but must avoid leaking the
  // final JSON payload into the transcript.
  if (intent === 'review') {
    const stripped = stripTrailingJsonObjectFromText(fullText).trimEnd();
    if (stripped !== String(fullText ?? '').trimEnd()) return stripped;

    // If the model is currently emitting the final JSON object but it's not parseable yet,
    // avoid streaming partial JSON fragments by cutting at the JSON start marker.
    const t = String(fullText ?? '');
    const start = t.lastIndexOf('\n{');
    if (start >= 0) {
      const tail = t.slice(start, Math.min(t.length, start + 400));
      if (tail.includes('"summary"') || tail.includes('"findings"')) {
        return t.slice(0, start).trimEnd();
      }
    }
    return t;
  }

  // Plan/delegate end with strict trailing JSON; avoid streaming it into the UI.
  if (intent === 'plan' || intent === 'delegate') {
    return stripTrailingJsonObjectFromText(fullText);
  }

  return fullText;
}

