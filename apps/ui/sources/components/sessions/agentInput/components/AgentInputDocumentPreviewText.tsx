import * as React from 'react';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { referenceChipFill } from '@/components/ui/referenceChip/referenceChipFill';
import {
  MULTI_TEXT_INPUT_BASE_FONT_SIZE,
  MULTI_TEXT_INPUT_BASE_LINE_HEIGHT,
} from '@/components/ui/forms/multiTextInputTypography';
import { Typography } from '@/constants/Typography';

import {
  splitAgentInputDocumentPreviewText,
  type AgentInputDocumentPreviewTextProps,
} from './agentInputDocumentPreviewTypes';

/** The native field's vertical inset (`MultiTextInput` in `AgentInput`). */
const FIELD_PADDING_Y = 8;

const styles = StyleSheet.create((theme) => ({
  text: {
    ...Typography.default(),
    fontSize: MULTI_TEXT_INPUT_BASE_FONT_SIZE,
    lineHeight: MULTI_TEXT_INPUT_BASE_LINE_HEIGHT,
    color: theme.colors.input.text,
    paddingVertical: FIELD_PADDING_Y,
  },
  /** A reading outside any field: its host row already gives the text its room. */
  outsideField: {
    paddingVertical: 0,
  },
  placeholder: {
    color: theme.colors.composer.chipTint,
  },
  chip: {
    ...Typography.default('medium'),
  },
  unavailable: {
    color: theme.colors.text.tertiary,
  },
}));

/**
 * A composer document's text as the native field draws it, without the native editor: the written
 * text with each placed reference as its inline chip label on the quiet-ink fill.
 */
export function AgentInputDocumentPreviewText(
  props: AgentInputDocumentPreviewTextProps,
): React.ReactElement {
  const { theme } = useUnistyles();
  if (props.value.length === 0) {
    return (
      <Text style={[styles.text, styles.placeholder]}>{props.placeholder}</Text>
    );
  }
  const fill = referenceChipFill(theme.colors.input.text);
  return (
    <Text testID="agent-input-document-preview-text" style={[styles.text, props.fieldInset === false ? styles.outsideField : null]}>
      {splitAgentInputDocumentPreviewText(props.value, props.references).map(
        (segment) =>
          segment.kind === 'text' ? (
            segment.text
          ) : (
            <Text
              key={`r${segment.reference.start}`}
              style={[
                styles.chip,
                { backgroundColor: fill },
                segment.reference.unavailable ? styles.unavailable : null,
              ]}
            >
              {` ${segment.reference.label} `}
            </Text>
          ),
      )}
    </Text>
  );
}
