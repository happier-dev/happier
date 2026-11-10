import * as React from 'react';
import type { StyleProp, TextStyle } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { OfferedChoiceFeedbackInput, type OfferedChoiceFeedbackInputHostProps } from '@happier-dev/plugin-ui/presentation';
import { usePluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { TextInput } from '@/components/ui/text/Text';

/** Native input binding; the public presentation owner supplies the feedback field's geometry. */
export function renderPermissionFeedbackInput(props: OfferedChoiceFeedbackInputHostProps): React.ReactNode {
  return <TextInput {...props} style={props.style as StyleProp<TextStyle>} multiline />;
}

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
  const presentationTheme = usePluginUiTheme(theme);
  return <OfferedChoiceFeedbackInput {...props} theme={presentationTheme} renderInput={renderPermissionFeedbackInput} />;
}
