export type TurnAssistantPreviewTracker = Readonly<{
  reset: () => void;
  replace: (text: unknown) => void;
  append: (delta: unknown) => void;
  getPreview: () => string | null;
}>;

function normalizeAssistantPreviewText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > 0 ? normalized : null;
}

export function createTurnAssistantPreviewTracker(): TurnAssistantPreviewTracker {
  let text = '';

  return Object.freeze({
    reset() {
      text = '';
    },
    replace(nextText: unknown) {
      text = normalizeAssistantPreviewText(nextText) ?? '';
    },
    append(delta: unknown) {
      if (typeof delta !== 'string' || delta.length === 0) return;
      text += delta;
    },
    getPreview() {
      return normalizeAssistantPreviewText(text);
    },
  });
}
