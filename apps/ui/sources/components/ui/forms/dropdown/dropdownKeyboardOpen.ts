type FocusedElement =
  | Readonly<{
      matches?: (selector: string) => boolean;
      tagName?: string;
      isContentEditable?: boolean;
    }>
  | null
  | undefined;

/**
 * Whether the control that opened the menu holds keyboard focus (the browser's own `:focus-visible` judgement).
 * A text field is never evidence: a searchable menu focuses its own field on open, and a focused text field
 * always matches `:focus-visible`, however the menu was opened. Its first key reveals the highlight instead.
 */
export function openedFromKeyboard(active: FocusedElement): boolean {
  if (active == null || typeof active.matches !== 'function') return false;
  if (active.isContentEditable === true) return false;
  const tag = active.tagName?.toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA') return false;
  try {
    return active.matches(':focus-visible');
  } catch {
    // A browser without the selector cannot tell; the first key still reveals the highlight.
    return false;
  }
}
