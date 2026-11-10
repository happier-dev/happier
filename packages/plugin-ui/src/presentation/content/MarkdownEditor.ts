/**
 * The portable request for Happier's one Markdown editor (the editor Documents, Prompts, Skills and Board notes
 * use). The author owns the text; the host owns the editor, its Raw/Rich modes and whether Rich is offered.
 */
export type HappierMarkdownEditorRequest = Readonly<{
  /** The Markdown being edited. A value the editor did not emit (a cleared draft, a reload) reseeds it. */
  value: string;
  onChange: (value: string) => void;
  /** The field's accessible name. */
  accessibilityLabel: string;
  /** Shown while the document is empty; never part of it. */
  placeholder?: string;
  /** Shows the text without letting it change. */
  disabled: boolean;
  /**
   * `document`: the text is the page (a task's notes in its detail), unframed on the page's surface.
   * `field`: a framed box inside a form (a description or a comment being edited).
   */
  presentation: 'document' | 'field';
  testID?: string;
}>;

/** Keep optional-member omission stable across plugin and app adapters. */
export function resolveHappierMarkdownEditorRequest(
  input: HappierMarkdownEditorRequest,
): HappierMarkdownEditorRequest {
  return Object.freeze({
    value: input.value,
    onChange: input.onChange,
    accessibilityLabel: input.accessibilityLabel,
    disabled: input.disabled,
    presentation: input.presentation,
    ...(input.placeholder === undefined
      ? {}
      : { placeholder: input.placeholder }),
    ...(input.testID === undefined ? {} : { testID: input.testID }),
  });
}
