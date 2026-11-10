import * as React from 'react';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { TextInput } from '@/components/ui/text/Text';

/**
 * The words a person sends with a decision: a plan's requested changes, or the feedback an offered choice
 * accepts. One multiline field, so every prompt card asks for feedback the same way.
 */
export function PermissionFeedbackInput(
  props: Readonly<{
    testID: string;
    value: string;
    onChangeText: (text: string) => void;
    placeholder: string;
    editable: boolean;
    accessibilityLabel?: string;
    autoFocus?: boolean;
  }>,
): React.ReactElement {
  const { theme } = useUnistyles();
  return (
    <TextInput
      testID={props.testID}
      style={styles.input}
      value={props.value}
      onChangeText={props.onChangeText}
      placeholder={props.placeholder}
      placeholderTextColor={theme.colors.text.secondary}
      multiline
      editable={props.editable}
      {...(props.accessibilityLabel === undefined
        ? {}
        : { accessibilityLabel: props.accessibilityLabel })}
      {...(props.autoFocus ? { autoFocus: true } : {})}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  input: {
    borderWidth: 1,
    borderColor: theme.colors.border.default,
    borderRadius: 10,
    paddingHorizontal: theme.space.s12,
    paddingVertical: theme.space.s10,
    minHeight: 88,
    color: theme.colors.text.primary,
    textAlignVertical: 'top',
  },
}));
