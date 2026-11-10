import * as React from 'react';
import { View } from 'react-native';
import {
  HAPPIER_FIELD_BOX_METRICS,
  type HappierMarkdownEditorRequest,
} from '@happier-dev/plugin-ui/presentation';

import { MarkdownCodeEditorField } from '@/components/ui/markdown/editor/MarkdownCodeEditorField';

/** A document opens as a short note's page; a field as a few lines in its form. Both grow with the pane. */
const DOCUMENT_MIN_HEIGHT = {
  minHeight: 8 * HAPPIER_FIELD_BOX_METRICS.lineHeightPx,
} as const;
const FIELD_MIN_HEIGHT = {
  minHeight: 4 * HAPPIER_FIELD_BOX_METRICS.lineHeightPx,
} as const;

/**
 * A plugin's editable Markdown in the app's one Markdown editor (Documents, Prompts, Skills and Board notes use
 * it): its Raw/Rich modes, gate and formatting stay that editor's. The plugin's value is the source of truth; a
 * value the editor did not emit (a cleared draft, a reload) reseeds it.
 */
export function PluginUiPrivateMarkdownEditor(
  props: HappierMarkdownEditorRequest,
) {
  const { value, onChange } = props;
  const seed = React.useRef({ text: value, generation: 0 });
  if (seed.current.text !== value)
    seed.current = { text: value, generation: seed.current.generation + 1 };
  const emit = React.useCallback(
    (next: string) => {
      seed.current = { ...seed.current, text: next };
      onChange(next);
    },
    [onChange],
  );
  return (
    <View
      style={
        props.presentation === 'document'
          ? DOCUMENT_MIN_HEIGHT
          : FIELD_MIN_HEIGHT
      }
    >
      <MarkdownCodeEditorField
        resetKey={`plugin-markdown:${seed.current.generation}`}
        value={value}
        onChange={emit}
        language="markdown"
        readOnly={props.disabled}
        accessibilityLabel={props.accessibilityLabel}
        {...(props.placeholder === undefined
          ? {}
          : { placeholder: props.placeholder })}
        presentation={props.presentation === 'document' ? 'canvas' : 'framed'}
        {...(props.testID === undefined ? {} : { testID: props.testID })}
      />
    </View>
  );
}
