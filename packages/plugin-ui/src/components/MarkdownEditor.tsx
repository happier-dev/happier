import type { ReactElement } from 'react';

import { useOptionalPluginUiPresentationHost } from '../presentationHost/context.js';
import { resolveHappierMarkdownEditorRequest } from '../presentation/content/MarkdownEditor.js';
import { TextField } from './Form.js';

export type MarkdownEditorProps = Readonly<{
  /** The Markdown being edited. A value the editor did not emit (a cleared draft) replaces what it shows. */
  value: string;
  onChange: (value: string) => void;
  /** The field's accessible name; its place on the page names it visibly. */
  accessibilityLabel: string;
  /** Says what goes here while the document is empty. */
  placeholder?: string;
  /** Shows the text without letting it change (while a write is in flight). */
  disabled?: boolean;
  /**
   * `field` (default): a framed box inside a form (a description, a comment). `document`: the text is the page
   * (a task's notes in its detail), unframed, as a Document is written.
   */
  presentation?: 'document' | 'field';
  testID?: string;
}>;

/**
 * Markdown written in Happier's one Markdown editor, the editor Documents use: Raw and Rich modes, formatting and
 * its slash menu, all host-owned. Isolated author renders get a multiline text field with the same value.
 */
export function MarkdownEditor(props: MarkdownEditorProps): ReactElement {
  const host = useOptionalPluginUiPresentationHost();
  const presentation = props.presentation ?? 'field';
  const disabled = props.disabled === true;
  const hosted = host?.renderMarkdownEditor?.(
    resolveHappierMarkdownEditorRequest({ ...props, presentation, disabled }),
  );
  if (hosted !== undefined && hosted !== null) return <>{hosted}</>;
  return (
    <TextField
      presentation={presentation}
      multiline
      label={props.accessibilityLabel}
      value={props.value}
      onChange={props.onChange}
      disabled={disabled}
      {...(props.placeholder === undefined
        ? {}
        : { placeholder: props.placeholder })}
      {...(props.testID === undefined ? {} : { testID: props.testID })}
    />
  );
}
